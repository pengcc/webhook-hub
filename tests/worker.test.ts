import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultHandlers } from '../src/handlers.js';
import {
  type Handler,
  PermanentError,
  runOnce,
  startWorker,
} from '../src/worker.js';
import { createTestDb } from './helpers.js';

const logger = { info() {}, warn() {}, error() {} };

let db: Awaited<ReturnType<typeof createTestDb>>;
let pool: Pool;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE events RESTART IDENTITY');
});

async function insertEvent(
  overrides: {
    topic?: string;
    payload?: unknown;
    status?: string;
    attempts?: number;
    lockedAtSecondsAgo?: number;
  } = {}
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO events
       (source, event_id, topic, payload, status, attempts, locked_at)
     VALUES ('shopify', $1, $2, $3, $4, $5,
             CASE WHEN $6::int IS NULL THEN NULL
                  ELSE now() - make_interval(secs => $6::int) END)
     RETURNING id`,
    [
      randomUUID(),
      overrides.topic ?? 'orders/create',
      JSON.stringify(overrides.payload ?? { id: 1 }),
      overrides.status ?? 'pending',
      overrides.attempts ?? 0,
      overrides.lockedAtSecondsAgo ?? null,
    ]
  );
  return rows[0]!.id;
}

async function getEvent(id: string) {
  const { rows } = await pool.query(
    `SELECT status, attempts, last_error, processed_at, locked_at,
            extract(epoch FROM (next_attempt_at - now())) AS due_in_seconds
       FROM events WHERE id = $1`,
    [id]
  );
  return rows[0];
}

/** Make a failed event due again without waiting for the real backoff. */
async function makeDue(id: string) {
  await pool.query(
    `UPDATE events SET next_attempt_at = now() - interval '1 second' WHERE id = $1`,
    [id]
  );
}

const ok: Handler = async () => {};
const boom: Handler = async () => {
  throw new Error('downstream unavailable');
};
const options = (handlers: Record<string, Handler>) => ({
  pool,
  handlers,
  logger,
  backoff: { random: () => 0 },
});

describe('runOnce', () => {
  it('processes a pending event to done', async () => {
    const id = await insertEvent();
    const result = await runOnce(options({ 'shopify:orders/create': ok }));

    expect(result).toEqual({ claimed: 1, done: 1, retrying: 0, dead: 0 });
    const row = await getEvent(id);
    expect(row).toMatchObject({
      status: 'done',
      attempts: 1,
      last_error: null,
    });
    expect(row.processed_at).not.toBeNull();
    expect(row.locked_at).toBeNull();
  });

  it('marks events without a handler as done instead of failing them', async () => {
    const id = await insertEvent({ topic: 'products/update' });
    await runOnce(options({}));
    expect(await getEvent(id)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('schedules a failed event for a later retry and does not re-claim it early', async () => {
    const id = await insertEvent();
    const result = await runOnce(options({ 'shopify:orders/create': boom }));

    expect(result).toMatchObject({ claimed: 1, retrying: 1, done: 0, dead: 0 });
    const row = await getEvent(id);
    expect(row).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'downstream unavailable',
    });
    // attempt 1, base 5s, random=0 -> 2.5s from now
    expect(Number(row.due_in_seconds)).toBeGreaterThan(1);
    expect(Number(row.due_in_seconds)).toBeLessThan(5.5);

    const second = await runOnce(options({ 'shopify:orders/create': ok }));
    expect(second.claimed).toBe(0);
  });

  it('retries once due and recovers: failed then done, error cleared', async () => {
    const id = await insertEvent();
    await runOnce(options({ 'shopify:orders/create': boom }));
    await makeDue(id);
    const result = await runOnce(options({ 'shopify:orders/create': ok }));

    expect(result.done).toBe(1);
    expect(await getEvent(id)).toMatchObject({
      status: 'done',
      attempts: 2,
      last_error: null,
    });
  });

  it('moves an event to dead after maxAttempts and never claims it again', async () => {
    const id = await insertEvent();
    const opts = {
      ...options({ 'shopify:orders/create': boom }),
      maxAttempts: 3,
    };

    await runOnce(opts);
    await makeDue(id);
    await runOnce(opts);
    expect((await getEvent(id)).status).toBe('failed');
    await makeDue(id);
    const last = await runOnce(opts);

    expect(last.dead).toBe(1);
    expect(await getEvent(id)).toMatchObject({
      status: 'dead',
      attempts: 3,
      last_error: 'downstream unavailable',
    });
    await makeDue(id);
    expect((await runOnce(opts)).claimed).toBe(0);
  });

  it('sends a PermanentError straight to dead on the first attempt', async () => {
    const id = await insertEvent();
    const permanent: Handler = async () => {
      throw new PermanentError('bad payload');
    };
    const result = await runOnce(
      options({ 'shopify:orders/create': permanent })
    );

    expect(result.dead).toBe(1);
    expect(await getEvent(id)).toMatchObject({
      status: 'dead',
      attempts: 1,
      last_error: 'bad payload',
    });
  });

  it('does not let concurrent workers handle the same event twice', async () => {
    const ids = await Promise.all(
      Array.from({ length: 30 }, () => insertEvent())
    );
    const seen: string[] = [];
    const record: Handler = async (event) => {
      seen.push(event.id);
      await new Promise((r) => setTimeout(r, 5));
    };
    const opts = {
      ...options({ 'shopify:orders/create': record }),
      batchSize: 4,
    };

    for (let i = 0; i < 20; i++) {
      const results = await Promise.all([
        runOnce(opts),
        runOnce(opts),
        runOnce(opts),
      ]);
      if (results.every((r) => r.claimed === 0)) break;
    }

    expect(seen).toHaveLength(30);
    expect(new Set(seen)).toEqual(new Set(ids));
    const { rows } = await pool.query(
      `SELECT count(*) FROM events WHERE status = 'done' AND attempts = 1`
    );
    expect(Number(rows[0].count)).toBe(30);
  });
});

describe('crash recovery', () => {
  it('reclaims an event stuck in processing past the lock timeout', async () => {
    const id = await insertEvent({
      status: 'processing',
      attempts: 1,
      lockedAtSecondsAgo: 600,
    });
    const result = await runOnce({
      ...options({ 'shopify:orders/create': ok }),
      lockTimeoutSeconds: 300,
    });

    expect(result.done).toBe(1);
    // the crashed attempt counted: attempts went 1 -> 2
    expect(await getEvent(id)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('leaves a recently locked event alone', async () => {
    const id = await insertEvent({
      status: 'processing',
      attempts: 1,
      lockedAtSecondsAgo: 10,
    });
    const result = await runOnce({
      ...options({ 'shopify:orders/create': ok }),
      lockTimeoutSeconds: 300,
    });

    expect(result.claimed).toBe(0);
    expect(await getEvent(id)).toMatchObject({
      status: 'processing',
      attempts: 1,
    });
  });

  it('does not let a slow worker overwrite the result after its lock was reclaimed', async () => {
    const id = await insertEvent();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Handler = async () => {
      await blocked;
      throw new Error('late failure from the slow worker');
    };

    // Worker A claims the event (attempt 1) and hangs in the handler.
    const slowRun = runOnce({
      ...options({ 'shopify:orders/create': slow }),
      lockTimeoutSeconds: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    // Worker B treats the lock as expired, reclaims (attempt 2) and succeeds.
    const fast = await runOnce({
      ...options({ 'shopify:orders/create': ok }),
      lockTimeoutSeconds: 0,
    });
    expect(fast.done).toBe(1);

    // A finally fails, but its update is fenced out by the attempts counter.
    release();
    const slowResult = await slowRun;
    expect(slowResult).toEqual({ claimed: 1, done: 0, retrying: 0, dead: 0 });
    expect(await getEvent(id)).toMatchObject({
      status: 'done',
      attempts: 2,
      last_error: null,
    });
  });
});

describe('defaultHandlers', () => {
  it('accepts an order payload and dead-letters one that cannot be an order', async () => {
    const good = await insertEvent({
      payload: { id: 123, total_price: '9.99' },
    });
    const bad = await insertEvent({ payload: { note: 'no id here' } });

    const result = await runOnce(options(defaultHandlers));

    expect(result).toMatchObject({ claimed: 2, done: 1, dead: 1 });
    expect((await getEvent(good)).status).toBe('done');
    expect(await getEvent(bad)).toMatchObject({
      status: 'dead',
      attempts: 1,
    });
  });
});

describe('startWorker', () => {
  it('picks up new events in the background and stops promptly', async () => {
    const worker = startWorker({
      ...options({ 'shopify:orders/create': ok }),
      pollIntervalMs: 20,
    });
    const id = await insertEvent();

    const deadline = Date.now() + 3000;
    let status = 'pending';
    while (Date.now() < deadline && status !== 'done') {
      await new Promise((r) => setTimeout(r, 25));
      status = (await getEvent(id)).status;
    }
    expect(status).toBe('done');

    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
