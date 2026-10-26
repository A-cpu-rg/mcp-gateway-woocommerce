import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Principal } from '../src/auth.ts';
import { createDb, type Db, migrate } from '../src/db.ts';
import { assertStoreNamespace, type Helm, type Kube, kubeClient } from '../src/kube.ts';
import { Provisioner } from '../src/provisioner.ts';
import { assertNotStoreServer, serverInput, updateServer } from '../src/servers.ts';
import { deleteStore, listStores, requestStore, retryStore, type StoreSettings } from '../src/stores.ts';
import { UpstreamPool } from '../src/upstreams.ts';
import { DATABASE_URL, fakeApi, skip, startUpstream, type Upstream } from './helpers.ts';

// The provisioner's reconcile logic against real Postgres and a real MCP upstream. Kubernetes and Helm are
// in-memory fakes here; the real cluster run is documented in the README.

class FakeKube implements Kube {
  namespaces = new Map<string, { labels: Record<string, string>; terminating: boolean }>();
  secrets = new Map<string, Record<string, string>>();
  /** Namespaces the provisioner bound itself into, and every step in order (to check what came first). */
  access = new Set<string>();
  log: string[] = [];
  async ensureAccess(ns: string) {
    this.access.add(ns);
    this.log.push(`access ${ns}`);
  }
  async getNamespace(name: string) {
    return this.namespaces.get(name) ?? null;
  }
  async createNamespace(name: string, labels: Record<string, string>) {
    if (!this.namespaces.has(name)) this.namespaces.set(name, { labels, terminating: false });
  }
  async deleteNamespace(name: string) {
    this.namespaces.delete(name);
    for (const k of this.secrets.keys()) if (k.startsWith(`${name}/`)) this.secrets.delete(k);
  }
  async readMcpToken(ns: string) {
    return this.secrets.get(`${ns}/woocommerce-mcp-auth`)?.MCP_AUTH_TOKEN ?? null;
  }
  async allowed() {
    return false;
  }
  async createSecret(ns: string, name: string, data: Record<string, string>) {
    this.log.push(`secret ${ns}/${name}`);
    if (!this.secrets.has(`${ns}/${name}`)) this.secrets.set(`${ns}/${name}`, data);
  }
}

class FakeHelm implements Helm {
  releases = new Map<string, string>();
  calls: string[] = [];
  failWith?: string;
  async status(ns: string) {
    return this.releases.get(ns) ?? null;
  }
  async upgradeInstall(ns: string, set: Record<string, string>) {
    this.calls.push(`install ${ns} host=${set.host}`);
    if (this.failWith) throw new Error(this.failWith);
    this.releases.set(ns, 'deployed');
  }
  async uninstall(ns: string) {
    this.calls.push(`uninstall ${ns}`);
    this.releases.delete(ns);
  }
}

const settings: StoreSettings = {
  hostTemplate: '{slug}.store.localtest.me',
  urlScheme: 'http',
  maxPerUser: 2,
  timeoutMs: 60_000,
};

