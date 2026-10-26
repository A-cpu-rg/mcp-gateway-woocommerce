// Same-origin JSON API client. The session is an HttpOnly cookie, so no token is ever handled in JS.

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Me {
  userId: string;
  email: string;
  role: 'admin' | 'member';
  mcpUrl: string;
  chatEnabled: boolean;
  storesEnabled: boolean;
}

export interface Tool {
  name: string;
  exposedName: string;
  description: string;
  adminOnly: boolean;
  readOnly: boolean;
}

export interface Server {
  id: string;
  slug: string;
  name: string;
  url?: string;
  enabled: boolean;
  authType?: 'none' | 'bearer' | 'header';
  authHeader?: string | null;
  hasCredential?: boolean;
  timeoutMs: number;
  adminOnlyTools?: string[];
  status: 'connected' | 'unreachable' | 'disabled' | 'unknown';
  lastError: string | null;
  lastCheckedAt: string | null;
  tools: Tool[];
}

export type ChatEvent =
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; preview: string }
  | { type: 'message'; content: string }
  | { type: 'error'; message: string };

/** Streams NDJSON events from the chat endpoint. */
export async function chat(
  messages: { role: 'user' | 'assistant'; content: string }[],
  onEvent: (e: ChatEvent) => void,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data?.error?.message ?? `HTTP ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as ChatEvent);
      nl = buffer.indexOf('\n');
    }
  }
}
