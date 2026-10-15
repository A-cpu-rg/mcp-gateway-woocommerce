// Definition-of-done checks against a running gateway (local processes or the Kubernetes deployment).
//   GATEWAY_URL=http://app.localtest.me ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/e2e.ts
// Optional: KILL_CMD="kubectl -n platform delete pod -l app.kubernetes.io/name=everything-mcp" to include
// the dead-upstream check (any command that makes one upstream unreachable).
import { execSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const BASE = (process.env.GATEWAY_URL ?? 'http://app.localtest.me').replace(/\/$/, '');
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.ADMIN_PASSWORD ?? '',
};
const run = Date.now().toString(36);
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function api(path: string, cookie: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { cookie, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  // biome-ignore lint/suspicious/noExplicitAny: script reads arbitrary JSON responses.
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any, headers: res.headers };
}

async function login(email: string, password: string): Promise<string> {
  const res = await api('/auth/login', '', 'POST', { email, password });
  if (res.status !== 200) throw new Error(`login ${email} failed: HTTP ${res.status}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

async function mcp(key: string): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

const text = (r: { content?: unknown }) => ((r.content as { text?: string }[]) ?? [])[0]?.text ?? '';
const today = new Date().toISOString().slice(0, 10);

// --- admin (user A) ---
const adminCookie = await login(ADMIN.email, ADMIN.password);
const servers = (await api('/servers', adminCookie)).json as {
  slug: string;
  status: string;
  id: string;
  url: string;
  name: string;
}[];
check(
  'at least three upstream servers registered',
  servers.length >= 3,
  servers.map((s) => `${s.slug}:${s.status}`).join(', '),
);
check(
  'WooCommerce server registered and connected',
  servers.some((s) => s.slug === 'woocommerce' && s.status === 'connected'),
);
const keyA = (await api('/keys', adminCookie, 'POST', { name: `e2e-a-${run}` })).json.token as string;

// --- invite user B (member) ---
const emailB = `member-${run}@example.com`;
const invite = await api('/invites', adminCookie, 'POST', {
  email: emailB,
  name: 'Member B',
  role: 'member',
});
const token = String(invite.json.inviteUrl).split('/invite/')[1];
await api('/invites/accept', '', 'POST', { token, password: 'member-b-password' });
const cookieB = await login(emailB, 'member-b-password');
const keyRes = (await api('/keys', cookieB, 'POST', { name: 'e2e-b' })).json as { id: string; token: string };

// --- user B via an external MCP client: only gateway URL + own key ---
const b = await mcp(keyRes.token);
const toolsB = (await b.listTools()).tools.map((t) => t.name);
const connected = servers.filter((s) => s.status === 'connected').map((s) => `${s.slug}__`);
check(
  'member sees tools of every connected server',
  connected.every((p) => toolsB.some((t) => t.startsWith(p))),
  `${toolsB.length} tools from ${connected.length} servers`,
);
check('member does not see admin-only create_product', !toolsB.includes('woocommerce__create_product'));
const ordersB = await b.callTool({ name: 'woocommerce__list_orders', arguments: { created_on: today } });
check(
  'member: "orders today" via woocommerce__list_orders',
  !ordersB.isError,
  text(ordersB).slice(0, 80).replace(/\s+/g, ' '),
);
const time = await b.callTool({ name: 'toolbox__current_time', arguments: { timezone: 'UTC' } });
const firstTotal = Number((JSON.parse(text(ordersB) || '[]')[0]?.total as string) ?? 0);
const eur = await b.callTool({
  name: 'toolbox__convert_currency',
  arguments: { amount: firstTotal, from: 'USD', to: 'EUR' },
});
check('two upstream servers in one task (woocommerce + toolbox)', !time.isError && !eur.isError, text(eur));
const denied = await b.callTool({
  name: 'woocommerce__create_product',
  arguments: { name: 'x', regular_price: '1.00' },
});
check('member calling admin-only tool directly is rejected', denied.isError === true, text(denied));

// --- user A (admin) creates a product ---
const a = await mcp(keyA);
const product = await a.callTool({
  name: 'woocommerce__create_product',
  arguments: { name: `E2E Product ${run}`, regular_price: '9.99' },
});
check('admin creates a product', !product.isError, text(product).slice(0, 120).replace(/\s+/g, ' '));
const found = await a.callTool({ name: 'woocommerce__list_products', arguments: { search: run } });
check('new product is listed in the store', text(found).includes(`E2E Product ${run}`));

// --- revoke B's key: next call rejected ---
await api(`/keys/${keyRes.id}`, cookieB, 'DELETE');
const after = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${keyRes.token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});
check('revoked key is rejected on the next call', after.status === 401, `HTTP ${after.status}`);

// --- disable one upstream: its tools disappear ---
const toolbox = servers.find((s) => s.slug === 'toolbox');
if (toolbox) {
  const full = (await api('/servers', adminCookie)).json.find((s: { id: string }) => s.id === toolbox.id);
  const body = {
    slug: full.slug,
    name: full.name,
    url: full.url,
    authType: full.authType,
    authHeader: full.authHeader,
    timeoutMs: full.timeoutMs,
    adminOnlyTools: full.adminOnlyTools,
  };
  await api(`/servers/${toolbox.id}`, adminCookie, 'PUT', { ...body, enabled: false });
  const toolsA = (await a.listTools()).tools.map((t) => t.name);
  check('disabled server tools disappear', !toolsA.some((t) => t.startsWith('toolbox__')));
  await api(`/servers/${toolbox.id}`, adminCookie, 'PUT', { ...body, enabled: true });
}

// --- optional: kill one upstream, others keep working ---
if (process.env.KILL_CMD) {
  execSync(process.env.KILL_CMD, { stdio: 'inherit' });
  const everything = servers.find((s) => s.slug === 'everything');
  // Killing is asynchronous (process shutdown, pod termination): poll the health check for up to 30 s.
  for (let i = 0; i < 30 && everything; i++) {
    const r = await api(`/servers/${everything.id}/refresh`, adminCookie, 'POST');
    if (r.json.status === 'unreachable') break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  const ok = await a.callTool({ name: 'woocommerce__list_orders', arguments: { created_on: today } });
  check('other servers keep working while one is down', !ok.isError);
  const status = (await api('/servers', adminCookie)).json.find(
    (s: { slug: string }) => s.slug === 'everything',
  );
  check(
    'killed server is shown as unreachable with a reason',
    status?.status === 'unreachable',
    status?.lastError ?? '',
  );
  const tools = (await a.listTools()).tools.map((t) => t.name);
  check(
    'killed server tools are gone, others still listed',
    !tools.some((t) => t.startsWith('everything__')) && tools.some((t) => t.startsWith('woocommerce__')),
  );
}

// --- audit attributes calls to the right users ---
const audit = (await api('/audit?limit=200', adminCookie)).json as {
  user: string;
  tool: string;
  outcome: string;
}[];
check(
  'audit has member B calls',
  audit.some((r) => r.user === emailB && r.tool === 'list_orders' && r.outcome === 'ok'),
);
check(
  'audit has member B denied call',
  audit.some((r) => r.user === emailB && r.outcome === 'denied'),
);
check(
  'audit has member B revoked-key attempt',
  audit.some((r) => r.user === emailB && r.outcome === 'auth_rejected'),
);
check(
  'audit has admin create_product',
  audit.some((r) => r.user === ADMIN.email && r.tool === 'create_product' && r.outcome === 'ok'),
);

await a.close();
await b.close().catch(() => {});
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
