import {
  hashPassword,
  newApiKey,
  parseApiKey,
  randomToken,
  safeEqual,
  sha256,
  verifyPassword,
} from './crypto.ts';
import type { Db } from './db.ts';

export type Role = 'admin' | 'member';

/** Who is acting. Every tool call and API request is attributed to a Principal. */
export interface Principal {
  userId: string;
  email: string;
  role: Role;
  apiKeyId?: string;
}

const SESSION_TTL_HOURS = 12;
const INVITE_TTL_HOURS = 72;

export async function ensureAdmin(db: Db, email: string, password: string): Promise<void> {
  const { rowCount } = await db.query("SELECT 1 FROM users WHERE role = 'admin' AND disabled_at IS NULL");
  if (rowCount) return;
  await db.query(
    `INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Admin', 'admin', $2)
     ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash, disabled_at = NULL`,
    [email.toLowerCase(), await hashPassword(password)],
  );
}

// ---- Sessions (dashboard) ----

export async function login(db: Db, email: string, password: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string; password_hash: string | null }>(
    'SELECT id, password_hash FROM users WHERE email = $1 AND disabled_at IS NULL',
    [email.toLowerCase()],
  );
  // Verify against a dummy hash when the user does not exist, so timing does not reveal valid emails.
  const ok = await verifyPassword(password, rows[0]?.password_hash ?? DUMMY_HASH);
  if (!rows[0] || !ok) return null;
  const token = randomToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_TTL_HOURS} hours')`,
    [sha256(token), rows[0].id],
  );
  return token;
}
const DUMMY_HASH = await hashPassword(randomToken());

export async function sessionPrincipal(db: Db, token: string | undefined): Promise<Principal | null> {
  if (!token) return null;
  const { rows } = await db.query<{ id: string; email: string; role: Role }>(
    `SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const u = rows[0];
  return u ? { userId: u.id, email: u.email, role: u.role } : null;
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

// ---- API keys (MCP clients) ----

export type KeyCheck =
  | { ok: true; principal: Principal }
  | { ok: false; reason: 'malformed' | 'unknown' | 'revoked' | 'user_disabled'; principal?: Principal };

/** Checked on every request (no cache) so revocation takes effect on the very next call. */
export async function verifyApiKey(db: Db, token: string): Promise<KeyCheck> {
  const parsed = parseApiKey(token);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const { rows } = await db.query<{
    secret_hash: Buffer;
    revoked_at: Date | null;
    user_id: string;
    email: string;
    role: Role;
    disabled_at: Date | null;
  }>(
    `SELECT k.secret_hash, k.revoked_at, u.id AS user_id, u.email, u.role, u.disabled_at
     FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.id = $1`,
    [parsed.id],
  );
  const row = rows[0];
  if (!row || !safeEqual(sha256(parsed.secret), row.secret_hash)) return { ok: false, reason: 'unknown' };
  const principal: Principal = { userId: row.user_id, email: row.email, role: row.role, apiKeyId: parsed.id };
  if (row.revoked_at) return { ok: false, reason: 'revoked', principal };
  if (row.disabled_at) return { ok: false, reason: 'user_disabled', principal };
  // Best-effort usage stamp; never blocks or fails the request.
  db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [parsed.id]).catch(() => {});
  return { ok: true, principal };
}

export async function createApiKey(
  db: Db,
  userId: string,
  name: string,
): Promise<{ id: string; token: string }> {
  const key = newApiKey();
  await db.query('INSERT INTO api_keys (id, user_id, name, secret_hash) VALUES ($1, $2, $3, $4)', [
    key.id,
    userId,
    name,
    key.secretHash,
  ]);
  return { id: key.id, token: key.token };
}

/** Revokes a key. Members may revoke only their own; admins any. Returns false if not found/not allowed. */
export async function revokeApiKey(db: Db, actor: Principal, keyId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL AND ($2 = 'admin' OR user_id = $3)`,
    [keyId, actor.role, actor.userId],
  );
  return rowCount === 1;
}

// ---- Invites ----

export async function createInvite(
  db: Db,
  email: string,
  name: string,
  role: Role,
): Promise<{ userId: string; token: string }> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (email, name, role) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role
       WHERE users.password_hash IS NULL
       RETURNING id`,
      [email.toLowerCase(), name, role],
    );
    if (!rows[0]) throw new Error('user already exists');
    const token = randomToken();
    await client.query(
      `INSERT INTO invites (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${INVITE_TTL_HOURS} hours')`,
      [sha256(token), rows[0].id],
    );
    await client.query('COMMIT');
    return { userId: rows[0].id, token };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Single use: the UPDATE ... WHERE used_at IS NULL claim makes concurrent accepts safe. */
export async function acceptInvite(db: Db, token: string, password: string): Promise<boolean> {
  const hash = await hashPassword(password);
  const { rows } = await db.query<{ user_id: string }>(
    `UPDATE invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [sha256(token)],
  );
  if (!rows[0]) return false;
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, rows[0].user_id]);
  return true;
}
