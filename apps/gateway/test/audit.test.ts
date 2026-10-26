import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import * as z from 'zod/v4';
import { createApiKey, type Principal, revokeApiKey } from '../src/auth.ts';
import { Broker } from '../src/broker.ts';
import { createDb, type Db, migrate } from '../src/db.ts';
import { createMcpEndpoint } from '../src/mcp.ts';
import { UpstreamPool } from '../src/upstreams.ts';
import { DATABASE_URL, skip, startUpstream, textOf, type Upstream } from './helpers.ts';

// Audit durability against real Postgres and a real MCP upstream: a call that reaches an upstream is
// recorded before it happens, and a call that cannot be recorded is not made.

describe('audit durability', { skip }, () => {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  let admin: Db;
  let db: Db;
  let up: Upstream;
  let p: Principal;
  const writes: string[] = [];
  const pools: UpstreamPool[] = [];

  /** The real database, except that statements matching `fails` reject. */
  const failing = (fails: RegExp) =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'query') return Reflect.get(target, prop, receiver);
        return (sql: unknown, ...rest: unknown[]) =>
          fails.test(String(sql))
            ? Promise.reject(new Error('audit storage unavailable'))
            : (target.query as (...a: unknown[]) => unknown)(sql, ...rest);
      },
    }) as Db;
  const broker = (d: Db) => {
    const pool = new UpstreamPool(db, randomBytes(32), fetch);
    pools.push(pool);
    return new Broker(d, pool);
  };
  const rows = async () =>
    (
      await db.query<{ tool: string; outcome: string; error: string | null; user_email: string }>(
        'SELECT tool, outcome, error, user_email FROM audit_log ORDER BY id',
      )
    ).rows;

  before(async () => {
    admin = createDb(DATABASE_URL as string);
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = createDb(DATABASE_URL as string, `-c search_path=${schema}`);
    await migrate(db);
    const id = (
      await db.query(
        "INSERT INTO users (email, name, role) VALUES ('ops@example.com', 'Ops', 'admin') RETURNING id",
      )
    ).rows[0].id;
    p = { userId: id, email: 'ops@example.com', role: 'admin' };
    up = await startUpstream((s) => {
      s.registerTool('create_product', { inputSchema: z.object({}) }, async () => {
        writes.push('create_product');
        return { content: [{ type: 'text', text: 'created' }] };
      });
      s.registerTool('broken', { inputSchema: z.object({}) }, async () => ({
        isError: true,
        content: [
          { type: 'text', text: 'WooCommerce error 404: Invalid ID (upstream said Bearer abc123secret)' },
        ],
      }));
    });
    await db.query(
      "INSERT INTO upstream_servers (slug, name, url, admin_only_tools) VALUES ('shop', 'Shop', $1, '{create_product}')",
      [up.url],
    );
  });
  after(async () => {
    for (const pool of pools) await pool.stop();
    await up.close();
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  test('a call that cannot be audited is refused before it reaches the upstream', async () => {
    const res = await broker(failing(/INSERT INTO audit_log/)).callTool(p, 'mcp', 'shop__create_product', {});
    assert.equal(res.isError, true);
    assert.match(textOf(res), /audit log is unavailable, so 'shop__create_product' was not called/);
    assert.deepEqual(writes, [], 'no side effect without an audit record');
    assert.deepEqual(await rows(), []);
  });

  test('a successful call leaves exactly one row with its final outcome', async () => {
    const res = await broker(db).callTool(p, 'chat', 'shop__create_product', {});
    assert.equal(textOf(res), 'created');
    assert.deepEqual(await rows(), [
      { tool: 'create_product', outcome: 'ok', error: null, user_email: 'ops@example.com' },
    ]);
    writes.length = 0;
    await db.query('DELETE FROM audit_log');
  });

  test('if the outcome cannot be written, the attempt stays recorded as pending', async () => {
    const res = await broker(failing(/UPDATE audit_log/)).callTool(p, 'mcp', 'shop__create_product', {});
    assert.equal(textOf(res), 'created', 'the caller still gets the result of a call that happened');
    assert.deepEqual(writes, ['create_product']);
    assert.deepEqual(await rows(), [
      { tool: 'create_product', outcome: 'pending', error: null, user_email: 'ops@example.com' },
    ]);
    writes.length = 0;
    await db.query('DELETE FROM audit_log');
  });

  test('a failed tool call records why it failed, with credentials redacted', async () => {
    await broker(db).callTool(p, 'mcp', 'shop__broken', {});
    const [row] = await rows();
    assert.equal(row?.outcome, 'tool_error');
    assert.match(row?.error ?? '', /^WooCommerce error 404: Invalid ID/);
    assert.ok(!row?.error?.includes('abc123secret'), 'bearer token redacted');
  });
  test('rejected attempts are audited best effort: refused either way, a lost row is reported', async (t) => {
    await db.query('DELETE FROM audit_log');
    const logged = t.mock.method(console, 'error', () => {});
    const noAudit = failing(/INSERT INTO audit_log/);
    const member: Principal = { userId: p.userId, email: 'member@example.com', role: 'member' };
    // Denied (admin-only tool), unknown tool: still refused, nothing reaches the upstream.
    const denied = await broker(noAudit).callTool(member, 'mcp', 'shop__create_product', {});
    assert.match(textOf(denied), /requires the admin role/);
    const unknown = await broker(noAudit).callTool(p, 'chat', 'shop__no_such_tool', {});
    assert.match(textOf(unknown), /Unknown tool/);
    // Revoked key on the MCP endpoint: still 401.
    const key = await createApiKey(db, p.userId, 'revoked');
    await revokeApiKey(db, p, key.id);
    const mcp = createMcpEndpoint(noAudit, broker(noAudit));
    const res = await mcp.handle(
      new Request('http://gateway.test/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
    await mcp.close();
    assert.equal(res.status, 401);
    assert.deepEqual(writes, [], 'no rejected attempt reached the upstream');
    assert.deepEqual(await rows(), [], 'the audit store was down');
    const reports = logged.mock.calls.map((c) => JSON.parse(String(c.arguments[0])));
    assert.deepEqual(
      reports.filter((r) => r.msg === 'audit write failed').map((r) => r.entry.outcome),
      ['denied', 'not_found', 'auth_rejected'],
      'each lost row is reported, not silently dropped',
    );
    assert.ok(
      reports.every((r) => !JSON.stringify(r).includes(key.token)),
      'the key is never logged',
    );
  });

  test('with the audit store up, rejected attempts are recorded with user and outcome', async () => {
    await db.query('DELETE FROM audit_log');
    const member: Principal = { userId: p.userId, email: 'member@example.com', role: 'member' };
    await broker(db).callTool(member, 'mcp', 'shop__create_product', {});
    await broker(db).callTool(p, 'chat', 'shop__no_such_tool', {});
    assert.deepEqual(
      (await rows()).map((r) => [r.user_email, r.outcome]),
      [
        ['member@example.com', 'denied'],
        ['ops@example.com', 'not_found'],
      ],
    );
  });
});
