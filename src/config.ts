import { isIP } from 'node:net';
import { z } from 'zod';

function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isProxyEntry(entry: string): boolean {
  if (PROXY_KEYWORDS.has(entry)) return true;
  const [address = '', bits, extra] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || extra !== undefined) return false;
  if (bits === undefined) return true;
  return /^\d{1,3}$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128);
}

const HOP_COUNT = /^[1-9]\d{0,2}$/;

function proxyEntries(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isTrustProxy(value: string): boolean {
  const v = value.trim();
  if (v === 'true' || v === 'false' || HOP_COUNT.test(v)) return true;
  const entries = proxyEntries(v);
  return entries.length > 0 && entries.every(isProxyEntry);
}

function parseTrustProxy(value: string): boolean | number | string[] {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (HOP_COUNT.test(v)) return Number(v);
  return proxyEntries(v);
}

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    SHOPIFY_WEBHOOK_SECRET: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // Background worker. Disable to run only the HTTP receiver in a process.
    WORKER_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    WORKER_POLL_MS: z.coerce.number().int().min(50).default(1000),
    WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(12),
    WORKER_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(300),
    WORKER_HANDLER_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(60),
    // Browser origins allowed to call the read API (comma separated, e.g.
    // https://example.pages.dev). Empty means no CORS headers are sent.
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      )
      .refine((list) => list.every(isOrigin), {
        message: 'must be origins like https://example.com, without a path',
      }),
    // Per client IP, read API only. Webhook deliveries are not rate limited.
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    // Which proxies to believe about the client address (X-Forwarded-For).
    // false: none (default). A hop count such as 1: trust only that many
    // proxies in front of the app, so the address the nearest proxy saw is
    // used and a client-supplied leftmost entry is ignored. A comma separated
    // list of proxy addresses or CIDRs also works. true trusts every hop and
    // takes the leftmost entry, which a client can forge: avoid it.
    TRUST_PROXY: z
      .string()
      .default('false')
      .refine(isTrustProxy, {
        message: 'must be false, true, a hop count, or proxy addresses/CIDRs',
      })
      .transform(parseTrustProxy),
  })
  .superRefine((value, ctx) => {
    if (
      value.WORKER_HANDLER_TIMEOUT_SECONDS >= value.WORKER_LOCK_TIMEOUT_SECONDS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['WORKER_HANDLER_TIMEOUT_SECONDS'],
        message: 'must be below WORKER_LOCK_TIMEOUT_SECONDS',
      });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Report variable names only, never values.
    const names = [
      ...new Set(parsed.error.issues.map((i) => i.path.join('.'))),
    ];
    throw new Error(`Invalid environment configuration: ${names.join(', ')}`);
  }
  return parsed.data;
}
