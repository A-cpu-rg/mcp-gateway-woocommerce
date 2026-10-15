import { createHash, timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { createToolboxServer } from './server.ts';

const apiKey = process.env.TOOLBOX_API_KEY;
if (!apiKey) throw new Error('missing env TOOLBOX_API_KEY');
const keyDigest = createHash('sha256').update(apiKey).digest();

const mcp = createMcpHandler(() => createToolboxServer());
const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));
app.get('/readyz', (c) => c.text('ok'));
// Uses a custom header credential (X-Api-Key) so the gateway's "header" credential type is exercised.
app.all('/mcp', async (c) => {
  const presented = createHash('sha256')
    .update(c.req.header('x-api-key') ?? '')
    .digest();
  if (!timingSafeEqual(presented, keyDigest)) return c.json({ error: 'unauthorized' }, 401);
  return mcp.fetch(c.req.raw);
});

const port = Number(process.env.PORT ?? 8080);
const server = serve({ fetch: app.fetch, port });
console.log(JSON.stringify({ msg: 'toolbox-mcp listening', port }));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    void mcp.close().finally(() => process.exit(0));
  });
}