describe('stores', { skip }, () => {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  let admin: Db;
  let db: Db;
  let upstream: Upstream;
  let alice: Principal;
  let bob: Principal;
  const root: Principal = { userId: '', email: 'root@example.com', role: 'admin' };
  const key = randomBytes(32);
  const pools: UpstreamPool[] = [];

  function provisioner(kube: Kube, helm: Helm, id = 'p1', connectWaitMs = 2_000) {
    const pool = new UpstreamPool(db, key, fetch);
    pools.push(pool);
    return new Provisioner({
      connectWaitMs,
      pollMs: 20,
      db,
      kube,
      helm,
      pool,
      key,
      allowedHosts: ['127.0.0.1'],
      gatewayNamespace: 'platform',
      id,
      concurrency: 3,
      leaseMs: 30_000,
      backoffMs: 1,
      storeMcpUrl: () => upstream.url,
    });
  }
  /**
   * Provisioner passes until nothing is pending (the real loop runs every 5 s). Meanwhile a gateway replica
   * health-checks registered servers, as every replica does every 10 s: the provisioner itself is not allowed
   * to call them. `between: true` checks only between passes, so a pass can run out of time waiting.
   */
  async function run(p: Provisioner, opts: { between?: boolean } = {}) {
    const gateway = new UpstreamPool(db, key, fetch);
    pools.push(gateway);
    const checkAll = async () => {
      for (const row of await gateway.servers()) if (row.enabled) await gateway.check(row);
    };
    let checking = !opts.between;
    const checker = (async () => {
      while (checking) {
        await checkAll();
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    try {
      for (let pass = 0; pass < 6; pass++) {
        await Promise.all(await p.tick());
        if (opts.between) await checkAll();
        const { rowCount } = await db.query(
          `UPDATE stores SET lease_until = NULL
           WHERE status IN ('provisioning', 'deleting') AND (lease_owner IS NULL OR lease_owner = $1)`,
          [p.id],
        );
        if (!rowCount) return;
      }
    } finally {
      checking = false;
      await checker;
    }
  }
  const store = async (slug: string) =>
    (await db.query('SELECT * FROM stores WHERE slug = $1', [slug])).rows[0];
  const server = async (slug: string) =>
    (await db.query('SELECT * FROM upstream_servers WHERE slug = $1', [slug])).rows[0];

  before(async () => {
    admin = createDb(DATABASE_URL as string);
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = createDb(DATABASE_URL as string, `-c search_path=${schema}`);
    await migrate(db);
    const user = async (email: string, role: 'admin' | 'member'): Promise<Principal> => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO users (email, name, role) VALUES ($1, $1, $2) RETURNING id`,
        [email, role],
      );
      return { userId: rows[0]?.id as string, email, role };
    };
    alice = await user('alice@example.com', 'member');
    bob = await user('bob@example.com', 'member');
    root.userId = (await user('root@example.com', 'admin')).userId;
    upstream = await startUpstream((s) =>
      s.registerTool('list_orders', {}, async () => ({ content: [{ type: 'text', text: '[]' }] })),
    );
  });
  after(async () => {
    for (const p of pools) await p.stop();
    await upstream.close();
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  test('create is safe to retry, slugs are unique per platform, and the per-user limit holds', async () => {
    const first = await requestStore(db, settings, alice, { name: 'Acme', slug: 'acme' });
    const again = await requestStore(db, settings, alice, { name: 'Acme', slug: 'acme' });
    assert.equal(first.created, true);
    assert.equal(again.created, false, 'repeating the request returns the same store');
    assert.equal(again.store.id, first.store.id);
    assert.equal(first.store.status, 'provisioning');
    assert.equal(first.store.url, 'http://acme.store.localtest.me');
    await assert.rejects(requestStore(db, settings, bob, { name: 'Mine', slug: 'acme' }), /already exists/);

    await requestStore(db, settings, alice, { name: 'Beta', slug: 'beta' });
    await assert.rejects(
      requestStore(db, settings, alice, { name: 'Gamma', slug: 'gamma' }),
      /store limit reached \(2 per user\)/,
    );
    // Concurrent creates by one user cannot both pass the limit.
    const results = await Promise.allSettled([
      requestStore(db, settings, bob, { name: 'B1', slug: 'bob-one' }),
      requestStore(db, settings, bob, { name: 'B2', slug: 'bob-two' }),
      requestStore(db, settings, bob, { name: 'B3', slug: 'bob-three' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  });

  test('provisioning: namespace with labels, Secrets, Helm release, gateway registration, then ready', async () => {
    const kube = new FakeKube();
    const helm = new FakeHelm();
    await run(provisioner(kube, helm));
    const acme = await store('acme');
    assert.equal(acme.status, 'ready', acme.status_reason);
    const ns = kube.namespaces.get('store-acme');
    assert.equal(ns?.labels['urumi.io/store'], 'true');
    assert.equal(ns?.labels['urumi.io/store-id'], acme.id);
    for (const s of ['store-db', 'store-wp-admin', 'store-wc-api', 'woocommerce-mcp-auth'])
      assert.ok(kube.secrets.has(`store-acme/${s}`), s);
    assert.ok(helm.calls.includes('install store-acme host=acme.store.localtest.me'));
    assert.equal(helm.calls.filter((c) => c.startsWith('install store-acme')).length, 1, 'installed once');
    // The provisioner has no rights in a namespace until it binds itself there, so that comes first.
    assert.ok(kube.access.has('store-acme'));
    assert.ok(kube.log.indexOf('access store-acme') < kube.log.indexOf('secret store-acme/store-db'));
    const srv = await server('store-acme');
    assert.equal(srv.status, 'connected');
    assert.equal(srv.auth_type, 'bearer');
    assert.ok(srv.credential_enc, 'MCP token is stored encrypted');
    assert.deepEqual(srv.admin_only_tools, ['create_product', 'update_order_status']);
    assert.equal(srv.store_id, acme.id, 'linked to its store: the owner may use the admin-only tools');
    // Several stores were provisioned in the same tick.
    assert.equal((await store('beta')).status, 'ready');
  });

  test('a pass that runs out of time waiting for the gateway resumes without installing again', async () => {
    await requestStore(db, settings, root, { name: 'Slow', slug: 'slow' });
    const helm = new FakeHelm();
    // Nothing health-checks during a pass and each pass waits only 30 ms, so the first pass gives up waiting.
    await run(provisioner(new FakeKube(), helm, 'p1', 30), { between: true });
    assert.equal((await store('slow')).status, 'ready');
    assert.deepEqual(
      helm.calls.filter((c) => c.includes('store-slow')),
      ['install store-slow host=slow.store.localtest.me'],
      'one Helm revision, not one per wait',
    );
  });

  test('a restart mid-provisioning resumes: expired lease is taken over, a locked Helm release is cleared', async () => {
    await db.query('DELETE FROM stores WHERE owner_id = $1', [bob.userId]);
    await requestStore(db, settings, bob, { name: 'Crash', slug: 'crash' });
    const kube = new FakeKube();
    const helm = new FakeHelm();
    // State left behind by a provisioner that died during "helm upgrade".
    await db.query(
      `UPDATE stores SET lease_owner = 'dead-pod', lease_until = now() - interval '1 second',
         status_reason = 'Installing WordPress, MariaDB and WooCommerce (Helm)' WHERE slug = 'crash'`,
    );
    helm.releases.set('store-crash', 'pending-install');
    await run(provisioner(kube, helm, 'new-pod'));
    assert.equal((await store('crash')).status, 'ready');
    assert.deepEqual(helm.calls.slice(0, 2), [
      'uninstall store-crash',
      'install store-crash host=crash.store.localtest.me',
    ]);

    // A store whose lease is still valid is not touched by another provisioner.
    await requestStore(db, settings, bob, { name: 'Busy', slug: 'busy' });
    await db.query(
      "UPDATE stores SET lease_owner = 'other', lease_until = now() + interval '1 minute' WHERE slug = 'busy'",
    );
    await run(provisioner(new FakeKube(), new FakeHelm(), 'third'));
    assert.equal((await store('busy')).status, 'provisioning');
    await db.query("UPDATE stores SET lease_until = NULL WHERE slug = 'busy'");
  });

  test('a store that cannot be provisioned in time fails with a clear reason, and can be retried', async () => {
    await db.query("DELETE FROM stores WHERE slug = 'busy'");
    await requestStore(db, settings, bob, { name: 'Broken', slug: 'broken' });
    const helm = new FakeHelm();
    helm.failWith = 'helm upgrade: Job store-setup failed: BackoffLimitExceeded';
    const kube = new FakeKube();
    await run(provisioner(kube, helm));
    let broken = await store('broken');
    assert.equal(broken.status, 'provisioning', 'transient errors are retried until the deadline');
    assert.match(broken.status_reason, /Retrying .*BackoffLimitExceeded/);

    await db.query(
      "UPDATE stores SET deadline_at = now() - interval '1 second', lease_until = NULL WHERE slug = 'broken'",
    );
    await run(provisioner(kube, helm));
    broken = await store('broken');
    assert.equal(broken.status, 'failed');
    assert.match(broken.status_reason, /Timed out|deadline/);

    await assert.rejects(retryStore(db, settings, alice, broken.id), /not your store/);
    const retried = await retryStore(db, settings, bob, broken.id);
    assert.equal(retried.status, 'provisioning');
    helm.failWith = undefined;
    await run(provisioner(kube, helm));
    assert.equal((await store('broken')).status, 'ready');
  });

  test('a namespace that belongs to something else is never adopted', async () => {
    await db.query("DELETE FROM stores WHERE slug IN ('broken')");
    await requestStore(db, settings, bob, { name: 'Taken', slug: 'taken' });
    const kube = new FakeKube();
    kube.namespaces.set('store-taken', { labels: { team: 'other' }, terminating: false });
    await run(provisioner(kube, new FakeHelm()));
    const taken = await store('taken');
    assert.equal(taken.status, 'failed');
    assert.match(taken.status_reason, /does not belong to this store/);
  });

  test('a gateway server with the store name that is not linked to the store is never adopted', async () => {
    await db.query("DELETE FROM stores WHERE slug = 'taken'");
    await requestStore(db, settings, bob, { name: 'Squat', slug: 'squat' });
    // Registered by someone else after the store was requested, so it would grant bob nothing.
    await db.query(
      "INSERT INTO upstream_servers (slug, name, url) VALUES ('store-squat', 'Other', 'http://127.0.0.1:1/mcp')",
    );
    await run(provisioner(new FakeKube(), new FakeHelm()));
    const squat = await store('squat');
    assert.equal(squat.status, 'failed');
    assert.match(squat.status_reason, /store-squat already exists and does not belong to this store/);
    assert.equal((await server('store-squat')).store_id, null, 'the foreign server is left untouched');
    await db.query("DELETE FROM upstream_servers WHERE slug = 'store-squat'");
    await db.query("DELETE FROM stores WHERE slug = 'squat'");
  });

  test('store URLs use the configured scheme (https when the store chart terminates TLS)', async () => {
    const https = { ...settings, urlScheme: 'https' as const };
    const listed = (await listStores(db, https, root)).find((s) => s.slug === 'slow');
    assert.equal(listed?.url, 'https://slow.store.localtest.me');
    assert.equal(
      (await listStores(db, settings, root)).find((s) => s.slug === 'slow')?.url,
      'http://slow.store.localtest.me',
    );
  });

  test("a store's registration follows the store: no rename or removal through the API, teardown by link", async () => {
    const srv = await server('store-slow');
    const slow = await store('slow');
    const deps = { db, pool: new UpstreamPool(db, key, fetch), key, allowedHosts: ['127.0.0.1'] };
    pools.push(deps.pool);
    const edit = (slug: string) =>
      serverInput.parse({
        slug,
        name: srv.name,
        url: srv.url,
        authType: 'bearer',
        adminOnlyTools: srv.admin_only_tools,
      });
    await assert.rejects(
      updateServer(deps, srv.id, edit('renamed')),
      /belongs to store "slow": its name follows/,
    );
    await assert.rejects(assertNotStoreServer(db, srv.id, 'removed'), /delete the store to remove it/);
    // Everything except the name stays editable.
    assert.equal(
      (await updateServer(deps, srv.id, { ...edit('store-slow'), timeoutMs: 5000 }))?.timeout_ms,
      5000,
    );

    // Even a registration renamed directly in the database is found by its store link: disabled at once on
    // delete, removed by teardown, never left behind enabled (it would keep the store's tools visible).
    await db.query("UPDATE upstream_servers SET slug = 'renamed-by-hand' WHERE id = $1", [srv.id]);
    await deleteStore(db, root, slow.id);
    assert.equal((await server('renamed-by-hand')).enabled, false, 'disabled by store link, not slug');
    await run(provisioner(new FakeKube(), new FakeHelm()));
    assert.equal(await store('slow'), undefined);
    assert.equal(await server('renamed-by-hand'), undefined, 'teardown removed the linked registration');
  });

  test('a store deleted while Helm runs is never registered, and is torn down', async () => {
    await requestStore(db, settings, root, { name: 'Mid', slug: 'mid' });
    const mid = await store('mid');
    // The owner deletes the store while `helm upgrade` is still running.
    class DeletedDuringHelm extends FakeHelm {
      async upgradeInstall(ns: string, set: Record<string, string>) {
        await super.upgradeInstall(ns, set);
        await deleteStore(db, root, mid.id);
      }
    }
    const p = provisioner(new FakeKube(), new DeletedDuringHelm());
    await Promise.all(await p.tick());
    assert.equal(await server('store-mid'), undefined, 'a deleting store gets no registration (no tools)');
    assert.equal(
      (await store('mid')).lease_until,
      null,
      'lease released so teardown starts on the next pass',
    );
    await run(p);
    assert.equal(await store('mid'), undefined);
  });

  test('through the real Kubernetes client: no Secret is listed, changed, or read except the MCP token', async () => {
    const api = fakeApi();
    const kube = kubeClient(api.call, {
      tenantRole: 'platform-store-tenant',
      serviceAccount: { name: 'store-provisioner', namespace: 'platform' },
    });
    await requestStore(db, settings, root, { name: 'Recorded', slug: 'recorded' });
    await run(provisioner(kube, new FakeHelm()));
    const rec = await store('recorded');
    assert.equal(rec.status, 'ready', rec.status_reason);
    await deleteStore(db, root, rec.id);
    await run(provisioner(kube, new FakeHelm()));
    assert.equal(await store('recorded'), undefined, 'torn down');
    assert.ok(api.requests.includes('DELETE /api/v1/namespaces/store-recorded'));

    const secrets = [...new Set(api.requests.filter((r) => r.includes('/secrets')))];
    assert.deepEqual(
      secrets.filter((r) => !r.startsWith('POST ')),
      ['GET /api/v1/namespaces/store-recorded/secrets/woocommerce-mcp-auth'],
      'store-db, store-wp-admin and store-wc-api are created, never read back',
    );
    assert.equal(secrets.filter((r) => r.startsWith('POST ')).length, 1, 'created through one collection');
  });

  test('delete: tools disappear at once; then registration, release and namespace are removed', async () => {
    const kube = new FakeKube();
    const helm = new FakeHelm();
    await db.query("DELETE FROM stores WHERE slug = 'taken'");
    // Re-provision acme into this fake cluster so there is something to tear down.
    await db.query("UPDATE stores SET status = 'provisioning', lease_until = NULL WHERE slug = 'acme'");
    await run(provisioner(kube, helm));
    const acme = await store('acme');
    assert.equal(acme.status, 'ready');

    await assert.rejects(deleteStore(db, bob, acme.id), /not your store/);
    await deleteStore(db, alice, acme.id);
    assert.equal((await server('store-acme')).enabled, false, 'tools are hidden before teardown starts');
    kube.access.clear();
    await run(provisioner(kube, helm));
    assert.ok(kube.access.has('store-acme'), 'teardown binds access first (stores from before RoleBindings)');
    assert.equal(await server('store-acme'), undefined, 'registration removed');
    assert.ok(helm.calls.includes('uninstall store-acme'));
    assert.equal(kube.namespaces.has('store-acme'), false, 'namespace (volumes, Secrets) removed');
    assert.equal(await store('acme'), undefined);

    // Admins may delete anyone's store.
    const beta = await store('beta');
    await deleteStore(db, root, beta.id);
    assert.equal((await store('beta')).status, 'deleting');
  });

  test('the provisioner refuses to touch namespaces outside store-*', () => {
    for (const ns of ['kube-system', 'platform', 'store', 'store-', 'store-UPPER'])
      assert.throws(() => assertStoreNamespace(ns), /refusing/);
    assert.doesNotThrow(() => assertStoreNamespace('store-acme'));
  });
});
