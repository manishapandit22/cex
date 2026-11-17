# Kairos CEX — Two-Developer Workstream Plan

> Companion to [cex.md](cex.md) (the spec) and [agent.md](agent.md). This file does not change the architecture.
> It decides **who owns which part**, **what the contracts between the two parts are**, and **in what order the work runs in parallel**.
> If this file conflicts with `cex.md`, `cex.md` wins. Fix this file in the same PR.

- **Dev A — Core & Realtime:** everything on the *engine side* of the Redis streams.
- **Dev B — Platform, API & Web:** everything on the *client side* of the Redis streams, plus the shared tooling.

---

## 1. Project Architecture Overview

### 1.1 What exists today (verified 2026-11-04)

| Path | State | Problem |
|---|---|---|
| `Backend/documentation/cex.md`, `agent.md` | Full spec, Phases 0–20 | Uncommitted planning comment added after §8.2 (lines 1005–1009). Remove it before committing. |
| `Backend/docker-compose.dev.yml`, `.env.example`, `.gitignore`, `README.md` | Phase 0 files, matching spec | They live in `Backend/`, but the spec puts the monorepo root (`apps/`, `packages/`) at the repo root. |
| `Backend/package.json` | Output of `npm init` with `express`, `cors`, `psql` | Conflicts with **D2** (Fastify) and **D12** (Prisma). The npm package `psql@0.0.1` is not a Postgres client. Replace it in Phase 1. |
| `Frontend/Designs/Kairos.html` | Bundled mockup with 7 screens: Markets, Sign in, Sign up, Trade terminal, Wallet, Orders, Admin | Matches the §8.1 screen map, so it serves as the UI reference. The uncommitted diff only re-escapes `<` as `<` and changes no content. |
| `debug.log` (root, tracked) | Chrome crashpad noise | Delete it and add `*.log` to a root `.gitignore`. |
| Toolchain | `agent.md` reports Node 24 | The spec requires Node 20 LTS on **both** machines (add an `.nvmrc`). |

**Required layout decision (before any code is written):** make the **repo root the npm-workspaces root**, as in spec Phase 1:

```
Kairos/
├── apps/ api-gateway/ engine/ db-worker/ market-data/ ws-server/ web/
├── packages/ types/ money/ db/ config/ logger/
├── docs/ cex.md agent.md workstreams.md designs/Kairos.html
├── docker-compose.dev.yml  .env.example  .gitignore  README.md  .nvmrc
├── package.json  tsconfig.base.json  .eslintrc.cjs  .prettierrc  vitest.workspace.ts
```

This step follows the spec rather than changing it. `Backend/` and `Frontend/` are not part of the specified architecture, and `apps/web` would otherwise end up under a folder named `Backend`.

### 1.2 Target architecture (from cex.md §3)

```
            REST                XADD                XREADGROUP
  web ───────────► api-gateway ─────► engine.commands ─────────► ENGINE (single process,
   ▲                  │  ▲                                        books + live balances,
   │                  │  └──── engine.replies ◄───────────────────  journal + snapshots)
   │                  │ reads                                         │
   │                  ▼                                     engine.events (stream)
   │              Postgres ◄──── db-worker ◄────────────────────────┤
   │                  ▲                                             │
   │                  └──── (trades/candles) ── market-data ◄───────┤
   │                                              │ depth:/ticker: keys, md:* pub/sub, user:* pub/sub
   └──── WSS ◄──────────── ws-server ◄────────────┘
```

All writes go through one path (gateway → engine). Everything after the engine reads its event stream. **Redis Streams form the natural seam**: on each side, the code knows about the other side only through message shapes.

### 1.3 Module dependencies (code-level imports)

| Module | Imports | Talks to at runtime |
|---|---|---|
| `@cex/types` | — | — |
| `@cex/money` | — | — |
| `@cex/config`, `@cex/logger` | — | — |
| `@cex/db` (Prisma) | types | Postgres |
| `apps/engine` | types, money, config, logger | Redis streams, local disk. **Never** Postgres or HTTP (it reads Postgres once for the initial seed) |
| `apps/db-worker` | types, money, db, config, logger | `engine.events` → Postgres |
| `apps/market-data` | types, money, db, config, logger | `engine.events` → Redis keys and pub/sub |
| `apps/ws-server` | types, config, logger | Redis pub/sub and keys → clients. Verifies the gateway's JWT |
| `apps/api-gateway` | types, money, db, config, logger | Postgres, Redis (commands, replies, cache, rate limits) |
| `apps/web` | types, money | gateway REST, ws-server WS |

