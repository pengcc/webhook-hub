import { z } from 'zod';

const schema = z.object({
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
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
  WORKER_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(300),
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
