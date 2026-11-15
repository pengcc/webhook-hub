import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './migrate.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

async function main() {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
  const app = buildApp({ pool, config });

  const applied = await migrate(pool, migrationsDir);
  if (applied.length > 0) app.log.info({ applied }, 'migrations applied');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
