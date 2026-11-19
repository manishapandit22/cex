# Data Layer of a Spot CEX

**Rule one:** there is no single database. Each store is chosen for one job, and for every piece of data you decide up front which store is the **source of truth** and which ones only hold copies.

This is the common industry pattern. Binance is publicly said to lean on MySQL, Redis and Kafka-style messaging, and many newer exchanges use Postgres. This is not any one exchange's exact stack.

---

## 1. Which store does what

| Data | Store | Why |
|---|---|---|
| Live order book, engine state | **RAM** inside the matching engine, rebuilt from the journal | Microsecond latency |
| Engine command journal and snapshots | **Append-only log on local NVMe**, replicated (custom, Aeron/Raft-style) | Sequential writes, replay |
| Balances, ledger, orders, trades, withdrawals, users | **PostgreSQL or MySQL** (relational, ACID) | Money needs transactions and constraints |
| Event bus between services | **Kafka** (or Redpanda/Pulsar) | Ordered, durable, replayable log |
| Caches, rate limits, sessions, WS fanout | **Redis** | Fast, ephemeral |
| Candles, big history, analytics | **ClickHouse / TimescaleDB** | Columnar, time-series scale |
| Cold archive, statements, audit exports | **S3 / object storage** (Parquet) | Cheap |
| Search/support tools | Elasticsearch/OpenSearch (optional) | Free-text lookup |

**Truth map**
- Order book: the engine journal is truth. The SQL `orders` table is a projection.
- Money: the SQL **ledger** is truth.
- Chain state: the blockchain is truth, and the DB tracks it.
- Redis and Kafka consumers' views: never truth. They can be rebuilt.

## 2. Money representation
- Engine: integers (ticks and lots).
- SQL: `NUMERIC(38,18)` (Postgres) or `BIGINT` in the smallest unit plus an `assets.decimals` column. Never `FLOAT`.
- Add `CHECK (available >= 0 AND locked >= 0)` so the database itself refuses an overdraft even if app code has a bug.

---

## 3. Core schemas (PostgreSQL flavor)

### 3.1 Reference/config
```sql
CREATE TABLE assets (
  asset_id      SMALLINT PRIMARY KEY,
  symbol        TEXT UNIQUE NOT NULL,        -- 'BTC','USDT'
  decimals      SMALLINT NOT NULL,
  status        TEXT NOT NULL                -- active, deposit_only, delisted
);

CREATE TABLE markets (
  market_id     INT PRIMARY KEY,
  symbol        TEXT UNIQUE NOT NULL,        -- 'BTC_USDT'
  base_asset    SMALLINT REFERENCES assets,
  quote_asset   SMALLINT REFERENCES assets,
  tick_size     NUMERIC(38,18) NOT NULL,
  step_size     NUMERIC(38,18) NOT NULL,
  min_notional  NUMERIC(38,18) NOT NULL,
  maker_fee_bps INT, taker_fee_bps INT,
  status        TEXT NOT NULL                -- trading, halt, cancel_only
);

CREATE TABLE networks (                      -- per asset per chain
  asset_id SMALLINT, chain TEXT, contract TEXT,
  min_confirmations INT, withdraw_fee NUMERIC(38,18),
  min_withdraw NUMERIC(38,18), deposit_enabled BOOL, withdraw_enabled BOOL,
  PRIMARY KEY (asset_id, chain)
);
```

### 3.2 Users and auth
```sql
CREATE TABLE users (
  user_id BIGINT PRIMARY KEY, email CITEXT UNIQUE, pw_hash TEXT,
  kyc_level SMALLINT, status TEXT, created_at TIMESTAMPTZ
);
CREATE TABLE user_security (user_id BIGINT PRIMARY KEY, totp_secret_enc BYTEA,
  withdraw_locked_until TIMESTAMPTZ, anti_phishing_code TEXT);
CREATE TABLE api_keys (
  key_id BIGINT PRIMARY KEY, user_id BIGINT, public_key TEXT UNIQUE,  -- or key + hashed secret
  permissions TEXT[], ip_whitelist INET[], created_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
);
CREATE TABLE sub_accounts (sub_id BIGINT PRIMARY KEY, parent_user_id BIGINT, ...);
CREATE TABLE withdrawal_whitelist (user_id BIGINT, chain TEXT, address TEXT, label TEXT, ...);
```
Secrets are encrypted (KMS/envelope encryption) and API secrets are stored hashed or encrypted, never plain.

### 3.3 The ledger (the most important part)
Two layers: a **balance snapshot** for speed, and an **immutable journal** for truth.

