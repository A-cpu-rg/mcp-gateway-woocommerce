import { signOAuth1 } from './oauth1.ts';

export interface WooConfig {
  /** Where we connect, e.g. http://wordpress.store-default.svc.cluster.local */
  baseUrl: string;
  /** WordPress home URL host, used only for the OAuth signature (see oauth1.ts). */
  signingOrigin: string;
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** Error whose message is safe to show to an MCP client: never contains URLs, keys or signatures. */
export class WooError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type WooClient = ReturnType<typeof createWooClient>;

export function createWooClient(cfg: WooConfig) {
  const doFetch = cfg.fetch ?? fetch;

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT',
    route: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const path = `/wp-json/wc/v3${route}`;
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined && v !== '') query[k] = String(v);
    const signed = signOAuth1({
      method,
      signingOrigin: cfg.signingOrigin,
      path,
      query,
      consumerKey: cfg.consumerKey,
      consumerSecret: cfg.consumerSecret,
    });
    const url = `${cfg.baseUrl}${path}?${new URLSearchParams(signed)}`;
    const timeout = AbortSignal.timeout(cfg.timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: { accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
        redirect: 'error',
      });
    } catch (err) {
      if (timeout.aborted) throw new WooError(504, `Store did not respond within ${cfg.timeoutMs} ms`);
      throw new WooError(502, `Store unreachable: ${(err as Error).name}`);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new WooError(502, `Store returned non-JSON response (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const e = data as { code?: string; message?: string } | null;
      throw new WooError(
        res.status,
        `WooCommerce error ${res.status} ${e?.code ?? ''}: ${e?.message ?? 'unknown'}`,
      );
    }
    return data as T;
  }

  return {
    get: <T>(route: string, query?: Record<string, string | number | undefined>, signal?: AbortSignal) =>
      request<T>('GET', route, { query, signal }),
    post: <T>(route: string, body: unknown, signal?: AbortSignal) =>
      request<T>('POST', route, { body, signal }),
    put: <T>(route: string, body: unknown, signal?: AbortSignal) =>
      request<T>('PUT', route, { body, signal }),
  };
}