### 1.4 Tight coupling and bottlenecks

| # | Coupling point | Why it's risky | Resolution |
|---|---|---|---|
| C1 | **Command / Event / Reply shapes** (`@cex/types`) | Every service depends on them. Spec §5.1 types `payload` and `data` loosely, so each side would guess differently. | Freeze them in the **Contract Sprint** (§5.3), fully typed and with zod schemas. |
| C2 | **Prisma schema** | The gateway writes users, tokens, deposits, withdrawals, audit rows and markets. db-worker writes orders, trades, balances and ledger. Both read all of it. | Single owner (B). Schema is verbatim from §4.5. Changes go through a `contract/` PR. |
| C3 | **`@cex/money`** | Used by the engine, gateway and web. A bug here breaks money everywhere. | Single owner (A). The API signatures are fixed by spec Phase 3 from day 1. |
| C4 | **Redis key, stream and channel names** (§4.7) | Strings scattered across six apps drift easily. | One constants file in `@cex/types`. |
| C5 | **Depth seq protocol** | market-data writes it, ws-server serves it, web consumes it. A seq bug breaks the order book UI. | market-data and ws-server have the same owner (A). Web (B) codes against §6.2 and the fixtures. |
| C6 | **JWT claims** | The gateway issues tokens and ws-server verifies them. | Contract `{ sub, role, iat, exp }`, HS256, `JWT_ACCESS_SECRET`. |
| C7 | **Root tooling** (`package.json`, `package-lock.json`, tsconfig, eslint) | The lockfile is the most common merge-conflict source. | Single owner (B) plus the lockfile rule in §5.2. |
| **B1** | **Engine critical path** (Phases 5 → 6 → 7 → 8 → 10) | Strictly sequential, the hardest part, and no end-to-end flow works without it. | B develops against a **fake engine** speaking the same stream contract (§4.2). |
| **B2** | **Phase 8 covers both sides** (runner + `EngineClient`) | Without a split, both developers edit the same phase. | Split it: runner = A, `EngineClient` = B. The reply stream is the contract between them. |

### 1.5 Spec gaps to close in the Contract Sprint (they'd cause integration bugs otherwise)

| ID | Gap | Recommended decision |
|---|---|---|
| G1 | `Trade` is unique on `(engineSeq, createdAt)` and `LedgerEntry` on `(engineSeq, userId, asset, reason)`. One command that sweeps 3 makers emits 3 trades with the **same** command seq and timestamp, which causes unique violations. | `engineSeq` is **per event** (the glossary already says "every processed command/event"). `process()` gets `ctx.engineSeq` as the first seq and numbers its events consecutively (still pure). Each event also carries `commandSeq` for grouping. |
| G2 | §Phase 7 says one `BALANCE_UPDATED` per touched (user, asset) "with the delta reason", but one trade both credits (`TRADE`) and charges (`FEE`). | `BALANCE_UPDATED.data.entries: { delta, reason, refId }[]`. db-worker writes one `LedgerEntry` per entry. |
| G3 | `WITHDRAW_COMPLETE/REJECT` need user, asset and amount. Invariant 12 counts pending withdrawals, but `EngineState` (§4.6) has no place to track them. | Add `pendingWithdrawals: Map<withdrawalId, {userId, asset, amount}>` to engine state (A-internal). Payload is `{ withdrawalId }`. |
| G4 | `/admin/fees` reads "fee account balances", but the fee account only exists in engine memory. | Seed a system user (fixed UUID, `role ADMIN`, `isActive false`). The engine emits `BALANCE_UPDATED` for it, so the normal projection makes fees queryable. |
| G5 | `DELETE /order/:id` has no market, and `Book.index` is per market. | Payload is `{ orderId }` only. The engine keeps a global `orderId → market` map (A-internal). The gateway never guesses the market. |
| G6 | Shape of the `engine.replies` entries is undefined. | See `EngineReply` in §3.2. The gateway reads replies with plain `XREAD` (not a group), so every gateway instance sees every reply. |
| G7 | db-worker must *insert* `Order` rows, but nobody else writes them. | Every `ORDER_*` event carries a **full order snapshot** (all non-null `Order` columns). |
| G8 | `Order.quantity` is non-null, but a market BUY only has `quoteQuantity`. | The engine reports `quantity = filledQuantity` on terminal events of a market BUY. The first event carries `"0"`. |

