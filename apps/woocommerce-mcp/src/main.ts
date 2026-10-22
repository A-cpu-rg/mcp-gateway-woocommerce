import { createHash, timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { createWooMcpServer } from './server.ts';
import { createWooClient } from './wc-client.ts';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const wc = createWooClient({
  baseUrl: env('WC_BASE_URL'),
  signingOrigin: env('WC_SIGNING_ORIGIN'),
  consumerKey: env('WC_CONSUMER_KEY'),
  consumerSecret: env('WC_CONSUMER_SECRET'),
  timeoutMs: Number(env('WC_TIMEOUT_MS', '8000')),
});
// Only the gateway holds this token; NetworkPolicy is the first barrier, this is the second.
const tokenDigest = createHash('sha256').update(env('MCP_AUTH_TOKEN')).digest();

const mcp = createMcpHandler(() => createWooMcpServer(wc));
const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));
// Diagnostic: 200 only if the store answers. Deliberately NOT the Kubernetes readiness probe (the chart uses
// /healthz): the store is installed by a post-install Job that Helm starts only after `--wait` sees this pod Ready.
app.get('/readyz', async (c) => {
  try {
    await wc.get('/products', { per_page: 1, _fields: 'id' });
    return c.text('ok');
  } catch (err) {
    return c.text(`store not ready: ${(err as Error).message}`, 503);
  }
});
app.all('/mcp', async (c) => {
  const header = c.req.header('authorization') ?? '';
  const presented = createHash('sha256')
    .update(header.replace(/^Bearer /i, ''))
    .digest();
  if (!header.toLowerCase().startsWith('bearer ') || !timingSafeEqual(presented, tokenDigest)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return mcp.fetch(c.req.raw);
});

const port = Number(env('PORT', '8080'));
const server = serve({ fetch: app.fetch, port });
console.log(JSON.stringify({ msg: 'woocommerce-mcp listening', port }));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    void mcp.close().finally(() => process.exit(0));
  });
}
