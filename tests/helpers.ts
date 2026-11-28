import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { readPoolConfig } from '../src/read-pool.js';

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
  const database = decodeURIComponent(
    new URL(TEST_DATABASE_URL).pathname.slice(1)
  );
  const readPools: pg.Pool[] = [];
  const roles: string[] = [];
  return {
    pool,
    schema,
    /**
     * A temporary login role with the same rights as the production read-only
     * role (CONNECT on the database, usage on the schema, SELECT on
     * events_public), or with no grant at all. CONNECT is granted explicitly
     * although the local and CI databases still give it to PUBLIC; production
     * revokes it. Roles are cluster-wide, so the name is random with a fixed prefix
     * (`test_read_`) to make leftovers from a crashed run easy to find.
     */
    async createReadRole(options: { grant?: boolean } = {}) {
      const role = `test_read_${randomBytes(6).toString('hex')}`;
      const roleSecret = randomBytes(16).toString('hex');
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${roleSecret}'`);
      roles.push(role);
      if (options.grant ?? true) {
        await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
        await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
        await admin.query(`GRANT SELECT ON ${schema}.events_public TO ${role}`);
      }
      const url = new URL(TEST_DATABASE_URL);
      url.username = role;
      const config = readPoolConfig(url.href, roleSecret, {
        options: `-c search_path=${schema}`,
      });
      const makePool = () => {
        const readPool = new pg.Pool(config);
        readPools.push(readPool);
        return readPool;
      };
      return { role, readPool: makePool(), makePool };
    },
    async drop() {
      // Order matters: a role cannot be dropped while it still holds
      // privileges on objects in the schema.
      await Promise.all(readPools.map((p) => p.end()));
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      // DROP OWNED also revokes the database-level CONNECT grant.
      for (const role of roles) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      await admin.end();
    },
  };
}