---

## 2. Work Distribution

### Dev A — Core & Realtime (engine side of the stream)

**Rationale:** the engine, its event consumers and the realtime fan-out all depend on engine event *semantics*: seq ordering, depth deltas and idempotency. Keeping them with one person means the hardest-to-specify coupling (C5, depth reconstruction, replay determinism) never crosses a person boundary.

| Module | Spec phases | Directories | Deliverables |
|---|---|---|---|
| `@cex/money` | 3 | `packages/money/` | All functions in Phase 3, `serialize`/`deserialize`, `zScaledString()`, coverage ≥ 95% |
| Order book | 5 | `apps/engine/src/book/` | `DoublyLinkedList`, `SortedPriceLevels`, `Book` with snapshot/restore, property tests |
| Matching | 6 | `apps/engine/src/engine/` | Pure `process(state, cmd, ctx)`, validation, LIMIT/MARKET/IOC/Post-Only/STP, fuzz test |
| Balances and fees | 7 | `apps/engine/src/balances/` | `BalanceManager`, `settleTrade`, deposits/withdrawals, `checkInvariants` |
| Engine runner | 8 (engine half) | `apps/engine/src/runner/` | `XREADGROUP` loop, seq assignment, pipelined reply + events, `XACK`, pending recovery, idempotency window, stream trimming |
| Recovery | 10 | `apps/engine/src/persistence/` | Journal, snapshots, replay, CRC truncation, `engine:verify`, crash test |
| DB worker | 11 | `apps/db-worker/` | Idempotent batch projection, dead-letter stream, `dbw:rebuild`, metrics |
| Market data | 12 (steps 1–6, 8) | `apps/market-data/` | Ticker, 24 h stats, depth mirror and snapshots, 100 ms batching, in-progress candles, `user:{id}` events |
| WebSocket server | 13 | `apps/ws-server/` | Subscriptions, AUTH, depth resync, backpressure, heartbeat, 5k-client test, `docs/perf.md` |
| Test fixtures | — | `packages/types/fixtures/` | Golden event logs (e.g. the §5.3 worked example) produced by the real engine |

### Dev B — Platform, API & Web (client side of the stream + tooling)

**Rationale:** everything request/response-shaped and user-facing. B also owns the shared tooling and the schema because Phases 0–2 come first on the critical path and someone has to be the single gatekeeper for them.

| Module | Spec phases | Directories | Deliverables |
|---|---|---|---|
| Repo scaffold | 0, 1 | root files, `packages/config/`, `packages/logger/`, skeletons of all apps | Workspaces, strict tsconfig, ESLint money rule, Vitest workspace, **minimal CI** (lint, typecheck, test) |
| `@cex/db` | 2 | `packages/db/` | Prisma schema (verbatim §4.5), Timescale migration + candle aggregates, idempotent seed (+ G4 fee user) |
| Auth | 4 | `apps/api-gateway/src/{routes,services,middleware,schemas,plugins}/auth*` | Signup/signin/refresh/signout, JWT, rotation with reuse detection, rate limits, audit |
| Engine client | 8 (gateway half) | `apps/api-gateway/src/services/engine-client.ts` | `XADD`, reply waiter, 2 s timeout → 202, `XLEN` backpressure → 503 |
| Fake engine | — | `apps/api-gateway/src/tests/fake-engine.ts` | Reads `engine.commands` and answers per contract (replays fixtures). Deleted or kept only as a test double after I1 |
| Trading API | 9 | `apps/api-gateway/src/{routes,services,schemas}/orders*, balances*` | Order routes, `MarketConfigCache`, pagination, OpenAPI at `/docs` |
| Public read API | 12 (step 7) | `apps/api-gateway/src/routes/market*` | `/depth`, `/ticker` (Redis keys from A), `/trades`, `/klines` (Postgres views) |
| Wallet and admin | 14 | `apps/api-gateway/src/routes/{wallet,admin}*` | Deposit/withdraw, admin market/halt/withdrawal/fees, audit rows |
| Web | 15, 16, 17 | `apps/web/` | Next.js app, `lib/api.ts`, `lib/ws.ts`, `lib/format.ts`, stores, terminal, wallet/orders/admin pages, Playwright. Design reference: `docs/designs/Kairos.html` |
| Mock WS server | — | `apps/web/scripts/mock-ws.ts` | Serves fixture-driven §6.2 frames until A's ws-server lands |

