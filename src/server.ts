import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { defaultHandlers } from './handlers.js';
import { migrate } from './migrate.js';
import {
  createReadPool,
  probeReadPool,
  warnIfNoReadPool,
} from './read-pool.js';
import { startWorker } from './worker.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

async function main() {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
  // The worker gets its own small pool so a backlog cannot starve webhook
  // ingestion or the health check of connections.
  const workerPool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 3,
  });
  // The read API uses its own pool with the read-only role when configured,
  // and falls back to the read-write pool (with a warning) otherwise.
  const readPool = createReadPool(config);
  const app = buildApp({ pool, readPool, config });
  warnIfNoReadPool(readPool, app.log);

  const applied = await migrate(pool, migrationsDir);
  if (applied.length > 0) app.log.info({ applied }, 'migrations applied');

  const worker = config.WORKER_ENABLED
    ? startWorker({
        pool: workerPool,
        handlers: defaultHandlers,
        logger: app.log,
        pollIntervalMs: config.WORKER_POLL_MS,
        batchSize: config.WORKER_BATCH_SIZE,
        maxAttempts: config.WORKER_MAX_ATTEMPTS,
        lockTimeoutSeconds: config.WORKER_LOCK_TIMEOUT_SECONDS,
        handlerTimeoutSeconds: config.WORKER_HANDLER_TIMEOUT_SECONDS,
      })
    : undefined;

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    // Stop taking new events before closing the HTTP server and the pool.
    await worker?.stop();
    await app.close();
    await workerPool.end();
    await readPool?.end();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
  // After migrations (the view exists) and after listen, without waiting: a
  // slow or broken read role must not delay webhook ingestion or /healthz.
  if (readPool) void probeReadPool(readPool, app.log);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
