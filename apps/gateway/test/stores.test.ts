import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Principal } from '../src/auth.ts';
import { createDb, type Db, migrate } from '../src/db.ts';
import { assertStoreNamespace, type Helm, type Kube } from '../src/kube.ts';
import { Provisioner } from '../src/provisioner.ts';
import { deleteStore, requestStore, retryStore, type StoreSettings } from '../src/stores.ts';
import { UpstreamPool } from '../src/upstreams.ts';
import { DATABASE_URL, skip, startUpstream, type Upstream } from './helpers.ts';

// The provisioner's reconcile logic against real Postgres and a real MCP upstream. Kubernetes and Helm are
// in-memory fakes here; the real cluster run is documented in the README.

class FakeKube implements Kube {
  namespaces = new Map<string, { labels: Record<string, string>; terminating: boolean }>();
  secrets = new Map<string, Record<string, string>>();
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
  async getSecret(ns: string, name: string) {
    return this.secrets.get(`${ns}/${name}`) ?? null;
  }
  async createSecret(ns: string, name: string, data: Record<string, string>) {
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

  function provisioner(kube: Kube, helm: Helm, id = 'p1') {
    const pool = new UpstreamPool(db, key, fetch);
    pools.push(pool);
    return new Provisioner({
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
   * Provisioner passes until nothing is pending (the real loop runs every 5 s). Between passes, a gateway
   * replica health-checks registered servers: the provisioner itself is not allowed to call them.
   */
  async function run(p: Provisioner) {
    const gateway = new UpstreamPool(db, key, fetch);
    pools.push(gateway);
    for (let pass = 0; pass < 6; pass++) {
      await Promise.all(await p.tick());
      for (const row of await gateway.servers()) if (row.enabled) await gateway.check(row);
      const { rowCount } = await db.query(
        `UPDATE stores SET lease_until = NULL
         WHERE status IN ('provisioning', 'deleting') AND (lease_owner IS NULL OR lease_owner = $1)`,
        [p.id],
      );
      if (!rowCount) return;
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
    const srv = await server('store-acme');
    assert.equal(srv.status, 'connected');
    assert.equal(srv.auth_type, 'bearer');
    assert.ok(srv.credential_enc, 'MCP token is stored encrypted');
    assert.deepEqual(srv.admin_only_tools, ['create_product', 'update_order_status']);
    assert.equal(srv.store_id, acme.id, 'linked to its store: the owner may use the admin-only tools');
    // Several stores were provisioned in the same tick.
    assert.equal((await store('beta')).status, 'ready');
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
    await run(provisioner(kube, helm));
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
