import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export type Db = pg.Pool;

export function createDb(connectionString: string, options?: string): Db {
  return new pg.Pool({ connectionString, max: 10, options, connectionTimeoutMillis: 5000 });
}

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
// Arbitrary constant: serializes migrations when several gateway replicas start at once.
const MIGRATION_LOCK = 4242_0001;

/** Applies forward-only SQL migrations in order, each in its own transaction, under an advisory lock. */
export async function migrate(db: Db): Promise<string[]> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
