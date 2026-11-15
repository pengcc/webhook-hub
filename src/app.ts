import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { verifyShopifyHmac } from './shopify.js';

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

type AppDeps = {
  pool: Pool;
  config: Pick<Config, 'SHOPIFY_WEBHOOK_SECRET' | 'LOG_LEVEL'>;
};

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function buildApp({ pool, config }: AppDeps): FastifyInstance {
  const app = Fastify({
    bodyLimit: MAX_BODY_BYTES,
    logger: {
      level: config.LOG_LEVEL,
      // Never log signatures or payloads.
      redact: [
        'req.headers["x-shopify-hmac-sha256"]',
        'req.headers.authorization',
      ],
    },
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

  return app;
}
