import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

const LOCK_KEY = 727_001;

/**
 * Applies `*.sql` files from `dir` in filename order, once each. Each file runs
 * in its own transaction. An advisory lock keeps concurrent starts from racing.
 */
export async function migrate(pool: Pool, dir: string): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const done = new Set(
      (
        await client.query<{ name: string }>(
          'SELECT name FROM schema_migrations'
        )
      ).rows.map((r) => r.name)
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
          file,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file} failed: ${(error as Error).message}`
        );
      }
      applied.push(file);
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
      .catch(() => {});
    client.release();
  }
  return applied;
}
