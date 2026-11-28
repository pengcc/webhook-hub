# webhook-hub

A small backend that receives order webhooks, verifies their signatures, stores
them exactly once, processes them asynchronously with retries, and exposes a
read-only API for a dashboard.

It is a portfolio project that mirrors a common integration job: platforms such
as Shopify push webhooks, and the receiving side has to be fast, safe against
forgery, tolerant of duplicate and out-of-order deliveries, and observable.

> **Status: early development.** Implemented so far: signature verification,
> idempotent ingestion of Shopify webhooks into Postgres, a background worker
> with exponential backoff, retries and dead letters, crash recovery, a
> read-only API (`/events`, `/events/:id`, `/stats`), a health endpoint,
> CORS limited to configured origins, per-IP rate limiting of the read API,
> migrations, tests against a real Postgres, CI, and a Docker image. Not yet
> implemented: metrics and deployment. Event processing itself is a
> placeholder that only validates order payloads.

## What it will do

- **Verify signatures.** HMAC-SHA256 over the raw request body, compared in
  constant time. Shopify's `X-Shopify-Hmac-Sha256` header is the first format.
- **Deduplicate.** A unique constraint on `(source, event_id)` makes repeated
  deliveries harmless; duplicates still get a `200`.
- **Persist first, process later.** A verified event is written to Postgres and
  acknowledged immediately. A worker picks it up afterwards.
- **Retry and dead-letter.** Exponential backoff with jitter; events that keep
  failing move to a `dead` state instead of disappearing.
- **Stay observable.** Structured logs, a health endpoint and basic metrics.
- **Serve a read-only API** (`GET /events`, `/events/:id`, `/stats`) for a
  dashboard that lives in a separate repository.

## Stack

Node 24, TypeScript, Fastify, Postgres (the job queue is Postgres itself via
`FOR UPDATE SKIP LOCKED`), Docker Compose, Caddy. Quality tooling: Biome and
Node's built-in test runner for repo tooling.

## Demo data

The dashboard only shows synthetic events from a simulator, or events from a
sandbox source such as a Shopify development store. No real customer data is
ever ingested, and real secrets never enter this repository: `.env.example`
lists placeholders only.

The simulator (`pnpm simulate`) sends synthetic Shopify-shaped orders signed
with the receiver's secret, read from `SHOPIFY_WEBHOOK_SECRET` in the
environment (never as an argument, and never printed). Per scenario it sends
valid orders, a delivery and its repeat (one stored row), a wrong signature
(401, nothing stored), a signed payload without an order id (accepted, then
dead-lettered by the worker) and a topic with no handler (accepted, then done).
It exits 1 if any response differs from what is expected.

```bash
SHOPIFY_WEBHOOK_SECRET=dev-only-secret pnpm simulate --url http://localhost:3000 --count 3
```

Options: `--scenarios valid,duplicate,...`, `--shop`, `--help`. It cannot produce
a retryable downstream failure yet, because the placeholder handlers never
fail that way.

## Development

Requires Node 24 and pnpm 11 (see `mise.toml`).

```bash
pnpm install
pnpm db:up          # start local Postgres (needs Docker)
pnpm check          # Biome lint and format check
pnpm typecheck
pnpm test           # repo tooling tests and service tests (needs db:up)
pnpm safety:guard   # read-only secret scan against origin/main

# run the service locally
DATABASE_URL=postgres://webhook_hub@127.0.0.1:5432/webhook_hub \
PGPASSWORD=webhook_hub_dev SHOPIFY_WEBHOOK_SECRET=dev-only-secret pnpm dev
```

The values above are the throwaway ones from `compose.yaml`, for local
development only. The database password is passed as `PGPASSWORD` so that no
connection URL needs to contain credentials.

## Decisions

Architecture choices, trade-offs, risks and open questions are recorded in
[`docs/decisions.md`](docs/decisions.md) (written in Chinese).

## License

[MIT](LICENSE)
