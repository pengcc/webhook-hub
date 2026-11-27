import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// The routes under test never need a real database.
const pool = {
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
} as unknown as Pool;

const base = { SHOPIFY_WEBHOOK_SECRET: 'unused', LOG_LEVEL: 'silent' } as const;
const ALLOWED = 'https://portfolio.example.pages.dev';

async function appWith(config: Parameters<typeof buildApp>[0]['config']) {
  const app = buildApp({ pool, config, statsCacheMs: 0 });
  await app.ready();
  return app;
}

describe('CORS', () => {
  it('allows a configured origin and varies on Origin', async () => {
    const app = await appWith({ ...base, CORS_ALLOWED_ORIGINS: [ALLOWED] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/events',
        headers: { origin: ALLOWED },
      });
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(res.headers.vary).toContain('Origin');
    } finally {
      await app.close();
    }
  });

  it('sends no CORS headers to other origins', async () => {
    const app = await appWith({ ...base, CORS_ALLOWED_ORIGINS: [ALLOWED] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/events',
        headers: { origin: 'https://evil.example' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('sends no CORS headers at all when no origin is configured', async () => {
    const app = await appWith(base);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/events',
        headers: { origin: ALLOWED },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('answers a preflight for the allowed origin with read-only methods', async () => {
    const app = await appWith({ ...base, CORS_ALLOWED_ORIGINS: [ALLOWED] });
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/events',
        headers: {
          origin: ALLOWED,
          'access-control-request-method': 'GET',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-methods']).toBe(
        'GET, HEAD, OPTIONS'
      );
    } finally {
      await app.close();
    }
  });
});

describe('rate limiting', () => {
  const limited = { ...base, RATE_LIMIT_MAX: 3, RATE_LIMIT_WINDOW_SECONDS: 60 };

  it('rejects read requests over the limit with 429 and a generic body', async () => {
    const app = await appWith(limited);
    try {
      const codes: number[] = [];
      let last = await app.inject({ method: 'GET', url: '/events' });
      codes.push(last.statusCode);
      for (let i = 0; i < 3; i++) {
        last = await app.inject({ method: 'GET', url: '/stats' });
        codes.push(last.statusCode);
      }
      expect(codes).toEqual([200, 200, 200, 429]);
      expect(last.headers['retry-after']).toBeDefined();
      expect(Object.keys(last.json())).toEqual(['error']);
    } finally {
      await app.close();
    }
  });

  it('does not limit the health check or webhook deliveries', async () => {
    const app = await appWith(limited);
    try {
      for (let i = 0; i < 8; i++) {
        const health = await app.inject({ method: 'GET', url: '/healthz' });
        expect(health.statusCode).toBe(200);
        const hook = await app.inject({
          method: 'POST',
          url: '/webhooks/shopify',
          headers: { 'content-type': 'application/json' },
          payload: '{}',
        });
        expect(hook.statusCode).toBe(401); // rejected by signature, never 429
      }
    } finally {
      await app.close();
    }
  });

  it('ignores X-Forwarded-For unless the proxy is trusted', async () => {
    const app = await appWith(limited);
    try {
      const codes: number[] = [];
      for (let i = 1; i <= 4; i++) {
        const res = await app.inject({
          method: 'GET',
          url: '/events',
          headers: { 'x-forwarded-for': `203.0.113.${i}` },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([200, 200, 200, 429]);
    } finally {
      await app.close();
    }
  });

  it('counts clients separately behind a trusted proxy', async () => {
    const app = await appWith({ ...limited, TRUST_PROXY: true });
    try {
      const codes: number[] = [];
      for (let i = 1; i <= 4; i++) {
        const res = await app.inject({
          method: 'GET',
          url: '/events',
          headers: { 'x-forwarded-for': `203.0.113.${i}` },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([200, 200, 200, 200]);
    } finally {
      await app.close();
    }
  });
});

describe('config', () => {
  const env = {
    DATABASE_URL: 'postgres://u@localhost/db',
    SHOPIFY_WEBHOOK_SECRET: 'x',
  };

  it('parses origins and applies safe defaults', () => {
    const config = loadConfig({
      ...env,
      CORS_ALLOWED_ORIGINS: `${ALLOWED}, http://localhost:5173`,
    });
    expect(config.CORS_ALLOWED_ORIGINS).toEqual([
      ALLOWED,
      'http://localhost:5173',
    ]);
    expect(config.RATE_LIMIT_MAX).toBe(60);
    expect(config.TRUST_PROXY).toBe(false);
    expect(loadConfig(env).CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('rejects origins with a path or a trailing slash and names only the variable', () => {
    for (const bad of [`${ALLOWED}/`, `${ALLOWED}/app`, 'portfolio.example']) {
      expect(() => loadConfig({ ...env, CORS_ALLOWED_ORIGINS: bad })).toThrow(
        'CORS_ALLOWED_ORIGINS'
      );
    }
    let message = '';
    try {
      loadConfig({ ...env, CORS_ALLOWED_ORIGINS: `${ALLOWED}/secret-path` });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('CORS_ALLOWED_ORIGINS');
    expect(message).not.toContain('secret-path');
  });
});
