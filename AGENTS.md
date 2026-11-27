Read `~/Projects/agent-home/core.md` first (shared rules). Start sessions from this project directory.

# AGENTS.md

Entry point for agents working in this repository. Keep it short.

## Project

webhook-hub: a Node/TypeScript + Postgres service that receives order webhooks
(HMAC signature check, idempotent ingestion keyed on `(source, event_id)`,
persist first then process asynchronously, retries and dead letters) and exposes
a read-only API for a dashboard. The dashboard lives in a separate repository
(`pengcc/portfolio`); this repository only serves the API.

Current decisions, risks and the open questions are in `docs/decisions.md`.
Read it before planning or changing architecture. Update it when a decision
changes; do not duplicate it here.

## Commands

- `pnpm check` runs Biome (lint and format check); `pnpm typecheck` runs tsc.
- `pnpm db:up` starts local Postgres; service tests need it (`pnpm test`).
- `pnpm test:repo-tools` and `pnpm test:service` run the two suites separately.
- `pnpm safety:guard` runs the read-only secret scan against `origin/main`.
- `pnpm build` / `pnpm start` compile and run the service; `pnpm dev` watches.

Requires Node 24 and pnpm 11 (see `mise.toml`, `packageManager`).

## Project Profile

- stack: Node 24, TypeScript, Postgres, pnpm 11
- validate: `pnpm check && pnpm typecheck && pnpm test` (`pnpm db:up` first)
- branch: `feat/<topic>` or `fix/<topic>`, based on `main`
- pr: squash merge; merging always needs the user's approval of the exact command
- plan-store: none (plans stay in the chat; decisions go to `docs/decisions.md`)
- memory: none
- worktrees: none
- skills: plan, execute-plan, code-review

## Boundaries

- Real secrets only in the VPS `.env`. Never put them in repository files,
  fixtures, docs or commit messages. `.env.example` holds placeholders only.
- Demo data is synthetic or from a sandbox source (Shopify development store).
  Never ingest real customer data.
- Ask the user before any outward-facing action: creating a repository,
  pushing, opening or merging a PR, deploying, registering accounts, changing
  DNS or firewall rules. Approval for one action does not extend to the next.
- The Oracle console is operated by the user. Give instructions; do not drive it.
- Do not change global tooling (package managers, shell profiles, PATH, global
  Git config). If a tool is missing or at the wrong version, report it.

## Working style

Smallest safe, reviewable change. Do not expand scope silently. Report results
faithfully: say what was verified and what was not.

## Provenance

Tooling in `.repo-tools/`, `biome.json`, `mise.toml` and
`.github/workflows/repository-safety.yml` was copied from `badminton-club-app`
at commit `0849b529` (2026-11-05) and adapted here. There is no ongoing sync;
this repository owns its copies.
