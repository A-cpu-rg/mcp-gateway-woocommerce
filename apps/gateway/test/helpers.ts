import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import pg from 'pg';
import type { ChatModel } from '../src/agent.ts';
import { createGateway } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { KubeError } from '../src/kube.ts';

export const DATABASE_URL = process.env.TEST_DATABASE_URL;
export const skip = DATABASE_URL ? false : 'TEST_DATABASE_URL not set';

export interface Upstream {
  url: string;
  close: () => Promise<void>;
}

/** A real MCP server on a random localhost port, optionally requiring a header credential. */
export async function startUpstream(
  build: (s: McpServer) => void,
  auth?: { header: string; value: string },
): Promise<Upstream> {
  const handler = createMcpHandler(() => {
    const s = new McpServer({ name: 'test-upstream', version: '1.0.0' });
    build(s);
    return s;
  });
  const server = (serve as (o: object) => Server)({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req: Request) => {
      if (auth && req.headers.get(auth.header) !== auth.value)
        return new Response('unauthorized', { status: 401 });
      return handler.fetch(req);
    },
  });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const ADMIN = { email: 'admin@example.com', password: 'admin-password-123' };

/** Gateway on an isolated Postgres schema, so test files can run in parallel. */
export async function startGateway(model?: ChatModel) {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const cfg: Config = {
    port: 0,
    databaseUrl: DATABASE_URL as string,
    encryptionKey: randomBytes(32),
    publicUrl: 'http://gateway.test',
    cookieSecure: false,
    upstreamAllowedHosts: ['127.0.0.1'],
    healthIntervalMs: 60_000,
    bootstrapAdmin: ADMIN,
  };
  const gw = await createGateway(cfg, { model, dbOptions: `-c search_path=${schema}`, startHealth: false });

  async function request(path: string, init: RequestInit & { cookie?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.body) headers.set('content-type', 'application/json');
    const res = await gw.app.request(`http://gateway.test${path}`, { ...init, headers });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {}
    // biome-ignore lint/suspicious/noExplicitAny: tests index into arbitrary JSON responses.
    return { status: res.status, json: json as any, text, headers: res.headers };
  }

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.text}`);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  }

  async function mcpClient(apiKey: string, mode: 'auto' | 'legacy' = 'auto') {
    const client = new Client({ name: 'test-client', version: '1' }, { versionNegotiation: { mode } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://gateway.test/mcp'), {
        fetch: async (input, init) => gw.app.fetch(new Request(input, init)),
        requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
      }),
    );
    return client;
  }

  return {
    ...gw,
    request,
    loginAs,
    mcpClient,
    async close() {
      await gw.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export const textOf = (r: { content?: unknown }) => ((r.content as { text?: string }[]) ?? [])[0]?.text ?? '';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tiny Kubernetes API: objects by path; POST to an existing path is 409, GET of a missing one 404. */
export function fakeApi(seed: Record<string, Record<string, unknown>> = {}) {
  const objects = new Map(Object.entries(seed));
  const requests: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    requests.push(`${method} ${path}`);
    const b = (body ?? {}) as { metadata?: { name?: string }; stringData?: Record<string, string> };
    if (method === 'POST' && path.endsWith('/selfsubjectaccessreviews'))
      return { status: { allowed: false } };
    if (method === 'POST') {
      const target = `${path}/${b.metadata?.name}`;
      if (objects.has(target)) throw new KubeError(409, `${target} exists`);
      const data = b.stringData
        ? Object.fromEntries(
            Object.entries(b.stringData).map(([k, v]) => [k, Buffer.from(v).toString('base64')]),
          )
        : undefined;
      objects.set(target, { ...(body as object), ...(data ? { data } : {}) });
      return {};
    }
    if (method === 'GET') {
      const o = objects.get(path);
      if (!o) throw new KubeError(404, `${path} not found`);
      return o;
    }
    if (method === 'DELETE') {
      if (!objects.delete(path)) throw new KubeError(404, `${path} not found`);
      return {};
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call, objects, requests };
}
