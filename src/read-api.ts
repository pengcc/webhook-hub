import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';

/**
 * Read-only API for the dashboard. Payloads are deliberately not exposed: the
 * list and detail views show delivery metadata and processing state only.
 * Raw error text (`last_error`) is not exposed either; it can contain internal
 * details, so the API only says whether an error was recorded.
 */

const STATUSES = ['pending', 'processing', 'done', 'failed', 'dead'] as const;
type Status = (typeof STATUSES)[number];
const MAX_LIMIT = 100;

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  topic: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
  cursor: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
});

const idParam = z.object({
  id: z.string().regex(/^\d{1,18}$/),
});

// Reads go through the events_public view (migration 003), which leaves out
// the payload and the raw error text; the read-only role can see nothing else.
const EVENT_COLUMNS = `id, source, event_id, correlation_id, topic, shop, status,
  attempts, received_at, next_attempt_at, processed_at, has_error`;

type EventRow = {
  id: string;
  source: string;
  event_id: string;
  correlation_id: string | null;
  topic: string;
  shop: string | null;
  status: Status;
  attempts: number;
  received_at: Date;
  next_attempt_at: Date;
  processed_at: Date | null;
  has_error: boolean;
};

type ReadApiOptions = {
  /** How long /stats may be served from memory. 0 disables the cache. */
  statsCacheMs?: number;
};

type Stats = { total: number; by_status: Record<Status, number> };

async function loadStats(pool: Pool): Promise<Stats> {
  const { rows } = await pool.query<{ status: string; count: string }>(
    'SELECT status, count(*) AS count FROM events_public GROUP BY status'
  );
  const byStatus: Record<Status, number> = {
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    dead: 0,
  };
  for (const row of rows) {
    if (row.status in byStatus) {
      byStatus[row.status as Status] = Number(row.count);
    }
  }
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  return { total, by_status: byStatus };
}

export function registerReadApi(
  app: FastifyInstance,
  pool: Pool,
  { statsCacheMs = 5000 }: ReadApiOptions = {}
): void {
  // The count scans the whole table, so concurrent and repeated requests share
  // one query per window. A failed load is not cached.
  let statsCache: { at: number; value: Promise<Stats> } | undefined;
  app.get('/events', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid query' });
    }
    const { status, topic, limit, cursor } = parsed.data;

    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (topic) {
      params.push(topic);
      where.push(`topic = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor);
      where.push(`id < $${params.length}`);
    }
    params.push(limit + 1);

    // Keyset pagination on id: stable while new events arrive.
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM events_public ${whereSql}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      params
    );

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toEvent);
    const last = items.at(-1);
    return {
      items,
      next_cursor: hasMore && last ? last.id : null,
    };
  });

  app.get('/events/:id', async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(404).send({ error: 'not found' });
    }
    const { rows } = await pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM events_public WHERE id = $1`,
      [parsed.data.id]
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'not found' });
    return toEvent(row);
  });

  app.get('/stats', async (_req, reply) => {
    const now = Date.now();
    let entry = statsCache;
    if (!entry || now - entry.at >= statsCacheMs) {
      const value = loadStats(pool);
      const fresh = { at: now, value };
      entry = fresh;
      statsCache = fresh;
      value.catch(() => {
        if (statsCache === fresh) statsCache = undefined;
      });
    }
    // Await first: a failed load must not leave a cacheable header on the 500.
    const stats = await entry.value;
    reply.header(
      'cache-control',
      `public, max-age=${Math.floor(statsCacheMs / 1000)}`
    );
    return stats;
  });
}

function toEvent(row: EventRow) {
  return {
    id: row.id,
    source: row.source,
    event_id: row.event_id,
    correlation_id: row.correlation_id,
    topic: row.topic,
    shop: row.shop,
    status: row.status,
    attempts: row.attempts,
    received_at: row.received_at,
    next_attempt_at: row.next_attempt_at,
    processed_at: row.processed_at,
    has_error: row.has_error,
  };
}
