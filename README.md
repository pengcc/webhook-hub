# webhook-hub

A small backend that receives order webhooks, verifies their signatures, stores
them exactly once, processes them asynchronously with retries, and exposes a
read-only API for a dashboard.

It is a portfolio project that mirrors a common integration job: platforms such
as Shopify push webhooks, and the receiving side has to be fast, safe against
forgery, tolerant of duplicate and out-of-order deliveries, and observable.

> **Status: early development.** The repository currently contains the project
> tooling and the design decisions. The service itself is not implemented yet.

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

## Development

Requires Node 24 and pnpm 11 (see `mise.toml`).

```bash
pnpm install
pnpm check          # Biome lint and format check
pnpm test           # repo tooling tests
pnpm safety:guard   # read-only secret scan against origin/main
```

## Decisions

Architecture choices, trade-offs, risks and open questions are recorded in
[`docs/decisions.md`](docs/decisions.md) (written in Chinese).

## License

[MIT](LICENSE)
