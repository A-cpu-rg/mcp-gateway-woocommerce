import * as z from 'zod/v4';
import type { Principal } from './auth.ts';
import type { Db } from './db.ts';

// Multi-store provisioning, API side. The gateway only records the desired state in Postgres; the
// store-provisioner (provisioner.ts) is the only component with Kubernetes credentials.

export interface StoreRow {
  id: string;
  slug: string;
  name: string;
  owner_id: string;
  namespace: string;
  host: string;
  status: 'provisioning' | 'ready' | 'failed' | 'deleting';
  status_reason: string | null;
  deadline_at: Date;
  attempt: number;
  lease_owner: string | null;
  lease_until: Date | null;
  created_at: Date;
  updated_at: Date;
  ready_at: Date | null;
}

export interface StoreSettings {
  /** Host for a store's storefront, e.g. "{slug}.store.localtest.me". */
  hostTemplate: string;
  maxPerUser: number;
  timeoutMs: number;
}

export class StoreError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** Slugs that would collide with platform names or read as something they are not. */
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'store', 'platform', 'default', 'kube', 'system']);

export const storeInput = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{1,17}$/,
      'lowercase letters, digits and "-", 2-18 characters, starting with a letter',
    )
    .refine((s) => !RESERVED.has(s) && !s.endsWith('-'), 'reserved or invalid slug'),
});

// Naming is derived from the slug in one place, so the API, the provisioner and the tool names agree.
export const storeNamespace = (slug: string) => `store-${slug}`;
/** Gateway server slug: tools appear as store-<slug>__list_orders, naming the store they act on. */
export const storeServerSlug = (slug: string) => `store-${slug}`;
export const storeHost = (template: string, slug: string) => template.replaceAll('{slug}', slug);

export function publicStore(row: StoreRow & { owner_email?: string }) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    owner: row.owner_email,
    status: row.status,
    reason: row.status_reason,
    url: `http://${row.host}`,
    tools: `${storeServerSlug(row.slug)}__*`,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    deadlineAt: row.deadline_at,
  };
}

export async function listStores(db: Db, p: Principal) {
  const { rows } = await db.query<StoreRow & { owner_email: string }>(
    `SELECT s.*, u.email AS owner_email FROM stores s JOIN users u ON u.id = s.owner_id
     WHERE $1 OR s.owner_id = $2 ORDER BY s.created_at`,
    [p.role === 'admin', p.userId],
  );
  return rows.map(publicStore);
}

/**
 * Requests a new store. Safe to retry: repeating the same request for a store you already own returns
 * that store instead of creating a second one. Enforces the per-user limit atomically.
 */
export async function requestStore(
  db: Db,
  settings: StoreSettings,
  p: Principal,
  input: z.infer<typeof storeInput>,
): Promise<{ store: ReturnType<typeof publicStore>; created: boolean }> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialises requests per user, so two concurrent creates cannot both pass the limit check.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stores:${p.userId}`]);
    const existing = await client.query<StoreRow>('SELECT * FROM stores WHERE slug = $1', [input.slug]);
    const found = existing.rows[0];
    if (found) {
      await client.query('ROLLBACK');
      if (found.owner_id !== p.userId) throw new StoreError(409, `store "${input.slug}" already exists`);
      if (found.status === 'deleting') throw new StoreError(409, `store "${input.slug}" is being deleted`);
      return { store: publicStore(found), created: false };
    }
    const taken = await client.query('SELECT 1 FROM upstream_servers WHERE slug = $1', [
      storeServerSlug(input.slug),
    ]);
    if (taken.rowCount)
      throw new StoreError(409, `a server named ${storeServerSlug(input.slug)} already exists`);
    const { rows: count } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM stores WHERE owner_id = $1 AND status <> 'deleting'",
      [p.userId],
    );
    if ((count[0]?.n ?? 0) >= settings.maxPerUser) {
      throw new StoreError(409, `store limit reached (${settings.maxPerUser} per user)`);
    }
    const { rows } = await client.query<StoreRow>(
      `INSERT INTO stores (slug, name, owner_id, namespace, host, status_reason, deadline_at)
       VALUES ($1, $2, $3, $4, $5, 'Queued', now() + make_interval(secs => $6)) RETURNING *`,
      [
        input.slug,
        input.name,
        p.userId,
        storeNamespace(input.slug),
        storeHost(settings.hostTemplate, input.slug),
        settings.timeoutMs / 1000,
      ],
    );
    await client.query('COMMIT');
    return { store: publicStore(rows[0] as StoreRow), created: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function ownedStore(db: Db, p: Principal, id: string): Promise<StoreRow> {
  const parsed = z.uuid().safeParse(id);
  const row = parsed.success
    ? (await db.query<StoreRow>('SELECT * FROM stores WHERE id = $1', [id])).rows[0]
    : undefined;
  if (!row) throw new StoreError(404, 'store not found');
  if (p.role !== 'admin' && row.owner_id !== p.userId) throw new StoreError(403, 'not your store');
  return row;
}

/** A failed store gets a fresh deadline and is provisioned again (all steps are idempotent). */
export async function retryStore(db: Db, settings: StoreSettings, p: Principal, id: string) {
  const row = await ownedStore(db, p, id);
  if (row.status !== 'failed')
    throw new StoreError(409, `only failed stores can be retried (is ${row.status})`);
  const { rows } = await db.query<StoreRow>(
    `UPDATE stores SET status = 'provisioning', status_reason = 'Queued (retry)', attempt = attempt + 1,
       deadline_at = now() + make_interval(secs => $2), lease_until = NULL, updated_at = now()
     WHERE id = $1 AND status = 'failed' RETURNING *`,
    [id, settings.timeoutMs / 1000],
  );
  return publicStore((rows[0] ?? row) as StoreRow);
}

/** Marks a store for teardown. Idempotent; the provisioner removes registration, release and namespace. */
export async function deleteStore(db: Db, p: Principal, id: string) {
  const row = await ownedStore(db, p, id);
  await db.query(
    `UPDATE stores SET status = 'deleting', status_reason = 'Queued for deletion', lease_until = NULL,
       updated_at = now()
     WHERE id = $1 AND status <> 'deleting'`,
    [id],
  );
  // Tools disappear immediately for everyone, before the namespace is gone.
  await db.query('UPDATE upstream_servers SET enabled = false, updated_at = now() WHERE slug = $1', [
    storeServerSlug(row.slug),
  ]);
}
