import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createToolboxServer } from '../src/server.ts';

async function connect() {
  const handler = createMcpHandler(() => createToolboxServer());
  const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://toolbox.test/mcp'), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    }),
  );
  return client;
}
const textOf = (r: { content: unknown }) => (r.content as { text: string }[])[0]?.text ?? '';

test('convert_currency uses the reference rates', async () => {
  const client = await connect();
  const res = await client.callTool({
    name: 'convert_currency',
    arguments: { amount: 100, from: 'usd', to: 'EUR' },
  });
  assert.equal(JSON.parse(textOf(res)).result, 92);
});

test('unsupported currency is a validation error', async () => {
  const client = await connect();
  const res = await client.callTool({
    name: 'convert_currency',
    arguments: { amount: 1, from: 'XXX', to: 'EUR' },
  });
  assert.equal(res.isError, true);
});

test('current_time resolves a time zone and rejects unknown ones', async () => {
  const client = await connect();
  const ok = JSON.parse(
    textOf(await client.callTool({ name: 'current_time', arguments: { timezone: 'Asia/Kolkata' } })),
  );
  assert.match(ok.date, /^\d{4}-\d{2}-\d{2}$/);
  const bad = await client.callTool({ name: 'current_time', arguments: { timezone: 'Mars/Base' } });
  assert.equal(bad.isError, true);
});
