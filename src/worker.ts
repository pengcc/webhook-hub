import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import { type BackoffOptions, retryDelaySeconds } from './backoff.js';

/** Throw from a handler when retrying cannot help; the event goes straight to `dead`. */
export class PermanentError extends Error {
  override name = 'PermanentError';
}

export type WorkerEvent = {
  id: string;
  source: string;
  topic: string;
  payload: unknown;
  /** Attempts including the current one. */
  attempts: number;
};

export type Handler = (event: WorkerEvent) => Promise<void>;

export type WorkerOptions = {
  pool: Pool;
  /** Keyed by `${source}:${topic}`. Events without a handler are marked done. */
  handlers: Record<string, Handler>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  batchSize?: number;
  maxAttempts?: number;
  lockTimeoutSeconds?: number;
  backoff?: BackoffOptions;
};

export type RunResult = {
  claimed: number;
  done: number;
  retrying: number;
  dead: number;
};

const MAX_ERROR_LENGTH = 1000;

type ClaimedRow = {
  id: string;
  source: string;
  topic: string;
  payload: unknown;
  attempts: number;
};

/**
 * Claims due events and processes them once. Due means: pending or failed with
 * next_attempt_at reached, or stuck in `processing` past the lock timeout.
 * FOR UPDATE SKIP LOCKED lets several workers share the queue without
 * handling the same event twice.
 */
export async function runOnce(options: WorkerOptions): Promise<RunResult> {
  const {
    pool,
    handlers,
    logger,
    batchSize = 10,
    maxAttempts = 8,
    lockTimeoutSeconds = 300,
    backoff,
  } = options;

  const claimed = await pool.query<ClaimedRow>(
    `WITH due AS (
       SELECT id FROM events
       WHERE (status IN ('pending', 'failed') AND next_attempt_at <= now())
          OR (status = 'processing'
              AND locked_at < now() - make_interval(secs => $2))
       ORDER BY next_attempt_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE events e
        SET status = 'processing', locked_at = now(), attempts = e.attempts + 1
       FROM due
      WHERE e.id = due.id
     RETURNING e.id, e.source, e.topic, e.payload, e.attempts`,
    [batchSize, lockTimeoutSeconds]
  );

  const result: RunResult = {
    claimed: claimed.rows.length,
    done: 0,
    retrying: 0,
    dead: 0,
  };

  await Promise.all(
    claimed.rows.map(async (row) => {
      const event: WorkerEvent = row;
      const handler = handlers[`${row.source}:${row.topic}`];
      try {
        if (handler) await handler(event);
        else logger.info({ id: row.id, topic: row.topic }, 'no handler, done');
        if (await markDone(pool, row)) result.done++;
      } catch (error) {
        const message = String(
          error instanceof Error ? error.message : error
        ).slice(0, MAX_ERROR_LENGTH);
        const permanent = error instanceof PermanentError;
        if (permanent || row.attempts >= maxAttempts) {
          if (await markDead(pool, row, message)) result.dead++;
          logger.error(
            { id: row.id, topic: row.topic, attempts: row.attempts, permanent },
            'event moved to dead letters'
          );
        } else {
          const delay = retryDelaySeconds(row.attempts, backoff);
          if (await markRetry(pool, row, message, delay)) result.retrying++;
          logger.warn(
            { id: row.id, topic: row.topic, attempts: row.attempts, delay },
            'event failed, will retry'
          );
        }
      }
    })
  );

  return result;
}

// Each update is fenced by `attempts`: if the lock timed out and another worker
// reclaimed the event, attempts has moved on and this update changes nothing.

async function markDone(pool: Pool, row: ClaimedRow): Promise<boolean> {
  const res = await pool.query(
    `UPDATE events
        SET status = 'done', processed_at = now(), last_error = NULL, locked_at = NULL
      WHERE id = $1 AND status = 'processing' AND attempts = $2`,
    [row.id, row.attempts]
  );
  return res.rowCount === 1;
}

async function markRetry(
  pool: Pool,
  row: ClaimedRow,
  message: string,
  delaySeconds: number
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE events
        SET status = 'failed', last_error = $3, locked_at = NULL,
            next_attempt_at = now() + make_interval(secs => $4)
      WHERE id = $1 AND status = 'processing' AND attempts = $2`,
    [row.id, row.attempts, message, delaySeconds]
  );
  return res.rowCount === 1;
}

async function markDead(
  pool: Pool,
  row: ClaimedRow,
  message: string
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE events
        SET status = 'dead', last_error = $3, locked_at = NULL
      WHERE id = $1 AND status = 'processing' AND attempts = $2`,
    [row.id, row.attempts, message]
  );
  return res.rowCount === 1;
}

export type WorkerLoop = { stop(): Promise<void> };

/** Polls until stopped. Drains immediately while batches come back full. */
export function startWorker(
  options: WorkerOptions & { pollIntervalMs?: number }
): WorkerLoop {
  const { pollIntervalMs = 1000, batchSize = 10, logger } = options;
  const controller = new AbortController();

  const loop = (async () => {
    while (!controller.signal.aborted) {
      let busy = false;
      try {
        busy = (await runOnce(options)).claimed >= batchSize;
      } catch (error) {
        logger.error({ err: error }, 'worker iteration failed');
      }
      if (!busy) {
        try {
          await sleep(pollIntervalMs, undefined, { signal: controller.signal });
        } catch {
          // aborted while waiting: leave the loop
        }
      }
    }
  })();

  return {
    async stop() {
      controller.abort();
      await loop;
    },
  };
}
