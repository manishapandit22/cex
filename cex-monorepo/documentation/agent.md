# CEX Project Agent Reference

This file is the working reference for humans and AI agents contributing to this repository. The detailed product and engineering specification is [cex.md](cex.md); it remains the source of truth when details here are abbreviated.

## Project

Build a spot centralized exchange with registration and authentication, simulated wallet balances, limit and market orders, a deterministic in-memory matching engine, live market data, a Next.js trading terminal, and operational/admin tools. This is a phased project; implement only the current phase and do not skip ahead.

## Current repository state

At the time this reference was created, the repository contains `cex.md` and this `agent.md`. There is no application code or Phase 0 infrastructure/configuration committed yet. Phase 0 is **in progress / not complete**. The environment check is a point-in-time check on the current Windows machine, not a claim about every contributor's machine.

| Phase 0 item | Observed status | Evidence / next action |
|---|---|---|
| Git | Installed; repository is on `main` with `origin/main` configured | Git reports a dubious-ownership safety error in this environment. Resolve local Git ownership/safe-directory configuration before normal Git operations; do not change global config without the repository owner's choice. |
| VS Code | Installed | Required extensions ESLint, Prettier, Prisma, and Mermaid preview were not found in the extension list. Install them as needed. |
| Node.js | Installed, **v24.20.0** | Specification requires Node.js 20 LTS. Switch/install Node 20 for project work. |
| npm | Installed, **11.17.0** | Meets the npm 10+ minimum. |
| Docker CLI | Installed, **29.3.1** | `docker --version` works. Docker emitted a permissions warning reading the user's Docker config. |
| Docker daemon / Compose services | Not verified / unavailable | Docker cannot connect to `//./pipe/docker_engine`. Start Docker Desktop/Engine, then verify Compose v2 and launch Postgres/TimescaleDB and Redis. |
| PostgreSQL client | Installed, **17.9** | Client version alone does not verify a running Postgres/TimescaleDB service. Phase 0 requires a successful `psql` query against the compose database. |
| Redis CLI | Not found on PATH | Verify `redis-cli` availability after infrastructure is running (or use an equivalent documented container command if the local CLI is unavailable). |
| WSL status | Could not be checked | Windows denied access to `wsl --status`; not required if Docker Desktop runs with its normal backend. |
| RAM prerequisite | Could not be checked | Windows denied the system query; Phase 0 specifies 8 GB RAM minimum. |
| `.gitignore` | Missing | Create with the required build, environment, log, and data exclusions from Phase 0. |
| `docker-compose.dev.yml` | Missing | Create local-only Postgres/TimescaleDB and Redis infrastructure per `cex.md` Phase 0. |
| `.env.example` / `.env` | Missing | Add all Appendix C variables with placeholders to `.env.example`; create a local `.env` from it and ensure secrets are ignored. Never commit `.env`. |
| `README.md` | Missing | Add the Phase 0 stub and expand it in later phases as specified. |
| Private repository / clone | Existing Git checkout detected | `origin/main` is configured, but remote privacy/hosting settings cannot be confirmed from local files. |
| Phase 0 acceptance checks | Not passed | Must run Docker health checks, `psql` query, Redis `PONG`, confirm Node 20, and confirm `.env` is not tracked. |

The IDE/CLI and server commands were checked from this workspace. Tool launches can emit Windows access-denied diagnostics (VS Code logging, WSL, Docker config/daemon); these are environmental observations and do not constitute passing service checks.

## Locked technology choices

Follow the Decision Log in `cex.md` (Section 2). Core choices:

- Node.js 20 LTS, strict TypeScript, npm workspaces.
- Fastify with Zod validation; Redis 7 Streams for commands, replies, and events.
- One matching-engine process owns every market and all live balances.
- PostgreSQL 16 with TimescaleDB and Prisma stores durable projections/history.
- Next.js 14 App Router, Tailwind CSS, `lightweight-charts`, and Zustand.
- Vitest and fast-check; Playwright for E2E; k6 for load tests.
- Pino logs, Prometheus metrics, Grafana dashboards; Docker Compose behind Nginx.
- Wallet deposits and withdrawals are simulated ledger operations; there is no real blockchain custody.

Do not substitute technologies or invent endpoints, tables, message types, or product behavior that are not specified. If a required decision is absent from `cex.md`, ask the project owner.

## Architecture and ownership

