import type { FastifyBaseLogger } from 'fastify';
import pg, { type Pool, type PoolConfig } from 'pg';

/**
 * Connection settings for the read-only pool, as separate fields.
 *
 * Never pass `connectionString` here: pg merges the parsed URL over the
 * explicit options, a URL without a password yields an empty one, and pg then
 * falls back to PGPASSWORD, which holds the owner role's password. The read
 * pool would silently authenticate with the wrong password.
 */
export function readPoolConfig(
  url: string,
  password: string,
  extra: Partial<PoolConfig> = {}
): PoolConfig {
  const parsed = new URL(url);
  return {
    ...extra,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    password,
  };
}

export function createReadPool(config: {
  READ_DATABASE_URL?: string;
  READ_DATABASE_PASSWORD?: string;
}): Pool | undefined {
  if (!config.READ_DATABASE_URL || !config.READ_DATABASE_PASSWORD) {
    return undefined;
  }
  return new pg.Pool({
    ...readPoolConfig(config.READ_DATABASE_URL, config.READ_DATABASE_PASSWORD),
    max: 5,
  });
}

type Logger = Pick<FastifyBaseLogger, 'warn' | 'error'>;

/**
 * Without a read-only pool, buildApp falls back to the read-write pool for the
 * read API. That is fine locally; in production it is a misconfiguration.
 */
export function warnIfNoReadPool(
  readPool: Pool | undefined,
  logger: Logger
): void {
  if (readPool) return;
  logger.warn(
    'READ_DATABASE_URL and READ_DATABASE_PASSWORD are not set: the read API uses the read-write pool. Set both in production.'
  );
}

/**
 * Checks once that the read-only role can read the view. A wrong password, a
 * missing role or a missing grant would otherwise only show as 500s on the
 * read API, because /healthz uses the main pool. It logs instead of failing
 * startup: webhook ingestion matters more than the dashboard.
 */
export async function probeReadPool(
  readPool: Pool,
  logger: Logger
): Promise<boolean> {
  try {
    await readPool.query('SELECT 1 FROM events_public LIMIT 0');
    return true;
  } catch (error) {
    logger.error(
      { err: error },
      'read-only database role cannot read events_public: check the role, READ_DATABASE_PASSWORD and the grant (deploy/README.md, "Read-only role"). The read API will fail until this is fixed.'
    );
    return false;
  }
}
