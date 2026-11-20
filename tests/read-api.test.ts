import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createTestDb } from './helpers.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createTestDb();
  app = buildApp({
    pool: db.pool,
    config: { SHOPIFY_WEBHOOK_SECRET: 'unused', LOG_LEVEL: 'silent' },
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

async function insert(
  i: number,
  overrides: { topic?: string; status?: string; payload?: unknown } = {}
): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO events (source, event_id, correlation_id, topic, shop, status, payload, last_error)
     VALUES ('shopify', $1, $2, $3, 'demo.myshopify.com', $4, $5, $6)
     RETURNING id`,
    [
      `wh-${i}`,
      `ev-${i}`,
      overrides.topic ?? 'orders/create',
      overrides.status ?? 'done',
      JSON.stringify(
        overrides.payload ?? { id: i, email: 'secret@example.com' }
      ),
      overrides.status === 'dead' ? 'boom' : null,
    ]
  );
  return rows[0]!.id;
}

describe('GET /events', () => {
  it('lists newest first without exposing payloads', async () => {
    await insert(1);
    await insert(2);

    const res = await app.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((e: { event_id: string }) => e.event_id)).toEqual([
      'wh-2',
      'wh-1',
    ]);
    expect(body.next_cursor).toBeNull();
    expect(JSON.stringify(body)).not.toContain('secret@example.com');
    expect(body.items[0]).not.toHaveProperty('payload');
  });

  it('pages with a cursor and returns each event exactly once', async () => {
    for (let i = 1; i <= 5; i++) await insert(i);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = cursor
        ? `/events?limit=2&cursor=${cursor}`
        : '/events?limit=2';
      const res = await app.inject({ method: 'GET', url });
      const body = res.json<{
        items: { event_id: string }[];
        next_cursor: string | null;
      }>();
      seen.push(...body.items.map((e) => e.event_id));
      cursor = body.next_cursor;
    } while (cursor);

    expect(seen).toEqual(['wh-5', 'wh-4', 'wh-3', 'wh-2', 'wh-1']);
  });

  it('filters by status and topic', async () => {
    await insert(1, { status: 'dead' });
    await insert(2, { status: 'done', topic: 'orders/updated' });
    await insert(3, { status: 'dead', topic: 'orders/updated' });

    const dead = (
      await app.inject({ method: 'GET', url: '/events?status=dead' })
    ).json();
    expect(dead.items.map((e: { event_id: string }) => e.event_id)).toEqual([
      'wh-3',
      'wh-1',
    ]);

    const updated = (
      await app.inject({
        method: 'GET',
        url: '/events?topic=orders/updated&status=dead',
      })
    ).json();
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0].event_id).toBe('wh-3');
    expect(updated.items[0].last_error).toBe('boom');
  });

  it('rejects invalid query parameters', async () => {
    for (const url of [
      '/events?status=bogus',
      '/events?limit=0',
      '/events?limit=101',
      '/events?cursor=abc',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
    }
  });
});

describe('GET /events/:id', () => {
  it('returns one event without its payload', async () => {
    const id = await insert(1, { status: 'dead' });
    const res = await app.inject({ method: 'GET', url: `/events/${id}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id,
      status: 'dead',
      topic: 'orders/create',
      event_id: 'wh-1',
      last_error: 'boom',
    });
    expect(body).not.toHaveProperty('payload');
  });

  it('returns 404 for unknown and malformed ids', async () => {
    for (const url of ['/events/999999', '/events/abc', '/events/-1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe('GET /stats', () => {
  it('counts events per status, including zeros', async () => {
    expect((await app.inject({ method: 'GET', url: '/stats' })).json()).toEqual(
      {
        total: 0,
        by_status: { pending: 0, processing: 0, done: 0, failed: 0, dead: 0 },
      }
    );

    await insert(1, { status: 'done' });
    await insert(2, { status: 'done' });
    await insert(3, { status: 'dead' });

    expect((await app.inject({ method: 'GET', url: '/stats' })).json()).toEqual(
      {
        total: 3,
        by_status: { pending: 0, processing: 0, done: 2, failed: 0, dead: 1 },
      }
    );
  });
});
