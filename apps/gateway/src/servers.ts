import * as z from 'zod/v4';
import { encrypt } from './crypto.ts';
import type { Db } from './db.ts';
import type { ServerRow, UpstreamPool } from './upstreams.ts';
import { validateUpstreamUrl } from './url-guard.ts';

// Admin CRUD for upstream servers. Credentials are write-only: accepted here, encrypted, never returned.

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
]);

export const serverInput = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/, 'lowercase letters, digits and "-", max 24'),
    name: z.string().trim().min(1).max(80),
    url: z.string().max(2000),
    enabled: z.boolean().default(true),
    authType: z.enum(['none', 'bearer', 'header']).default('none'),
    authHeader: z
      .string()
      .regex(HEADER_NAME)
      .refine((h) => !FORBIDDEN_HEADERS.has(h.toLowerCase()), 'reserved header')
      .nullish(),
    /** undefined = keep existing, null = clear, string = replace */
    credential: z.string().min(1).max(4096).nullish(),
    timeoutMs: z.number().int().min(1000).max(60000).default(10000),
    adminOnlyTools: z.array(z.string().max(128)).max(200).default([]),
  })
  .refine((s) => s.authType !== 'header' || !!s.authHeader, {
    message: 'authHeader required',
    path: ['authHeader'],
  });
export type ServerInput = z.infer<typeof serverInput>;

export interface ServerDeps {
  db: Db;
  pool: UpstreamPool;
  key: Buffer;
  allowedHosts: string[];
}

export async function createServer(d: ServerDeps, input: ServerInput): Promise<ServerRow> {
  const url = await validateUpstreamUrl(input.url, d.allowedHosts);
  const { rows } = await d.db.query<ServerRow>(
    `INSERT INTO upstream_servers (slug, name, url, enabled, auth_type, auth_header, credential_enc, timeout_ms, admin_only_tools)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      input.slug,
      input.name,
      url,
      input.enabled,
      input.authType,
      input.authType === 'header' ? input.authHeader : null,
      input.credential ? encrypt(d.key, input.credential) : null,
      input.timeoutMs,
      input.adminOnlyTools,
    ],
  );
  const row = rows[0] as ServerRow;
  await d.pool.check(row);
  return row;
}

export async function updateServer(d: ServerDeps, id: string, input: ServerInput): Promise<ServerRow | null> {
  const url = await validateUpstreamUrl(input.url, d.allowedHosts);
  const { rows } = await d.db.query<ServerRow>(
    `UPDATE upstream_servers SET slug = $2, name = $3, url = $4, enabled = $5, auth_type = $6, auth_header = $7,
       credential_enc = CASE WHEN $11 THEN $8::bytea ELSE credential_enc END, timeout_ms = $9, admin_only_tools = $10, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id,
      input.slug,
      input.name,
      url,
      input.enabled,
      input.authType,
      input.authType === 'header' ? input.authHeader : null,
      input.credential ? encrypt(d.key, input.credential) : null,
      input.timeoutMs,
      input.adminOnlyTools,
      input.credential !== undefined, // undefined = keep the stored credential
    ],
  );
  const row = rows[0];
  if (row) await d.pool.check(row);
  return row ?? null;
}

/** What the dashboard sees. No credential, only whether one is set. */
export function publicServer(row: ServerRow, pool: UpstreamPool) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    authType: row.auth_type,
    authHeader: row.auth_header,
    hasCredential: row.credential_enc !== null,
    timeoutMs: row.timeout_ms,
    adminOnlyTools: row.admin_only_tools,
    status: row.enabled ? row.status : 'disabled',
    lastError: row.last_error,
    lastCheckedAt: row.last_checked_at,
    tools: pool.tools(row).map((t) => ({
      name: t.name,
      exposedName: t.exposedName,
      description: t.description ?? '',
      adminOnly: row.admin_only_tools.includes(t.name),
      readOnly: t.annotations?.readOnlyHint === true,
    })),
  };
}

/**
 * Registers servers from deployment config (a Kubernetes Secret) on first start only.
 * Existing slugs are left untouched, so later edits made by an admin in the dashboard win.
 */
export async function seedServers(d: ServerDeps, json: string): Promise<string[]> {
  const list = z.array(serverInput).parse(JSON.parse(json));
  const created: string[] = [];
  for (const s of list) {
    const exists = await d.db.query('SELECT 1 FROM upstream_servers WHERE slug = $1', [s.slug]);
    if (exists.rowCount) continue;
    // Seed URLs come from the operator, not the dashboard, but they pass the same URL policy.
    try {
      await createServer(d, s);
      created.push(s.slug);
    } catch (err) {
      // Another replica starting at the same time inserted this slug first: nothing left to do.
      if ((err as { code?: string }).code === '23505') continue;
      throw new Error(`seed server ${s.slug}: ${(err as Error).message}`);
    }
  }
  return created;
}