### 2.1 Why this split and not another

- **Frontend vs. backend** was rejected: the backend is about 80% of the work, and the engine's coupling problems would stay inside one person anyway.
- **Engine vs. "all other services"** was rejected: the other services split depth/seq semantics (C5) across two people.
- **The cut along the Redis stream** gives one write-side contract (commands and replies) and one read-side contract (events, plus the WS protocol, which §6.2 already specifies). Both are message schemas, so they can be fixed in a few days, tested mechanically and faked easily.
- **Workload:** A carries the deepest correctness work. B carries more surface area. **Fallback if A falls behind:** move `apps/ws-server` to B. It is isolated behind pub/sub and §6.2, so the move costs no restructuring.

---

## 3. Dependency and Integration Matrix

### 3.1 Module × module (rows depend on columns)

| ↓ depends on → | types | money | config/logger | db | engine | db-worker | market-data | ws-server | gateway |
|---|---|---|---|---|---|---|---|---|---|
| **engine** (A) | ● | ● | ● | seed only | | | | | |
| **db-worker** (A) | ● | ● | ● | **B** | events | | | | |
| **market-data** (A) | ● | ● | ● | **B** (reads) | events | | | | |
| **ws-server** (A) | ● | | ● | | | | pub/sub, keys | | **B** (JWT) |
| **gateway** (B) | ● | **A** | ● | ● | **A** (stream) | **A** (projection lag) | **A** (keys) | | |
| **web** (B) | ● | **A** | | | | | | **A** (WS) | ● |

`●` = same owner or a frozen contract. A **bold letter** marks a dependency on the other developer.

### 3.2 Contracts (frozen in the Contract Sprint, tag `contracts-v1`)

All of these live in `packages/types/src/`, one file per concern so that edits rarely touch the same file.

