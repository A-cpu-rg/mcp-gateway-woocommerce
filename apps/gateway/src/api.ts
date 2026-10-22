import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as z from 'zod/v4';
import { type ChatModel, runAgent } from './agent.ts';
import {
  acceptInvite,
  createApiKey,
  createInvite,
  login,
  logout,
  type Principal,
  revokeApiKey,
  sessionPrincipal,
} from './auth.ts';
import type { Broker } from './broker.ts';
import { createServer, publicServer, type ServerDeps, serverInput, updateServer } from './servers.ts';
import { UrlPolicyError } from './url-guard.ts';

const COOKIE = 'mgw_session';
type Env = { Variables: { principal: Principal } };

export interface ApiDeps extends ServerDeps {
  broker: Broker;
  model?: ChatModel;
  mcpUrl: string;
  cookieSecure: boolean;
}

class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409;
  readonly code: string;
  constructor(status: 400 | 401 | 403 | 404 | 409, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new HttpError(400, 'invalid_request', z.prettifyError(parsed.error));
  return parsed.data;
}

function requireAdmin(c: Context<Env>): void {
  if (c.get('principal').role !== 'admin') throw new HttpError(403, 'forbidden', 'admin role required');
}

export function createApi(d: ApiDeps): Hono<Env> {
  const api = new Hono<Env>();

  api.onError((err, c) => {
    if (err instanceof HttpError)
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof UrlPolicyError)
      return c.json({ error: { code: 'url_rejected', message: err.message } }, 400);
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: { code: 'conflict', message: 'already exists' } }, 409);
    }
    console.error(JSON.stringify({ msg: 'api error', path: c.req.path, error: String(err) }));
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  // CSRF: the session cookie is SameSite=Strict, and every state-changing request must be JSON, which a
  // cross-site form cannot send without a CORS preflight that this API never approves.
  api.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && !c.req.header('content-type')?.startsWith('application/json')) {
      throw new HttpError(400, 'invalid_request', 'content-type must be application/json');
    }
    await next();
  });

  // ---- public ----
  api.post('/auth/login', async (c) => {
    const { email, password } = await body(
      c,
      z.object({ email: z.string().max(200), password: z.string().max(200) }),
    );
    const token = await login(d.db, email, password);
    if (!token) throw new HttpError(401, 'invalid_credentials', 'wrong email or password');
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: d.cookieSecure,
      path: '/',
      maxAge: 12 * 3600,
    });
    return c.json({ ok: true });
  });

  api.post('/invites/accept', async (c) => {
    const { token, password } = await body(
      c,
      z.object({ token: z.string().max(100), password: z.string().min(10).max(200) }),
    );
    if (!(await acceptInvite(d.db, token, password)))
      throw new HttpError(400, 'invalid_invite', 'invite is invalid, used or expired');
    return c.json({ ok: true });
  });

  // ---- everything below needs a dashboard session ----
  api.use('*', async (c, next) => {
    const p = await sessionPrincipal(d.db, getCookie(c, COOKIE));
    if (!p) throw new HttpError(401, 'unauthenticated', 'login required');
    c.set('principal', p);
    await next();
  });

  api.post('/auth/logout', async (c) => {
    const token = getCookie(c, COOKIE);
    if (token) await logout(d.db, token);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  api.get('/me', (c) => c.json({ ...c.get('principal'), mcpUrl: d.mcpUrl, chatEnabled: !!d.model }));

  // ---- servers ----
  api.get('/servers', async (c) => {
    const p = c.get('principal');
    const rows = await d.pool.servers();
    const list = rows.map((r) => publicServer(r, d.pool));
    // Members see status and the tools they can use, not URLs or credential settings.
    if (p.role === 'admin') return c.json(list);
    return c.json(
      list.map(
        ({ url: _u, authType: _a, authHeader: _h, hasCredential: _c, adminOnlyTools: _t, ...rest }) => ({
          ...rest,
          tools: rest.tools.filter((t) => !t.adminOnly),
        }),
      ),
    );
  });
  api.post('/servers', async (c) => {
    requireAdmin(c);
    const row = await createServer(d, await body(c, serverInput));
    const fresh = (await d.pool.serverBySlug(row.slug)) ?? row;
    return c.json(publicServer(fresh, d.pool), 201);
  });
  api.put('/servers/:id', async (c) => {
    requireAdmin(c);
    const row = await updateServer(d, c.req.param('id'), await body(c, serverInput));
    if (!row) throw new HttpError(404, 'not_found', 'server not found');
    const fresh = (await d.pool.serverBySlug(row.slug)) ?? row;
    return c.json(publicServer(fresh, d.pool));
  });
  api.post('/servers/:id/refresh', async (c) => {
    const rows = await d.pool.servers();
    const row = rows.find((r) => r.id === c.req.param('id'));
    if (!row) throw new HttpError(404, 'not_found', 'server not found');
    await d.pool.check(row);
    return c.json(publicServer((await d.pool.serverBySlug(row.slug)) ?? row, d.pool));
  });
  api.delete('/servers/:id', async (c) => {
    requireAdmin(c);
    const { rowCount } = await d.db.query('DELETE FROM upstream_servers WHERE id = $1', [c.req.param('id')]);
    if (!rowCount) throw new HttpError(404, 'not_found', 'server not found');
    await d.pool.refreshAll();
    return c.json({ ok: true });
  });

  // ---- team ----
  api.get('/users', async (c) => {
    requireAdmin(c);
    const { rows } = await d.db.query(
      `SELECT id, email, name, role, disabled_at AS "disabledAt", created_at AS "createdAt",
              password_hash IS NOT NULL AS "active"
       FROM users ORDER BY created_at`,
    );
    return c.json(rows);
  });
  api.post('/invites', async (c) => {
    requireAdmin(c);
    const input = await body(
      c,
      z.object({
        email: z.email().max(200),
        name: z.string().trim().min(1).max(80),
        role: z.enum(['admin', 'member']),
      }),
    );
    const { userId, token } = await createInvite(d.db, input.email, input.name, input.role).catch((err) => {
      throw new HttpError(409, 'conflict', (err as Error).message);
    });
    // Token travels in the URL fragment, so it never reaches server or proxy access logs.
    return c.json({ userId, inviteUrl: `${new URL(d.mcpUrl).origin}/#/invite/${token}` }, 201);
  });
  api.patch('/users/:id', async (c) => {
    requireAdmin(c);
    const input = await body(
      c,
      z.object({ role: z.enum(['admin', 'member']).optional(), disabled: z.boolean().optional() }),
    );
    if (c.req.param('id') === c.get('principal').userId)
      throw new HttpError(400, 'invalid_request', 'cannot change yourself');
    const { rowCount } = await d.db.query(
      `UPDATE users SET role = COALESCE($2, role),
         disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN now() ELSE NULL END
       WHERE id = $1`,
      [c.req.param('id'), input.role ?? null, input.disabled ?? null],
    );
    if (!rowCount) throw new HttpError(404, 'not_found', 'user not found');
    // Disabling a user ends their sessions immediately; their keys are rejected by the user check.
    if (input.disabled) await d.db.query('DELETE FROM sessions WHERE user_id = $1', [c.req.param('id')]);
    return c.json({ ok: true });
  });

  // ---- API keys ----
  api.get('/keys', async (c) => {
    const p = c.get('principal');
    const all = p.role === 'admin' && c.req.query('all') === '1';
    const { rows } = await d.db.query(
      `SELECT k.id, k.name, k.created_at AS "createdAt", k.last_used_at AS "lastUsedAt", k.revoked_at AS "revokedAt",
              u.email AS "userEmail"
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE $1 OR k.user_id = $2 ORDER BY k.created_at DESC`,
      [all, p.userId],
    );
    return c.json(rows);
  });
  api.post('/keys', async (c) => {
    const p = c.get('principal');
    const { name, userId } = await body(
      c,
      z.object({ name: z.string().trim().min(1).max(80), userId: z.uuid().optional() }),
    );
    // Admins may issue a key on behalf of a team member; the key belongs to (and is audited as) that member.
    const owner = userId ?? p.userId;
    if (owner !== p.userId) {
      requireAdmin(c);
      const { rowCount } = await d.db.query('SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL', [
        owner,
      ]);
      if (!rowCount) throw new HttpError(404, 'not_found', 'user not found or disabled');
    }
    const key = await createApiKey(d.db, owner, name);
    return c.json({ ...key, mcpUrl: d.mcpUrl }, 201); // the token is shown exactly once
  });
  api.delete('/keys/:id', async (c) => {
    if (!(await revokeApiKey(d.db, c.get('principal'), c.req.param('id')))) {
      throw new HttpError(404, 'not_found', 'key not found or already revoked');
    }
    return c.json({ ok: true });
  });

  // ---- audit ----
  api.get('/audit', async (c) => {
    const p = c.get('principal');
    const q = z
      .object({
        user: z.string().max(200).optional(),
        server: z.string().max(40).optional(),
        outcome: z.string().max(40).optional(),
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(c.req.query());
    const { rows } = await d.db.query(
      `SELECT id, at, user_email AS "user", api_key_id AS "apiKeyId", channel, server_slug AS "server", tool,
              duration_ms AS "durationMs", outcome, error
       FROM audit_log
       WHERE ($1::uuid IS NULL OR user_id = $1)
         AND ($2::text IS NULL OR user_email = $2)
         AND ($3::text IS NULL OR server_slug = $3)
         AND ($4::text IS NULL OR outcome = $4)
         AND ($5::bigint IS NULL OR id < $5)
       ORDER BY id DESC LIMIT $6`,
      // Members only ever see their own calls.
      [
        p.role === 'admin' ? null : p.userId,
        q.user ?? null,
        q.server ?? null,
        q.outcome ?? null,
        q.before ?? null,
        q.limit,
      ],
    );
    return c.json(rows);
  });

  // ---- chat agent: streams NDJSON events (tool calls, results, final message) ----
  api.post('/chat', async (c) => {
    if (!d.model) throw new HttpError(400, 'chat_disabled', 'no LLM configured (set LLM_API_KEY)');
    const { messages } = await body(
      c,
      z.object({
        messages: z
          .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
          .min(1)
          .max(40),
      }),
    );
    const principal = c.get('principal');
    const model = d.model;
    const signal = c.req.raw.signal;
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (e: unknown) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(e)}\n`));
        try {
          await runAgent({ broker: d.broker, principal, model, history: messages, emit, signal });
        } catch (err) {
          emit({ type: 'error', message: (err as Error).message.slice(0, 500) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
    });
  });

  return api;
}
