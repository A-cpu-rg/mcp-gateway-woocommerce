import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import * as z from 'zod/v4';
import { acceptInvite, createApiKey, createInvite, type Principal } from '../src/auth.ts';
import { Broker } from '../src/broker.ts';
import { createDb, type Db, migrate } from '../src/db.ts';
import { createServer, serverInput } from '../src/servers.ts';
import { requestStore } from '../src/stores.ts';
import { UpstreamPool } from '../src/upstreams.ts';
import { ADMIN, DATABASE_URL, skip, startGateway, startUpstream, textOf, type Upstream } from './helpers.ts';

// Multi-store owners and admin-only tools, end to end through the real gateway (MCP endpoint, broker,
// dashboard API) with real Postgres and real MCP upstreams standing in for each store's WooCommerce server.

const WRITE_TOOLS = ['create_product', 'update_order_status'];

describe('store owner permissions', { skip }, () => {
  let gw: Awaited<ReturnType<typeof startGateway>>;
  const ups: Upstream[] = [];
  /** Write calls that reached each upstream: proves a denied call never touches the store. */
  const writes: Record<string, string[]> = {};
  const users: Record<string, Principal & { key: string; password: string }> = {};
  const storeIds: Record<string, string> = {};

  async function wooUpstream(name: string) {
    writes[name] = [];
    const up = await startUpstream((s) => {
      s.registerTool(
        'list_products',
        { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: 'text', text: `${name}: []` }] }),
      );
      for (const tool of WRITE_TOOLS) {
        s.registerTool(tool, { inputSchema: z.object({}).passthrough() }, async () => {
          writes[name]?.push(tool);
          return { content: [{ type: 'text', text: `${name}: ${tool} ok` }] };
        });
      }
    });
    ups.push(up);
    return up;
  }

  async function addUser(email: string, role: 'admin' | 'member') {
    const password = `${email}-password`;
    const { userId, token } = await createInvite(gw.db, email, email, role);
    await acceptInvite(gw.db, token, password);
    const key = (await createApiKey(gw.db, userId, 'test')).token;
    users[email] = { userId, email, role, key, password };
  }

  async function register(slug: string, url: string, storeId?: string) {
    const input = serverInput.parse({ slug, name: slug, url, adminOnlyTools: WRITE_TOOLS });
    const deps = { db: gw.db, pool: gw.pool, key: randomBytes(32), allowedHosts: ['127.0.0.1'] };
    await createServer(deps, input, { storeId });
  }

  /** Tool names a user sees over MCP. */
  async function listed(email: string): Promise<string[]> {
    const client = await gw.mcpClient(users[email]?.key as string);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    return names;
  }

  async function call(email: string, name: string, args: Record<string, unknown> = {}) {
    const client = await gw.mcpClient(users[email]?.key as string);
    const res = await client.callTool({ name, arguments: args });
    await client.close();
    return res;
  }

  const lastAudit = async (email: string, tool: string) =>
    (
      await gw.db.query<{ outcome: string; server_slug: string; error: string | null }>(
        'SELECT outcome, server_slug, error FROM audit_log WHERE user_email = $1 AND tool = $2 ORDER BY id DESC LIMIT 1',
        [email, tool],
      )
    ).rows[0];

  before(async () => {
    gw = await startGateway();
    const adminId = (await gw.db.query('SELECT id FROM users WHERE email = $1', [ADMIN.email])).rows[0].id;
    const adminKey = (await createApiKey(gw.db, adminId, 'admin')).token;
    users[ADMIN.email] = { userId: adminId, email: ADMIN.email, role: 'admin', key: adminKey, password: '' };
    await addUser('alice@example.com', 'member'); // owns store "alice-shop"
    await addUser('bob@example.com', 'member'); // owns store "bob-shop"
    await addUser('carol@example.com', 'member'); // owns no store

    const settings = {
      hostTemplate: '{slug}.store.test',
      urlScheme: 'http' as const,
      maxPerUser: 2,
      timeoutMs: 60_000,
    };
    for (const [owner, slug] of [
      ['alice@example.com', 'alice-shop'],
      ['bob@example.com', 'bob-shop'],
    ] as const) {
      const { store } = await requestStore(gw.db, settings, users[owner] as Principal, { name: slug, slug });
      await gw.db.query("UPDATE stores SET status = 'ready' WHERE id = $1", [store.id]);
      storeIds[slug] = store.id;
      // Registered the way the store-provisioner registers a store's MCP server.
      await register(`store-${slug}`, (await wooUpstream(slug)).url, store.id);
    }
    // The original single store, registered by an admin: belongs to no provisioned store.
    await register('woocommerce', (await wooUpstream('woocommerce')).url);
    for (const row of await gw.pool.servers()) await gw.pool.check(row);
  });

  after(async () => {
    await gw.close();
    for (const u of ups) await u.close();
  });

  test('platform admin lists and calls every admin-only tool on every server', async () => {
    const names = await listed(ADMIN.email);
    for (const server of ['store-alice-shop', 'store-bob-shop', 'woocommerce'])
      for (const tool of WRITE_TOOLS) assert.ok(names.includes(`${server}__${tool}`), `${server}__${tool}`);
    const res = await call(ADMIN.email, 'store-alice-shop__create_product', { name: 'admin' });
    assert.equal(res.isError, undefined, textOf(res));
    assert.deepEqual(writes['alice-shop'], ['create_product']);
    assert.equal((await lastAudit(ADMIN.email, 'create_product'))?.outcome, 'ok');
    writes['alice-shop'] = [];
  });

  test('store owner sees and calls create_product and update_order_status for their own store', async () => {
    const names = await listed('alice@example.com');
    assert.ok(names.includes('store-alice-shop__create_product'));
    assert.ok(names.includes('store-alice-shop__update_order_status'));
    for (const tool of WRITE_TOOLS) {
      const res = await call('alice@example.com', `store-alice-shop__${tool}`);
      assert.equal(res.isError, undefined, textOf(res));
      assert.equal(textOf(res), `alice-shop: ${tool} ok`);
      const audit = await lastAudit('alice@example.com', tool);
      assert.equal(audit?.outcome, 'ok');
      assert.equal(audit?.server_slug, 'store-alice-shop');
    }
    assert.deepEqual(writes['alice-shop'], WRITE_TOOLS);
    writes['alice-shop'] = [];
  });

  test("another member neither sees nor can call the owner's admin-only tools; denial is audited", async () => {
    for (const email of ['bob@example.com', 'carol@example.com']) {
      const names = await listed(email);
      for (const tool of WRITE_TOOLS) {
        assert.ok(!names.includes(`store-alice-shop__${tool}`), `${email} must not see ${tool}`);
        // Knowing the name, and naming the store in the arguments, changes nothing.
        const res = await call(email, `store-alice-shop__${tool}`, {
          store: 'alice-shop',
          storeId: storeIds['alice-shop'],
        });
        assert.equal(res.isError, true);
        assert.match(textOf(res), /requires the admin role or ownership of this store/);
        const audit = await lastAudit(email, tool);
        assert.equal(audit?.outcome, 'denied');
        assert.equal(audit?.server_slug, 'store-alice-shop');
      }
    }
    assert.deepEqual(writes['alice-shop'], [], 'no denied call reached the store');
  });

  test("a store owner cannot use admin-only tools on another owner's store", async () => {
    const names = await listed('alice@example.com');
    for (const tool of WRITE_TOOLS) {
      assert.ok(!names.includes(`store-bob-shop__${tool}`));
      const res = await call('alice@example.com', `store-bob-shop__${tool}`);
      assert.equal(res.isError, true);
      assert.equal((await lastAudit('alice@example.com', tool))?.outcome, 'denied');
    }
    assert.deepEqual(writes['bob-shop'], []);
  });

  test('a member who owns no store keeps the previous restrictions; read-only tools stay available', async () => {
    const names = await listed('carol@example.com');
    assert.deepEqual(
      names.filter((n) => WRITE_TOOLS.some((t) => n.endsWith(`__${t}`))),
      [],
    );
    for (const server of ['store-alice-shop', 'store-bob-shop', 'woocommerce']) {
      assert.ok(names.includes(`${server}__list_products`), server);
      const res = await call('carol@example.com', `${server}__list_products`);
      assert.equal(res.isError, undefined, textOf(res));
    }
  });

  test('the original single-store server is unchanged: admin-only even for store owners', async () => {
    for (const email of ['alice@example.com', 'bob@example.com']) {
      const names = await listed(email);
      assert.ok(names.includes('woocommerce__list_products'));
      for (const tool of WRITE_TOOLS) {
        assert.ok(!names.includes(`woocommerce__${tool}`));
        const res = await call(email, `woocommerce__${tool}`);
        assert.equal(res.isError, true);
        assert.match(textOf(res), /^Tool 'woocommerce__\w+' requires the admin role\.$/);
      }
    }
    assert.deepEqual(writes.woocommerce, []);
  });

  test('visibility and direct-call authorization agree for every user, tool and server', async () => {
    const all = (await listed(ADMIN.email)).filter((n) => WRITE_TOOLS.some((t) => n.endsWith(`__${t}`)));
    assert.equal(all.length, 6);
    for (const email of ['alice@example.com', 'bob@example.com', 'carol@example.com']) {
      const visible = new Set(await listed(email));
      // The dashboard's server list applies the same policy.
      const cookie = await gw.loginAs(email, users[email]?.password as string);
      const dashboard = new Set(
        ((await gw.request('/api/servers', { cookie })).json as { tools: { exposedName: string }[] }[])
          .flatMap((s) => s.tools)
          .map((t) => t.exposedName),
      );
      for (const name of all) {
        const res = await call(email, name);
        assert.equal(res.isError !== true, visible.has(name), `${email} ${name}: listed iff callable`);
        assert.equal(dashboard.has(name), visible.has(name), `${email} ${name}: dashboard agrees`);
      }
    }
    for (const k of Object.keys(writes)) writes[k] = [];
  });

  test('ownership is read from the store record on every call: a transfer applies at once', async () => {
    await gw.db.query('UPDATE stores SET owner_id = $1 WHERE id = $2', [
      users['bob@example.com']?.userId,
      storeIds['alice-shop'],
    ]);
    assert.equal((await call('alice@example.com', 'store-alice-shop__create_product')).isError, true);
    assert.equal((await call('bob@example.com', 'store-alice-shop__create_product')).isError, undefined);
    assert.ok((await listed('bob@example.com')).includes('store-alice-shop__create_product'));
    await gw.db.query('UPDATE stores SET owner_id = $1 WHERE id = $2', [
      users['alice@example.com']?.userId,
      storeIds['alice-shop'],
    ]);
    writes['alice-shop'] = [];
  });

  test('a server named like a store, but not linked to it, grants its owner nothing', async () => {
    // Store "ghost" is carol's; "store-ghost" was registered by an admin and is not linked to it.
    await gw.db.query(
      `INSERT INTO stores (slug, name, owner_id, namespace, host, status, deadline_at)
       VALUES ('ghost', 'Ghost', $1, 'store-ghost', 'ghost.store.test', 'ready', now())`,
      [users['carol@example.com']?.userId],
    );
    await register('store-ghost', (await wooUpstream('ghost')).url);
    await gw.pool.check((await gw.pool.serverBySlug('store-ghost')) as never);
    const names = await listed('carol@example.com');
    assert.ok(names.includes('store-ghost__list_products'));
    assert.ok(!names.includes('store-ghost__create_product'));
    assert.equal((await call('carol@example.com', 'store-ghost__create_product')).isError, true);
    assert.deepEqual(writes.ghost, []);
    await gw.db.query("DELETE FROM upstream_servers WHERE slug = 'store-ghost'");
    await gw.db.query("DELETE FROM stores WHERE slug = 'ghost'");
  });

  test('admins cannot rename or remove a store-linked server through the API (409); other edits work', async () => {
    const cookie = await gw.loginAs(ADMIN.email, ADMIN.password);
    const list = (await gw.request('/api/servers', { cookie })).json as Record<string, unknown>[];
    const s = list.find((x) => x.slug === 'store-alice-shop') as Record<string, unknown>;
    const body = (slug: string, timeoutMs = 10_000) =>
      JSON.stringify({
        slug,
        name: s.name,
        url: s.url,
        authType: s.authType,
        timeoutMs,
        adminOnlyTools: s.adminOnlyTools,
      });
    const del = await gw.request(`/api/servers/${s.id}`, { method: 'DELETE', cookie, body: '{}' });
    assert.equal(del.status, 409, del.text);
    assert.match(del.json.error.message, /belongs to store "alice-shop": delete the store to remove it/);
    const rename = await gw.request(`/api/servers/${s.id}`, {
      method: 'PUT',
      cookie,
      body: body('stolen-name'),
    });
    assert.equal(rename.status, 409, rename.text);
    const edit = await gw.request(`/api/servers/${s.id}`, {
      method: 'PUT',
      cookie,
      body: body('store-alice-shop', 7000),
    });
    assert.equal(edit.status, 200, edit.text);
    assert.equal(edit.json.timeoutMs, 7000);
    assert.ok((await gw.pool.serverBySlug('store-alice-shop'))?.store_id, 'still registered and linked');
    // An unlinked server is still removable.
    await register('fde-temp', ups[0]?.url as string);
    const temp = (await gw.pool.serverBySlug('fde-temp'))?.id;
    assert.equal(
      (await gw.request(`/api/servers/${temp}`, { method: 'DELETE', cookie, body: '{}' })).status,
      200,
    );
  });

  test('ownership that cannot be resolved denies: store record gone, or the lookup fails', async () => {
    // Lookup failure: every read of the server and its owner errors. Nothing is listed or called.
    const failing = new Proxy(gw.db, {
      get(target, prop, receiver) {
        if (prop !== 'query') return Reflect.get(target, prop, receiver);
        return (sql: unknown, ...rest: unknown[]) =>
          String(sql).includes('JOIN stores')
            ? Promise.reject(new Error('connection terminated'))
            : (target.query as (...a: unknown[]) => unknown)(sql, ...rest);
      },
    }) as Db;
    const broker = new Broker(failing, new UpstreamPool(failing, randomBytes(32), fetch));
    const alice = users['alice@example.com'] as Principal;
    await assert.rejects(broker.listTools(alice), /connection terminated/);
    await assert.rejects(
      broker.callTool(alice, 'mcp', 'store-alice-shop__create_product', {}),
      /connection terminated/,
    );
    assert.deepEqual(writes['alice-shop'], []);

    // Missing record: deleting the store unlinks its server (ON DELETE SET NULL).
    await gw.db.query('DELETE FROM stores WHERE id = $1', [storeIds['alice-shop']]);
    assert.equal((await gw.pool.serverBySlug('store-alice-shop'))?.store_id, null);
    assert.ok(!(await listed('alice@example.com')).includes('store-alice-shop__create_product'));
    const res = await call('alice@example.com', 'store-alice-shop__create_product');
    assert.equal(res.isError, true);
    assert.match(textOf(res), /requires the admin role\./);
    assert.equal((await lastAudit('alice@example.com', 'create_product'))?.outcome, 'denied');
    assert.deepEqual(writes['alice-shop'], []);
  });
});

