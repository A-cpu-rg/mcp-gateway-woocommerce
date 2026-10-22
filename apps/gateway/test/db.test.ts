import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { after, describe, test } from 'node:test';
import { acceptInvite, createInvite, login } from '../src/auth.ts';
import { Broker } from '../src/broker.ts';
import { createDb, type Db, migrate, waitForDb } from '../src/db.ts';
import { createServer, seedServers } from '../src/servers.ts';
import { UpstreamPool } from '../src/upstreams.ts';
import { DATABASE_URL, skip, startUpstream } from './helpers.ts';

const key = randomBytes(32);

interface Replicas {
  /** One pool per simulated gateway replica, all on the same throwaway schema. */
  pools: Db[];
  /** application_name of every connection these pools open, so a test can target only its own. */
  tag: string;
  close: () => Promise<void>;
}

async function replicas(count: number): Promise<Replicas> {
  const tag = `t_${randomBytes(6).toString('hex')}`;
  const base = DATABASE_URL as string;
  const admin = createDb(base);
  await admin.query(`CREATE SCHEMA ${tag}`);
  const url = `${base}${base.includes('?') ? '&' : '?'}application_name=${tag}`;
  const pools = Array.from({ length: count }, () => createDb(url, `-c search_path=${tag}`));
  return {
    pools,
    tag,
    async close() {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP SCHEMA ${tag} CASCADE`);
      await admin.end();
    },
  };
}

const deps = (db: Db, k: Buffer = key) => ({
  db,
  pool: new UpstreamPool(db, k, fetch),
  key: k,
  allowedHosts: ['127.0.0.1'],
});

describe('database', { skip }, () => {
  const open: Replicas[] = [];
  const start = async (n: number) => {
    const r = await replicas(n);
    open.push(r);
    return r;
  };
  after(async () => {
    for (const r of open) await r.close();
  });

  test('migrations: replicas starting together apply each migration once; reruns keep data', async () => {
    const { pools } = await start(3);
    const [a, b, c] = pools as [Db, Db, Db];
    const applied = await Promise.all([migrate(a), migrate(b), migrate(c)]);
    assert.equal(applied.flat().length, 1, 'exactly one replica applied 001_init.sql');
    await a.query("INSERT INTO users (email, name, role) VALUES ('keep@example.com', 'Keep', 'member')");
    assert.deepEqual(await migrate(b), [], 'a second run is a no-op');
    const { rowCount } = await c.query("SELECT 1 FROM users WHERE email = 'keep@example.com'");
    assert.equal(rowCount, 1, 'existing data survives a rerun');
  });

  test('schema: secrets are stored hashed or encrypted, never as plaintext columns', async () => {
    const [db] = (await start(1)).pools as [Db];
    await migrate(db);
    const { rows } = await db.query<{ col: string }>(
      `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
       WHERE table_schema = current_schema()`,
    );
    const cols = new Set(rows.map((r) => r.col));
    for (const bad of ['api_keys.secret', 'api_keys.token', 'users.password', 'upstream_servers.credential'])
      assert.ok(!cols.has(bad), `${bad} must not exist`);
    for (const good of ['api_keys.secret_hash', 'users.password_hash', 'upstream_servers.credential_enc'])
      assert.ok(cols.has(good), `${good} must exist`);
  });

  test('startup: waitForDb succeeds when Postgres is up and fails with a clear error when it is not', async () => {
    const [db] = (await start(1)).pools as [Db];
    await waitForDb(db, 1, 1);
    const dead = createDb('postgres://nobody@127.0.0.1:1/none');
    await assert.rejects(waitForDb(dead, 2, 10), /database unavailable after 2 attempts/);
    await dead.end();
  });

  test('connection loss: terminated idle connections do not crash the process; the pool recovers', async () => {
    const { pools, tag } = await start(1);
    const [db] = pools as [Db];
    await migrate(db);
    assert.ok(db.listenerCount('error') > 0, 'pool has an error listener');
    await Promise.all([db.query('SELECT pg_sleep(0.2)'), db.query('SELECT pg_sleep(0.2)')]); // two idle connections
    // Same effect as Postgres restarting or failing over: the server drops the connections.
    await db.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()',
      [tag],
    );
    await new Promise((r) => setTimeout(r, 300)); // an unhandled 'error' event would fail the run here
    assert.equal((await db.query('SELECT 1 AS ok')).rows[0].ok, 1);
  });

  test('seeding: two replicas that both see "not registered yet" both start cleanly', async () => {
    const { pools } = await start(2);
    const [a, b] = pools as [Db, Db];
    await migrate(a);
    // Hold each replica's "does this slug exist?" answer until both have asked, so both then insert.
    let arrived = 0;
    let release: () => void = () => {};
    const bothArrived = new Promise<void>((r) => {
      release = r;
    });
    const withBarrier = (db: Db): Db =>
      new Proxy(db, {
        get(target, prop) {
          if (prop !== 'query') return Reflect.get(target, prop, target);
          return async (...args: unknown[]) => {
            const result = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
            if (String(args[0]).startsWith('SELECT 1 FROM upstream_servers WHERE slug')) {
              if (++arrived === 2) release();
              await bothArrived;
            }
            return result;
          };
        },
      });
    const upstream = await startUpstream(() => {});
    const seed = JSON.stringify([{ slug: 'shop', name: 'Shop', url: upstream.url }]);
    const results = await Promise.allSettled([
      seedServers(deps(withBarrier(a)), seed),
      seedServers(deps(withBarrier(b)), seed),
    ]);
    await upstream.close();
    assert.deepEqual(
      results.map((r) => r.status),
      ['fulfilled', 'fulfilled'],
    );
    assert.equal((await a.query("SELECT 1 FROM upstream_servers WHERE slug = 'shop'")).rowCount, 1);
  });

  test('invites: single use, one winner under concurrency, a wrong token changes nothing', async () => {
    const [db] = (await start(1)).pools as [Db];
    await migrate(db);
    const { token } = await createInvite(db, 'new@example.com', 'New', 'member');
    assert.equal(await acceptInvite(db, 'not-a-real-token', 'a-long-enough-password'), false);
    assert.equal(await login(db, 'new@example.com', 'a-long-enough-password'), null);
    const results = await Promise.all([
      acceptInvite(db, token, 'first-password-123'),
      acceptInvite(db, token, 'second-password-456'),
    ]);
    assert.equal(results.filter(Boolean).length, 1, 'exactly one accept wins');
    const winner = results[0] ? 'first-password-123' : 'second-password-456';
    assert.ok(await login(db, 'new@example.com', winner), 'the winning password works');
  });

  test('credentials: a different ENCRYPTION_KEY gives an actionable error, not a crypto stack message', async () => {
    const [db] = (await start(1)).pools as [Db];
    await migrate(db);
    const upstream = await startUpstream(() => {}, { header: 'x-api-key', value: 'secret' });
    await createServer(deps(db), {
      slug: 'locked',
      name: 'Locked',
      url: upstream.url,
      enabled: true,
      authType: 'header',
      authHeader: 'x-api-key',
      credential: 'secret',
      timeoutMs: 5000,
      adminOnlyTools: [],
    });
    const other = deps(db, randomBytes(32));
    const [row] = await other.pool.servers();
    await other.pool.check(row as NonNullable<typeof row>);
    const after = (await other.pool.servers())[0];
    await upstream.close();
    assert.equal(after?.status, 'unreachable');
    assert.match(after?.last_error ?? '', /ENCRYPTION_KEY differs/);
  });

  test('replicas: once one replica sees an upstream die, the other stops listing its cached tools', async () => {
    const { pools } = await start(2);
    const [a, b] = pools as [Db, Db];
    await migrate(a);
    const upstream = await startUpstream((s) =>
      s.registerTool('ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] })),
    );
    const [replicaA, replicaB] = [deps(a), deps(b)];
    await createServer(replicaA, { ...serverDefaults, slug: 'flaky', name: 'Flaky', url: upstream.url });
    const row = async () =>
      (await replicaB.pool.servers())[0] as NonNullable<Awaited<ReturnType<typeof replicaB.pool.servers>>[0]>;
    await replicaB.pool.check(await row());
    assert.equal(replicaB.pool.tools(await row()).length, 1, 'replica B has the tool cached');

    await upstream.close(); // the pod dies
    await replicaA.pool.check(await row()); // only replica A notices (its health check ran first)
    assert.deepEqual(replicaB.pool.tools(await row()), [], 'replica B no longer lists the dead server');
    await Promise.all([replicaA.pool.stop(), replicaB.pool.stop()]);
  });

  test('replicas: a server added through one replica is listed by the other at once; a slow one cannot stall it', async (t) => {
    const { pools } = await start(2);
    const [a, b] = pools as [Db, Db];
    await migrate(a);
    const fast = await startUpstream((s) =>
      s.registerTool('ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] })),
    );
    const replicaA = deps(a);
    const replicaB = deps(b);
    const listB = new Broker(b, replicaB.pool);
    const sockets = new Set<import('node:net').Socket>();
    const silent = createNetServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
    });
    // Cleanup runs even if an assertion fails, so a regression fails fast instead of hanging the suite.
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      silent.close();
      await fast.close();
      await Promise.all([replicaA.pool.stop(), replicaB.pool.stop()]);
    });
    const member = {
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'm@example.com',
      role: 'member' as const,
    };

    await createServer(replicaA, { ...serverDefaults, slug: 'fresh', name: 'Fresh', url: fast.url });
    const names = (await listB.listTools(member)).map((t) => t.exposedName);
    assert.ok(
      names.includes('fresh__ping'),
      'replica B lists the new server without waiting for its health check',
    );

    // A server registered (connected) through A that then hangs: it accepts connections and never answers.
    const real = await startUpstream((s) =>
      s.registerTool('later', {}, async () => ({ content: [{ type: 'text', text: 'x' }] })),
    );
    await createServer(replicaA, { ...serverDefaults, slug: 'slow', name: 'Slow', url: real.url });
    await real.close();
    const port = Number(new URL(real.url).port);
    await new Promise<void>((resolve) => silent.listen(port, '127.0.0.1', resolve));
    const t0 = performance.now();
    const again = (await listB.listTools(member)).map((t) => t.exposedName);
    const ms = performance.now() - t0;
    assert.ok(again.includes('fresh__ping'), 'other servers are still listed');
    assert.ok(ms < 2500, `listing took ${Math.round(ms)} ms`);
  });
});

const serverDefaults = {
  enabled: true,
  authType: 'none' as const,
  timeoutMs: 2000,
  adminOnlyTools: [],
};
