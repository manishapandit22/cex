# CEX Platform: Project Documentation & Build Specification

> **Purpose.** This is the single source of truth for building a spot Centralized Exchange (CEX) from scratch. It has two audiences:
> 
> 1. **A human** who wants to understand the whole project and follow it step by step.
> 2. **An AI assistant** that receives this file and must build, review, or extend the project without needing more explanation.
> 
> **Structure.**
> 
> - **Part A (Sections 1 to 3):** what we are building and how it is shaped.
> - **Part B (Sections 4 to 9):** reference specifications (data, engine rules, API, security, UI, conventions).
> - **Part C (Phase 0 to Phase 20):** the ordered build plan.
> - **Appendices:** dependency map, ports, environment variables, glossary of error codes.

---

## 0. How to Use This Document

### 0.1 For humans

1. Read Part A to understand the system.
2. Skim Part B; return to it whenever a phase references a rule.
3. Execute Part C in order. A phase is finished only when **every acceptance criterion passes**. Do not skip ahead.
4. Commit at the end of every phase with the message format `phase-NN: <summary>`.

### 0.2 For an AI assistant (paste this block first, then the document)

```
ROLE: You are a senior backend/full-stack engineer building the CEX in this document.

RULES
1. Work on ONE phase at a time. Never write code that belongs to a later phase.
2. Before coding, restate the phase Goal, Steps, and Acceptance Criteria in 5 lines.
3. Obey the Non-Negotiable Invariants (Section 3.5). If a request conflicts with them, say so and stop.
4. All money is a scaled BigInt. Never use float/number for money. Wire format is a decimal string.
5. The matching engine's process() function is pure and synchronous: no DB, Redis, HTTP, clock, or random calls inside it.
6. Use only the technology listed in the Decision Log (Section 2). If something is not specified, ask me.
7. Follow the naming, folder, and error conventions in Section 9.
8. After each phase reply with: files created/changed, commands to run, tests written and their results, acceptance checklist (pass/fail).
9. Never invent endpoints, tables, or message types that are not in this document without asking.
```

### 0.3 Glossary

| Term                | Meaning                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Base / Quote asset  | In `SOL_USDT`, SOL is the base (thing traded) and USDT is the quote (price currency)        |
| Maker               | An order that rests on the book and provides liquidity                                      |
| Taker               | An order that matches immediately against resting orders                                    |
| Spread              | Best ask minus best bid                                                                     |
| Scaled integer      | Human value multiplied by 10^8 and stored as BigInt (Section 4.1)                           |
| Price-time priority | Better price matches first; at equal price, the earlier order matches first                 |
| STP                 | Self-Trade Prevention: stops a user’s order matching the same user’s resting order          |
| Command             | An input message to the engine (place order, cancel, deposit, …)                            |
| Event               | An output message from the engine (accepted, trade, cancelled, balance changed, …)          |
| Journal (WAL)       | Append-only file of every command, used to rebuild engine state after a crash               |
| Snapshot            | Periodic full dump of engine state used to speed up recovery                                |
| engineSeq           | Strictly increasing sequence number assigned by the engine to every processed command/event |
| Tick size           | Smallest allowed price increment. **Lot size:** smallest allowed quantity increment         |
| Notional            | Price x quantity, expressed in the quote asset                                              |
| L2 depth            | Aggregated order book: total quantity per price level                                       |
| OHLCV               | Open, High, Low, Close, Volume (a candlestick)                                              |
| Projection          | A database view of engine events, rebuildable from them                                     |

---

# PART A: UNDERSTANDING THE PROJECT

## 1. Vision and Scope

### 1.1 What we are building

A **spot exchange**. Users register, receive balances, place buy/sell orders, watch a live order book and chart, and see their trade history. The hard engineering problem is a **fast, correct, crash-recoverable matching engine** that never loses or invents money.

### 1.2 Who uses it

| Actor            | What they do                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| Trader (USER)    | Sign up, deposit (simulated), trade, cancel, withdraw (request), view history                          |
| Bot / API client | Same as trader via REST and WebSocket with high order rates                                            |
| Admin (ADMIN)    | Create markets, set fees, halt or resume a market, approve withdrawals, view fee revenue and audit log |
| Operator         | Deploys, monitors, restores from backup                                                                |

### 1.3 In scope

- Email/password auth, JWT access tokens, rotating refresh tokens
- LIMIT and MARKET orders; Post-Only and IOC flags; self-trade prevention
- In-memory matching with price-time priority
- Balance locking, settlement, maker/taker fees
- Real-time order book, trades, ticker, candles and private user stream (WebSocket)
- Simulated wallet (deposits and withdrawals are ledger entries; no real blockchain)
- Admin basics
- Next.js trading terminal

### 1.4 Out of scope

Margin, futures, stop/OCO orders, FOK, order amendment, real blockchain custody, real fiat rails, real KYC provider, mobile apps, multi-region deployment.

### 1.5 User stories (drive the acceptance tests)

1. As a trader I can sign up and sign in, and my session stays alive without re-typing my password for 7 days.
2. As a trader I can place a limit buy; if it does not match it appears on the book and my funds show as locked.
3. As a trader I can place a market order and receive fills at the best available prices.
4. As a trader I can cancel an open order and my locked funds are released immediately.
5. As a trader I see my order, trade, and balance updates in real time without refreshing.
6. As a trader I never see another user’s private data.
7. As an admin I can halt a market; traders can still cancel but cannot place new orders.
8. As an operator I can kill the engine at any moment and after restart no accepted order is lost and balances are unchanged.

### 1.6 Non-functional targets

| Metric                      | Target                   | Note                                        |
| --------------------------- | ------------------------ | ------------------------------------------- |
| Engine match time per order | < 1 ms p99               | Measured in-process, excludes network       |
| API order acknowledgement   | < 50 ms p99              | Gateway to engine to gateway                |
| Throughput                  | 3,000+ orders/sec        | One engine process, load-tested in Phase 18 |
| Crash recovery              | < 60 s                   | Snapshot load + journal replay              |
| Acknowledged-order loss     | 0                        | Journal is written before acknowledgement   |
| WebSocket fan-out           | 5,000 concurrent clients | p99 < 250 ms local                          |
| Availability target         | 99.5% (single region)    | Documented, not contractually enforced      |

---

## 2. Decision Log (Locked Choices)

An AI must treat these as fixed unless the user changes them.

| #   | Decision                                                                                           | Reason                                                         |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| D1  | Runtime Node.js 20 LTS, TypeScript (strict), npm workspaces monorepo                               | Mature tooling                                                 |
| D2  | API framework Fastify with zod validation                                                          | Fast, schema-first                                             |
| D3  | Message transport Redis 7 **Streams** with consumer groups, AOF persistence on                     | Ack, replay, ordering                                          |
| D4  | **One engine process owns all markets and all live balances**                                      | Users share balances across markets, so one owner avoids races |
| D5  | The engine is the **only authority for live balances**; Postgres is a durable projection           | No double-spend, no drift                                      |
| D6  | Internal scale 10^8; money is BigInt; wire format is decimal string                                | Precision and JSON safety                                      |
| D7  | Market BUY uses `quoteQuantity` (budget); market SELL uses `quantity`                              | Clear lock rule                                                |
| D8  | Fees are charged in the **asset received**; defaults maker 0.08%, taker 0.10%; rounded **up**      | Standard convention                                            |
| D9  | STP mode default `CANCEL_TAKER`                                                                    | Simple, safe                                                   |
| D10 | IDs: UUIDv7 for orders (time-sortable); UUIDv4 elsewhere; optional `clientOrderId` for idempotency | Dedupe + ordering                                              |
| D11 | Passwords: argon2id. Access token 15 min. Refresh token 7 days, rotating, stored hashed            | Security baseline                                              |
| D12 | Database PostgreSQL 16 + TimescaleDB, Prisma ORM                                                   | Time series + typed access                                     |
| D13 | Frontend Next.js 14 App Router, TailwindCSS, `lightweight-charts`, Zustand for state               | Lightweight, fast                                              |
| D14 | Testing: Vitest (unit/integration), fast-check (property tests), Playwright (E2E), k6 (load)       | Standard, TS-native                                            |
| D15 | Wallet is simulated (ledger entries only)                                                          | No custody liability                                           |
| D16 | Logging pino (JSON), metrics Prometheus, dashboards Grafana                                        | Standard stack                                                 |
| D17 | Deployment Docker Compose behind Nginx (single host)                                               | Simple and reproducible                                        |

---

## 3. Architecture

### 3.1 Component responsibilities

| Component           | Folder             | Stateless?               | Owns                                                             | Must NOT                    |
| ------------------- | ------------------ | ------------------------ | ---------------------------------------------------------------- | --------------------------- |
| API Gateway         | `apps/api-gateway` | Yes                      | Auth, validation, rate limits, command creation, read APIs       | Hold balances; match orders |
| Matching Engine     | `apps/engine`      | No (in-memory + journal) | Order books, live balances, sequence numbers, journal, snapshots | Touch Postgres; call HTTP   |
| DB Worker           | `apps/db-worker`   | Yes                      | Writing events to Postgres idempotently                          | Decide business outcomes    |
| Market Data Service | `apps/market-data` | Mostly                   | Ticker, rolling stats, depth snapshots, kline pushes             | Write orders/balances       |
| WebSocket Server    | `apps/ws-server`   | Yes                      | Client connections, subscriptions, fan-out                       | Mutate state                |
| Web App             | `apps/web`         | n/a                      | Trading terminal UI                                              | Do float math on money      |
| Shared packages     | `packages/*`       | n/a                      | `types`, `money`, `db`, `config`, `logger`                       | Contain app logic           |

### 3.2 System architecture

```mermaid
flowchart TB
    subgraph Clients
        WEB[Next.js Trading Terminal]
        BOT[Trading Bots / API Clients]
    end

    subgraph Edge
        NGX[Nginx Reverse Proxy + TLS]
    end

    subgraph Stateless
        API[API Gateway - Fastify]
        WS[WebSocket Server]
    end

    subgraph Redis[Redis 7 - AOF on]
        CMD[(Stream: engine.commands)]
        REP[(Stream: engine.replies)]
        EVT[(Stream: engine.events)]
        PUB[[Pub/Sub: market data + user events]]
        CACHE[(Keys: depth snapshots, market config, rate limits)]
    end

    subgraph Core[Single-threaded Core]
        ENG[Matching Engine - books + balances in RAM]
        JRN[(Journal + Snapshots on disk)]
    end

    subgraph Persistence
        DBW[DB Worker - idempotent consumer]
        MD[Market Data Service - ticker, depth, klines]
        PG[(PostgreSQL 16 + TimescaleDB)]
    end

    WEB -->|HTTPS REST| NGX
    WEB -->|WSS| NGX
    BOT --> NGX
    NGX --> API
    NGX --> WS

    API -->|XADD command| CMD
    API -->|wait for reply| REP
    API -->|read-only queries| PG
    API --> CACHE

    CMD -->|XREADGROUP| ENG
    ENG -->|append before processing| JRN
    ENG -->|XADD reply| REP
    ENG -->|XADD events| EVT

    EVT --> DBW --> PG
    EVT --> MD --> PG
    MD --> CACHE
    MD --> PUB
    EVT --> WS
    PUB --> WS
    WS --> WEB
```

