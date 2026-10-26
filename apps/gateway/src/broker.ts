import type { Principal } from './auth.ts';
import type { Db } from './db.ts';
import {
  type CallOutcome,
  type ServerRow,
  slugOf,
  type UpstreamPool,
  type UpstreamTool,
} from './upstreams.ts';

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

/**
 * The tool policy, shared by listing and calling so a tool is visible exactly when it may be called.
 * Admin-only tools: platform admins, and the owner of the store this server was provisioned for
 * (upstream_servers.store_id -> stores.owner_id, read from the database with the server). A server that
 * belongs to no store, or whose owner cannot be resolved, grants members nothing beyond ordinary tools.
 */
export function mayUseTool(p: Principal, row: ServerRow, tool: string): boolean {
  if (!row.admin_only_tools.includes(tool) || p.role === 'admin') return true;
  return !!row.store_id && !!row.store_owner_id && row.store_owner_id === p.userId;
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

  /** Tools this principal may call: enabled, connected servers only; admin-only tools per mayUseTool. */
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
          .filter((t) => mayUseTool(p, r, t.name))
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
    if (!mayUseTool(p, row, tool.name)) {
      const msg = row.store_id
        ? `Tool '${exposedName}' requires the admin role or ownership of this store.`
        : `Tool '${exposedName}' requires the admin role.`;
      await audit(row.slug, tool.name, 'denied', msg);
      return denied(msg);
    }
    const res = await this.#pool.call(row, tool.name, args, signal);
    await audit(row.slug, tool.name, res.outcome, res.error);
    return res.result;
  }
}
