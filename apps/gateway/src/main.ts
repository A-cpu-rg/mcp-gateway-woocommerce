import { serve } from '@hono/node-server';
import { createGateway } from './app.ts';
import { loadConfig } from './config.ts';

const cfg = loadConfig();
const gw = await createGateway(cfg);
const server = serve({ fetch: gw.app.fetch, port: cfg.port });
console.log(JSON.stringify({ msg: 'gateway listening', port: cfg.port, chat: !!cfg.llm }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    void gw.close().finally(() => process.exit(0));
  });
}
