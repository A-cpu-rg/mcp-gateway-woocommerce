import { hostname } from 'node:os';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createDb, migrate, waitForDb } from './db.ts';
import { helmCli, inClusterKube } from './kube.ts';
import { assertLeastPrivilege, Provisioner } from './provisioner.ts';
import { UpstreamPool } from './upstreams.ts';
import { createGuardedFetch } from './url-guard.ts';

// store-provisioner: the only component with Kubernetes credentials. It has no Ingress and no public API;
// it reads desired stores from Postgres and reconciles them (see provisioner.ts).

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const key = Buffer.from(env('ENCRYPTION_KEY'), 'base64');
if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded');
const allowedHosts = env('UPSTREAM_ALLOWED_HOSTS', '*.svc.cluster.local')
  .split(',')
  .map((s) => s.trim());
const db = createDb(env('DATABASE_URL'));
await waitForDb(db);
await migrate(db);

const kube = inClusterKube({
  tenantRole: env('STORE_TENANT_ROLE'),
  serviceAccount: { name: env('SERVICE_ACCOUNT_NAME'), namespace: env('GATEWAY_NAMESPACE') },
});
// Fail closed on stale or widened RBAC (e.g. the image upgraded without the chart): exit and say why.
try {
  await assertLeastPrivilege(kube, env('GATEWAY_NAMESPACE'));
} catch (err) {
  console.error(JSON.stringify({ msg: 'store-provisioner refusing to start', error: String(err) }));
  process.exit(1);
}

const pool = new UpstreamPool(db, key, createGuardedFetch(allowedHosts));
const provisioner = new Provisioner({
  db,
  kube,
  helm: helmCli({ chartDir: env('STORE_CHART_DIR'), valuesFile: env('STORE_VALUES_FILE') }),
  pool,
  key,
  allowedHosts,
  gatewayNamespace: env('GATEWAY_NAMESPACE'),
  id: env('POD_NAME', hostname()),
  concurrency: Number(env('PROVISION_CONCURRENCY', '3')),
  leaseMs: 90_000,
  backoffMs: 15_000,
});

let stopping = false;
const loop = async () => {
  if (stopping) return;
  try {
    await provisioner.tick();
  } catch (err) {
    console.error(JSON.stringify({ msg: 'provisioner tick failed', error: String(err) }));
  }
  setTimeout(loop, 5000);
};
void loop();

const app = new Hono();
app.get('/healthz', (c) => c.text('ok'));
app.get('/readyz', async (c) => {
  try {
    await db.query('SELECT 1');
    return c.text('ok');
  } catch {
    return c.text('database unavailable', 503);
  }
});
const server = serve({ fetch: app.fetch, port: Number(env('PORT', '8080')) });
console.log(JSON.stringify({ msg: 'store-provisioner started', id: env('POD_NAME', hostname()) }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    // Stop claiming. Work in progress is abandoned; its lease expires and the next provisioner resumes it.
    stopping = true;
    server.close();
    void pool.stop().finally(() => process.exit(0));
  });
}