**How to read it.** Everything that changes money goes through the engine only, left to right. Postgres is never in the matching path. The WebSocket server is read-only.

### 3.3 End-to-end order lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant UI as Web UI
    participant G as API Gateway
    participant R as Redis Streams
    participant E as Engine
    participant J as Journal
    participant D as DB Worker
    participant W as WS Server

    U->>UI: Click "Buy SOL"
    UI->>G: POST /api/v1/order (JWT)
    G->>G: Validate JWT, schema, tick/lot, clientOrderId
    G->>G: Advisory balance check (cache only)
    G->>R: XADD engine.commands PLACE_ORDER
    R->>E: XREADGROUP (blocking read)
    E->>J: Append command
    E->>E: Lock funds, match against book
    alt Rejected
        E->>R: XADD replies ORDER_REJECTED
        R->>G: reply
        G->>UI: 422 + reason code
    else Accepted
        E->>R: XADD replies ORDER_ACCEPTED
        E->>R: XADD events (TRADE, ORDER_*, BALANCE_UPDATED, DEPTH_DELTA)
        R->>G: reply
        G->>UI: 201 + order state
    end
    E->>R: XACK command
    R->>D: events (consumer group)
    D->>D: Upsert by engineSeq (idempotent)
    D->>D: Write Order, Trade, Balance, Ledger
    R->>W: depth delta + user events
    W->>UI: Live book, trades, private order update
```

### 3.4 Cancel and withdraw flows

```mermaid
sequenceDiagram
    participant UI
    participant G as Gateway
    participant E as Engine
    UI->>G: DELETE /order/:id
    G->>E: CANCEL_ORDER (via stream)
    E->>E: index lookup O(1), verify owner, remove, unlock
    E-->>G: ORDER_CANCELLED or NOT_FOUND / NOT_OWNER
    G-->>UI: 200 or 404/403
    Note over E: Unlocked funds are available immediately
```

### 3.5 Non-Negotiable Invariants

These are testable. Every phase’s tests must keep them true.

1. **No float for money.** All amounts are BigInt (wire: decimal string).
2. **Conservation.** For each asset: `sum(available + locked over all users) + fee_account = total_deposits - total_withdrawals`. Trades never create or destroy value.
3. **No negative balances.** `available >= 0` and `locked >= 0` always.
4. **Price-time priority.** Better price first; same price, lower `engineSeq` first.
5. **Maker-price execution.** A trade always executes at the resting (maker) order’s price.
6. **No crossed book.** After any command, `best_bid < best_ask`.
7. **Determinism.** Replaying the same journal from the same snapshot produces byte-identical state.
8. **Idempotency.** Applying the same command or event twice changes nothing the second time.
9. **Engine purity.** No I/O or non-deterministic calls inside the match function.
10. **No acknowledged order is lost.** The journal write happens before the acknowledgement.
11. **Quantity bookkeeping.** For every order, `0 <= filled <= quantity`; for every level, `totalQuantity = sum(order remaining)`.
12. **Locks match open orders.** A user’s locked balance equals the sum of locks of their open orders plus pending withdrawals.

### 3.6 Engine recovery flow

```mermaid
flowchart LR
    A[Engine starts] --> B{Snapshot exists?}
    B -- yes --> C[Load latest snapshot<br/>books, balances, lastSeq]
    B -- no --> D[Start empty<br/>seed balances from Postgres once]
    C --> E[Replay journal entries<br/>with seq greater than lastSeq]
    D --> E
    E --> F[Verify invariants<br/>conservation, no crossed book]
    F -- fail --> X[Refuse to start and alert]
    F -- ok --> G[Resume XREADGROUP from<br/>last acknowledged stream id]
    G --> H[Publish fresh depth snapshots]
```

### 3.7 Data ownership

| Data                          | Source of truth                                 | Other copies                                                       |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| Live balances, open orders    | Engine memory (rebuilt from snapshot + journal) | Postgres projection; Redis depth cache                             |
| Users, passwords, tokens      | Postgres                                        | none                                                               |
| Market configuration          | Postgres                                        | Redis cache + engine memory (refreshed by `MARKET_CONFIG` command) |
| Trades, order history, ledger | Postgres (from events)                          | none                                                               |
| Candles                       | TimescaleDB continuous aggregates               | in-progress candle in Market Data memory                           |

### 3.8 Deployment topology

```mermaid
flowchart LR
    Internet --> NGX[Nginx 80/443]
    subgraph Docker network - internal
        NGX --> API[api-gateway :4000]
        NGX --> WSS[ws-server :8080]
        NGX --> WEBAPP[web :3000]
        API --> RDS[(redis :6379)]
        API --> PGS[(postgres :5432)]
        ENGINE[engine] --> RDS
        ENGINE --> VOL[(volume: journal + snapshots)]
        DBWORKER[db-worker] --> RDS
        DBWORKER --> PGS
        MKT[market-data] --> RDS
        MKT --> PGS
        WSS --> RDS
        PROM[prometheus :9090] --> API
        PROM --> ENGINE
        GRAF[grafana :3030] --> PROM
    end
```

Only Nginx publishes ports to the host in production.

---

# PART B: REFERENCE SPECIFICATIONS

## 4. Data Specifications

### 4.1 Fixed-point money

- `SCALE = 10n ** 8n`.
- Convert at the edge only: `toScaled("142.5") = 14250000000n`; `fromScaled(14250000000n) = "142.5"`.
- Parse from **strings**, never from JavaScript `Number`. Reject more than 8 decimals, negatives, exponent notation, empty strings.
- Formulas (integer division floors unless stated):

```
quoteAmount = (price * quantity) / SCALE                  // floor
fee         = ceil(receivedAmount * feeBps / 10_000)      // rounds UP (exchange favoring)
buyLock     = ceil(price * quantity / SCALE)              // limit buy lock, in quote asset
sellLock    = quantity                                    // limit sell lock, in base asset
```

- Assets with more than 8 native decimals (e.g., ETH has 18): amounts are rounded **down** to 8 decimals at deposit. The remainder is not credited.
- Postgres column types: prices, quantities, balances `BIGINT`; any product or sum of products (`quoteAmount`, volumes) `NUMERIC(38,0)`. Maximum single balance supported: about 92 billion units at scale 10^8.
- Wire example: `{"price":"14250000000","quantity":"1000000000"}`.

### 4.2 Order model

| Field           | Type                         | Rules                                                     |
| --------------- | ---------------------------- | --------------------------------------------------------- |
| `orderId`       | UUIDv7                       | Generated by gateway                                      |
| `clientOrderId` | string, 1-36 chars, optional | Unique per user; duplicate returns the original result    |
| `userId`        | UUID                         | From JWT, never from request body                         |
| `market`        | string                       | Must exist and be `ACTIVE`                                |
| `side`          | `BUY` or `SELL`              |                                                           |
| `type`          | `LIMIT` or `MARKET`          |                                                           |
| `price`         | scaled BigInt                | Required for LIMIT; multiple of `tickSize`                |
| `quantity`      | scaled BigInt                | Required for LIMIT and market SELL; multiple of `lotSize` |
| `quoteQuantity` | scaled BigInt                | Required for market BUY only                              |
| `postOnly`      | bool                         | LIMIT only                                                |
| `ioc`           | bool                         | Unfilled remainder is cancelled                           |
| `stp`           | `CANCEL_TAKER`               | Default and only mode                                     |

Invalid combinations (rejected `INVALID_FLAGS`): `postOnly` with `ioc`; `postOnly` with `MARKET`; `MARKET` with `price`; market BUY without `quoteQuantity`; market SELL with `quoteQuantity`; LIMIT with `quoteQuantity`.

### 4.3 Order status state machine

```mermaid
stateDiagram-v2
    [*] --> NEW: Gateway accepts and sends to engine
    NEW --> REJECTED: Engine validation fails
    NEW --> OPEN: Rests on book, no fills
    NEW --> PARTIALLY_FILLED: Some fills, remainder rests
    NEW --> FILLED: Fully matched immediately
    NEW --> CANCELLED: IOC remainder / market remainder / STP
    OPEN --> PARTIALLY_FILLED: Maker partially hit
    OPEN --> FILLED: Maker fully hit
    OPEN --> CANCELLED: User cancel
    PARTIALLY_FILLED --> FILLED: Remainder hit
    PARTIALLY_FILLED --> CANCELLED: User cancel (keeps filled part)
    REJECTED --> [*]
    FILLED --> [*]
    CANCELLED --> [*]
