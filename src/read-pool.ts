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
  return { ...extra, ...parseReadDatabaseUrl(url), password };
}

/**
 * Strict parse of `postgres://user@host[:port]/database`. Config validation
 * uses the same function, so a URL that passes validation is exactly what the
 * pool gets. Anything this does not carry over is rejected rather than
 * silently dropped: query parameters (sslmode=...), a fragment, a password,
 * extra path segments, bad percent escapes, port 0. IPv6 brackets are removed.
 * Errors never include the URL.
 */
export function parseReadDatabaseUrl(value: string): {
  host: string;
  port: number;
  user: string;
  database: string;
} {
  const invalid = (why: string) =>
    new Error(`READ_DATABASE_URL is invalid: ${why}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('not a URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw invalid('scheme must be postgres');
  }
  if (url.password !== '') throw invalid('must not contain a password');
  if (url.search !== '' || url.hash !== '') {
    throw invalid('query parameters and fragments are not supported');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const path = url.pathname.replace(/^\//, '');
  if (host === '') throw invalid('missing host');
  if (path === '' || path.includes('/')) {
    throw invalid('path must be a single database name');
  }
  const port = url.port === '' ? 5432 : Number(url.port);
  if (port < 1) throw invalid('bad port');
  let user: string;
  let database: string;
  try {
    user = decodeURIComponent(url.username);
    database = decodeURIComponent(path);
  } catch {
    throw invalid('bad percent escape');
  }
  if (user === '') throw invalid('missing user');
  return { host, port, user, database };
}

export const READ_POOL_CONNECT_TIMEOUT_MS = 5000;

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
    // pg waits forever by default; fail a read request instead of hanging.
    connectionTimeoutMillis: READ_POOL_CONNECT_TIMEOUT_MS,
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
 * missing role or a missing grant (CONNECT on the database, SELECT on the view)
 * would otherwise only show as 500s on the read API, because /healthz uses the
 * main pool. It logs instead of failing startup, and the server runs it after
 * listen() without waiting: webhook ingestion matters more than the dashboard.
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