```ts
// money.ts — wire money type
export type Money = string;                     // scaled BigInt (1e8) as decimal string

// enums.ts — Side, OrderType, OrderStatus, MarketStatus, RejectCode, LedgerReason, Role (uppercase strings)

// redis.ts — the only place Redis names appear (§4.7)
export const STREAM = { COMMANDS: 'engine.commands', REPLIES: 'engine.replies',
                        EVENTS: 'engine.events', DEAD: 'engine.events.dead' } as const;
export const GROUP  = { ENGINE: 'engine', DBW: 'dbw', MD: 'md' } as const;
export const KEY    = { depth: (m: string) => `depth:${m}`, ticker: (m: string) => `ticker:${m}`,
                        marketCfg: (s: string) => `marketcfg:${s}`, rl: (scope: string, id: string) => `rl:${scope}:${id}` };
export const CHAN   = { depth: (m: string) => `md:depth:${m}`, trade: (m: string) => `md:trade:${m}`,
                        ticker: (m: string) => `md:ticker:${m}`, kline: (i: string, m: string) => `md:kline:${i}:${m}`,
                        user: (u: string) => `user:${u}` };

// commands.ts — written by B (gateway), consumed by A (engine)
interface Base<T extends string, P> { commandId: string; type: T; userId?: string; ts: number; payload: P }
export type Command =
  | Base<'PLACE_ORDER', { orderId: string; market: string; side: Side; type: OrderType;
        price?: Money; quantity?: Money; quoteQuantity?: Money;
        postOnly: boolean; ioc: boolean; clientOrderId?: string }>
  | Base<'CANCEL_ORDER',      { orderId: string }>                                   // G5
  | Base<'DEPOSIT',           { depositId: string; asset: string; amount: Money }>
  | Base<'WITHDRAW_REQUEST',  { withdrawalId: string; asset: string; amount: Money }>
  | Base<'WITHDRAW_COMPLETE', { withdrawalId: string }>                              // G3
  | Base<'WITHDRAW_REJECT',   { withdrawalId: string }>
  | Base<'MARKET_CONFIG',     MarketConfigWire>
  | Base<'HALT_MARKET' | 'RESUME_MARKET', { market: string }>;

// events.ts — written by A (engine), consumed by A (db-worker, market-data) and indirectly by B
export interface OrderSnapshot {                                                     // G7
  orderId: string; clientOrderId?: string; userId: string; market: string;
  side: Side; type: OrderType; price?: Money; quantity: Money;                       // G8
  quoteQuantity?: Money; filledQuantity: Money; avgPrice?: Money;
  status: OrderStatus; postOnly: boolean; ioc: boolean; rejectReason?: RejectCode;
}
interface Ev<T extends string, D> { engineSeq: string; commandSeq: string;            // G1
                                    commandId: string; type: T; ts: number; data: D }
export type EngineEvent =
  | Ev<'ORDER_ACCEPTED' | 'ORDER_PLACED' | 'ORDER_UPDATED' | 'ORDER_CANCELLED' | 'ORDER_REJECTED', OrderSnapshot>
  | Ev<'TRADE', { market: string; price: Money; quantity: Money; makerOrderId: string; takerOrderId: string;
                  makerUserId: string; takerUserId: string; takerSide: Side; makerFee: Money; takerFee: Money }>
  | Ev<'BALANCE_UPDATED', { userId: string; asset: string; available: Money; locked: Money;
                            entries: { delta: Money; reason: LedgerReason; refId?: string }[] }>   // G2
  | Ev<'DEPTH_DELTA',   { market: string; side: Side; price: Money; quantity: Money }>  // new level total; "0" = remove
  | Ev<'MARKET_STATUS', { market: string; status: MarketStatus }>;

// replies.ts — written by A (runner), consumed by B (EngineClient)                  // G6
export interface EngineReply {
  commandId: string; engineSeq: string;
  status: 'OK' | 'REJECTED'; code?: RejectCode;
  order?: OrderSnapshot;                                         // PLACE/CANCEL
  balance?: { asset: string; available: Money; locked: Money };  // DEPOSIT/WITHDRAW_*
}

// ws.ts — §6.2 frames. Payloads on md:* and user:* channels ARE these frames, so ws-server forwards them verbatim
export type WsServerFrame = DepthSnapshotFrame | DepthUpdateFrame | TradeFrame | TickerFrame
                          | KlineFrame | OrderUpdateFrame | BalanceUpdateFrame | ErrorFrame | PongFrame;
export type WsClientFrame = { method: 'SUBSCRIBE' | 'UNSUBSCRIBE'; params: string[] }
                          | { method: 'AUTH'; token: string } | { method: 'PING' };

// redis-values.ts — JSON stored at depth:{m} and ticker:{m} (A writes, B's /depth and /ticker read)
export interface DepthSnapshot { market: string; seq: number; bids: [Money, Money][]; asks: [Money, Money][] }
export interface TickerSnapshot { market: string; last: Money; open24h: Money; high24h: Money; low24h: Money; volume24h: Money; ts: number }

// auth.ts — B issues, A (ws-server) verifies. HS256 with JWT_ACCESS_SECRET            // C6
export interface AccessTokenClaims { sub: string; role: Role; iat: number; exp: number }
```

Each type also gets a **zod schema** in the same file. A's tests assert that every emitted event parses. B's tests assert that every command it sends parses. That makes contract drift a failing test instead of an integration surprise.

### 3.3 Blocking dependencies (task X cannot start until Y)

