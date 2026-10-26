import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export type Db = pg.Pool;

export function createDb(connectionString: string, options?: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    options,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
  });
  // A Postgres restart or failover kills idle pooled connections; pg reports that as an 'error' event on
  // the pool, which crashes the process if nobody listens. Log it and let the pool open fresh connections.
  pool.on('error', (err) =>
    console.error(JSON.stringify({ msg: 'idle database connection lost', error: String(err) })),
  );
  return pool;
}

/** Waits for Postgres to accept connections (it usually starts alongside the gateway on `helm install`). */
export async function waitForDb(db: Db, attempts = 60, delayMs = 2000): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= attempts) throw new Error(`database unavailable after ${attempts} attempts: ${err}`);
      console.error(JSON.stringify({ msg: 'waiting for database', attempt, error: String(err) }));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
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
