import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  probeReadPool,
  readPoolConfig,
  warnIfNoReadPool,
} from '../src/read-pool.js';
import { createTestDb } from './helpers.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let read: Awaited<ReturnType<typeof db.createReadRole>>;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createTestDb();
  read = await db.createReadRole();
  await db.pool.query(
    `INSERT INTO events (source, event_id, topic, payload, status, last_error)
     VALUES ('shopify', 'wh-1', 'orders/create', '{"id":1,"email":"buyer@example.com"}', 'dead', 'boom')`
  );
  app = buildApp({
    pool: db.pool,
    readPool: read.readPool,
    config: { SHOPIFY_WEBHOOK_SECRET: 'unused', LOG_LEVEL: 'silent' },
    statsCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const logger = () => ({ warn: vi.fn(), error: vi.fn() });

async function errorCode(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('read API on the read-only role', () => {
  it('serves list, detail and stats through the read pool', async () => {
    const list = await app.inject({ method: 'GET', url: '/events' });
    expect(list.statusCode).toBe(200);
    const [item] = list.json().items;
    expect(item).toMatchObject({ event_id: 'wh-1', has_error: true });
    expect(JSON.stringify(list.json())).not.toContain('buyer@example.com');

    const detail = await app.inject({
      method: 'GET',
      url: `/events/${item.id}`,
    });
    expect(detail.statusCode).toBe(200);

    const stats = await app.inject({ method: 'GET', url: '/stats' });
    expect(stats.json()).toMatchObject({ total: 1, by_status: { dead: 1 } });
  });

  it('uses the read pool, not the main pool', async () => {
    const spy = vi.spyOn(db.pool, 'query');
    await app.inject({ method: 'GET', url: '/events' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('read-only role permissions', () => {
  // 42501 is insufficient_privilege.
  it('cannot read the events table or the payload', async () => {
    expect(await errorCode(read.readPool.query('SELECT id FROM events'))).toBe(
      '42501'
    );
    expect(
      await errorCode(read.readPool.query('SELECT payload FROM events'))
    ).toBe('42501');
  });

  it('cannot write through the view or the table', async () => {
    expect(
      await errorCode(
        read.readPool.query("UPDATE events_public SET status = 'done'")
      )
    ).toBe('42501');
    expect(
      await errorCode(read.readPool.query('DELETE FROM events_public'))
    ).toBe('42501');
    expect(
      await errorCode(
        read.readPool.query(
          `INSERT INTO events (source, event_id, topic, payload)
           VALUES ('x', 'y', 'z', '{}')`
        )
      )
    ).toBe('42501');
  });

  it('sees no payload or error text in the view', async () => {
    const { fields } = await read.readPool.query(
      'SELECT * FROM events_public LIMIT 0'
    );
    const names = fields.map((f) => f.name);
    expect(names).toContain('has_error');
    expect(names).not.toContain('payload');
    expect(names).not.toContain('last_error');
  });
});

describe('read pool connection settings', () => {
  it('authenticates with its own password even when PGPASSWORD holds another one', async () => {
    // pg falls back to PGPASSWORD when a connection string carries no
    // password; the read pool must not, because in production PGPASSWORD is
    // the owner role's password.
    vi.stubEnv('PGPASSWORD', 'not-the-read-role-password');
    const fresh = read.makePool();
    const { rows } = await fresh.query<{ user: string }>(
      'SELECT current_user AS user'
    );
    expect(rows[0]?.user).toBe(read.role);
  });

  it('builds separate fields and never a connection string', () => {
    const config = readPoolConfig(
      'postgres://reader@db.internal:6543/app_db',
      'pw-value'
    );
    expect(config).toEqual({
      host: 'db.internal',
      port: 6543,
      user: 'reader',
      database: 'app_db',
      password: 'pw-value',
    });
    expect(config).not.toHaveProperty('connectionString');
    expect(readPoolConfig('postgres://reader@db/app_db', 'pw-value').port).toBe(
      5432
    );
  });
});

describe('startup checks', () => {
  it('probe passes for a granted role and logs nothing', async () => {
    const log = logger();
    expect(await probeReadPool(read.readPool, log)).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('probe logs an error, without throwing, when the grant is missing', async () => {
    const ungranted = await db.createReadRole({ grant: false });
    const log = logger();
    expect(await probeReadPool(ungranted.readPool, log)).toBe(false);
    expect(log.error).toHaveBeenCalledOnce();
    expect(String(log.error.mock.calls[0]?.[1])).toContain('events_public');
  });

  it('warns when no read pool is configured, and only then', () => {
    const log = logger();
    warnIfNoReadPool(undefined, log);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('READ_DATABASE_URL');

    const quiet = logger();
    warnIfNoReadPool(new pg.Pool(), quiet);
    expect(quiet.warn).not.toHaveBeenCalled();
  });
});

describe('READ_* configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://webhook_hub@db/webhook_hub',
    SHOPIFY_WEBHOOK_SECRET: 'unused',
  };
  const readUrl = 'postgres://webhook_hub_read@db:5432/webhook_hub';

  it('accepts both or neither', () => {
    expect(loadConfig(base).READ_DATABASE_URL).toBeUndefined();
    const both = loadConfig({
      ...base,
      READ_DATABASE_URL: readUrl,
      READ_DATABASE_PASSWORD: 'pw-value',
    });
    expect(both.READ_DATABASE_URL).toBe(readUrl);
    expect(
      loadConfig({ ...base, READ_DATABASE_URL: '', READ_DATABASE_PASSWORD: '' })
        .READ_DATABASE_URL
    ).toBeUndefined();
  });

  it('rejects one without the other, naming the variable only', () => {
    expect(() => loadConfig({ ...base, READ_DATABASE_URL: readUrl })).toThrow(
      'READ_DATABASE_PASSWORD'
    );
    expect(() =>
      loadConfig({ ...base, READ_DATABASE_PASSWORD: 'pw-value' })
    ).toThrow('READ_DATABASE_URL');
  });

  it('rejects a URL with a password, another scheme, or no user or database', () => {
    const withPassword = new URL(readUrl);
    withPassword.password = 'pw-value';
    for (const bad of [
      withPassword.href,
      'mysql://webhook_hub_read@db/webhook_hub',
      'postgres://db/webhook_hub',
      'postgres://webhook_hub_read@db',
      'not a url',
    ]) {
      expect(() =>
        loadConfig({
          ...base,
          READ_DATABASE_URL: bad,
          READ_DATABASE_PASSWORD: 'pw-value',
        })
      ).toThrow('READ_DATABASE_URL');
    }
    // The message names the variable, never the value.
    try {
      loadConfig({
        ...base,
        READ_DATABASE_URL: withPassword.href,
        READ_DATABASE_PASSWORD: 'pw-value',
      });
    } catch (error) {
      expect((error as Error).message).not.toContain('pw-value');
    }
  });
});
