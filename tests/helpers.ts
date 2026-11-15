import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

// Defaults match compose.yaml (throwaway local credentials). The password is
// supplied through PGPASSWORD so no URL in the repository embeds credentials.
process.env.PGPASSWORD ??= 'webhook_hub_dev';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://webhook_hub@127.0.0.1:5432/webhook_hub';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Creates an isolated schema in the test database, migrates it, and returns a
 * pool whose connections are pinned to it. `drop()` removes everything.
 */
export async function createTestDb() {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  await migrate(pool, migrationsDir);
  return {
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
