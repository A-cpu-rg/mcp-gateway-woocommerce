import { createHash } from 'node:crypto';
import {
  type CallToolResult,
  Client,
  ProtocolError,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { decrypt } from './crypto.ts';
import type { Db } from './db.ts';

export interface ServerRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  enabled: boolean;
  auth_type: 'none' | 'bearer' | 'header';
  auth_header: string | null;
  credential_enc: Buffer | null;
  timeout_ms: number;
  admin_only_tools: string[];
  /** The store this server was provisioned for (set by the store-provisioner only). */
  store_id: string | null;
  /** Owner of that store; only on rows read through UpstreamPool, which joins it in. */
  store_owner_id?: string | null;
  status: string;
  last_error: string | null;
  last_checked_at: Date | null;
  updated_at: Date;
}

export interface UpstreamTool {
  /** Name exposed by the gateway: <slug>__<tool>, always ^[a-zA-Z0-9_-]{1,64}$ (LLM API constraint). */
  exposedName: string;
  /** Name on the upstream server. */
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface CallOutcome {
  outcome: 'ok' | 'tool_error' | 'upstream_error' | 'timeout' | 'busy';
  result: CallToolResult;
  error?: string;
}

export const SEPARATOR = '__';
const MAX_DESCRIPTION = 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_IN_FLIGHT = 32;
const LIST_TIMEOUT_MS = 5000;
// The store owner is read together with the server's configuration, so authorization always uses the
// current owner from the database, never a cached or client-supplied ownership claim.
const SELECT_SERVERS = `SELECT us.*, st.owner_id AS store_owner_id
  FROM upstream_servers us LEFT JOIN stores st ON st.id = us.store_id`;

/**
 * Collision-free naming: slugs are unique and cannot contain "_", so "<slug>__" is an unambiguous prefix.
 * Upstream names that are too long or use characters LLM APIs reject are sanitized and get a short hash
 * of the original name, keeping them unique within the server.
 */
export function exposedToolName(slug: string, tool: string): string {
  const name = `${slug}${SEPARATOR}${tool}`;
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name;
  const hash = createHash('sha256').update(tool).digest('hex').slice(0, 8);
  const clean = tool.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${`${slug}${SEPARATOR}${clean}`.slice(0, 64 - 9)}_${hash}`;
}

export function slugOf(exposedName: string): string | null {
  const i = exposedName.indexOf(SEPARATOR);
  return i > 0 ? exposedName.slice(0, i) : null;
}

/** Human-readable reason for the dashboard, never containing credentials. */
export function describeError(err: unknown): string {
  const e = err as {
    name?: string;
    message?: string;
    code?: string;
    cause?: { code?: string; message?: string };
  };
  const code = e?.cause?.code ?? e?.code;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return e.message || 'timed out';
  const msg = (e?.cause?.message ?? e?.message ?? String(err)).replace(/Bearer\s+\S+/gi, 'Bearer ***');
  return (code && !msg.includes(String(code)) ? `${code}: ${msg}` : msg).slice(0, 300);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${what} timed out after ${ms} ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

interface Entry {
  version: number;
  client?: Promise<Client>;
  tools: UpstreamTool[];
  /** True once this replica has listed the tools of this version of the server. */
  listed: boolean;
  inFlight: number;
}

/**
 * Owns one MCP client per upstream (per gateway replica) and a cache of each upstream's tools.
 * The database is the source of truth for configuration; the cache only holds tool definitions.
 * A failing upstream only affects its own entry: separate clients, timeouts and in-flight limits.
 */
export class UpstreamPool {
  readonly #db: Db;
  readonly #key: Buffer;
  readonly #fetch: typeof fetch;
  readonly #entries = new Map<string, Entry>();
  #timer?: NodeJS.Timeout;

  constructor(db: Db, encryptionKey: Buffer, guardedFetch: typeof fetch) {
    this.#db = db;
    this.#key = encryptionKey;
    this.#fetch = guardedFetch;
  }

  async servers(): Promise<ServerRow[]> {
    return (await this.#db.query<ServerRow>(`${SELECT_SERVERS} ORDER BY us.created_at`)).rows;
  }

  async serverBySlug(slug: string): Promise<ServerRow | undefined> {
    return (await this.#db.query<ServerRow>(`${SELECT_SERVERS} WHERE us.slug = $1`, [slug])).rows[0];
  }

  /** Cached tools of a server; empty until the first successful health check. */
  tools(row: ServerRow): UpstreamTool[] {
    // Status lives in Postgres and is shared by every replica. When any replica has seen the server die,
    // the others must stop listing their cached tools too, not only after their own next health check.
    if (row.status === 'unreachable') return [];
    const e = this.#entries.get(row.id);
    return e && e.version === row.updated_at.getTime() ? e.tools : [];
  }

  /**
   * True when this replica has no tool list for the server's current configuration yet: the server was just
   * added or edited, possibly through another replica, and this replica's health check has not run since.
   */
  isCold(row: ServerRow): boolean {
    const e = this.#entries.get(row.id);
    return !e?.listed || e.version !== row.updated_at.getTime();
  }

  #entry(row: ServerRow): Entry {
    let e = this.#entries.get(row.id);
    if (!e || e.version !== row.updated_at.getTime()) {
      // Config changed (URL, credential, ...): discard the old connection and its tools.
      if (e) this.#closeClient(e);
      e = { version: row.updated_at.getTime(), tools: [], listed: false, inFlight: 0 };
      this.#entries.set(row.id, e);
    }
    return e;
  }

  #closeClient(e: Entry): void {
    const c = e.client;
    e.client = undefined;
    c?.then((client) => client.close()).catch(() => {});
  }

  #connect(row: ServerRow, e: Entry): Promise<Client> {
    if (!e.client) {
      const headers: Record<string, string> = {};
      let credential = '';
      if (row.credential_enc) {
        try {
          credential = decrypt(this.#key, row.credential_enc);
        } catch {
          throw new Error(
            `cannot decrypt the stored credential for '${row.slug}': ENCRYPTION_KEY differs from the one it was saved with. Restore the key or re-enter the credential.`,
          );
        }
      }
      if (row.auth_type === 'bearer') headers.authorization = `Bearer ${credential}`;
      if (row.auth_type === 'header' && row.auth_header) headers[row.auth_header] = credential;
      const client = new Client(
        { name: 'mcp-gateway', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(row.url), {
        fetch: this.#fetch,
        requestInit: { headers },
      });
      const pending = withTimeout(client.connect(transport), LIST_TIMEOUT_MS, 'connect').then(
        () => client,
        (err) => {
          client.close().catch(() => {});
          throw err;
        },
      );
      e.client = pending;
      // A failed connect is forgotten so the next call or health check retries it.
      pending.catch(() => {
        if (e.client === pending) e.client = undefined;
      });
    }
    return e.client;
  }

  /** Lists the upstream's tools and records its status. Never throws. */
  async check(row: ServerRow): Promise<void> {
    if (!row.enabled) {
      const e = this.#entries.get(row.id);
      if (e) this.#closeClient(e);
      this.#entries.delete(row.id);
      await this.#setStatus(row, 'disabled', null);
      return;
    }
    const e = this.#entry(row);
    try {
      const client = await this.#connect(row, e);
      const tools: UpstreamTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor }, { timeout: LIST_TIMEOUT_MS });
        for (const t of page.tools) {
          tools.push({
            exposedName: exposedToolName(row.slug, t.name),
            name: t.name,
            title: t.title,
            description: t.description?.slice(0, MAX_DESCRIPTION),
            inputSchema: t.inputSchema as Record<string, unknown>,
            annotations: t.annotations as Record<string, unknown> | undefined,
          });
        }
        cursor = page.nextCursor;
      } while (cursor && tools.length < 500);
      e.tools = tools;
      e.listed = true;
      await this.#setStatus(row, 'connected', null);
    } catch (err) {
      this.#closeClient(e);
      e.tools = [];
      await this.#setStatus(row, 'unreachable', describeError(err));
    }
  }

  async #setStatus(row: ServerRow, status: string, error: string | null): Promise<void> {
    await this.#db
      .query(
        'UPDATE upstream_servers SET status = $2, last_error = $3, last_checked_at = now() WHERE id = $1',
        [row.id, status, error],
      )
      .catch((err) => console.error(JSON.stringify({ msg: 'status update failed', error: String(err) })));
  }

  async refreshAll(): Promise<void> {
    const rows = await this.servers();
    const ids = new Set(rows.map((r) => r.id));
    for (const [id, e] of this.#entries) {
      if (!ids.has(id)) {
        this.#closeClient(e);
        this.#entries.delete(id);
      }
    }
    // Upstreams are checked in parallel: one slow server cannot delay the others.
    await Promise.allSettled(rows.map((r) => this.check(r)));
  }

  start(intervalMs: number): void {
    const tick = () => {
      this.refreshAll()
        .catch((err) => console.error(JSON.stringify({ msg: 'health check failed', error: String(err) })))
        .finally(() => {
          this.#timer = setTimeout(tick, intervalMs);
        });
    };
    tick();
  }

  async stop(): Promise<void> {
    clearTimeout(this.#timer);
    for (const e of this.#entries.values()) this.#closeClient(e);
    this.#entries.clear();
  }

  /**
   * Calls a tool with a hard timeout. Never retried: tools can have side effects (create_product), so a
   * timeout is reported as "outcome unknown" rather than risking a duplicate.
   */
  async call(
    row: ServerRow,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallOutcome> {
    const e = this.#entry(row);
    if (e.inFlight >= MAX_IN_FLIGHT) {
      return fail(
        'busy',
        `Upstream '${row.slug}' is at its concurrency limit (${MAX_IN_FLIGHT}); try again shortly.`,
      );
    }
    e.inFlight++;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), row.timeout_ms);
    try {
      const client = await withTimeout(
        this.#connect(row, e),
        Math.min(row.timeout_ms, LIST_TIMEOUT_MS),
        'connect',
      );
      const result = (await client.callTool(
        { name: tool, arguments: args },
        {
          signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
          timeout: row.timeout_ms + 1000,
        },
      )) as CallOutcome['result'];
      if (JSON.stringify(result).length > MAX_RESULT_BYTES) {
        return fail(
          'upstream_error',
          `Result from '${row.slug}' exceeded ${MAX_RESULT_BYTES} bytes and was dropped.`,
        );
      }
      return { outcome: result.isError ? 'tool_error' : 'ok', result };
    } catch (err) {
      if (timeout.signal.aborted) {
        return fail(
          'timeout',
          `Upstream '${row.slug}' did not answer within ${row.timeout_ms} ms. The outcome is unknown; ` +
            'check the current state before retrying a write.',
        );
      }
      // A JSON-RPC error means the server is alive and answered; anything else means the connection is suspect.
      if (!(err instanceof ProtocolError)) this.#closeClient(e);
      return fail('upstream_error', `Upstream '${row.slug}' failed: ${describeError(err)}`);
    } finally {
      clearTimeout(timer);
      e.inFlight--;
    }
  }
}

function fail(outcome: CallOutcome['outcome'], message: string): CallOutcome {
  return { outcome, error: message, result: { isError: true, content: [{ type: 'text', text: message }] } };
}