describe('migration 003: links servers registered before store_id existed', { skip }, () => {
  test('links the provisioner registration, not a server that predates the store', async () => {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    const admin = createDb(DATABASE_URL as string);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = createDb(DATABASE_URL as string, `-c search_path=${schema}`);
    try {
      await migrate(db);
      // Back to the schema before 003, with a store and two servers named after stores.
      await db.query('ALTER TABLE upstream_servers DROP COLUMN store_id');
      await db.query("DELETE FROM schema_migrations WHERE name = '003_server_store.sql'");
      const owner = (
        await db.query(
          "INSERT INTO users (email, name, role) VALUES ('o@example.com', 'O', 'member') RETURNING id",
        )
      ).rows[0].id;
      await db.query(
        `INSERT INTO upstream_servers (slug, name, url, created_at)
         VALUES ('store-early', 'early', 'http://x', now() - interval '1 hour')`,
      );
      const store = async (slug: string) =>
        (
          await db.query(
            `INSERT INTO stores (slug, name, owner_id, namespace, host, deadline_at, created_at)
             VALUES ($1, $1, $2, 'store-' || $1, 'h', now(), now() - interval '1 minute') RETURNING id`,
            [slug, owner],
          )
        ).rows[0].id as string;
      const shop = await store('shop');
      await store('early');
      await db.query(
        "INSERT INTO upstream_servers (slug, name, url) VALUES ('store-shop', 'shop', 'http://x')",
      );

      assert.deepEqual(await migrate(db), ['003_server_store.sql']);
      const { rows } = await db.query('SELECT slug, store_id FROM upstream_servers ORDER BY slug');
      assert.deepEqual(rows, [
        { slug: 'store-early', store_id: null },
        { slug: 'store-shop', store_id: shop },
      ]);
    } finally {
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
