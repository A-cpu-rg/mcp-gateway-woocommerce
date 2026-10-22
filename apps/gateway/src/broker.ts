import type { Principal } from './auth.ts';
import type { Db } from './db.ts';
import { type CallOutcome, slugOf, type UpstreamPool, type UpstreamTool } from './upstreams.ts';

export type Channel = 'mcp' | 'chat';

const COLD_LIST_WAIT_MS = 1500;

export interface AuditEntry {
  principal: Principal;
  channel: Channel;
  serverSlug: string | null;
  tool: string | null;
  durationMs: number;
  outcome: string;
  error?: string;
}

export async function writeAudit(db: Db, a: AuditEntry): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, user_email, api_key_id, channel, server_slug, tool, duration_ms, outcome, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        a.principal.userId,
        a.principal.email,
        a.principal.apiKeyId ?? null,
        a.channel,
        a.serverSlug,
        a.tool,
        a.durationMs,
        a.outcome,
        a.error?.slice(0, 500) ?? null,
      ],
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: 'audit write failed',
        error: String(err),
        entry: { ...a, principal: a.principal.userId },
      }),
    );
  }
}

const denied = (text: string): CallOutcome['result'] => ({
  isError: true,
  content: [{ type: 'text', text }],
});

/**
 * The single enforcement point. Both the MCP endpoint and the chat agent go through here, so
 * authorization, routing, timeouts and auditing cannot differ between them.
 * Server configuration (enabled, admin-only tools) is read from the database on every call, so
 * disabling a server or restricting a tool takes effect immediately on every replica.
 */
export class Broker {
  readonly #db: Db;
  readonly #pool: UpstreamPool;

  constructor(db: Db, pool: UpstreamPool) {
    this.#db = db;
    this.#pool = pool;
  }

  /** Tools this principal may call: enabled, connected servers only; admin-only tools hidden from members. */
  async listTools(p: Principal): Promise<(UpstreamTool & { server: string })[]> {
    const rows = await this.#pool.servers();
    // A server added or edited through another replica is not in this replica's cache yet. Fetch it now,
    // but wait only briefly, so a slow upstream still cannot hold up the listing (its check carries on).
    const cold = rows.filter((r) => r.enabled && r.status !== 'unreachable' && this.#pool.isCold(r));
    if (cold.length) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(cold.map((r) => this.#pool.check(r))),
        new Promise((resolve) => {
          timer = setTimeout(resolve, COLD_LIST_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    return rows
      .filter((r) => r.enabled)
      .flatMap((r) =>
        this.#pool
          .tools(r)
          .filter((t) => p.role === 'admin' || !r.admin_only_tools.includes(t.name))
          .map((t) => ({
            ...t,
            server: r.slug,
            description: `[${r.name}] ${t.description ?? ''}`.trim(),
          })),
      );
  }

  async callTool(
    p: Principal,
    channel: Channel,
    exposedName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallOutcome['result']> {
    const started = performance.now();
    const slug = slugOf(exposedName);
    const audit = (serverSlug: string | null, tool: string | null, outcome: string, error?: string) =>
      writeAudit(this.#db, {
        principal: p,
        channel,
        serverSlug,
        tool,
        durationMs: Math.round(performance.now() - started),
        outcome,
        error,
      });

    const row = slug ? await this.#pool.serverBySlug(slug) : undefined;
    if (!row?.enabled) {
      const msg = row ? `Server '${row.slug}' is disabled.` : `Unknown tool '${exposedName}'.`;
      await audit(slug, exposedName, 'not_found', msg);
      return denied(msg);
    }
    let tool = this.#pool.tools(row).find((t) => t.exposedName === exposedName);
    if (!tool && row.status !== 'unreachable') {
      // Cold cache (fresh replica or just-edited server): check once before giving up.
      await this.#pool.check(row);
      tool = this.#pool.tools(row).find((t) => t.exposedName === exposedName);
    }
    if (!tool) {
      const msg = `Unknown tool '${exposedName}' (server '${row.slug}' is ${row.status}).`;
      await audit(row.slug, exposedName, 'not_found', msg);
      return denied(msg);
    }
    // Enforced on call, not only on list: a member calling a hidden tool directly is rejected.
    if (p.role !== 'admin' && row.admin_only_tools.includes(tool.name)) {
      const msg = `Tool '${exposedName}' requires the admin role.`;
      await audit(row.slug, tool.name, 'denied', msg);
      return denied(msg);
    }
    const res = await this.#pool.call(row, tool.name, args, signal);
    await audit(row.slug, tool.name, res.outcome, res.error);
    return res.result;
  }
}
