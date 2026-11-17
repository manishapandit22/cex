-- This is an empty migration.
CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable('"Trade"', 'createdAt', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW candle_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', "createdAt") AS bucket,
  market,
  first(price, "createdAt") AS open,
  max(price) AS high,
  min(price) AS low,
  last(price, "createdAt") AS close,
  sum(quantity::numeric) AS volume
FROM "Trade"
GROUP BY bucket, market
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'candle_1m',
  start_offset => INTERVAL '2 hours',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute'
);

CREATE MATERIALIZED VIEW candle_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('5 minutes', "createdAt") AS bucket,
  market,
  first(price, "createdAt") AS open,
  max(price) AS high,
  min(price) AS low,
  last(price, "createdAt") AS close,
  sum(quantity::numeric) AS volume
FROM "Trade"
GROUP BY bucket, market
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'candle_5m',
  start_offset => INTERVAL '1 day',
  end_offset => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes'
);

CREATE MATERIALIZED VIEW candle_15m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('15 minutes', "createdAt") AS bucket,
  market,
  first(price, "createdAt") AS open,
  max(price) AS high,
  min(price) AS low,
  last(price, "createdAt") AS close,
  sum(quantity::numeric) AS volume
FROM "Trade"
GROUP BY bucket, market
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'candle_15m',
  start_offset => INTERVAL '2 days',
  end_offset => INTERVAL '15 minutes',
  schedule_interval => INTERVAL '15 minutes'
);

CREATE MATERIALIZED VIEW candle_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', "createdAt") AS bucket,
  market,
  first(price, "createdAt") AS open,
  max(price) AS high,
  min(price) AS low,
  last(price, "createdAt") AS close,
  sum(quantity::numeric) AS volume
FROM "Trade"
GROUP BY bucket, market
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'candle_1h',
  start_offset => INTERVAL '14 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour'
);

CREATE MATERIALIZED VIEW candle_1d
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', "createdAt") AS bucket,
  market,
  first(price, "createdAt") AS open,
  max(price) AS high,
  min(price) AS low,
  last(price, "createdAt") AS close,
  sum(quantity::numeric) AS volume
FROM "Trade"
GROUP BY bucket, market
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'candle_1d',
  start_offset => INTERVAL '365 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day'
);
