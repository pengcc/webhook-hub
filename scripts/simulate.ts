/**
 * Webhook simulator: sends synthetic, Shopify-shaped order deliveries to a
 * running webhook-hub and checks that each one gets the expected response.
 *
 *   SHOPIFY_WEBHOOK_SECRET=... pnpm simulate --url http://localhost:3000
 *
 * The secret is read from the environment only and is never printed. All data
 * is synthetic; nothing here resembles a real customer.
 */
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { signShopifyBody } from '../src/shopify.js';

export const SCENARIOS = [
  'valid',
  'duplicate',
  'bad-signature',
  'invalid-payload',
  'unknown-topic',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type Delivery = {
  label: string;
  scenario: Scenario;
  headers: Record<string, string>;
  body: string;
  expectedStatus: number;
  /** Value of `status` in the JSON response, when the response has one. */
  expectedResult?: 'accepted' | 'duplicate';
};

export type Outcome = {
  delivery: Delivery;
  httpStatus: number | null;
  result: string | null;
  ok: boolean;
  error?: string;
};

export type BuildOptions = {
  runId: string;
  count: number;
  secret: string;
  scenarios: readonly Scenario[];
  shop: string;
};

/**
 * Numeric id base for this run, so simulated order ids do not repeat across
 * runs (a later projection keyed on the order id would otherwise collide).
 * Below 2^53: at most 999_999_999 * 1000 + 999.
 */
export function orderIdBase(runId: string): number {
  const digest = createHash('sha256').update(runId).digest();
  return (digest.readUInt32BE(0) % 1_000_000_000) * 1000;
}

function orderBody(id: number, seq: number): string {
  return JSON.stringify({
    id,
    name: `#SIM${1000 + seq}`,
    currency: 'EUR',
    total_price: (10 + seq * 3.5).toFixed(2),
    created_at: new Date().toISOString(),
    line_items: [{ title: 'Synthetic item', quantity: 1 + (seq % 3) }],
    note: 'synthetic simulator order',
  });
}

/** Builds the deliveries for one run. Event ids are unique per run. */
export function buildDeliveries(options: BuildOptions): Delivery[] {
  const { runId, count, secret, scenarios, shop } = options;
  const deliveries: Delivery[] = [];
  const idBase = orderIdBase(runId);
  let seq = 0;

  const make = (
    scenario: Scenario,
    n: number,
    spec: {
      topic: string;
      body: string;
      signWith?: string;
      expectedStatus: number;
      expectedResult?: 'accepted' | 'duplicate';
      webhookId?: string;
      label?: string;
    }
  ): Delivery => ({
    label: spec.label ?? `${scenario} #${n}`,
    scenario,
    body: spec.body,
    expectedStatus: spec.expectedStatus,
    expectedResult: spec.expectedResult,
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': signShopifyBody(
        spec.body,
        spec.signWith ?? secret
      ),
      'x-shopify-webhook-id': spec.webhookId ?? `sim-${runId}-${scenario}-${n}`,
      'x-shopify-event-id': `sim-evt-${runId}-${scenario}-${n}`,
      'x-shopify-topic': spec.topic,
      'x-shopify-shop-domain': shop,
    },
  });

  for (const scenario of scenarios) {
    for (let n = 1; n <= count; n++) {
      seq += 1;
      switch (scenario) {
        case 'valid':
          deliveries.push(
            make(scenario, n, {
              topic: n % 2 === 0 ? 'orders/updated' : 'orders/create',
              body: orderBody(idBase + seq, seq),
              expectedStatus: 200,
              expectedResult: 'accepted',
            })
          );
          break;
        case 'duplicate': {
          const body = orderBody(idBase + seq, seq);
          const first = make(scenario, n, {
            topic: 'orders/create',
            body,
            expectedStatus: 200,
            expectedResult: 'accepted',
            label: `duplicate #${n} (first delivery)`,
          });
          deliveries.push(first, {
            ...first,
            label: `duplicate #${n} (repeat)`,
            expectedResult: 'duplicate',
          });
          break;
        }
        case 'bad-signature':
          // A well-formed digest made with the wrong key: rejected, never stored.
          deliveries.push(
            make(scenario, n, {
              topic: 'orders/create',
              body: orderBody(idBase + seq, seq),
              signWith: `${secret}-wrong`,
              expectedStatus: 401,
            })
          );
          break;
        case 'invalid-payload':
          // Signed and accepted, then the worker dead-letters it (no order id).
          deliveries.push(
            make(scenario, n, {
              topic: 'orders/create',
              body: JSON.stringify({ note: 'synthetic payload without an id' }),
              expectedStatus: 200,
              expectedResult: 'accepted',
            })
          );
          break;
        case 'unknown-topic':
          // No handler is registered for this topic, so the worker marks it done.
          deliveries.push(
            make(scenario, n, {
              topic: 'customers/create',
              body: JSON.stringify({ id: idBase + seq, note: 'synthetic' }),
              expectedStatus: 200,
              expectedResult: 'accepted',
            })
          );
          break;
      }
    }
  }
  return deliveries;
}

