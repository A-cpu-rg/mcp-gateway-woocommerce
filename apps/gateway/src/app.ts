import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { Hono } from 'hono';
import { type ChatModel, openAiCompatibleModel } from './agent.ts';
import { createApi } from './api.ts';
import { ensureAdmin } from './auth.ts';
import { Broker } from './broker.ts';
import type { Config } from './config.ts';
import { createDb, migrate } from './db.ts';
import { createMcpEndpoint } from './mcp.ts';
import { seedServers } from './servers.ts';
import { UpstreamPool } from './upstreams.ts';
import { createGuardedFetch } from './url-guard.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Wires the gateway. Used by main.ts and by the integration tests (with injected model/fetch/db options). */
export async function createGateway(
  cfg: Config,
  opts: { model?: ChatModel; dbOptions?: string; startHealth?: boolean } = {},
) {
  const db = createDb(cfg.databaseUrl, opts.dbOptions);
  await migrate(db);
  if (cfg.bootstrapAdmin) await ensureAdmin(db, cfg.bootstrapAdmin.email, cfg.bootstrapAdmin.password);

  const pool = new UpstreamPool(db, cfg.encryptionKey, createGuardedFetch(cfg.upstreamAllowedHosts));
  const deps = { db, pool, key: cfg.encryptionKey, allowedHosts: cfg.upstreamAllowedHosts };
  if (cfg.seedServers) await seedServers(deps, cfg.seedServers);

  const broker = new Broker(db, pool);
  const mcp = createMcpEndpoint(db, broker);
  const model = opts.model ?? (cfg.llm ? openAiCompatibleModel(cfg.llm) : undefined);

  const app = new Hono();
  app.get('/healthz', (c) => c.text('ok'));
  // Ready = our own dependency (Postgres) works. Upstream health is deliberately NOT part of readiness:
  // a dead upstream must not take the whole gateway out of the Service.
  app.get('/readyz', async (c) => {
    try {
      await db.query('SELECT 1');
      return c.text('ok');
    } catch {
      return c.text('database unavailable', 503);
    }
  });
  app.all('/mcp', (c) => mcp.handle(c.req.raw));
  app.route(
    '/api',
    createApi({ ...deps, broker, model, mcpUrl: `${cfg.publicUrl}/mcp`, cookieSecure: cfg.cookieSecure }),
  );

  // Dashboard SPA (built by apps/dashboard) served from the same origin: no CORS, SameSite cookies work.
  if (cfg.dashboardDir) {
    const root = normalize(cfg.dashboardDir);
    app.get('*', async (c) => {
      const path = normalize(join(root, c.req.path));
      const file = path.startsWith(root) && /\.[a-z0-9]+$/.test(path) ? path : join(root, 'index.html');
      try {
        const data = await readFile(file);
        const ext = file.slice(file.lastIndexOf('.'));
        return c.body(data, 200, {
          'content-type': TYPES[ext] ?? 'application/octet-stream',
          'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
        });
      } catch {
        return c.notFound();
      }
    });
  }

  if (opts.startHealth !== false) pool.start(cfg.healthIntervalMs);

  return {
    app,
    db,
    pool,
    async close() {
      await pool.stop();
      await mcp.close();
      await db.end();
    },
  };
}