```sql
-- Current balances (mutable, fast)
CREATE TABLE balances (
  user_id   BIGINT, asset_id SMALLINT,
  available NUMERIC(38,18) NOT NULL CHECK (available >= 0),
  locked    NUMERIC(38,18) NOT NULL CHECK (locked    >= 0),
  version   BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, asset_id)
);

-- Immutable journal (append-only; never UPDATE or DELETE)
CREATE TABLE journal_entries (
  entry_id    BIGINT PRIMARY KEY,              -- from a sequence/snowflake
  entry_type  TEXT NOT NULL,                   -- deposit, withdraw_lock, trade, fee, ...
  ref_type    TEXT NOT NULL,                   -- 'trade','deposit','withdrawal','order'
  ref_id      TEXT NOT NULL,                   -- business id
  created_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (entry_type, ref_type, ref_id)        -- IDEMPOTENCY: same event can't apply twice
);

CREATE TABLE postings (                        -- the double-entry lines
  posting_id  BIGINT PRIMARY KEY,
  entry_id    BIGINT REFERENCES journal_entries,
  user_id     BIGINT,                          -- or a system account id
  asset_id    SMALLINT,
  bucket      TEXT NOT NULL,                   -- 'available' | 'locked'
  amount      NUMERIC(38,18) NOT NULL          -- signed: +credit / -debit
);
-- Invariant: for every entry_id and asset, SUM(amount) = 0 (value only moves, never appears).
```
System accounts exist as pseudo users: `FEE_REVENUE`, `DEPOSIT_CLEARING`, `WITHDRAW_PENDING`, `SUSPENSE`. Deposits debit `DEPOSIT_CLEARING` and credit the user. This is how the sum-to-zero invariant holds.

