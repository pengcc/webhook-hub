import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultHandlers } from '../src/handlers.js';
import { runOnce } from '../src/worker.js';
import {
  buildDeliveries,
  main,
  orderIdBase,
  SCENARIOS,
  sendDelivery,
  webhookUrl,
} from '../scripts/simulate.js';
import { createTestDb } from './helpers.js';

const secret = 'test-secret';
const otherSecret = 'other-test-secret';
const logger = { info() {}, warn() {}, error() {} };

let db: Awaited<ReturnType<typeof createTestDb>>;
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  db = await createTestDb();
  app = buildApp({
    pool: db.pool,
    config: {
      SHOPIFY_WEBHOOK_SECRET: secret,
      LOG_LEVEL: 'silent',
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

beforeEach(async () => {
  await db.pool.query('TRUNCATE events RESTART IDENTITY');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Built at runtime so no credential-bearing URL literal sits in the source.
function withUserinfo(base: string, password: string): string {
  const url = new URL(base);
  url.username = 'user';
  url.password = password;
  return url.href;
}

const options = (count = 1) => ({
  runId: 'testrun',
  count,
  secret,
  scenarios: SCENARIOS,
  shop: 'demo.myshopify.com',
});

describe('buildDeliveries', () => {
  it('makes unique webhook ids per run, except the deliberate duplicate', () => {
    const deliveries = buildDeliveries(options(3));
    const ids = deliveries.map((d) => d.headers['x-shopify-webhook-id']);
    const repeats = deliveries.filter((d) => d.label.includes('(repeat)'));
    expect(repeats).toHaveLength(3);
    expect(new Set(ids).size).toBe(ids.length - repeats.length);
    expect(ids.every((id) => id?.startsWith('sim-testrun-'))).toBe(true);
  });

  it('gives orders ids that differ between runs and stay safe integers', () => {
    const orderIds = (runId: string) =>
      buildDeliveries({ ...options(2), runId })
        .filter((d) => !d.label.includes('(repeat)'))
        .map((d) => (JSON.parse(d.body) as { id?: number }).id)
        .filter((id): id is number => id !== undefined);
    const a = orderIds('run-a');
    const b = orderIds('run-b');
    expect(new Set(a).size).toBe(a.length);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect([...a, ...b].every(Number.isSafeInteger)).toBe(true);
    expect(orderIdBase('x')).toBe(orderIdBase('x'));
  });

  it('keeps the secret out of every delivery', () => {
    const text = JSON.stringify(buildDeliveries(options()));
    expect(text).not.toContain(secret);
  });
});

describe('webhookUrl', () => {
  it('keeps a path prefix and drops query and fragment', () => {
    expect(webhookUrl('http://h:3000').href).toBe(
      'http://h:3000/webhooks/shopify'
    );
    expect(webhookUrl('http://h:3000/').href).toBe(
      'http://h:3000/webhooks/shopify'
    );
    expect(webhookUrl('https://h/webhook-hub').href).toBe(
      'https://h/webhook-hub/webhooks/shopify'
    );
    expect(webhookUrl('https://h/webhook-hub/?a=1#x').href).toBe(
      'https://h/webhook-hub/webhooks/shopify'
    );
  });
});

describe('simulator against a running app', () => {
  it('gets the expected response for every scenario', async () => {
    for (const delivery of buildDeliveries(options(2))) {
      const outcome = await sendDelivery(baseUrl, delivery);
      expect(outcome.ok, `${delivery.label}: ${JSON.stringify(outcome)}`).toBe(
        true
      );
    }
  });

  it('stores accepted events once, never stores bad signatures, and the worker ends them as designed', async () => {
    for (const delivery of buildDeliveries(options(1))) {
      await sendDelivery(baseUrl, delivery);
    }
    // valid, duplicate (once), invalid-payload, unknown-topic. Not bad-signature.
    const { rows } = await db.pool.query<{ event_id: string }>(
      'SELECT event_id FROM events ORDER BY id'
    );
    expect(rows.map((r) => r.event_id)).toEqual([
      'sim-testrun-valid-1',
      'sim-testrun-duplicate-1',
      'sim-testrun-invalid-payload-1',
      'sim-testrun-unknown-topic-1',
    ]);

    await runOnce({ pool: db.pool, handlers: defaultHandlers, logger });
    const status = await db.pool.query<{ event_id: string; status: string }>(
      'SELECT event_id, status FROM events ORDER BY id'
    );
    expect(
      Object.fromEntries(status.rows.map((r) => [r.event_id, r.status]))
    ).toEqual({
      'sim-testrun-valid-1': 'done',
      'sim-testrun-duplicate-1': 'done',
      'sim-testrun-invalid-payload-1': 'dead',
      'sim-testrun-unknown-topic-1': 'done',
    });
  });

  it('reports a mismatch when the receiver uses a different secret', async () => {
    const wrong = buildDeliveries({ ...options(), secret: otherSecret });
    const valid = wrong.find((d) => d.scenario === 'valid');
    if (!valid) throw new Error('no valid delivery');
    const outcome = await sendDelivery(baseUrl, valid);
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(401);
  });

  it('reports a connection failure without throwing', async () => {
    const [delivery] = buildDeliveries(options());
    if (!delivery) throw new Error('no delivery');
    const outcome = await sendDelivery('http://127.0.0.1:1', delivery, 2000);
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBeNull();
    expect(outcome.error).toBeTruthy();
  });
});

describe('main', () => {
  it('exits 0 against a healthy app and never prints the secret', async () => {
    vi.stubEnv('SHOPIFY_WEBHOOK_SECRET', secret);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => {
      lines.push(a.join(' '));
    });
    expect(await main(['--url', baseUrl])).toBe(0);
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).toContain('6/6 as expected');
  });

  it('exits 2 without a secret, and 1 when a delivery does not match', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('SHOPIFY_WEBHOOK_SECRET', '');
    expect(await main(['--url', baseUrl])).toBe(2);
    vi.stubEnv('SHOPIFY_WEBHOOK_SECRET', otherSecret);
    expect(await main(['--url', baseUrl, '--scenarios', 'valid'])).toBe(1);
  });

  it('rejects bad arguments', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('SHOPIFY_WEBHOOK_SECRET', secret);
    expect(await main(['--count', '0'])).toBe(2);
    expect(await main(['--url', 'ftp://example.com'])).toBe(2);
    expect(await main(['--url', 'not a url'])).toBe(2);
    expect(await main(['--url', `${baseUrl}/webhooks/shopify`])).toBe(2);
    await expect(main(['--scenarios', 'nope'])).rejects.toThrow(
      'unknown scenario'
    );
  });

  it('rejects credentials in --url without printing them', async () => {
    const printed: string[] = [];
    const capture = (...a: unknown[]) => {
      printed.push(a.join(' '));
    };
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.stubEnv('SHOPIFY_WEBHOOK_SECRET', secret);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(
      await main([
        '--url',
        withUserinfo('http://127.0.0.1:1/x', 'url-pw-value'),
      ])
    ).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(printed.join('\n')).not.toContain('url-pw-value');
  });

  it('posts to the endpoint under a path prefix', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('SHOPIFY_WEBHOOK_SECRET', secret);
    const requested: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return Response.json({ status: 'accepted' });
    });
    expect(
      await main([
        '--url',
        'https://example.test/webhook-hub',
        '--scenarios',
        'valid',
      ])
    ).toBe(0);
    expect(requested).toEqual([
      'https://example.test/webhook-hub/webhooks/shopify',
    ]);
  });

  it('webhookUrl never keeps credentials', () => {
    expect(webhookUrl(withUserinfo('http://h/x', 'p')).href).toBe(
      'http://h/x/webhooks/shopify'
    );
  });
});
