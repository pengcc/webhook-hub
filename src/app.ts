import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { registerReadApi } from './read-api.js';
import { verifyShopifyHmac } from './shopify.js';

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

type AppDeps = {
  pool: Pool;
  config: Pick<Config, 'SHOPIFY_WEBHOOK_SECRET' | 'LOG_LEVEL'> &
    Partial<
      Pick<
        Config,
        | 'CORS_ALLOWED_ORIGINS'
        | 'RATE_LIMIT_MAX'
        | 'RATE_LIMIT_WINDOW_SECONDS'
        | 'TRUST_PROXY'
      >
    >;
  /** See registerReadApi. Tests set 0 to see fresh counts. */
  statsCacheMs?: number;
};

/** A hop count n trusts the n proxies closest to the app (same rule as proxy-addr). */
function trustProxyOption(value: boolean | number | string[]) {
  return typeof value === 'number'
    ? (_address: string, hop: number) => hop < value
    : value;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function buildApp({
  pool,
  config,
  statsCacheMs,
}: AppDeps): FastifyInstance {
  const options: FastifyServerOptions = {
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: trustProxyOption(config.TRUST_PROXY ?? false),
    logger: {
      level: config.LOG_LEVEL,
      // Never log signatures or payloads.
      redact: [
        'req.headers["x-shopify-hmac-sha256"]',
        'req.headers.authorization',
      ],
    },
  };
  const app = Fastify(options);

  // Browsers may call the read API only from the configured origins; with none
  // configured no CORS headers are sent at all.
  const corsOrigins = config.CORS_ALLOWED_ORIGINS ?? [];
  app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'HEAD', 'OPTIONS'],
    exposedHeaders: ['retry-after'],
    maxAge: 600,
  });

  // Signature verification needs the exact bytes that were sent.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  );

  app.get('/healthz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch (error) {
      app.log.error({ err: error }, 'health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.post('/webhooks/shopify', async (req, reply) => {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.code(415).send({ error: 'expected application/json' });
    }

    // 1. Authenticate before looking at anything else; store nothing on failure.
    const signature = header(req.headers['x-shopify-hmac-sha256']);
    if (!verifyShopifyHmac(rawBody, signature, config.SHOPIFY_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    // 2. Required delivery metadata.
    const eventId = header(req.headers['x-shopify-webhook-id']);
    const topic = header(req.headers['x-shopify-topic']);
    if (!eventId || !topic) {
      return reply.code(400).send({ error: 'missing delivery headers' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid json' });
    }

    // 3. Persist first, idempotently. A repeated delivery is a success.
    const result = await pool.query(
      `INSERT INTO events (source, event_id, correlation_id, topic, shop, payload)
       VALUES ('shopify', $1, $2, $3, $4, $5)
       ON CONFLICT (source, event_id) DO NOTHING
       RETURNING id`,
      [
        eventId,
        header(req.headers['x-shopify-event-id']) ?? null,
        topic,
        header(req.headers['x-shopify-shop-domain']) ?? null,
        JSON.stringify(payload),
      ]
    );

    const duplicate = result.rowCount === 0;
    req.log.info({ eventId, topic, duplicate }, 'webhook accepted');
    return reply
      .code(200)
      .send({ status: duplicate ? 'duplicate' : 'accepted' });
  });

  // Never send internal error text (database host, query details) to clients.
  app.setErrorHandler((error, req, reply) => {
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) {
      req.log.error({ err: error }, 'request failed');
      // Headers set before the error was thrown survive; never let a proxy cache a 5xx.
      return reply
        .code(status)
        .header('cache-control', 'no-store')
        .send({ error: 'internal error' });
    }
    return reply
      .code(status)
      .send({ error: error instanceof Error ? error.message : 'bad request' });
  });

  // Rate limiting is scoped to the read API: webhook deliveries come from the
  // platform's shared addresses and are authenticated by signature instead.
  // buildApp callers that omit RATE_LIMIT_MAX (tests) get no limiter.
  app.register(async (scope) => {
    const max = config.RATE_LIMIT_MAX;
    if (max !== undefined) {
      await scope.register(rateLimit, {
        max,
        timeWindow: (config.RATE_LIMIT_WINDOW_SECONDS ?? 60) * 1000,
      });
    }
    registerReadApi(scope, pool, { statsCacheMs });
  });

  return app;
}