**Applying a trade is one DB transaction:**
```
BEGIN;
  INSERT journal_entries ... ON CONFLICT DO NOTHING;   -- if 0 rows inserted: already applied, stop
  UPDATE balances SET locked = locked - :x           WHERE user_id=:buyer  AND asset_id=:usdt;
  UPDATE balances SET available = available + :btc  WHERE user_id=:buyer  AND asset_id=:btc;
  ... seller rows, fee rows, refund row ...
  INSERT postings ...;
COMMIT;
```
- **Lock rows in a fixed order** (sort by `user_id, asset_id`) so two concurrent trades can't deadlock.
- **Hot-row problem:** a single `FEE_REVENUE` row is updated by every trade and becomes a bottleneck. Fix: spread it across N fee sub-accounts (`fee_account_{trade_id % 64}`) or aggregate fees asynchronously.
- **Sharding:** shard the ledger DB by `user_id`. A trade between users on different shards needs either a two-phase approach or a design where the engine event is applied independently on each shard (each side only touches its own user's rows, and the two idempotent applications together form the trade). The second approach avoids distributed transactions.

### 3.4 Orders and trades
```sql
CREATE TABLE orders (
  order_id BIGINT PRIMARY KEY,                 -- engine/sequencer-assigned
  client_order_id TEXT, user_id BIGINT, market_id INT,
  side SMALLINT, type SMALLINT, tif SMALLINT,  -- limit/market, GTC/IOC/FOK, post_only
  price NUMERIC(38,18), qty NUMERIC(38,18), quote_qty NUMERIC(38,18),
  filled_qty NUMERIC(38,18) DEFAULT 0, filled_quote NUMERIC(38,18) DEFAULT 0,
  status SMALLINT, locked_asset SMALLINT, locked_amount NUMERIC(38,18),
  engine_seq BIGINT,                           -- last engine event applied (for idempotent updates)
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  UNIQUE (user_id, client_order_id)            -- dedupes retries
) PARTITION BY RANGE (created_at);             -- monthly partitions
CREATE INDEX ON orders (user_id, created_at DESC);
CREATE INDEX ON orders (user_id, market_id) WHERE status IN (0,1);   -- open orders only

CREATE TABLE trades (
  trade_id BIGINT, market_id INT, engine_seq BIGINT,
  price NUMERIC(38,18), qty NUMERIC(38,18),
  taker_order_id BIGINT, maker_order_id BIGINT,
  taker_user_id BIGINT, maker_user_id BIGINT, taker_side SMALLINT,
  taker_fee NUMERIC(38,18), maker_fee NUMERIC(38,18), fee_asset_taker SMALLINT, fee_asset_maker SMALLINT,
  executed_at TIMESTAMPTZ,
  PRIMARY KEY (market_id, trade_id, executed_at)
) PARTITION BY RANGE (executed_at);
```
- The **partial index on open orders** keeps the "my open orders" query tiny, since open orders are a few thousandths of all rows.
- After a retention window (e.g. 90 days), old partitions are detached and moved to ClickHouse or S3. Users still see history through a different read path.

### 3.5 Deposits and addresses
```sql
CREATE TABLE deposit_addresses (
  user_id BIGINT, asset_id SMALLINT, chain TEXT, address TEXT, memo TEXT,
  derivation_index BIGINT, PRIMARY KEY (user_id, chain), UNIQUE (chain, address, memo)
);
CREATE TABLE deposits (
  deposit_id BIGINT PRIMARY KEY, user_id BIGINT, asset_id SMALLINT, chain TEXT,
  tx_hash TEXT, log_index INT, amount NUMERIC(38,18),
  confirmations INT, status TEXT,               -- pending, confirmed, credited, reverted, swept
  block_number BIGINT, block_hash TEXT, detected_at TIMESTAMPTZ, credited_at TIMESTAMPTZ,
  UNIQUE (chain, tx_hash, log_index)            -- same transfer can't be recorded or credited twice
);
CREATE TABLE chain_scan_state (chain TEXT PRIMARY KEY, last_scanned_block BIGINT, last_block_hash TEXT);
CREATE TABLE sweeps (sweep_id BIGINT PRIMARY KEY, chain TEXT, from_address TEXT, tx_hash TEXT, amount NUMERIC, status TEXT);
```
`chain_scan_state` plus stored `block_hash` is how the scanner detects reorgs: if the new block's parent hash doesn't match what you stored, roll back.

### 3.6 Withdrawals
```sql
CREATE TABLE withdrawals (
  withdrawal_id BIGINT PRIMARY KEY, user_id BIGINT, asset_id SMALLINT, chain TEXT,
  to_address TEXT, memo TEXT, amount NUMERIC(38,18), fee NUMERIC(38,18),
  status TEXT,       -- requested, risk_review, approved, signing, broadcast, confirming, completed, failed, canceled
  risk_score INT, approved_by BIGINT,
  signed_tx_raw BYTEA, tx_hash TEXT, nonce BIGINT, from_wallet TEXT,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
);
CREATE TABLE withdrawal_events (id BIGSERIAL, withdrawal_id BIGINT, from_status TEXT, to_status TEXT, actor TEXT, at TIMESTAMPTZ);  -- audit trail
CREATE TABLE hot_wallet_nonces (wallet TEXT, chain TEXT, next_nonce BIGINT, PRIMARY KEY (wallet, chain));
```
Status transitions are done with a compare-and-set: `UPDATE ... SET status='signing' WHERE id=? AND status='approved'`. If it affects 0 rows, someone else already took it, which prevents double-processing. `signed_tx_raw` is persisted **before** broadcast.

### 3.7 Audit and admin
`audit_log (actor, action, target, before, after, ip, at)`, append-only. Every admin and money-affecting action goes there. Often shipped to immutable storage as well.

---

## 4. Kafka (the event backbone)

**Principle:** a Kafka partition guarantees order only within one partition, so the **partition key** is the design decision.

| Topic | Key | Producers → Consumers |
|---|---|---|
| `engine.events.<group>` | `market_id` | Engine → ledger, order-projector, trade-projector, market-data, notifier |
| `ledger.events` | `user_id` | Ledger → balance push (WS), accounting/analytics |
| `deposits.detected` | `chain:tx_hash` | Scanners → deposit service |
| `withdrawals.commands` | `withdrawal_id` | Risk/approval → signer workers |
| `chain.tx.status` | `tx_hash` | Chain watchers → withdrawal service |
| `notifications` | `user_id` | Anything → email/SMS/push |
| `*.dlq` | n/a | Poison messages parked for humans |

### Delivery guarantees you actually build
Kafka gives at-least-once. You get *effective* exactly-once from **idempotent consumers**:
1. Each event has a stable ID or `engine_seq`.
2. The consumer applies the effect and records the processed seq/ID **in the same DB transaction** (`UNIQUE` on the journal entry is the dedupe check).
3. Reprocessing the same event then hits the unique key and becomes a no-op.

### The outbox pattern (never write DB then publish)
If you commit to Postgres and then crash before publishing to Kafka, the event is lost. Fix:
```sql
-- inside the same transaction as the business change
INSERT INTO outbox (id, topic, key, payload, created_at) VALUES (...);
```
A relay (a CDC tool like Debezium reading the WAL, or a poller) publishes rows to Kafka and marks them sent. The business change and the "intent to publish" commit atomically.

### Ordering and lag
- Ledger consumers for the same user must see events in order, so partition by user for balance-affecting commands.
- Monitor **consumer lag** per group. A growing lag on the ledger consumer means balances are visibly stale.
- Retention: keep engine events long (days to weeks) so any projection can be rebuilt by replay.

---

## 5. Redis (what it is and isn't for)

**Redis is a cache and coordination layer. It is never the source of truth for money.** Persistence (RDB/AOF) can lose the last second of writes and replication is asynchronous.

| Use | Structure | Key example |
|---|---|---|
| **Order book depth cache** (for REST/WS snapshots) | Sorted Set or hash of levels | `ob:BTC_USDT:bids`, updated from engine events |
| **Ticker / last price / 24h stats** | Hash | `ticker:BTC_USDT` |
| **Rate limiting** | Counters / token bucket via **Lua script** (atomic) | `rl:{apikey}:{window}` |
| **Sessions / JWT revocation** | String with TTL | `sess:{id}` |
| **Idempotency keys** | `SET key val NX EX 86400` | `idem:{user}:{clientOrderId}` |
| **WebSocket fan-out** | Pub/Sub or Streams | channel `depth:BTC_USDT` |
| **Recent trades list** | List capped with `LTRIM` | `trades:BTC_USDT` |
| **User's open orders cache** | Hash | `open:{user}` |
| **Distributed locks** | `SET NX PX` (use sparingly) | `lock:withdraw:{id}` |
| **2FA / OTP attempts, cooldowns** | String + TTL | `otp:{user}` |

Notes:
- **Cache invalidation is event-driven**: the engine event stream updates Redis, so there are no TTL-and-hope arrangements for market data.
- **Redis Cluster** shards by key hash slot, so keep multi-key Lua scripts on keys sharing a hash tag (`{BTC_USDT}`).
- Locks from Redis are fine for efficiency (avoid duplicate work) but not for correctness. Correctness belongs in DB unique constraints and compare-and-set updates.
- If Redis dies, everything is rebuilt from the engine stream and Postgres, and the system should degrade, not corrupt.

---

## 6. Time-series and history
- **Candles (klines):** a Kafka consumer aggregates trades into 1m candles and stores them in **ClickHouse or TimescaleDB** (`market_id, interval, open_time, o, h, l, c, volume, trades`). Larger intervals (5m, 1h, 1d) are rolled up from 1m. Serve the latest candle from Redis.
- **Trade history queries** (user statements, tax exports) hit the columnar store or archived Parquet, so they never load the OLTP database.

## 7. Scaling and safety patterns
- **Read/write split:** OLTP primary for writes, replicas for the UI's history queries. Balance checks that decide money never read from a lagging replica.
- **CQRS:** the write path is the engine plus ledger, and the read path is projections (orders, trades, Redis, ClickHouse) fed from events.
- **Partition and archive** big tables by time. Keep hot data small.
- **Connection pooling** (PgBouncer) and short transactions.
- **Backups and PITR** (point-in-time recovery) for the ledger, plus cross-region replicas.
- **Reconciliation jobs** (scheduled):
  - Σ postings per entry = 0.
  - `balances` = Σ postings per (user, asset).
  - Σ user balances + fees = Σ wallet balances on chain (with in-flight items accounted for).
  - Engine's final book state vs `orders` open rows.
  Any mismatch pages someone and can freeze withdrawals.
- **Secrets and keys** live in KMS/HSM, never in these tables.

---

## 8. One trade, every write (the full picture)

```
1. Gateway   → Redis: rate-limit check, idempotency key (SET NX)
2. Gateway   → Ledger DB: lock funds  (balances: available→locked, journal+postings)  [TX 1]
             → orders row INSERT status=NEW; outbox row   [same TX]
3. Gateway   → Engine journal (sequencer assigns seq#)    [durable log]
4. Engine    → emits Trade(seq=9001) → Kafka engine.events.BTC_USDT
5. Ledger consumer:  BEGIN; journal_entries(ref=trade 9001) ON CONFLICT DO NOTHING;
                     update 4–6 balance rows; postings; outbox; COMMIT   [TX 2, idempotent]
6. Order projector:  UPDATE orders SET filled_qty… WHERE order_id=? AND engine_seq < 9001
7. Trade projector:  INSERT trades …
8. Market data:      update Redis depth/ticker, publish to WS channels; candle aggregator → ClickHouse
9. Notifier:         push "order filled" to user's private WS stream
```
Steps 5–9 can lag and are replayable. The only synchronous, money-critical steps are 2 and 3.

## 9. Suggested minimal stack
- **PostgreSQL** (ledger, orders, users, deposits, withdrawals)
- **Kafka or Redpanda** (events), with an **outbox** table plus a relay
- **Redis** (cache, rate limit, WS fan-out)
- **ClickHouse** (candles and history), added later
- Engine journal on local disk, in the engine's own format