| Blocked task | Needs | Owner of need | Workaround so nobody waits |
|---|---|---|---|
| Everything | Layout decision + Phase 1 scaffold | B (+ A reviews) | A writes pure book code (Phase 5) in a scratch branch meanwhile |
| Everything that crosses the stream | `contracts-v1` | Both | Pairing sessions; this is the only true joint blocker |
| db-worker (A, P11) | Prisma schema + migrations (P2) | B | P2 is B's first task, so it lands early |
| Gateway order routes (B, P9) | money `zScaledString` (P3) | A | P3 is A's first task. Until it lands, B uses a temporary local regex schema |
| Gateway P9 end-to-end | Real engine runner (A, P8) | A | **Fake engine** replays fixtures |
| Gateway `/orders/open`, `/balances` real data | db-worker (A, P11) | A | Tests seed projection rows directly |
| Gateway `/depth`, `/ticker` | market-data keys (A, P12) | A | Tests write fixture `DepthSnapshot`/`TickerSnapshot` to Redis |
| Web live terminal (B, P16) | ws-server (A, P13) | A | `mock-ws.ts` serves fixture frames |
| ws-server private stream (A, P13) | JWT issuing (B, P4) | B | A signs test tokens with the contract claims and secret |
| Phase 18 suites | Everything | Both | — |

---

## 4. Parallel Development Strategy

### 4.1 What runs simultaneously

```
            M0 (joint)         M1                    M2                  M3                   M4 (joint)
A: scaffold-review/types │ P3 money → P5 book → P6 match → P7 balances → P8 runner │ P11 dbw → P10 recovery → P12 md → P13 ws │ P18
B: P0/P1 scaffold/types  │ P2 db → P4 auth → P8 client+fake → P9 trading API      │ P14 wallet/admin → P12.7 reads → P15 → P16 → P17 │ P18
                                                          ▲ I1                         ▲ I2   ▲ I3                 ▲ I4
```

**Reorder for A: Phase 11 before Phase 10.** Appendix A lists both as depending only on Phase 8. Doing the db-worker first unblocks B's read routes with real data (I2) weeks earlier, while recovery stays internal to the engine.

### 4.2 The fake engine (main tool against bottleneck B1)

`apps/api-gateway/src/tests/fake-engine.ts`, about 100 lines:
1. `XREADGROUP` on `engine.commands` with its own group.
2. Looks up the `commandId`'s scenario in a fixture map, or uses a default: `PLACE_ORDER` → `OK` with status `OPEN`; a `price` ending in `13` → `REJECTED INVALID_TICK`; and so on.
3. `XADD`s an `EngineReply` that passes the zod schema.

Once A's engine exists, A regenerates `packages/types/fixtures/*.jsonl` from the **real** engine. If B's tests still pass on the real fixtures, integration I1 is low-risk.

### 4.3 Git workflow (refines cex.md §9.3; it doesn't replace it)

- `main` is protected: PR required, CI green, no force-push.
- Branch names: `a/phase-05-order-book`, `b/phase-04-auth`, `contract/<topic>`, `chore/<topic>`.
- Branches are short-lived (≤ 3 days). **Rebase on `main` every morning** before work.
- **Squash-merge**, with the PR title as the commit message: `phase-NN: <summary>` for the PR that completes a phase, conventional commits (`feat:`, `fix:` …) otherwise.
- **Contract PRs** (`packages/types/**`, `packages/db/prisma/**`, root config) need approval from **both** developers, enforced by CODEOWNERS. They should only *add* fields. Removing or renaming a field means bumping the `contracts-vN` tag and fixing both sides in the same PR.
- Other PRs: author merges after green CI. Cross-review is optional but encouraged on engine PRs, since both of you need to understand the engine for Phase 18.
- Async rhythm: a daily three-line status in a shared channel (done / next / blocked-by), one 30-minute call per week, plus a call at each integration point (I1–I4).

---

## 5. Shared File and Module Ownership

### 5.1 Ownership table