```

### 4.4 Relational data model

```mermaid
erDiagram
    USER ||--o{ BALANCE : owns
    USER ||--o{ ORDER : places
    USER ||--o{ REFRESH_TOKEN : has
    USER ||--o{ DEPOSIT : makes
    USER ||--o{ WITHDRAWAL : requests
    USER ||--o{ LEDGER_ENTRY : "history of"
    ASSET ||--o{ BALANCE : "held as"
    MARKET ||--o{ ORDER : lists
    MARKET ||--o{ TRADE : produces
    ORDER ||--o{ TRADE : "maker in"
    ORDER ||--o{ TRADE : "taker in"

    USER { uuid id PK
           string email UK
           string passwordHash
           int kycLevel
           enum role
           bool isActive }
    ASSET { uuid id PK
            string symbol UK
            int decimals
            bool isActive }
    MARKET { uuid id PK
             string symbol UK
             string baseAsset
             string quoteAsset
             bigint tickSize
             bigint lotSize
             bigint minNotional
             int makerFeeBps
             int takerFeeBps
             enum status }
    BALANCE { uuid id PK
              uuid userId FK
              uuid assetId FK
              bigint available
              bigint locked
              bigint lastEngineSeq }
    ORDER { uuid id PK
            string clientOrderId
            uuid userId FK
            string market
            enum side
            enum type
            bigint price
            bigint quantity
            bigint filledQuantity
            enum status
            bigint engineSeq }
    TRADE { uuid id PK
            timestamptz createdAt PK
            bigint engineSeq
            string market
            bigint price
            bigint quantity
            uuid makerOrderId
            uuid takerOrderId
            enum takerSide
            bigint makerFee
            bigint takerFee }
    LEDGER_ENTRY { uuid id PK
                   uuid userId FK
                   string asset
                   bigint delta
                   enum reason
                   string refId
                   bigint engineSeq }
```

### 4.5 Prisma schema

File: `packages/db/prisma/schema.prisma`

```
datasource db { provider = "postgresql"  url = env("DATABASE_URL") }
generator client { provider = "prisma-client-js" }

enum Role           { USER ADMIN }
enum OrderSide      { BUY SELL }
enum OrderType      { LIMIT MARKET }
enum OrderStatus    { NEW OPEN PARTIALLY_FILLED FILLED CANCELLED REJECTED }
enum MarketStatus   { ACTIVE HALTED DELISTED }
enum LedgerReason   { DEPOSIT WITHDRAWAL TRADE FEE LOCK UNLOCK ADJUSTMENT }
enum WithdrawStatus { PENDING APPROVED REJECTED COMPLETED }

model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  kycLevel     Int      @default(1)
  role         Role     @default(USER)
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  balances     Balance[]
  orders       Order[]
  tokens       RefreshToken[]
  deposits     Deposit[]
  withdrawals  Withdrawal[]
}

model Asset {
  id        String  @id @default(uuid())
  symbol    String  @unique        // SOL, BTC, USDT
  name      String
  decimals  Int     @default(8)    // native decimals (used at deposit/display edge)
  isActive  Boolean @default(true)
  balances  Balance[]
}

model Market {
  id           String       @id @default(uuid())
  symbol       String       @unique       // SOL_USDT
  baseAsset    String
  quoteAsset   String
  tickSize     BigInt                      // scaled
  lotSize      BigInt                      // scaled
  minNotional  BigInt                      // scaled, in quote
  makerFeeBps  Int          @default(8)
  takerFeeBps  Int          @default(10)
  status       MarketStatus @default(ACTIVE)
}

model Balance {
  id            String @id @default(uuid())
  userId        String
  assetId       String
  available     BigInt @default(0)
  locked        BigInt @default(0)
  lastEngineSeq BigInt @default(0)     // projection watermark
  user          User   @relation(fields: [userId], references: [id])
  asset         Asset  @relation(fields: [assetId], references: [id])
  @@unique([userId, assetId])
}

model Order {
  id             String      @id
  clientOrderId  String?
  userId         String
  market         String
  side           OrderSide
  type           OrderType
  price          BigInt?
  quantity       BigInt
  quoteQuantity  BigInt?
  filledQuantity BigInt      @default(0)
  status         OrderStatus @default(NEW)
  postOnly       Boolean     @default(false)
  ioc            Boolean     @default(false)
  rejectReason   String?
  engineSeq      BigInt
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt
  user           User        @relation(fields: [userId], references: [id])
  @@unique([userId, clientOrderId])
  @@index([userId, market, status])
  @@index([userId, createdAt])
}

model Trade {                          // converted to a hypertable by raw SQL
  id           String   @default(uuid())
  createdAt    DateTime @default(now())   // engine timestamp
  engineSeq    BigInt
  market       String
  price        BigInt
  quantity     BigInt
  makerOrderId String
  takerOrderId String
  makerUserId  String
  takerUserId  String
  takerSide    OrderSide
  makerFee     BigInt
  takerFee     BigInt
  @@id([id, createdAt])
  @@unique([engineSeq, createdAt])
  @@index([market, createdAt])
  @@index([makerUserId, createdAt])
  @@index([takerUserId, createdAt])
}

model LedgerEntry {
  id        String       @id @default(uuid())
  userId    String
  asset     String
  delta     BigInt
  reason    LedgerReason
  refId     String?
  engineSeq BigInt
  createdAt DateTime     @default(now())
  @@unique([engineSeq, userId, asset, reason])   // makes projection idempotent
}

model Deposit {
  id String @id @default(uuid())
  userId String
  asset String
  amount BigInt
  createdAt DateTime @default(now())
  user User @relation(fields: [userId], references: [id])
}

model Withdrawal {
  id String @id @default(uuid())
  userId String
  asset String
  amount BigInt
  status WithdrawStatus @default(PENDING)
  createdAt DateTime @default(now())
  decidedAt DateTime?
  user User @relation(fields: [userId], references: [id])
}

model RefreshToken {
  id String @id @default(uuid())
  userId String
  familyId String
  tokenHash String @unique
  expiresAt DateTime
  revokedAt DateTime?
  user User @relation(fields: [userId], references: [id])
}

model AuditLog {
  id String @id @default(uuid())
  actorId String?
  action String
  meta Json
  createdAt DateTime @default(now())
}
```

Raw SQL migration (second migration, executed after the Prisma init):

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
SELECT create_hypertable('"Trade"', 'createdAt', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW candle_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', "createdAt") AS bucket,
  market,
  first(price, "createdAt")  AS open,
  max(price)                 AS high,
  min(price)                 AS low,
  last(price, "createdAt")   AS close,
  sum(quantity::numeric)     AS volume
FROM "Trade"
GROUP BY bucket, market
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candle_1m',
  start_offset => INTERVAL '2 hours',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

-- Build candle_5m, candle_15m, candle_1h, candle_1d as hierarchical continuous
-- aggregates on top of candle_1m, each with its own refresh policy.
```

### 4.6 Engine in-memory structures

```tsx
type Side = 'BUY' | 'SELL';

interface EngineOrder {
  orderId: string; userId: string; market: string;
  side: Side; type: 'LIMIT' | 'MARKET';
  price: bigint;            // 0n for market
  quantity: bigint; filled: bigint;
  engineSeq: bigint;        // time priority
  postOnly: boolean; ioc: boolean;
  lockedAmount: bigint;     // remaining lock for this order (quote for BUY, base for SELL)
}

interface PriceLevel {
  price: bigint;
  totalQuantity: bigint;
  queue: DoublyLinkedList<EngineOrder>;      // FIFO, O(1) removal
}

interface Book {
  bids: SortedPriceLevels;                   // best = highest price
  asks: SortedPriceLevels;                   // best = lowest price
  index: Map<string, { side: Side; price: bigint; node: ListNode<EngineOrder> }>;
}

interface EngineState {
  books: Map<string, Book>;
  markets: Map<string, MarketConfig>;
  balances: Map<string, Map<string, { available: bigint; locked: bigint }>>;
  feeAccount: Map<string, bigint>;           // asset -> collected fees
  idempotency: Map<string, string>;          // commandId / userId:clientOrderId -> original reply id
  seq: bigint;                               // last processed engineSeq
}
```

`SortedPriceLevels` can be a sorted array with binary search (simple; fine for MVP) or a red-black tree. Interface: `best()`, `getLevel(price)`, `insert(order)`, `remove(orderId)`, `topN(n)`.

### 4.7 Redis naming

| Name                           | Type          | Purpose                          | Written by              | Read by                             |
| ------------------------------ | ------------- | -------------------------------- | ----------------------- | ----------------------------------- |
| `engine.commands`              | Stream        | Commands into the engine         | Gateway                 | Engine (group `engine`)             |
| `engine.replies`               | Stream        | Per-command result               | Engine                  | Gateway                             |
| `engine.events`                | Stream        | All state-change events          | Engine                  | DB Worker, Market Data, WS (groups) |
| `engine.events.dead`           | Stream        | Poison events                    | DB Worker               | Operators                           |
| `depth:{market}`               | String (JSON) | Latest depth snapshot with `seq` | Market Data             | Gateway, WS                         |
| `ticker:{market}`              | String (JSON) | Latest ticker                    | Market Data             | Gateway, WS                         |
| `marketcfg:{symbol}`           | String (JSON) | Market config cache              | Gateway/Admin           | Gateway                             |
| `rl:{scope}:{id}`              | String        | Rate-limit counters              | Gateway                 | Gateway                             |
| `md:depth:{market}`            | Pub/Sub       | Depth deltas                     | Market Data             | WS                                  |
| `md:trade:{market}`            | Pub/Sub       | Trades                           | Market Data             | WS                                  |
| `md:ticker:{market}`           | Pub/Sub       | Ticker updates                   | Market Data             | WS                                  |
| `md:kline:{interval}:{market}` | Pub/Sub       | Candle updates                   | Market Data             | WS                                  |
| `user:{userId}`                | Pub/Sub       | Private order/balance events     | Market Data / WS bridge | WS                                  |

---

## 5. Engine Rules

### 5.1 Command and event envelopes

```tsx
interface Command {
  commandId: string;           // idempotency key (UUID)
  type: 'PLACE_ORDER' | 'CANCEL_ORDER' | 'DEPOSIT' | 'WITHDRAW_REQUEST' |
        'WITHDRAW_COMPLETE' | 'WITHDRAW_REJECT' | 'MARKET_CONFIG' |
        'HALT_MARKET' | 'RESUME_MARKET';
  userId?: string;
  ts: number;                  // gateway timestamp, informational
  payload: Record<string, string | boolean>;
}

interface Event {
  engineSeq: string;           // strictly increasing, bigint as string
  commandId: string;
  type: 'ORDER_ACCEPTED' | 'ORDER_REJECTED' | 'ORDER_PLACED' | 'ORDER_UPDATED' |
        'ORDER_CANCELLED' | 'TRADE' | 'BALANCE_UPDATED' | 'DEPTH_DELTA' | 'MARKET_STATUS';
  ts: number;                  // engine timestamp (set by the runner, passed into process())
  data: Record<string, unknown>;
}
```

The runner (not `process()`) supplies `ts` and `engineSeq`, so `process()` stays pure.

### 5.2 Place-order algorithm

```
1. Idempotency: if commandId or (userId, clientOrderId) already seen, return the original reply.
2. Market checks: market ACTIVE; price is a tick multiple; quantity is a lot multiple;
   notional >= minNotional; flag combinations valid.
3. Lock funds:
     LIMIT  BUY  : lock ceil(price*qty/SCALE) of quote asset
     LIMIT  SELL : lock qty of base asset
     MARKET BUY  : lock quoteQuantity of quote asset
     MARKET SELL : lock qty of base asset
   If available < lock -> ORDER_REJECTED (INSUFFICIENT_FUNDS).
4. Post-only: if the order would cross the best opposite price ->
   unlock, ORDER_REJECTED (POST_ONLY_WOULD_CROSS).
5. Match loop (best opposite price first; FIFO inside a level):
     stop when: LIMIT price no longer crosses, remaining = 0, or (MARKET BUY) budget exhausted.
     if maker.userId == taker.userId -> STP: cancel the taker, unlock, stop.
     tradePrice = maker.price
     tradeQty   = min(takerRemaining, makerRemaining)
     (MARKET BUY) tradeQty is also limited so quoteAmount does not exceed remaining budget
     quoteAmt   = tradePrice * tradeQty / SCALE
     settle(...)                                  // Section 5.3
     emit TRADE; remove maker if filled
6. Remainder:
     LIMIT and not ioc -> rest on the book (ORDER_PLACED)
     LIMIT and ioc     -> cancel remainder, unlock
     MARKET            -> cancel remainder, unlock
7. Emit DEPTH_DELTA for each changed price level, then BALANCE_UPDATED for each touched balance.
```

### 5.3 Settlement per trade

```
Buyer  : locked(quote)   decreases by the portion of the lock used for this fill
         (if buyer is the taker and limit price > tradePrice, the difference
          (limitPrice - tradePrice) * qty / SCALE is released back to available)
         available(base) += qty - buyerFee            (fee in base)
Seller : locked(base)    -= qty
         available(quote)+= quoteAmt - sellerFee      (fee in quote)
Fees   : maker pays makerFeeBps, taker pays takerFeeBps, each in the asset that party receives.
         The fee account for that asset increases by the same amount.
```

**Worked example** (market `SOL_USDT`, tick 0.01, makerFee 8 bps, takerFee 10 bps):

| Step | Action                                               | Result                                                                          |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1    | Alice has 100 SOL, places LIMIT SELL 10 SOL @ 142.50 | Alice locks 10 SOL. Rests on the ask side                                       |
| 2    | Bob has 5,000 USDT, places LIMIT BUY 10 SOL @ 143.00 | Bob locks `10 x 143.00 = 1,430.00` USDT                                         |
| 3    | Engine matches at maker price 142.50                 | Trade qty 10 SOL, quoteAmount `1,425.00` USDT                                   |
| 4    | Bob is taker: fee `0.10%` of received SOL            | `10 x 0.001 = 0.01` SOL                                                         |
| 5    | Alice is maker: fee `0.08%` of received USDT         | `1,425 x 0.0008 = 1.14` USDT                                                    |
| 6    | Bob settlement                                       | locked USDT -1,430; pays 1,425; **refund 5.00** to available; receives 9.99 SOL |
| 7    | Alice settlement                                     | locked SOL -10; receives 1,423.86 USDT                                          |
| 8    | Fee account                                          | +0.01 SOL and +1.14 USDT                                                        |

Conservation check: USDT `-1,425 + 1,423.86 + 1.14 = 0`. SOL `-10 + 9.99 + 0.01 = 0`. In scaled units: price `14250000000`, quantity `1000000000`.

### 5.4 Cancel

Look up `orderId` in the book index (O(1)); verify `userId`; remove the node; release the remaining lock; emit `ORDER_CANCELLED` and `BALANCE_UPDATED` and `DEPTH_DELTA`. Unknown or finished order returns `ORDER_NOT_FOUND`; another user’s order returns `NOT_OWNER`. Cancels are allowed while a market is HALTED.

### 5.5 Withdraw flow

`WITHDRAW_REQUEST` moves the amount from `available` to `locked` (rejected if insufficient). Admin approval triggers `WITHDRAW_COMPLETE` (locked decreases; ledger entry `WITHDRAWAL`). Rejection triggers `WITHDRAW_REJECT` (locked back to available).

### 5.6 Rejection codes

| Code                    | Meaning                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `INSUFFICIENT_FUNDS`    | Available balance lower than required lock                 |
| `MARKET_NOT_ACTIVE`     | Market halted, delisted, or unknown                        |
| `INVALID_TICK`          | Price is not a multiple of tick size                       |
| `INVALID_LOT`           | Quantity is not a multiple of lot size                     |
| `BELOW_MIN_NOTIONAL`    | Notional smaller than market minimum                       |
| `INVALID_FLAGS`         | Illegal combination from Section 4.2                       |
| `POST_ONLY_WOULD_CROSS` | Post-only order would take liquidity                       |
| `SELF_TRADE`            | STP cancelled the taker                                    |
| `DUPLICATE_ORDER`       | Reserved: `clientOrderId` reused with different parameters |
| `ORDER_NOT_FOUND`       | Cancel target does not exist or is finished                |
| `NOT_OWNER`             | Cancel attempted by non-owner                              |

---

## 6. API and Protocol Specification

### 6.1 REST (base path `/api/v1`)

| Endpoint                         | Method      | Auth   | Purpose                                     |
| -------------------------------- | ----------- | ------ | ------------------------------------------- |
| `/healthz`                       | GET         | Public | Liveness                                    |
| `/auth/signup`                   | POST        | Public | Create account                              |
| `/auth/signin`                   | POST        | Public | Access token + refresh cookie               |
| `/auth/refresh`                  | POST        | Cookie | Rotate refresh token                        |
| `/auth/signout`                  | POST        | JWT    | Revoke refresh family                       |
| `/markets`                       | GET         | Public | Market configs                              |
| `/order`                         | POST        | JWT    | Place order                                 |
| `/order/:orderId`                | GET         | JWT    | Order status                                |
| `/order/:orderId`                | DELETE      | JWT    | Cancel order                                |
| `/orders/open`                   | GET         | JWT    | Open orders (`?market=`)                    |
| `/orders/history`                | GET         | JWT    | Paginated (`?market=&cursor=&limit=`)       |
| `/trades/mine`                   | GET         | JWT    | Own trades, paginated                       |
| `/depth`                         | GET         | Public | L2 snapshot (`?market=&limit=20`)           |
| `/trades`                        | GET         | Public | Recent public trades                        |
| `/klines`                        | GET         | Public | Candles (`?market=&interval=15m&limit=500`) |
| `/ticker`                        | GET         | Public | 24h stats (`?market=` optional)             |
| `/balances`                      | GET         | JWT    | Available/locked per asset                  |
| `/wallet/deposit`                | POST        | JWT    | Simulated deposit                           |
| `/wallet/withdraw`               | POST        | JWT    | Withdrawal request                          |
| `/wallet/history`                | GET         | JWT    | Deposits and withdrawals                    |
| `/admin/markets`                 | POST, PATCH | Admin  | Create/update market, set fees              |
| `/admin/markets/:symbol/halt`    | POST        | Admin  | Halt                                        |
| `/admin/markets/:symbol/resume`  | POST        | Admin  | Resume                                      |
| `/admin/withdrawals/:id/approve` | POST        | Admin  | Approve                                     |
| `/admin/withdrawals/:id/reject`  | POST        | Admin  | Reject                                      |
| `/admin/fees`                    | GET         | Admin  | Fee account totals                          |

**Conventions**

- All money fields are **strings**. Timestamps are ISO-8601 UTC.
- Error body: `{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "Not enough available USDT", "details": {} } }`.
- HTTP mapping: validation 400, auth 401, forbidden 403, not found 404, business rejection 422, rate limit 429, overload 503.
- Pagination: cursor-based (`nextCursor`), default limit 50, max 200.
- Rate limits: 20 order requests/sec/user, 100 requests/sec/IP, 5 auth attempts/min/IP.

**Place order request**

```json
{
  "market": "SOL_USDT",
  "side": "BUY",
  "type": "LIMIT",
  "price": "14250000000",
  "quantity": "1000000000",
  "postOnly": false,
  "ioc": false,
  "clientOrderId": "bot-0001"
}
```

**Response `201`** (engine answered within 2 s):

```json
{ "orderId": "018f6c2e-....", "status": "PARTIALLY_FILLED", "filledQuantity": "400000000", "avgPrice": "14250000000" }
```

**Response `202`** (engine slow): `{ "orderId": "018f6c2e-....", "status": "PENDING" }`. The client then follows the `user` WebSocket stream or polls `GET /order/:id`.

**Balances response**

```json
{ "balances": [ { "asset": "USDT", "available": "500000000000", "locked": "143000000000" } ] }
```

### 6.2 WebSocket

- Endpoint `wss://<host>/ws`. Public streams need no auth. The private stream requires `{"method":"AUTH","token":"<access jwt>"}` first.
- Client messages: `SUBSCRIBE`, `UNSUBSCRIBE`, `AUTH`, `PING`.
- Streams: `depth@SOL_USDT`, `trade@SOL_USDT`, `ticker@SOL_USDT`, `kline_15m@SOL_USDT`, `user`.
- Keepalive: server ping every 20 s; connection closed after 2 missed pongs.
- Limits: 50 subscriptions per connection, 20 client messages/sec.

**Depth synchronization protocol**

```mermaid
sequenceDiagram
    participant C as Client
    participant W as WS Server
    participant R as Redis
    C->>W: SUBSCRIBE depth@SOL_USDT
    W->>R: read depth:SOL_USDT (seq = N)
    W->>C: depthSnapshot seq N
    loop every 100 ms batch
        R->>W: delta seq N+1
        W->>C: depthUpdate seq N+1
    end
    Note over C: If a seq gap is detected, UNSUBSCRIBE then SUBSCRIBE to resync
```

A level with quantity `"0"` means “remove this price”.

**Message examples**

```json
{ "e": "depthUpdate", "seq": 1042, "s": "SOL_USDT",
  "b": [["14250000000","25000000000"]], "a": [["14260000000","0"]] }

{ "e": "trade", "s": "SOL_USDT", "p": "14250000000", "q": "400000000", "t": 1700000000123, "m": true }

{ "e": "orderUpdate", "orderId": "...", "status": "FILLED", "filledQuantity": "1000000000" }

{ "e": "balanceUpdate", "asset": "USDT", "available": "500000000000", "locked": "0" }
```

---

## 7. Security Baseline

- Passwords: argon2id; minimum 10 characters; breached-password check optional.
- Access JWT 15 min (memory only on the client); refresh token 7 days in an HTTP-only, Secure, SameSite=Strict cookie; stored hashed; rotation with reuse detection (reuse revokes the whole family).
- CSRF token on cookie-authenticated endpoints (`/auth/refresh`, `/auth/signout`).
- Strict CORS allowlist; Helmet headers; JSON body size limit 64 KB.
- Schema validation (zod) on every route; reject unknown fields.
- Rate limiting per user and per IP (Redis).
- Secrets only from environment variables; none committed. Redis requires a password; Postgres and Redis are not exposed to the host in production.
- Admin routes require role `ADMIN`; every admin action writes `AuditLog`.
- Never log passwords, tokens, or full request bodies of auth routes.
- Dependency audit (`npm audit`) in CI; Docker images run as non-root.

## 8. Frontend Specification

### 8.1 Screen map

```mermaid
flowchart LR
    L["/ Markets landing"] --> T["/trade/[symbol] Terminal"]
    S["/signup /signin"] --> T
    T --> W["/wallet"]
    T --> O["/orders"]
    W --> O
    A["/admin (role ADMIN)"]
```

### 8.2 Terminal layout

```
+--------------------------------------------------------------------------+
| Logo  Markets  Trade  Wallet  Orders                     user@email.com |
+----------------------------------+-----------------------+---------------+
| SOL/USDT 142.50 +4.2% Vol 1.2M   | Orderbook             | Order Panel   |
+----------------------------------+ Price   Qty   Total   | [Buy] [Sell]  |
|                                  | asks (red)            | Limit/Market  |
|   Candlestick chart + volume     | ---- spread --------- | Price         |
|   (lightweight-charts)           | bids (green)          | Quantity      |
|                                  +-----------------------+ 25/50/75/100% |
|                                  | Market Trades         | [Post][IOC]   |
|                                  |                       | [BUY SOL]     |
+----------------------------------+-----------------------+---------------+
| Open Orders | Order History | Trade History | Balances                  |
+--------------------------------------------------------------------------+
```
<!-- //bid price:the heigest that is someone betting to buy that share -->
<!-- //ask price :the lowest that some one is keeping to sell that share  -->
<!-- and the difference is called spread -->
<!-- we are using redis :becuase it helps in redis  -->

### 8.3 Components

| Component         | Data source               | Behavior                                                                 |
| ----------------- | ------------------------- | ------------------------------------------------------------------------ |
| `TickerHeader`    | `ticker@` stream          | Last price, 24h change, high/low, volume                                 |
| `PriceChart`      | `/klines` then `kline_*@` | Interval selector 1m/5m/15m/1h/1d; live candle updates                   |
| `OrderBook`       | `depth@`                  | 20 levels per side, cumulative bars, spread, click-to-fill price         |
| `MarketTrades`    | `trade@`                  | Last 50 trades, color by taker side                                      |
| `OrderPanel`      | `/markets`, `/balances`   | Tabs, limit/market, flags, % slider, validation by tick/lot/min notional |
| `UserTabs`        | `user` stream + REST      | Open orders with cancel, history, trades, balances                       |
| `ConnectionBadge` | WS client                 | Connected / reconnecting / stale                                         |

### 8.4 UI rules

- Only one `format` module converts scaled strings to display text; no `Number()` or `parseFloat()` on money.
- The percent slider computes quantity using BigInt math from available balance and price.
- Every rejection code from Section 5.6 maps to a human-readable message.
- WebSocket client reconnects with exponential backoff, resubscribes, and resyncs depth on a sequence gap.
- Loading, empty, and error states are required for every table and panel.
- State: Zustand stores for `auth`, `market`, `orderbook`, `orders`, `balances`.

## 9. Engineering Conventions

### 9.1 Naming and structure

- Packages scoped `@cex/*` (`@cex/types`, `@cex/money`, `@cex/db`, `@cex/config`, `@cex/logger`).
- Files `kebab-case.ts`; classes `PascalCase`; constants `UPPER_SNAKE_CASE`.
- Enums are uppercase strings and live only in `@cex/types`.
- One folder per feature in each app: `routes/`, `services/`, `schemas/`, `tests/`.

### 9.2 Error handling

- Domain errors extend `AppError(code, httpStatus, message)`. A central handler converts them to the error body in Section 6.1.
- The engine never throws for business rejections; it returns `ORDER_REJECTED` events. It throws only on invariant violations (which stop the process).

### 9.3 Git workflow

- Trunk-based with short branches `phase-NN-topic`. One commit per finished phase at minimum: `phase-NN: <summary>`.
- Conventional commits for smaller commits (`feat:`, `fix:`, `test:`, `chore:`).
- CI must pass before merge.

### 9.4 Testing conventions

- Test files sit next to code as `.test.ts`.
- Engine tests are table-driven (input commands and expected events).
- Any bug fixed gets a regression test first.
- Randomized tests print their seed so failures are reproducible.

### 9.5 Logging

- JSON logs via pino with fields `service`, `level`, `msg`, `requestId`, `userId` (when known), `engineSeq` (when relevant).
- Do not log secrets or full balances of users at `info` level.

---

# PART C: BUILD PLAN (PHASE 0 TO PHASE 20)

## Roadmap

```mermaid
flowchart LR
    subgraph F[Foundation]
        P0[0 Setup] --> P1[1 Monorepo] --> P2[2 Database] --> P3[3 Money math]
    end
    subgraph C[Core]
        P4[4 Auth] --> P5[5 Order book] --> P6[6 Matching] --> P7[7 Balances and fees] --> P8[8 Messaging] --> P9[9 Trading API] --> P10[10 Recovery]
    end
    subgraph S[Services]
        P11[11 DB worker] --> P12[12 Market data] --> P13[13 WebSocket] --> P14[14 Wallet and admin]
    end
    subgraph U[Frontend]
        P15[15 UI base] --> P16[16 Terminal] --> P17[17 Other pages]
    end
    subgraph R[Release]
        P18[18 Testing] --> P19[19 Hardening and deploy] --> P20[20 Final commit]
    end
    F --> C --> S --> U --> R
```

Each phase lists: **Goal, Prerequisites, Steps, Files, Tests, Acceptance criteria.**

---

### PHASE 0: Tech Setup

**Goal:** A clean machine can run Postgres/TimescaleDB and Redis, and Node tooling works.
**Prerequisites:** a computer with 8 GB RAM or more, admin rights.

**Steps**

1. Install Node.js 20 LTS, npm 10+, Docker Desktop (or Docker Engine + Compose v2), Git, VS Code (extensions: ESLint, Prettier, Prisma, Mermaid preview).
2. Create a private Git repository `cex-monorepo`, clone it locally.
3. Add `.gitignore` containing at least: `node_modules`, `dist`, `.next`, `.env`, `.env.*` (except `.env.example`), `coverage`, `.log`, `data/`.
4. Create `docker-compose.dev.yml` (infrastructure only; apps run on the host during development):

```yaml
services:
postgres:
image: timescale/timescaledb:latest-pg16
environment:{POSTGRES_USER: cex_user,POSTGRES_PASSWORD: cex_dev_pw,POSTGRES_DB: cex_db}
ports:["127.0.0.1:5432:5432"]
volumes:[pgdata:/var/lib/postgresql/data]
healthcheck:{test:["CMD-SHELL","pg_isready -U cex_user -d cex_db"],interval: 5s,retries:10}
redis:
image: redis:7-alpine
command:["redis-server","--appendonly","yes","--requirepass","cex_dev_redis"]
ports:["127.0.0.1:6379:6379"]
volumes:[redisdata:/data]
healthcheck:{test:["CMD","redis-cli","-a","cex_dev_redis","ping"],interval: 5s,retries:10}
volumes:{pgdata:{},redisdata:{}}
```

1. Create `.env.example` containing every variable from Appendix C with placeholder values; copy it to `.env` locally.
2. Write a stub `README.md` with the project name and “see docs”.
3. Commit: `phase-00: dev infrastructure`.

**Files:** `.gitignore`, `docker-compose.dev.yml`, `.env.example`, `README.md`.
**Tests (manual):** run each verification command below.
**Acceptance criteria**

- [ ]  `docker compose -f docker-compose.dev.yml up -d` shows both services `healthy`.
- [ ]  `psql postgresql://cex_user:cex_dev_pw@localhost:5432/cex_db -c "select 1"` succeeds.
- [ ]  `redis-cli -a cex_dev_redis ping` returns `PONG`.
- [ ]  `node -v` prints v20.x; `docker --version` works.
- [ ]  `git ls-files` does not contain `.env`.

---

### PHASE 1: Monorepo Scaffolding and Shared Packages

**Goal:** All workspaces build and import each other under strict TypeScript.
**Prerequisites:** Phase 0.

**Steps**

1. Create the folder layout:

```
cex-monorepo/
├── apps/
│   ├── api-gateway/   engine/   db-worker/   market-data/   ws-server/   web/
├── packages/
│   ├── types/   money/   db/   config/   logger/
├── docker-compose.dev.yml   docker-compose.yml
├── tsconfig.base.json   package.json   .eslintrc.cjs   .prettierrc   vitest.workspace.ts
```

1. Root `package.json`: `"private": true`, `"workspaces": ["apps/*","packages/*"]`, scripts `build`, `dev`, `lint`, `test`, `typecheck`.
2. `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `target ES2022`, `module NodeNext`, `moduleResolution NodeNext`, `declaration`.
3. Each package/app gets its own `package.json` (name `@cex/<name>`), `tsconfig.json` extending the base, and `src/index.ts`.
4. `packages/types` exports: enums (`Side`, `OrderType`, `OrderStatus`, `RejectCode`, `MarketStatus`), `Command`, `Event`, `MarketConfig`, REST DTOs. Uppercase string values only.
5. `packages/config`: zod schema of environment variables with a `loadConfig()` that fails fast with a readable error.
6. `packages/logger`: pino instance factory `createLogger(serviceName)`.
7. Install dev dependencies at the root: `typescript`, `tsx`, `vitest`, `fast-check`, `eslint`, `@typescript-eslint/*`, `prettier`.
8. Create the `web` app later (Phase 15); leave `apps/web` as an empty placeholder folder with a `package.json`.
9. Add a lint rule banning `parseFloat`, `Number(` on identifiers named `price|quantity|amount|balance` (custom `no-restricted-syntax`).

**Tests:** one trivial Vitest test per package proving imports work.
**Acceptance criteria**

- [ ]  `npm install` from repo root succeeds.
- [ ]  `npm run build --workspaces --if-present` and `npm run typecheck` pass.
- [ ]  `apps/engine` can `import { Side } from '@cex/types'`.
- [ ]  `npm run lint` and `npm test` run (even if few tests).

---

### PHASE 2: Database Schema and Migrations

**Goal:** The schema in Section 4.5 exists in Postgres, with Timescale hypertable and candle aggregates.
**Prerequisites:** Phases 0 and 1.

**Steps**

1. Add `packages/db/prisma/schema.prisma` exactly as Section 4.5.
2. Install Prisma in `packages/db`; set `DATABASE_URL`.
3. Run `npx prisma migrate dev --name init --schema=packages/db/prisma/schema.prisma` (development only).
4. Create a second migration folder with the raw SQL from Section 4.5 (extension, hypertable, `candle_1m`, refresh policy, 5m/15m/1h/1d hierarchical aggregates). Apply it with `prisma migrate dev --create-only` then edit the generated SQL file.
5. Write `packages/db/src/index.ts` exporting a singleton `prisma` client and types.
6. Write `packages/db/prisma/seed.ts` (idempotent upserts):
    - Assets: `USDT (decimals 6)`, `SOL (9)`, `BTC (8)`.
    - Markets: `SOL_USDT` (tick `1000000` = 0.01, lot `1000000` = 0.01, minNotional `100000000` = 1 USDT), `BTC_USDT` (tick `1000000`, lot `100000`, minNotional `100000000`).
    - Admin user `admin@cex.local` with a password from `SEED_ADMIN_PASSWORD`.
7. Add scripts `db:migrate`, `db:seed`, `db:studio`, `db:reset`.

**Tests:** integration test that inserts two trades with the same `(engineSeq, createdAt)` and expects a unique violation; test that seed runs twice with no duplicates.
**Acceptance criteria**

- [ ]  All tables exist; `select * from timescaledb_information.hypertables;` lists `Trade`.
- [ ]  Inserting trades and refreshing `candle_1m` returns correct OHLCV for a hand-made data set.
- [ ]  `npm run db:seed` twice leaves the same row counts.
- [ ]  `prisma migrate status` reports up to date.

---

### PHASE 3: Money Math and Wire Format (`packages/money`)

**Goal:** One heavily tested library for every conversion and money formula.
**Prerequisites:** Phase 1.

**Steps**

1. Implement and export: `SCALE`, `toScaled(str)`, `fromScaled(big, opts?)`, `mulDiv(a,b,c)` (floor), `mulDivCeil(a,b,c)`, `quoteAmount(price, qty)`, `calcFee(amount, bps)`, `lockForBuyLimit(price, qty)`, `isMultipleOf(v, step)`, `minBig`, `maxBig`.
2. Implement `serialize(value)` and `deserialize(value)` that convert BigInt to/from decimal strings recursively for objects and arrays. Mark BigInt-bearing keys through a schema list (e.g., `price`, `quantity`, `available`, …) so deserialization is explicit, not guessed.
3. `toScaled` rules: input must match `^\d+(\.\d{1,8})?$`; throw `MoneyError` otherwise.
4. Add zod helpers `zScaledString()` used by API schemas.
5. Document edge rules (rounding down at 8 decimals for deposits, rounding up for fees and buy locks).

**Tests (must exist):**

- `toScaled("0.1") + toScaled("0.2") === toScaled("0.3")`.
- 10,000 random decimal strings: `fromScaled(toScaled(x)) === normalized(x)`.
- `calcFee(1n, 10)` equals `1n` (rounds up); `calcFee(0n, 10)` equals `0n`.
- `lockForBuyLimit` never undercounts: `lock >= price*qty/SCALE` for random inputs.
- Rejects `"1e5"`, `"-1"`, `"1.123456789"`, `""`, `" 1"`, `"01x"`.
- JSON round trip of a full order object preserves every digit.

**Acceptance criteria**

- [ ]  All tests pass; line coverage on the package is at least 95%.
- [ ]  No usage of `Number` or `parseFloat` in the package (lint passes).

---

### PHASE 4: Authentication and User Management

**Goal:** Users sign up, sign in, refresh, and sign out; protected routes work.
**Prerequisites:** Phases 2 and 3.

**Steps**

1. Create the Fastify app in `apps/api-gateway/src/index.ts` with plugins: CORS, Helmet, cookies, rate-limit (Redis), request id, and the central error handler (`AppError`).
2. Add `GET /api/v1/healthz` (checks Postgres and Redis connectivity).
3. `POST /auth/signup`: validate email format and password (min 10 chars, not equal to email); hash with argon2id; create user; return `201` with no token (or optionally sign in).
4. `POST /auth/signin`: verify; return access JWT (15 min, claims `sub`, `role`); create a refresh token (random 32 bytes), store its SHA-256 hash with `familyId`, `expiresAt`; set the HTTP-only cookie.
5. `POST /auth/refresh`: read cookie; look up hash; if revoked or unknown, revoke the whole family and return 401; otherwise rotate (revoke old, issue new).
6. `POST /auth/signout`: revoke the family; clear cookie.
7. Middleware `requireAuth` (verifies JWT) and `requireRole('ADMIN')`.
8. Auth rate limits: 5 attempts/min/IP and 10/hour/email; generic error text (“Invalid credentials”).
9. Write an `AuditLog` entry for signup, signin failure bursts, and token-reuse detection.

**Files:** `routes/auth.ts`, `services/auth-service.ts`, `middleware/auth.ts`, `schemas/auth.ts`, `plugins/*`.
**Tests:** signup duplicates email → 409; wrong password → 401 generic; expired access token → 401; reused refresh token revokes the family; role guard returns 403 for USER on admin route; rate limiter blocks the 6th attempt.
**Acceptance criteria**

- [ ]  All tests pass.
- [ ]  Passwords are never in logs or responses.
- [ ]  Cookie flags verified (`HttpOnly`, `Secure` in prod, `SameSite=Strict`).

---

### PHASE 5: Order Book Data Structure

**Goal:** A pure, I/O-free order book with correct ordering and O(1) cancel.
**Prerequisites:** Phase 3.
**Location:** `apps/engine/src/book/`

**Steps**

1. `DoublyLinkedList<T>`: `pushBack`, `remove(node)`, `first`, `iterate`, size.
2. `SortedPriceLevels(side)`: bids sorted descending, asks ascending; methods `best()`, `getLevel(price)`, `getOrCreateLevel(price)`, `deleteLevel(price)`, `topN(n)`. Use a sorted array with binary search for MVP.
3. `Book`: `add(order)`, `remove(orderId)`, `bestBid()`, `bestAsk()`, `depth(n)`, `get(orderId)`, `reduce(orderId, qty)` (for partial fills). Maintain `totalQuantity` on every mutation.
4. `Book.snapshot()` and `Book.restore(snapshot)` for Phase 10 (stable, sorted, deterministic output).

**Tests**

- Unit: insertion order, FIFO within a level, removal in the middle, best price after deletes.
- Property (fast-check): random add/remove sequences keep both sides sorted, totals equal the sum of remaining quantities (Invariant 11), and `index.size` equals the number of resting orders.
- Benchmark: 100,000 adds and 100,000 cancels complete in under 1 second.

**Acceptance criteria**

- [ ]  All tests pass including 1,000 property-test runs.
- [ ]  `snapshot → restore → snapshot` is byte-identical.

---

### PHASE 6: Matching Engine Core

**Goal:** Implement the Section 5.2 algorithm for LIMIT, MARKET, Post-Only, IOC, and STP, with a stubbed balance manager that approves every lock.
**Prerequisites:** Phase 5.
**Location:** `apps/engine/src/engine/`

**Steps**

1. `Engine.process(state, command, ctx): { events: Event[] }` where `ctx = { engineSeq, now }` is supplied by the caller (purity).
2. Validation module: market active, tick, lot, min notional, flag combinations; returns a `RejectCode` or `null`.
3. Matching loop for BUY and SELL sides sharing one implementation parameterized by side (avoid duplicate code).
4. Handle: partial fills, multi-level sweeps, maker removal, level cleanup, market BUY budget logic, IOC/market remainder cancel, post-only check, STP.
5. Emit `ORDER_ACCEPTED`, `TRADE`, `ORDER_PLACED`, `ORDER_UPDATED`, `ORDER_CANCELLED`, `ORDER_REJECTED`, `DEPTH_DELTA`.
6. `CANCEL_ORDER`, `HALT_MARKET`, `RESUME_MARKET`, `MARKET_CONFIG` handling.
7. Assert invariants in a debug mode (`ENGINE_ASSERT=true`): no crossed book, quantity bookkeeping.

**Tests (table-driven):** full fill; partial fill; sweep 3 levels; time priority at equal price; market buy exhausts budget mid-level; market sell on thin book; IOC remainder cancelled; post-only rejected when crossing and accepted when not; STP cancels taker; halted market rejects PLACE but accepts CANCEL; cancel unknown order; duplicate `commandId` returns the same events.
**Fuzz:** 100,000 random commands (seeded); after each, `best_bid < best_ask`, totals consistent.
**Acceptance criteria**

- [ ]  All table tests and the fuzz run pass.
- [ ]  `process()` contains no `Date.now`, `Math.random`, I/O (verified by a lint rule or code review checklist).
- [ ]  Benchmark: at least 100,000 orders/sec in-process on a laptop.

---

### PHASE 7: Balances, Locking, Fees, Settlement

**Goal:** Real money handling inside the engine (Sections 4.1, 5.2, 5.3).
**Prerequisites:** Phases 3 and 6.

**Steps**

1. `BalanceManager` with `get`, `credit`, `debit`, `lock`, `unlock`, `consumeLock`, each asserting non-negative results (Invariant 3).
2. Per-order `lockedAmount` tracking so cancels and partial fills release exact amounts.
3. `settleTrade(buyer, seller, trade)` implementing Section 5.3 including **price-improvement refund** and fees to `feeAccount`.
4. Integrate into `process()`: lock before matching, settle on each trade, unlock on cancel/reject/remainder.
5. `DEPOSIT` command: credit `available`, emit `BALANCE_UPDATED`, ledger info in event data. `WITHDRAW_REQUEST/COMPLETE/REJECT` per Section 5.5.
6. Emit one `BALANCE_UPDATED` per touched (user, asset) with absolute `available` and `locked` values and the delta reason.
7. Add `engine.checkInvariants(state)` computing conservation (Invariant 2) and lock consistency (Invariant 12). Used by tests, recovery, and a periodic runtime check.

**Tests:** replicate the worked example in Section 5.3 exactly; buy at 150 matched at 140 refunds 10 per unit; fee rounding up on a tiny trade; cancel releases remaining lock after partial fill; insufficient funds reject; withdrawal reject unlocks; random scenarios with `checkInvariants` after each command.
**Acceptance criteria**

- [ ]  Worked example numbers match to the unit.
- [ ]  100,000-command random run: conservation and lock invariants hold at every step.
- [ ]  No code path can produce a negative balance (assert + test).

---

### PHASE 8: Messaging Layer (Redis Streams)

**Goal:** Reliable command in, events out, replies, idempotency.
**Prerequisites:** Phase 7.

**Steps**

1. Create the streams and consumer group on startup: `XGROUP CREATE engine.commands engine $ MKSTREAM`.
2. `EngineRunner` loop:
    - `XREADGROUP GROUP engine engine-1 COUNT 100 BLOCK 1000 STREAMS engine.commands >`
    - for each entry: assign `engineSeq`, call `process()`, then publish reply and events with a single pipeline, then `XACK`.
3. Gateway-side `EngineClient.send(command)`: `XADD`, then wait for a reply with matching `commandId` (use a reply consumer that resolves in-memory promises; timeout 2 s → `202 PENDING`).
4. Idempotency window in engine state (24 h or 1M entries, whichever first) for `commandId` and `(userId, clientOrderId)`.
5. Backpressure: gateway checks `XLEN engine.commands`; if above `MAX_QUEUE_LEN` returns 503.
6. Stream trimming: `XTRIM engine.commands MINID` after events are journaled and acknowledged; keep `engine.events` for 7 days (`MAXLEN ~`).
7. Pending-entries recovery: on start, process `XPENDING` entries for this consumer before reading new ones (they were read but not acknowledged).

**Tests (integration with a real Redis):** 10,000 commands processed in order; duplicate `commandId` returns the original reply; kill the engine after read but before ack, restart, command processed exactly once (journal + idempotency); gateway timeout path returns 202.
**Acceptance criteria**

- [ ]  All integration tests pass.
- [ ]  Throughput at least 3,000 commands/sec end to end on a laptop.
- [ ]  No unacknowledged entries remain after a clean shutdown.

---

### PHASE 9: API Gateway Trading Routes

**Goal:** Full order and balance endpoints.
**Prerequisites:** Phases 4 and 8.

**Steps**

1. `MarketConfigCache`: load markets from Postgres into Redis (`marketcfg:*`) and memory; refresh on admin changes.
2. `POST /order`: zod schema; build `PLACE_ORDER` command; UUIDv7 `orderId`; advisory balance check from the latest balance projection (cache only); send; map the reply to HTTP codes (`201`, `202`, `422`).
3. `DELETE /order/:orderId`, `GET /order/:orderId`, `GET /orders/open`, `GET /orders/history`, `GET /trades/mine`, `GET /balances` (Postgres projection; document possible millisecond lag).
4. Standardize pagination and error codes (Section 6.1).
5. OpenAPI generation from zod schemas; serve docs at `/docs` in non-production.
6. Request logging with `requestId`; slow-request warning above 200 ms.

**Tests:** invalid payloads → 400 with field errors; tick violation → 422 `INVALID_TICK`; insufficient funds → 422; duplicate `clientOrderId` returns the same `orderId`; cancel by another user → 403/404; unauthenticated → 401; 21st request in one second → 429.
**Acceptance criteria**

- [ ]  End-to-end test: sign in → deposit (command injected) → place order → see it in `/orders/open` → cancel → balance unlocked.
- [ ]  OpenAPI document matches Section 6.1.

---

### PHASE 10: Engine Persistence and Recovery

**Goal:** The engine survives crashes with identical state.
**Prerequisites:** Phase 8.

**Steps**

1. **Journal:** before `process()`, append `{seq, commandId, ts, payload, crc32}` as one line/binary record to `journal-<startSeq>.log`. Configurable fsync: `ENGINE_FSYNC_MS` (default 50 ms group commit) or `always`.
2. **Snapshot:** every `SNAPSHOT_EVERY_N` commands (default 100,000) or 5 minutes, serialize full `EngineState` (books, balances, fee account, idempotency window, seq, market configs) to `snapshot-<seq>.tmp`, fsync, atomically rename to `snapshot-<seq>.json`. Keep the last 3.
3. **Recovery** per Section 3.6: load newest valid snapshot; replay journal records with `seq` greater than the snapshot; stop at the first record failing CRC (truncate the torn tail); run `checkInvariants`; abort startup on failure.
4. **Stream alignment:** store `lastStreamId` in each snapshot and journal record so the engine resumes `XREADGROUP` correctly and does not double-apply commands (idempotency window covers the gap).
5. **Initial seed:** if no snapshot and no journal, seed balances from Postgres once (`SEED_FROM_DB=true`) and write snapshot 0.
6. **Journal rotation:** new segment per snapshot; delete segments older than the third newest snapshot.
7. CLI tools: `engine:verify` (replay and print state hash), `engine:snapshot-now`.

**Tests:** run a seeded random workload; `kill -9` at 50 random moments; after each restart compute the state hash and compare with a reference engine that processed the same prefix; corrupt the last journal record and confirm safe truncation; recovery time for 1,000,000 commands under 60 s.
**Acceptance criteria**

- [ ]  Determinism (Invariant 7) proven by the hash comparison in all 50 crash runs.
- [ ]  No acknowledged order lost (Invariant 10) in the crash test.
- [ ]  Recovery time target met.

---

### PHASE 11: DB Worker (Idempotent Projection)

**Goal:** Postgres mirrors engine events exactly once.
**Prerequisites:** Phases 2 and 8.

**Steps**

1. Consumer group `dbw` on `engine.events`; read batches (up to 500 events or 50 ms).
2. Per batch, inside one transaction:
    - `ORDER_*` events → upsert `Order` by id; apply status/filled only if `engineSeq` is newer than stored.
    - `TRADE` → insert `Trade` (`ON CONFLICT (engineSeq, createdAt) DO NOTHING`).
    - `BALANCE_UPDATED` → set `Balance.available/locked` to the absolute values where `lastEngineSeq < event.engineSeq`; insert `LedgerEntry` (`ON CONFLICT DO NOTHING`).
    - Deposits and withdrawals link to their rows via `refId`.
3. `XACK` only after a successful commit.
4. Poison handling: after 3 failed attempts move the event to `engine.events.dead` and raise an alert metric.
5. Metrics: `dbw_lag_seconds`, `dbw_batch_size`, `dbw_events_total`.
6. Admin script `dbw:rebuild` to truncate projection tables and replay the retained event stream (or from journal) for disaster recovery.

**Tests:** replay the same event stream twice → identical rows; kill the worker mid-batch → no gap, no duplicate; out-of-order delivery of older events does not overwrite newer balances; poison event lands in the dead stream.
**Acceptance criteria**

- [ ]  After a 100,000-order simulation, DB balances equal engine balances for every user and asset.
- [ ]  Idempotency (Invariant 8) proven by double replay test.

---

### PHASE 12: Market Data Service

**Goal:** Trades, ticker, candles, and depth snapshots for public APIs and streams.
**Prerequisites:** Phase 11.

**Steps**

1. Consumer group `md` on `engine.events`.
2. Maintain per market: last price, rolling 24 h open/high/low/volume (bucketed by minute for efficient expiry), best bid/ask, trade count.
3. Maintain a full in-memory mirror of each book from `DEPTH_DELTA` events; write top-50 snapshot with `seq` to `depth:{market}` after each batch.
4. Throttle: batch depth deltas into 100 ms windows and publish on `md:depth:{market}` with increasing `seq`.
5. Publish trades on `md:trade:{market}`, ticker every 1 s or on trade on `md:ticker:{market}`.
6. Maintain the in-progress candle for each interval in memory and publish on `md:kline:{interval}:{market}`; closed candles are read from Timescale aggregates.
7. Public REST handlers in the gateway read: `/depth` from Redis, `/trades` from Postgres (last N), `/klines` from the candle views, `/ticker` from Redis.
8. Private user events: transform `ORDER_*` and `BALANCE_UPDATED` into messages published on `user:{userId}`.

**Tests:** known trade sequence yields hand-computed OHLC; 24 h rolling window correct across the boundary; depth snapshot + replayed deltas equals the engine book exactly; throttling never reorders `seq`.
**Acceptance criteria**

- [ ]  `/klines` and `/ticker` values match hand calculation in tests.
- [ ]  Snapshot + delta reconstruction equality test passes on 10,000 random events.

---

### PHASE 13: WebSocket Server

**Goal:** Live public and private streams with safe resync.
**Prerequisites:** Phase 12.

**Steps**

1. `ws` server on port 8080 with `perMessageDeflate` disabled by default; connection manager; per-connection state (subscriptions, authenticated user, rate counters).
2. Message handlers: `SUBSCRIBE`, `UNSUBSCRIBE`, `AUTH`, `PING`; strict validation; unknown messages get an error frame.
3. Redis subscriber (single shared connection) with pattern subscriptions; fan-out via channel → set of sockets maps.
4. Depth subscribe flow per Section 6.2: send snapshot from `depth:{market}`, then deltas; if the first delta `seq` does not follow the snapshot, resend a snapshot.
5. Private stream: after `AUTH`, subscribe the socket to `user:{userId}` only for that id (never trusting a client-provided id).
6. Backpressure: if `ws.bufferedAmount` exceeds a threshold or the queue grows, drop the connection with code 1013.
7. Heartbeat, graceful shutdown, metrics (`ws_connections`, `ws_messages_out_total`).

**Tests:** subscribe/unsubscribe lifecycle; sequence-gap triggers resync; user A cannot receive user B’s `user` events (negative test); slow consumer is disconnected; 5,000 concurrent clients receive depth with p99 under 250 ms (k6 or custom script).
**Acceptance criteria**

- [ ]  All tests pass including the isolation test.
- [ ]  Load figure recorded in the repo `docs/perf.md`.

---

### PHASE 14: Wallet, Admin, Operational Controls

**Goal:** Simulated money in/out and exchange operations.
**Prerequisites:** Phases 9 and 11.

**Steps**

1. `POST /wallet/deposit`: validate asset; amount at most `DEV_DEPOSIT_MAX` per request and per day; create `Deposit` row; send `DEPOSIT` command; return new balance when the engine replies.
2. `POST /wallet/withdraw`: create `Withdrawal(PENDING)`; send `WITHDRAW_REQUEST`; on reject return 422.
3. Admin endpoints (Section 6.1): market create/update (also sends `MARKET_CONFIG`), halt/resume (`HALT_MARKET`/`RESUME_MARKET`), approve/reject withdrawals (`WITHDRAW_COMPLETE`/`WITHDRAW_REJECT`), fee report from the fee account balances.
4. Every admin action writes `AuditLog` with actor, action, and before/after values.
5. Basic admin pages are built in Phase 17.

**Tests:** halted market rejects new orders but still accepts cancels; withdrawal rejection restores available; non-admin gets 403 on all admin routes; each admin action produces one audit row; daily deposit cap enforced.
**Acceptance criteria**

- [ ]  Conservation holds after a mixed deposit/withdraw/trade simulation (Invariant 2).
- [ ]  Audit rows exist for every admin test action.

---

### PHASE 15: Frontend Foundation

**Goal:** Next.js app with design tokens, auth, typed API/WS clients.
**Prerequisites:** Phases 4, 9, 13.

**Steps**

1. `npx create-next-app@latest apps/web --typescript --tailwind --app --eslint` (run inside `apps/`), then align package name `@cex/web`.
2. Install: `lightweight-charts`, `lucide-react`, `zustand`, `clsx`, `tailwind-merge`, `zod`.
3. Design tokens in Tailwind config: dark theme (background, surface, border, text, up-green, down-red, accent), typography scale, spacing.
4. `lib/api.ts`: typed fetch wrapper using DTOs from `@cex/types`; access token in memory; on 401 call `/auth/refresh` once, retry, else redirect to sign-in.
5. `lib/ws.ts`: WebSocket client with reconnect (exponential backoff with jitter), resubscribe, pending message queue, depth gap detection and resync, `onStatusChange`.
6. `lib/format.ts`: `formatPrice`, `formatQty`, `formatPct`, `parseInputToScaled` using `@cex/money` only.
7. Zustand stores: `useAuth`, `useMarket`, `useBook`, `useOrders`, `useBalances`.
8. Pages: `/signup`, `/signin` with validation and error states; `AuthGuard` layout.
9. Base UI kit: `Button`, `Input`, `Tabs`, `Table`, `Modal`, `Toast`, `Skeleton`.

**Tests:** unit tests for `format` and `parseInputToScaled`; Playwright smoke: sign up → sign in → reload keeps the session.
**Acceptance criteria**

- [ ]  Session persists across reload; WS reconnects after the ws-server restarts.
- [ ]  ESLint rule confirms no `Number()`/`parseFloat()` on money in `apps/web`.

---

### PHASE 16: Trading Terminal UI

**Goal:** The `/trade/[symbol]` screen from Section 8.2.
**Prerequisites:** Phase 15.

**Steps**

1. Page `app/trade/[symbol]/page.tsx` with a responsive grid (desktop 3 columns; tablet stacked).
2. `PriceChart`: initial history from `/klines`; interval selector; live updates from `kline_*@`; volume histogram.
3. `OrderBook`: render top 20 asks/bids from the depth store; cumulative bars; spread row; click a price to fill the order panel; highlight changed rows briefly.
4. `OrderPanel`: Buy/Sell tabs; Limit/Market toggle; price and quantity (and quote amount for market buy); flags (Post-Only, IOC) with mutual-exclusion; % slider (25/50/75/100) computed with BigInt; live client-side validation (tick/lot/min notional/balance); submit with loading state; map rejection codes to messages; use `clientOrderId` per submit to avoid duplicates on retry.
5. `UserTabs`: open orders with cancel buttons and fill progress; history; my trades; balances (available/locked). Updated from the `user` stream with REST fallback on reconnect.
6. `MarketTrades` list and `TickerHeader`.
7. Connection badge; stale-data overlay if no update for 10 s.

**Tests:** component tests for the slider math and validation; Playwright: two browser contexts (two users) trade against each other and both UIs update.
**Acceptance criteria**

- [ ]  A crossing limit order updates book, chart, trades, and balances within 300 ms locally.
- [ ]  Rejected orders show readable messages; no `NaN` or negative values appear anywhere.

---

### PHASE 17: Remaining Pages and Admin UI

**Goal:** Landing, wallet, orders, and a minimal admin console.
**Prerequisites:** Phases 14 and 16.

**Steps**

1. `/` markets table: pairs, last price, 24h change, volume, mini sparkline; sort and search; live ticker updates.
2. `/wallet`: balances table; simulated deposit and withdraw modals with validation; deposit/withdraw history.
3. `/orders`: paginated order history and trade/fee history with filters (market, side, status, date); CSV export of the visible filter.
4. `/admin` (role guard): markets list with halt/resume and fee edit; pending withdrawals queue; fee revenue summary; recent audit log.
5. Empty/loading/error states and mobile layout polishing.

**Tests:** Playwright: deposit → trade → check wallet and orders pages; admin halts a market → trader sees “Market halted” and cannot submit.
**Acceptance criteria**

- [ ]  Lighthouse performance at least 85 on `/`.
- [ ]  All tables paginate on the server; mobile width is usable.

---

### PHASE 18: Testing and Verification

**Goal:** Prove correctness, speed, and resilience.
**Prerequisites:** Phases 1 to 17.

**Steps**

1. **Coverage gates:** at least 90% on `engine` and `money`; at least 80% on gateway services.
2. **Property/fuzz suite:** random streams of deposits, orders, cancels, halts; after every command run Invariants 2, 3, 6, 11, 12; run 1,000,000 commands with fixed seeds in CI nightly.
3. **Integration suite (Docker):** gateway → engine → worker → Postgres → WS for the happy path and each rejection code.
4. **E2E (Playwright):** sign up, deposit, limit order, market order, cancel, withdraw request, admin approval.
5. **Load (k6):** 3,000 orders/sec for 10 minutes with 500 users; record p50/p95/p99 gateway latency, engine CPU, queue length, worker lag. Store results in `docs/perf.md`.
6. **Chaos:** separately kill engine, db-worker, market-data, ws-server, Redis, and Postgres during load; confirm recovery and zero loss; document in `docs/chaos.md`.
7. **Reconciliation job** (`scripts/reconcile.ts`): compares engine balances (via a read-only engine admin command or latest snapshot) with Postgres; verifies conservation per asset; non-zero drift exits with failure. Schedule it nightly in CI/cron.
8. Security tests: auth bypass attempts, JWT tampering, IDOR on `/order/:id`, rate-limit checks, SQL/NoSQL injection payloads on all inputs.

**Acceptance criteria**

- [ ]  All suites green in CI.
- [ ]  Load results meet Section 1.6 targets (or a documented reason and fix plan).
- [ ]  Reconciliation shows zero drift after the chaos run.

---

### PHASE 19: Hardening, Observability, Deployment

**Goal:** Production-style deployment.
**Prerequisites:** Phase 18.

**Steps**

1. **Dockerfiles** (multi-stage, non-root, `npm ci --omit=dev` in final stage) for `api-gateway`, `engine`, `db-worker`, `market-data`, `ws-server`, `web`.
2. **`docker-compose.yml` (production-style):**
    - Internal network only; publish just Nginx (80/443).
    - Postgres and Redis with passwords from env; Redis `appendonly yes`; named volumes for `pgdata`, `redisdata`, `engine-data` (journal + snapshots).
    - Healthchecks and `depends_on: condition: service_healthy`; `restart: unless-stopped`.
    - Resource limits for engine (pin to a dedicated CPU if possible).
3. **Nginx:** TLS (Let’s Encrypt or self-signed for local), HTTP→HTTPS redirect, rate limiting, security headers, WebSocket upgrade for `/ws`, gzip for static assets, proxy timeouts.
4. **Migrations:** a one-shot `migrate` service running `prisma migrate deploy` before apps start.
5. **Secrets:** `.env.production` outside git; document rotation steps for JWT secrets and DB passwords.
6. **Observability:**
    - Prometheus metrics endpoints on every service (`/metrics`), including engine metrics: `engine_seq`, `engine_command_latency_seconds`, `engine_queue_depth`, `engine_open_orders`, `engine_invariant_failures_total`.
    - Grafana dashboards: API latency/error rate, engine throughput/latency, stream lag, worker lag, WS connections.
    - Alerts: worker lag over 5 s, engine process down, invariant failure, reconciliation failure, disk usage over 80% for the engine volume.
7. **Backups:** daily `pg_dump` plus WAL archiving (or provider snapshots); copy engine snapshots and journal to object storage every 15 minutes; write and test `docs/runbook.md` including a full restore drill.
8. **CI (GitHub Actions):** install, lint, typecheck, unit tests, integration tests (services), build images, `npm audit`, secret scan (gitleaks); on tag, push images and run `prisma migrate deploy`.

**Acceptance criteria**

- [ ]  `docker compose up -d` brings the whole stack healthy from a fresh clone and a filled `.env.production`.
- [ ]  Secret scan reports nothing; only Nginx is reachable from outside.
- [ ]  Restore drill completed: stack rebuilt from backups with matching balances.

---

### PHASE 20: Final Verification and Release Commit

**Goal:** A clean, documented, tagged release.
**Prerequisites:** Phase 19.

**Final checklist**

- [ ]  Every phase’s acceptance criteria are checked off in `docs/progress.md`.
- [ ]  All Non-Negotiable Invariants (Section 3.5) pass in the nightly fuzz job.
- [ ]  README contains: overview, architecture diagrams, quick start, environment variables, runbook link, test instructions, and a link to this document.
- [ ]  `docs/` contains: this document, `perf.md`, `chaos.md`, `runbook.md`, API reference (OpenAPI).
- [ ]  No secrets are tracked (`git ls-files | grep -i "\.env"` shows only `.env.example`).
- [ ]  CHANGELOG written; version set to `1.0.0` in all packages.
- [ ]  A demo script (`scripts/demo.ts`) creates two users, funds them, and produces a visible trade.

**Commands**

```bash
npm ci
npm run lint --workspaces --if-present
npm run typecheck
npm run test --workspaces --if-present
npm run build --workspaces --if-present
npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma
docker compose up --build -d
npm run demo                        # end-to-end smoke test
git status                          # review changes; avoid blind "git add ."
git add -A && git diff --cached --stat
git commit -m "release: v1.0.0 CEX spot exchange"
git tag v1.0.0
git push origin main --tags
```

**Acceptance criteria**

- [ ]  CI is green on `main`.
- [ ]  A fresh clone plus the README quick start runs the system and the demo trade succeeds.

---

## Appendix A: Phase Dependency Summary

| Phase | Name              | Depends on | Produces                          |
| ----- | ----------------- | ---------- | --------------------------------- |
| 0     | Tech setup        | none       | Dev infrastructure                |
| 1     | Monorepo          | 0          | Workspaces, shared types          |
| 2     | Database          | 1          | Schema, hypertable, seeds         |
| 3     | Money math        | 1          | `@cex/money`                      |
| 4     | Auth              | 2, 3       | Auth endpoints                    |
| 5     | Order book        | 3          | Book structure                    |
| 6     | Matching          | 5          | Matching logic                    |
| 7     | Balances and fees | 3, 6       | Settlement                        |
| 8     | Messaging         | 7          | Streams, runner, idempotency      |
| 9     | Trading API       | 4, 8       | Order endpoints                   |
| 10    | Recovery          | 8          | Journal, snapshots                |
| 11    | DB worker         | 2, 8       | Projection                        |
| 12    | Market data       | 11         | Depth, ticker, klines             |
| 13    | WebSocket         | 12         | Live streams                      |
| 14    | Wallet and admin  | 9, 11      | Money in/out, controls            |
| 15    | UI foundation     | 4, 9, 13   | Web base                          |
| 16    | Terminal          | 15         | Trading screen                    |
| 17    | Other pages       | 14, 16     | Landing, wallet, orders, admin UI |
| 18    | Testing           | 1 to 17    | Evidence                          |
| 19    | Deployment        | 18         | Production stack                  |
| 20    | Release           | 19         | Tagged `v1.0.0`                   |

## Appendix B: Port Map

| Service          | Dev port              | Production                 |
| ---------------- | --------------------- | -------------------------- |
| Web (Next.js)    | 3000                  | internal, via Nginx        |
| API Gateway      | 4000                  | internal, via Nginx `/api` |
| WebSocket Server | 8080                  | internal, via Nginx `/ws`  |
| PostgreSQL       | 5432 (localhost only) | internal only              |
| Redis            | 6379 (localhost only) | internal only              |
| Prometheus       | 9090                  | internal only              |
| Grafana          | 3030                  | internal or behind auth    |
| Nginx            | n/a                   | 80 and 443                 |

## Appendix C: Environment Variables

| Variable              | Used by                             | Example                                          | Notes                        |
| --------------------- | ----------------------------------- | ------------------------------------------------ | ---------------------------- |
| `NODE_ENV`            | all                                 | `development`                                    | `production` in deploy       |
| `DATABASE_URL`        | gateway, db-worker, market-data, db | `postgresql://cex_user:***@postgres:5432/cex_db` |                              |
| `REDIS_URL`           | all services                        | `redis://:***@redis:6379`                        | Password required            |
| `JWT_ACCESS_SECRET`   | gateway                             | 64+ random chars                                 | Rotate periodically          |
| `JWT_REFRESH_SECRET`  | gateway                             | 64+ random chars                                 |                              |
| `ACCESS_TOKEN_TTL`    | gateway                             | `15m`                                            |                              |
| `REFRESH_TOKEN_TTL`   | gateway                             | `7d`                                             |                              |
| `CORS_ORIGINS`        | gateway, ws-server                  | `https://app.example.com`                        | Comma-separated allowlist    |
| `API_PORT`            | gateway                             | `4000`                                           |                              |
| `WS_PORT`             | ws-server                           | `8080`                                           |                              |
| `MAX_QUEUE_LEN`       | gateway                             | `50000`                                          | Backpressure threshold       |
| `ENGINE_DATA_DIR`     | engine                              | `/data/engine`                                   | Journal and snapshots        |
| `ENGINE_FSYNC_MS`     | engine                              | `50`                                             | `0` means fsync every write  |
| `SNAPSHOT_EVERY_N`    | engine                              | `100000`                                         |                              |
| `SEED_FROM_DB`        | engine                              | `true`                                           | First boot only              |
| `ENGINE_ASSERT`       | engine                              | `false`                                          | `true` in tests              |
| `DEV_DEPOSIT_MAX`     | gateway                             | `100000000000`                                   | Scaled units; dev faucet cap |
| `SEED_ADMIN_PASSWORD` | db seed                             | strong password                                  | Never commit                 |
| `NEXT_PUBLIC_API_URL` | web                                 | `https://app.example.com/api/v1`                 |                              |
| `NEXT_PUBLIC_WS_URL`  | web                                 | `wss://app.example.com/ws`                       |                              |
| `LOG_LEVEL`           | all                                 | `info`                                           |                              |

## Appendix D: Quick Reference Card (for AI prompts)

```
MONEY      : BigInt scaled by 1e8; wire = decimal string; fees round UP; locks round UP
ENGINE     : single process, all markets, all live balances; process() is pure
TRANSPORT  : Redis Streams commands/replies/events; ack after events written
DURABILITY : journal before process; snapshot + replay to recover
DB         : Postgres is a projection keyed by engineSeq (idempotent)
EXECUTION  : maker price; price-time priority; STP cancel taker
MARKET BUY : quoteQuantity budget   MARKET SELL : quantity
FEES       : maker 8 bps, taker 10 bps, paid in the asset received
AUTH       : argon2id; access JWT 15m in memory; refresh 7d HTTP-only cookie, rotating
REALTIME   : WS snapshot + delta with seq; resync on gap
ORDER OF WORK : Phase 0 -> 20, never skip
```