/**
 * The webhook endpoint under `base`, keeping any path prefix
 * (`https://host/webhook-hub` -> `https://host/webhook-hub/webhooks/shopify`).
 * Query and fragment are dropped.
 */
export function webhookUrl(base: string | URL): URL {
  const url = new URL(base);
  // fetch rejects URLs with credentials and echoes the URL in its error.
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return new URL('webhooks/shopify', url);
}

export async function sendDelivery(
  baseUrl: string | URL,
  delivery: Delivery,
  timeoutMs = 15_000
): Promise<Outcome> {
  try {
    const res = await fetch(webhookUrl(baseUrl), {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let result: string | null = null;
    try {
      const json = (await res.json()) as { status?: unknown; error?: unknown };
      if (typeof json.status === 'string') result = json.status;
      else if (typeof json.error === 'string') result = json.error;
    } catch {
      // A non-JSON body is reported as a missing result.
    }
    const ok =
      res.status === delivery.expectedStatus &&
      (delivery.expectedResult === undefined ||
        result === delivery.expectedResult);
    return { delivery, httpStatus: res.status, result, ok };
  } catch (error) {
    return {
      delivery,
      httpStatus: null,
      result: null,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function newRunId(): string {
  return `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}

function parseScenarios(value: string | undefined): Scenario[] {
  if (!value) return [...SCENARIOS];
  const names = value.split(',').map((s) => s.trim());
  const unknown = names.filter(
    (n) => !(SCENARIOS as readonly string[]).includes(n)
  );
  if (unknown.length > 0) {
    throw new Error(
      `unknown scenario: ${unknown.join(', ')} (known: ${SCENARIOS.join(', ')})`
    );
  }
  return names as Scenario[];
}

const USAGE = `Usage: SHOPIFY_WEBHOOK_SECRET=... pnpm simulate [options]

  --url <base-url>      webhook-hub base URL, not the endpoint: /webhooks/shopify
                        is appended; a path prefix is kept
                        (default http://localhost:3000)
  --count <n>           deliveries per scenario (default 1, max 50)
  --scenarios <list>    comma-separated, default all: ${SCENARIOS.join(', ')}
  --shop <domain>       shop domain header (default demo.myshopify.com)
  --help

Exit code 1 if any delivery does not get the expected response.`;

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string', default: 'http://localhost:3000' },
      count: { type: 'string', default: '1' },
      scenarios: { type: 'string' },
      shop: { type: 'string', default: 'demo.myshopify.com' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      'SHOPIFY_WEBHOOK_SECRET is not set (never pass it as an argument).'
    );
    return 2;
  }
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    console.error('--count must be an integer from 1 to 50');
    return 2;
  }
  let url: URL;
  try {
    url = new URL(values.url ?? '');
  } catch {
    console.error('--url is not a valid URL');
    return 2;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.error('--url must be http or https');
    return 2;
  }
  if (url.username || url.password) {
    // Never echo the URL here: it would print the password.
    console.error('--url must not contain a username or password');
    return 2;
  }
  if (/\/webhooks\/shopify\/?$/.test(url.pathname)) {
    console.error(
      '--url is the base URL; leave out /webhooks/shopify (it is added)'
    );
    return 2;
  }

  const deliveries = buildDeliveries({
    runId: newRunId(),
    count,
    secret,
    scenarios: parseScenarios(values.scenarios),
    shop: values.shop ?? 'demo.myshopify.com',
  });

  let failed = 0;
  for (const delivery of deliveries) {
    const outcome = await sendDelivery(url, delivery);
    if (!outcome.ok) failed += 1;
    const got = outcome.error
      ? `error: ${outcome.error}`
      : `${outcome.httpStatus} ${outcome.result ?? '-'}`;
    const want = `${delivery.expectedStatus}${delivery.expectedResult ? ` ${delivery.expectedResult}` : ''}`;
    console.log(
      `${outcome.ok ? 'ok  ' : 'FAIL'} ${delivery.label}: ${got} (expected ${want})`
    );
  }
  console.log(
    `\n${deliveries.length - failed}/${deliveries.length} as expected.`
  );
  return failed === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  );
}