| Path | Owner | Others may change it? |
|---|---|---|
| `packages/money/**` | A | Via PR, A approves |
| `apps/engine/**`, `apps/db-worker/**`, `apps/market-data/**`, `apps/ws-server/**` | A | Via PR, A approves |
| `packages/types/fixtures/**` | A (generated from the engine) | No hand edits |
| `packages/db/**` (schema, migrations, seed) | B | `contract/` PR, both approve |
| `packages/config/**`, `packages/logger/**` | B | Via PR, B approves |
| `apps/api-gateway/**`, `apps/web/**` | B | Via PR, B approves |
| Root: `package.json`, `tsconfig.base.json`, `.eslintrc.cjs`, `.prettierrc`, `vitest.workspace.ts`, `.github/**`, compose files | B | Via PR, B approves |
| `packages/types/src/**` | **Joint** | `contract/` PR, both approve |
| `docs/cex.md`, `docs/agent.md`, `docs/workstreams.md` | Joint | Both approve |
| `package-lock.json` | Nobody hand-edits it | See the lockfile rule |

`.github/CODEOWNERS` (replace the placeholders with the real GitHub handles):

```
*                         <dev-b-github>
/packages/money/          <dev-a-github>
/apps/engine/             <dev-a-github>
/apps/db-worker/          <dev-a-github>
/apps/market-data/        <dev-a-github>
/apps/ws-server/          <dev-a-github>
/packages/types/          <dev-a-github> <dev-b-github>
/packages/db/prisma/      <dev-a-github> <dev-b-github>
/docs/                    <dev-a-github> <dev-b-github>
```

Enable "Require review from Code Owners" so that shared paths need both approvals.

### 5.2 Rules for shared files

1. **Lockfile:** only change dependencies inside your own workspace (`npm i <pkg> -w @cex/engine`). On a lockfile conflict, never hand-merge: take `main`'s version (`git checkout --theirs package-lock.json`), run `npm install` and commit the result.
2. **Config:** `packages/config` defines **all** Appendix C variables in Phase 1, so neither side needs to touch it later. A new variable means a PR that updates `.env.example` and Appendix C together.
3. **Types:** each concern has its own file (§3.2). Engine work touches `events.ts`/`replies.ts` and gateway work touches `commands.ts`/`dto.ts`, so the same file rarely gets two concurrent edits.
4. **Root scripts:** each workspace defines its own `build/test/lint/typecheck`. The root only runs `--workspaces --if-present`, so new apps never need root edits.
5. **Migrations:** only B creates Prisma migrations. If A needs a column or index for db-worker, A opens an issue and B ships the migration. Two developers generating migrations in parallel produces conflicting migration histories.

### 5.3 Contract Sprint (M0) — exit checklist

- [ ] Layout decision applied (§1.1); Node 20 on both machines; Phase 0 acceptance passes on **both** machines.
- [ ] Phase 1 scaffold merged (B); A has reviewed it.
- [ ] G1–G8 decided and recorded in this file (or in cex.md, if you prefer to amend the spec).
- [ ] `packages/types` merged with all §3.2 types and zod schemas; tag `contracts-v1`.
- [ ] CODEOWNERS, branch protection and minimal CI are on.

---

## 6. Integration and Testing Strategy

### 6.1 Test responsibilities

| Level | A owns | B owns |
|---|---|---|
| Unit / property | money (coverage ≥ 95%, round-trips); book property tests; matching table tests + 100k fuzz; balances (worked example to the unit, conservation fuzz) | auth service, schemas, `MarketConfigCache`, `format.ts`, `parseInputToScaled`, slider BigInt math |
| Contract | Every emitted event and reply parses with the zod schemas; fixtures regenerated by the engine | Every sent command parses; fake engine only answers with schema-valid replies; web parses fixture WS frames |
| Integration (own side, real Redis/PG) | runner exactly-once; recovery `kill -9` ×50 hash compare; db-worker double replay; depth snapshot + deltas = engine book; WS isolation (user A ≠ user B) | Auth flows + rate limits; order routes against the fake engine; wallet/admin + audit rows; migrations + seed idempotency |
| Cross-stream integration (Phase 18.3) | Co-owned: A owns engine/worker/WS assertions, B owns the harness + gateway/REST assertions | |
| E2E (Playwright) | — | B, with A reviewing the trading scenarios |
| Load (k6) / chaos | A: engine, worker, ws numbers; `docs/perf.md`, `docs/chaos.md` | B: gateway latency scenario + k6 scripts |
| Reconciliation (`scripts/reconcile.ts`) | A | — |

