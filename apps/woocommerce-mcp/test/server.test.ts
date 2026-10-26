import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createWooMcpServer } from '../src/server.ts';
import { createWooClient } from '../src/wc-client.ts';

interface Captured {
  method: string;
  url: URL;
  body: unknown;
}

/** Real MCP client -> real MCP handler (in memory) -> WooCommerce client -> fake store fetch. */
async function setup(store: (req: Captured) => { status: number; body: unknown }) {
  const calls: Captured[] = [];
  const wc = createWooClient({
    baseUrl: 'http://wordpress.internal',
    signingOrigin: 'http://store.localtest.me',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    timeoutMs: 200,
    fetch: async (input, init) => {
      const req = {
        method: init?.method ?? 'GET',
        url: new URL(String(input)),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(req);
      const r = store(req);
      return new Response(JSON.stringify(r.body), { status: r.status });
    },
  });
  const handler = createMcpHandler(() => createWooMcpServer(wc));
  const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    }),
  );
  return { client, calls };
}

const order = {
  id: 7,
  number: '7',
  status: 'processing',
  currency: 'USD',
  total: '19.99',
  date_created: '2026-10-15T10:00:00',
  payment_method_title: 'Cash on delivery',
  billing: { first_name: 'Ada', last_name: 'L', email: 'ada@example.com' },
  line_items: [{ product_id: 3, name: 'Mug', quantity: 1, total: '19.99' }],
};

test('exposes exactly the five required tools with annotations', async () => {
  const { client } = await setup(() => ({ status: 200, body: [] }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'create_product',
    'get_order',
    'list_orders',
    'list_products',
    'update_order_status',
  ]);
  assert.equal(tools.find((t) => t.name === 'list_orders')?.annotations?.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === 'update_order_status')?.annotations?.destructiveHint, true);
});

test('list_orders created_on maps to a store-local day window and signs the request', async () => {
  const { client, calls } = await setup(() => ({ status: 200, body: [order] }));
  const res = await client.callTool({ name: 'list_orders', arguments: { created_on: '2026-10-15' } });
  assert.equal(res.isError, undefined);
  const q = calls[0]?.url.searchParams;
  assert.equal(calls[0]?.url.pathname, '/wp-json/wc/v3/orders');
  assert.equal(q?.get('after'), '2026-10-14T23:59:59');
  assert.equal(q?.get('before'), '2026-10-15T23:59:59');
  assert.ok(q?.get('oauth_signature'));
  const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? '');
  assert.equal(body[0].customer, 'Ada L');
  assert.equal(body[0].items[0].name, 'Mug');
});

test('create_product posts a simple published product', async () => {
  const { client, calls } = await setup((r) => ({
    status: 201,
    body: {
      id: 9,
      name: (r.body as { name: string }).name,
      status: 'publish',
      sku: '',
      price: '5.00',
      regular_price: '5.00',
      stock_status: 'instock',
      permalink: 'http://store.localtest.me/product/x',
    },
  }));
  const res = await client.callTool({
    name: 'create_product',
    arguments: { name: 'Mug', regular_price: '5.00' },
  });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0]?.method, 'POST');
  assert.deepEqual(calls[0]?.body, { type: 'simple', name: 'Mug', regular_price: '5.00', status: 'publish' });
});

test('invalid input is rejected before reaching the store', async () => {
  const { client, calls } = await setup(() => ({ status: 200, body: {} }));
  const res = await client.callTool({
    name: 'create_product',
    arguments: { name: 'X', regular_price: 'free' },
  });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test('store errors become tool errors without leaking URLs or credentials', async () => {
  const { client } = await setup(() => ({
    status: 404,
    body: { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' },
  }));
  const res = await client.callTool({ name: 'get_order', arguments: { order_id: 999 } });
  assert.equal(res.isError, true);
  const text = (res.content as { text: string }[])[0]?.text ?? '';
  assert.match(text, /404 woocommerce_rest_shop_order_invalid_id/);
  assert.doesNotMatch(text, /oauth|ck|wordpress\.internal/);
});

test('update_order_status sends PUT with the new status', async () => {
  const { client, calls } = await setup(() => ({ status: 200, body: { ...order, status: 'completed' } }));
  const res = await client.callTool({
    name: 'update_order_status',
    arguments: { order_id: 7, status: 'completed' },
  });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0]?.method, 'PUT');
  assert.equal(calls[0]?.url.pathname, '/wp-json/wc/v3/orders/7');
  assert.deepEqual(calls[0]?.body, { status: 'completed' });
});
