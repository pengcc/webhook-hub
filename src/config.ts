import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
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
