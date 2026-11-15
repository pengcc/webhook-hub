import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { signShopifyBody } from '../src/shopify.js';
import { createTestDb } from './helpers.js';

const secret = 'test-secret';

let db: Awaited<ReturnType<typeof createTestDb>>;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createTestDb();
  app = buildApp({
    pool: db.pool,
    config: { SHOPIFY_WEBHOOK_SECRET: secret, LOG_LEVEL: 'silent' },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

beforeEach(async () => {
  await db.pool.query('TRUNCATE events RESTART IDENTITY');
});

function deliver(
  body: string,
  overrides: Record<string, string | undefined> = {}
) {
  const headers: Record<string, string | undefined> = {
    'content-type': 'application/json',
    'x-shopify-hmac-sha256': signShopifyBody(body, secret),
    'x-shopify-webhook-id': 'wh-1',
    'x-shopify-event-id': 'ev-1',
    'x-shopify-topic': 'orders/create',
    'x-shopify-shop-domain': 'demo.myshopify.com',
    ...overrides,
  };
  for (const key of Object.keys(headers)) {
    if (headers[key] === undefined) delete headers[key];
  }
  return app.inject({
    method: 'POST',
    url: '/webhooks/shopify',
    headers: headers as Record<string, string>,
    payload: body,
  });
}

const count = async () =>
  Number((await db.pool.query('SELECT count(*) FROM events')).rows[0].count);

describe('GET /healthz', () => {
  it('reports ok when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('POST /webhooks/shopify', () => {
  it('stores a correctly signed event', async () => {
    const res = await deliver('{"id":42,"total_price":"10.00"}');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'accepted' });

    const { rows } = await db.pool.query('SELECT * FROM events');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'shopify',
      event_id: 'wh-1',
      correlation_id: 'ev-1',
      topic: 'orders/create',
      shop: 'demo.myshopify.com',
      status: 'pending',
      attempts: 0,
      payload: { id: 42, total_price: '10.00' },
    });
  });

  it('rejects a bad signature and stores nothing', async () => {
    const res = await deliver('{"id":1}', {
      'x-shopify-hmac-sha256': signShopifyBody('{"id":1}', 'wrong-secret'),
    });
    expect(res.statusCode).toBe(401);
    expect(await count()).toBe(0);
  });

  it('rejects a missing signature', async () => {
    const res = await deliver('{"id":1}', {
      'x-shopify-hmac-sha256': undefined,
    });
    expect(res.statusCode).toBe(401);
    expect(await count()).toBe(0);
  });

  it('rejects a body that does not match its signature', async () => {
    const signed = signShopifyBody('{"id":1}', secret);
    const res = await deliver('{"id":2}', { 'x-shopify-hmac-sha256': signed });
    expect(res.statusCode).toBe(401);
    expect(await count()).toBe(0);
  });

  it('answers 200 to a repeated delivery and keeps one row', async () => {
    const body = '{"id":7}';
    expect((await deliver(body)).json()).toEqual({ status: 'accepted' });
    const second = await deliver(body);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: 'duplicate' });
    expect(await count()).toBe(1);
  });

  it('stores exactly one row for concurrent identical deliveries', async () => {
    const body = '{"id":8}';
    const results = await Promise.all(
      Array.from({ length: 10 }, () => deliver(body))
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().status === 'accepted')).toHaveLength(
      1
    );
    expect(await count()).toBe(1);
  });

  it('treats different webhook ids with one event id as distinct deliveries', async () => {
    const body = '{"id":9}';
    await deliver(body, { 'x-shopify-webhook-id': 'wh-a' });
    await deliver(body, { 'x-shopify-webhook-id': 'wh-b' });
    expect(await count()).toBe(2);
  });

  it('rejects a signed request without delivery headers', async () => {
    const res = await deliver('{"id":1}', {
      'x-shopify-webhook-id': undefined,
    });
    expect(res.statusCode).toBe(400);
    expect(await count()).toBe(0);
  });

  it('rejects a signed body that is not valid JSON', async () => {
    const res = await deliver('not json', {
      'x-shopify-hmac-sha256': signShopifyBody('not json', secret),
    });
    expect(res.statusCode).toBe(400);
    expect(await count()).toBe(0);
  });

  it('rejects a body over the size limit', async () => {
    const res = await deliver(`"${'x'.repeat(1_100_000)}"`);
    expect(res.statusCode).toBe(413);
    expect(await count()).toBe(0);
  });
});