### 6.2 Integration sequence (each step is a small PR plus a joint call)

| Step | Combines | Proof |
|---|---|---|
| **I1** | Real engine replaces the fake engine behind the gateway | Phase 9 acceptance E2E: sign in → deposit → place → see in open orders → cancel → balance unlocked |
| **I2** | db-worker on | `/orders/open`, `/orders/history`, `/trades/mine`, `/balances` return real projections; Phase 11 100k-order DB = engine balances |
| **I3** | market-data + gateway public reads | `/depth`, `/ticker`, `/klines`, `/trades` match hand-computed values (Phase 12 acceptance) |
| **I4** | ws-server ↔ web (mock-ws removed) | Phase 16 acceptance: two browsers trade, everything updates in < 300 ms |
| **I5** | Wallet/admin end to end | Phase 17 Playwright: admin halts a market, trader sees "Market halted" |

Rules: one integration step at a time on `main`; never two in flight. Each step starts with both of you rebased on the same `main` commit. A failure becomes a regression test before the fix (§9.4).

---

## 7. Development Roadmap

| Milestone | Dev A | Dev B | Exit criteria |
|---|---|---|---|
| **M0 Foundation** (joint, blocking) | Review scaffold; co-write `events.ts`, `replies.ts`, `ws.ts`; start Phase 5 in a scratch branch | Restructure repo, Phase 0/1 scaffold, CI; co-write `commands.ts`, `dto.ts`, `redis.ts` | §5.3 checklist; `contracts-v1` tagged |
| **M1 Cores** | P3 money → P5 book → P6 matching → P7 balances | P2 db + seed → P4 auth | Phase 2–7 acceptance (A: worked example exact; B: auth tests green) |
| **M2 First contact** | P8 runner; publish real fixtures | P8 EngineClient + fake engine → P9 trading API | **I1** passes |
| **M3 Services** | P11 db-worker → P10 recovery → P12 market-data → P13 ws-server | P14 wallet/admin → P12.7 public reads → P15 web foundation → P16 terminal (on mock-ws) | **I2, I3, I4** pass |
| **M4 Product complete** | Help with E2E trading scenarios; prepare reconciliation | P17 pages + admin UI | **I5** passes |
| **M5 Verify** (P18, joint) | Fuzz/coverage gates, chaos, reconciliation, perf | Integration harness, E2E, security tests, k6 gateway | Phase 18 acceptance |
| **M6 Ship** | P19: engine/worker/md/ws Dockerfiles, engine metrics, journal/snapshot backups, runbook engine section | P19: nginx, prod compose, migrate service, web/gateway Dockerfiles, full CI, secrets, Grafana | Phase 19 acceptance |
| **M7 Release** (P20, joint) | Demo script engine side | README, CHANGELOG, tag | `v1.0.0` |

### What can start right now

**Both, today:**
1. Agree on the layout decision (§1.1) and G1–G8 (§1.5).
2. Install Node 20 and pass Phase 0 acceptance on both machines.
3. Remove the planning comment from `cex.md`; delete `debug.log`; decide whether to keep the re-escaped `Kairos.html`.

**Dev A, immediately:** Phase 5 order book (`DoublyLinkedList`, `SortedPriceLevels`). It is pure code with no dependencies, so it can live in a scratch branch until the scaffold merges. Then Phase 3 money as the first merged PR.

**Dev B, immediately:** the Phase 1 scaffold (root workspace, tsconfig, ESLint money rule, config/logger, empty app skeletons, CI), then the Phase 2 Prisma schema verbatim from §4.5.

### Note on the "one phase at a time" rule (cex.md §0.2)

That rule now applies **per workstream**. Each developer still finishes their phases in order and meets every acceptance criterion. Cross-stream prerequisites from Appendix A are replaced by contracts and fakes only where listed in §3.3, and each one is retired at an explicit integration step (I1–I5). If you use the AI prompt in §0.2, tell it which workstream and phase it is on and point it at this file.
