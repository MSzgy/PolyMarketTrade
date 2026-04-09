# PolyMarketTrade

A minimal TypeScript starter for building a Polymarket auto-trading app.

The project is structured around four layers:

1. `Gamma/Data` clients for market discovery and analytics
2. `CLOB` adapter for orderbook reads and optional live order placement
3. `Strategy` interface for signal generation
4. `Risk` layer for hard limits before any order is sent

The default mode is safe:

- `DRY_RUN=true`
- no private key required
- strategy only logs intended orders until you opt into live trading

## What is implemented

- Polymarket Gamma client for market lookup by slug
- Polymarket Data client for positions/activity/value endpoints
- Official CLOB SDK adapter using `@polymarket/clob-client`
- Official geoblock check against `https://polymarket.com/api/geoblock`
- Optional market WebSocket feed with REST fallback
- Live execution manager with user WebSocket subscription, order reconciliation, and heartbeat loop
- Dashboard market explorer for browsing active prediction events and selecting outcomes
- Dashboard order ticket for one-off dry-run or live manual orders at top-of-book prices
- Dashboard standard-binary arbitrage scanner for complete-set mispricing discovery
- Local bot state persistence to `.data/bot-state.json`
- Example threshold strategy:
  - buy one configured outcome when best ask falls below a threshold
- Basic risk controls:
  - max position size
  - max notional per order
- Bot runner with polling loop or `RUN_ONCE=true`

## Project layout

```text
src/
  config.ts
  index.ts
  runner.ts
  engine/
    risk-manager.ts
    strategy.ts
  execution/
    order-manager.ts
  lib/
    env-file.ts
    http.ts
    logger.ts
    state-store.ts
  polymarket/
    clob-service.ts
    data-client.ts
    gamma-client.ts
    geoblock-client.ts
    market-websocket.ts
    types.ts
    user-websocket.ts
  strategies/
    price-threshold.ts
```

## Quickstart

```bash
npm install
cp .env.example .env
npm run dev
```

To open the local dashboard:

```bash
npm run dashboard
```

For a single evaluation cycle:

```bash
RUN_ONCE=true npm run dev
```

## Environment

The minimum configuration for dry-run mode is:

```env
MARKET_SLUG=fed-decision-in-october
OUTCOME=Yes
BUY_BELOW_PRICE=0.45
ORDER_SIZE=25
DRY_RUN=true
MARKET_DATA_MODE=websocket
```

Useful runtime options:

```env
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=3100
STATE_FILE=.data/bot-state.json
ENABLE_GEOBLOCK_CHECK=true
POLYMARKET_GEOBLOCK_URL=https://polymarket.com/api/geoblock
POLYMARKET_MARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_USER_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/user
POLYMARKET_WS_READY_TIMEOUT_MS=5000
POLYMARKET_HEARTBEAT_INTERVAL_MS=5000
```

To enable live trading, set:

```env
DRY_RUN=false
POLYMARKET_PRIVATE_KEY=...
POLYMARKET_FUNDER_ADDRESS=...
```

Optional explicit CLOB API credentials:

```env
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
```

If API credentials are omitted, the bot will attempt to derive them from the private key using the official SDK.

## Strategy behavior

The sample strategy:

- fetches a market by slug from Gamma
- selects one outcome by name
- reads prices from the market WebSocket when enabled, otherwise from the CLOB orderbook
- checks `best ask <= BUY_BELOW_PRICE`
- passes the proposed order through risk limits
- records last snapshot, signal, recent orders, open orders, and user-stream events to local state
- logs the order in dry-run mode or submits it in live mode
- keeps live sessions warm with CLOB heartbeats while open orders exist

## Dashboard

The local dashboard serves a read-only monitoring UI with:

- bot mode, config validity, and state-file presence
- last signal, geoblock result, and recent orders
- current market question and top-of-book snapshot from `/api/market`
- editable strategy/runtime fields persisted through `POST /api/config`
- active market discovery via `/api/markets`
- manual order submission via `POST /api/order`
- estimated complete-set opportunities via `GET /api/arbitrage`

By default it listens on `http://127.0.0.1:3100`.

The manual order flow is:

1. Browse active markets in the explorer and click an outcome chip.
2. The selection fills `MARKET_SLUG` and `OUTCOME` in the strategy form.
3. Use the order ticket to send a dry-run or live order using top-of-book pricing.

The arbitrage scanner only covers standard binary markets and reports estimated top-of-book edge before gas.

The dashboard edit form only writes a safe whitelist of non-secret fields such as:

- `MARKET_SLUG`, `OUTCOME`, `BUY_BELOW_PRICE`, `ORDER_SIZE`
- `POLL_INTERVAL_MS`, `MAX_POSITION_SIZE`, `MAX_NOTIONAL_PER_ORDER`
- `MARKET_DATA_MODE`, `DRY_RUN`, `RUN_ONCE`, `ENABLE_GEOBLOCK_CHECK`

When an env file already exists, writes preserve unrelated keys and comments and create `.env.bak`.

## Notes

- This starter assumes you are trading on Polygon (`chainId=137`).
- The bot intentionally does not hide execution risk. It uses a simple threshold strategy, not a production-grade execution engine.
- Live mode will stop on geoblock failure. Dry-run mode will warn and continue.
- `POLYMARKET_HEARTBEAT_INTERVAL_MS` should stay below `10000`; the order manager clamps it to `9000` because Polymarket cancels sessions that miss a heartbeat for 10 seconds.
- Before turning on live trading, add:
  - retry/backoff
  - structured storage for fills, orders, and PnL
  - order cancellation policies and stale-order cleanup

## Official references

- Docs: <https://docs.polymarket.com/>
- Gamma: <https://gamma-api.polymarket.com/>
- Data API: <https://data-api.polymarket.com/>
- CLOB: <https://clob.polymarket.com/>
- TypeScript SDK: <https://github.com/Polymarket/clob-client>