- `apps/api-gateway`: stateless auth, validation, rate limits, command creation, read APIs. It never owns balances or matches orders.
- `apps/engine`: in-memory order books and live balances, sequence numbers, journal, snapshots. It does not access Postgres or HTTP.
- `apps/db-worker`: idempotently projects engine events into Postgres; it does not decide business outcomes.
- `apps/market-data`: ticker, depth snapshots, rolling statistics, and candles.
- `apps/ws-server`: read-only subscriptions and fan-out.
- `apps/web`: trading terminal UI; money calculations use the shared money package only.
- `packages/*`: shared types, money, database, config, and logger packages; keep application-specific behavior out.

The engine is the sole authority for live balances. Postgres is a durable, rebuildable projection for users, orders, trades, ledger, and history. The engine writes commands to its journal before acknowledging them. Redis Streams carry commands/replies/events. See Sections 3 and 5 of `cex.md` for full flows and data ownership.

## Non-negotiable correctness rules

1. Money is signed/unsigned scaled `BigInt` at internal scale `10^8`; JSON/wire amounts are decimal strings. Never use floating point or JS `number` for money.
2. Maintain conservation per asset, nonnegative available/locked balances, and locks equal to open-order plus pending-withdrawal locks.
3. Match by price-time priority and execute at the resting maker's price. A completed command must not leave a crossed book.
4. Engine `process()` stays pure and synchronous: no database, Redis, HTTP, clock, or randomness inside it.
5. Replay is deterministic; command/event handling is idempotent; journal before acknowledgement so acknowledged orders survive crashes.
6. Market BUY locks/spends `quoteQuantity`; market SELL uses `quantity`. Fees are charged in the asset received, defaults are maker 8 bps and taker 10 bps, rounded up. Default STP is `CANCEL_TAKER`.
7. Authentication uses argon2id, 15-minute access JWTs, and rotating 7-day refresh tokens stored hashed (refresh token in an HTTP-only cookie as specified).
8. Never expose another user's private data. Admin actions require authorization and audit records.

See `cex.md` Section 3.5 for all twelve invariants and Sections 4–9 for full data, API, security, UI, and naming rules.

## Phase order

Work sequentially and satisfy every phase's acceptance criteria before proceeding:

| Phase | Deliverable |
|---:|---|
| 0 | Development infrastructure |
| 1 | npm-workspaces monorepo and shared types |
| 2 | Database schema, hypertable, and seeds |
| 3 | BigInt money math |
| 4 | Authentication |
| 5 | Order-book structure |
| 6 | Matching logic |
| 7 | Balances and fees |
| 8 | Redis messaging and engine runner |
| 9 | Trading API |
| 10 | Journal, snapshots, recovery |
| 11 | Database projection worker |
| 12 | Market data |
| 13 | WebSocket streams |
| 14 | Wallet and admin operations |
| 15 | Frontend foundation |
| 16 | Trading terminal |
| 17 | Remaining pages and admin UI |
| 18 | Correctness, performance, resilience verification |
| 19 | Deployment, observability, backups, CI |
| 20 | Final verification and `v1.0.0` release |

The detailed dependencies, file lists, commands, and acceptance criteria are in `cex.md` Part C and Appendix A. The current phase is **Phase 0**.

## Working instructions for agents

- Read this file and the relevant sections of `cex.md` before making changes.
- Work on one phase at a time. Before implementation, summarize that phase's Goal, Steps, and Acceptance Criteria in five lines.
- Use the specified folder, naming, error, and API conventions in `cex.md` Section 9. Preserve the locked decisions and invariants above.
- Keep secrets out of source control. `.env.example` may contain placeholders; `.env` must remain local and ignored.
- Do not claim a phase or acceptance criterion is complete without running its prescribed checks and recording the evidence.
- At phase completion, report files changed, commands/checks and outcomes, and an acceptance checklist. Commit using `phase-NN: <summary>` after reviewing the staged diff.
- Avoid broad staging without reviewing changes; inspect `git status` and the staged diff before commits.

## Phase 0 completion checklist

- [ ] Use Node.js 20 LTS and npm 10+.
- [ ] Docker Engine/Desktop and Compose v2 work; Postgres/TimescaleDB and Redis containers report healthy.
- [ ] The Phase 0 `psql` query succeeds and Redis returns `PONG`.
- [ ] Install the specified VS Code extensions: ESLint, Prettier, Prisma, Mermaid preview.
- [ ] Create `.gitignore`, `docker-compose.dev.yml`, `.env.example`, local `.env`, and `README.md` as described in `cex.md`.
- [ ] Confirm `.env` is ignored and absent from tracked files.
- [ ] Resolve local Git ownership configuration and verify the intended private remote/repository.
- [ ] Commit Phase 0 as `phase-00: dev infrastructure` after reviewing the diff.
