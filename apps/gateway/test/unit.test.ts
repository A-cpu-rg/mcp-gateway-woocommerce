import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { decrypt, encrypt, hashPassword, newApiKey, parseApiKey, verifyPassword } from '../src/crypto.ts';
import { exposedToolName, slugOf } from '../src/upstreams.ts';
import { checkAddress, createGuardedFetch, hostAllowed, validateUpstreamUrl } from '../src/url-guard.ts';

const CLUSTER = ['*.svc.cluster.local'];

test('url guard: metadata and link-local are blocked even for allow-listed hosts', () => {
  assert.throws(() => checkAddress('x.svc.cluster.local', '169.254.169.254', CLUSTER));
  assert.throws(() => checkAddress('x.svc.cluster.local', '::ffff:169.254.169.254', CLUSTER));
  assert.throws(() => checkAddress('x.svc.cluster.local', 'fe80::1', CLUSTER));
  // Spellings the URL parser actually produces: ::ffff:169.254.169.254 becomes ::ffff:a9fe:a9fe.
  for (const ip of ['::ffff:a9fe:a9fe', '::a9fe:a9fe', '64:ff9b::a9fe:a9fe', '0:0:0:0:0:ffff:a9fe:a9fe'])
    assert.throws(() => checkAddress('x.svc.cluster.local', ip, CLUSTER), /never allowed/, ip);
  // IPv6 loopback is an internal address like 127.0.0.1, not an embedded IPv4 one.
  assert.throws(() => checkAddress('evil.example.com', '::1', CLUSTER), /not on the allow-list/);
  assert.doesNotThrow(() => checkAddress('woo.store.svc.cluster.local', '::1', CLUSTER));
  assert.throws(() => checkAddress('evil.example.com', '::ffff:7f00:1', CLUSTER), /internal/);
  assert.throws(() => checkAddress('evil.example.com', '::ffff:a00:1', CLUSTER), /internal/);
  assert.doesNotThrow(() => checkAddress('mcp.example.com', '::ffff:5db8:d822', CLUSTER)); // 93.184.216.34
  assert.throws(() => checkAddress('x.svc.cluster.local', '0.0.0.0', CLUSTER));
});

test('url guard: private ranges only for allow-listed hosts; public addresses allowed', () => {
  assert.doesNotThrow(() => checkAddress('woo.store.svc.cluster.local', '10.43.0.12', CLUSTER));
  assert.throws(() => checkAddress('evil.example.com', '10.43.0.12', CLUSTER));
  assert.throws(() => checkAddress('evil.example.com', '127.0.0.1', CLUSTER));
  assert.throws(() => checkAddress('evil.example.com', '::1', CLUSTER));
  assert.doesNotThrow(() => checkAddress('mcp.example.com', '93.184.216.34', CLUSTER));
  assert.equal(hostAllowed('a.svc.cluster.local.', CLUSTER), true);
  assert.equal(hostAllowed('svc.cluster.local.evil.com', CLUSTER), false);
});

test('url guard: registration rejects IPv4-in-IPv6 URL literals that reach metadata or internal hosts', async () => {
  for (const url of [
    'http://[::ffff:169.254.169.254]/mcp',
    'http://[::ffff:a9fe:a9fe]/mcp',
    'http://[64:ff9b::a9fe:a9fe]/mcp',
    'http://[::ffff:127.0.0.1]/mcp',
    'http://[::ffff:10.0.0.1]/mcp',
  ])
    await assert.rejects(validateUpstreamUrl(url, CLUSTER), url);
});

test('url guard: registration resolves names and checks every address', async () => {
  const resolver = async () => ['93.184.216.34', '169.254.169.254'];
  await assert.rejects(validateUpstreamUrl('https://mixed.example.com/mcp', CLUSTER, resolver));
  const ok = await validateUpstreamUrl('https://mcp.example.com/mcp#frag', CLUSTER, async () => [
    '93.184.216.34',
  ]);
  assert.equal(ok, 'https://mcp.example.com/mcp');
});

test('url guard: connection-time check blocks a name that resolves to loopback (DNS rebinding)', async () => {
  // "localhost" is not on the allow-list, so even if it passed registration earlier, dialling it fails.
  const guarded = createGuardedFetch(CLUSTER);
  await assert.rejects(guarded('http://localhost:8999/mcp'), (err: Error) =>
    /not on the allow-list/.test(String((err as { cause?: Error }).cause?.message ?? err.message)),
  );
  await assert.rejects(guarded('http://169.254.169.254/latest/meta-data/'), /never allowed/);
});

test('credential encryption: round trip, random IV, tamper detection', () => {
  const key = randomBytes(32);
  const a = encrypt(key, 'secret');
  assert.equal(decrypt(key, a), 'secret');
  assert.notDeepEqual(a, encrypt(key, 'secret'));
  a[a.length - 1] = (a[a.length - 1] as number) ^ 1;
  assert.throws(() => decrypt(key, a));
  assert.throws(() => decrypt(randomBytes(32), encrypt(key, 'x')));
});

test('api keys: format, parsing and hashing', () => {
  const k = newApiKey();
  assert.match(k.token, /^mgw_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.equal(parseApiKey(k.token)?.id, k.id);
  assert.equal(parseApiKey('mgw_xyz'), null);
  assert.equal(parseApiKey(`${k.token}x`), null);
});

test('passwords: scrypt verify', async () => {
  const h = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('x', null), false);
});

test('tool naming: namespaced, LLM-safe, collision resistant', () => {
  assert.equal(exposedToolName('woocommerce', 'list_orders'), 'woocommerce__list_orders');
  const weird = exposedToolName('srv', 'files/read.v2');
  assert.match(weird, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.notEqual(weird, exposedToolName('srv', 'files_read_v2'));
  const long = exposedToolName('a-very-long-server-slug', 'x'.repeat(100));
  assert.ok(long.length <= 64);
  assert.notEqual(long, exposedToolName('a-very-long-server-slug', `${'x'.repeat(99)}y`));
  assert.equal(slugOf('woocommerce__list_orders'), 'woocommerce');
  assert.equal(slugOf('__x'), null);
});

test('Azure OpenAI adapter: deployment URL, api-key header, tool-call parsing', async () => {
  const { openAiCompatibleModel } = await import('../src/agent.ts');
  let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
  const model = openAiCompatibleModel(
    {
      provider: 'azure',
      endpoint: 'https://navis-openai.openai.azure.com/',
      apiKey: 'k-123',
      model: 'navis-gpt',
      apiVersion: '2024-12-01-preview',
    },
    async (url, init) => {
      seen = {
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 't1', type: 'function', function: { name: 'a__b', arguments: '{}' } }],
            },
          },
        ],
      });
    },
  );
  const reply = await model([{ role: 'user', content: 'hi' }], []);
  assert.equal(
    seen?.url,
    'https://navis-openai.openai.azure.com/openai/deployments/navis-gpt/chat/completions?api-version=2024-12-01-preview',
  );
  assert.equal(seen?.headers['api-key'], 'k-123');
  assert.equal(seen?.body.model, undefined);
  assert.equal(reply.toolCalls[0]?.function.name, 'a__b');
});
