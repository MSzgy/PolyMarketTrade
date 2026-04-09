export interface AppConfig {
  dryRun: boolean;
  runOnce: boolean;
  logLevel: LogLevel;
  marketDataMode: MarketDataMode;
  marketSlug: string;
  outcome: string;
  buyBelowPrice: number;
  orderSize: number;
  pollIntervalMs: number;
  maxPositionSize: number;
  maxNotionalPerOrder: number;
  stateFile: string;
  enableGeoblockCheck: boolean;
  geoblockUrl: string;
  marketWsUrl: string;
  userWsUrl: string;
  marketWsReadyTimeoutMs: number;
  heartbeatIntervalMs: number;
  portfolioAddress?: string;
  gammaUrl: string;
  dataUrl: string;
  clobUrl: string;
  chainId: number;
  signatureType: number;
  privateKey?: string;
  funderAddress?: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  geoBlockToken?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type MarketDataMode = "polling" | "websocket";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config: AppConfig = {
    dryRun: parseBoolean(env.DRY_RUN, true),
    runOnce: parseBoolean(env.RUN_ONCE, false),
    logLevel: parseLogLevel(env.LOG_LEVEL ?? "info"),
    marketDataMode: parseMarketDataMode(env.MARKET_DATA_MODE ?? "websocket"),
    marketSlug: requiredString(env.MARKET_SLUG, "MARKET_SLUG"),
    outcome: env.OUTCOME?.trim() || "Yes",
    buyBelowPrice: parseNumber(env.BUY_BELOW_PRICE, "BUY_BELOW_PRICE", 0.45),
    orderSize: parseNumber(env.ORDER_SIZE, "ORDER_SIZE", 25),
    pollIntervalMs: parseInteger(env.POLL_INTERVAL_MS, "POLL_INTERVAL_MS", 15_000),
    maxPositionSize: parseNumber(env.MAX_POSITION_SIZE, "MAX_POSITION_SIZE", 200),
    maxNotionalPerOrder: parseNumber(
      env.MAX_NOTIONAL_PER_ORDER,
      "MAX_NOTIONAL_PER_ORDER",
      100,
    ),
    stateFile: env.STATE_FILE?.trim() || ".data/bot-state.json",
    enableGeoblockCheck: parseBoolean(env.ENABLE_GEOBLOCK_CHECK, true),
    geoblockUrl:
      env.POLYMARKET_GEOBLOCK_URL?.trim() || "https://polymarket.com/api/geoblock",
    marketWsUrl:
      env.POLYMARKET_MARKET_WS_URL?.trim() ||
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    userWsUrl:
      env.POLYMARKET_USER_WS_URL?.trim() ||
      "wss://ws-subscriptions-clob.polymarket.com/ws/user",
    marketWsReadyTimeoutMs: parseInteger(
      env.POLYMARKET_WS_READY_TIMEOUT_MS,
      "POLYMARKET_WS_READY_TIMEOUT_MS",
      5_000,
    ),
    heartbeatIntervalMs: parseInteger(
      env.POLYMARKET_HEARTBEAT_INTERVAL_MS,
      "POLYMARKET_HEARTBEAT_INTERVAL_MS",
      5_000,
    ),
    portfolioAddress: optionalString(env.PORTFOLIO_ADDRESS),
    gammaUrl: env.POLYMARKET_GAMMA_URL?.trim() || "https://gamma-api.polymarket.com",
    dataUrl: env.POLYMARKET_DATA_URL?.trim() || "https://data-api.polymarket.com",
    clobUrl: env.POLYMARKET_CLOB_URL?.trim() || "https://clob.polymarket.com",
    chainId: parseInteger(env.POLYMARKET_CHAIN_ID, "POLYMARKET_CHAIN_ID", 137),
    signatureType: parseInteger(
      env.POLYMARKET_SIGNATURE_TYPE,
      "POLYMARKET_SIGNATURE_TYPE",
      1,
    ),
    privateKey: optionalString(env.POLYMARKET_PRIVATE_KEY),
    funderAddress: optionalString(env.POLYMARKET_FUNDER_ADDRESS),
    apiKey: optionalString(env.POLYMARKET_API_KEY),
    apiSecret: optionalString(env.POLYMARKET_API_SECRET),
    apiPassphrase: optionalString(env.POLYMARKET_API_PASSPHRASE),
    geoBlockToken: optionalString(env.POLYMARKET_GEO_BLOCK_TOKEN),
  };

  if (!config.dryRun) {
    if (!config.privateKey) {
      throw new Error("POLYMARKET_PRIVATE_KEY is required when DRY_RUN=false");
    }
    if (!config.funderAddress) {
      throw new Error("POLYMARKET_FUNDER_ADDRESS is required when DRY_RUN=false");
    }
  }

  if (config.heartbeatIntervalMs <= 0) {
    throw new Error("POLYMARKET_HEARTBEAT_INTERVAL_MS must be a positive integer");
  }

  return config;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

function parseNumber(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }

  return parsed;
}

function parseInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  const parsed = parseNumber(value, name, fallback);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function requiredString(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseLogLevel(value: string): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  throw new Error(`Unsupported LOG_LEVEL: ${value}`);
}

function parseMarketDataMode(value: string): MarketDataMode {
  if (value === "polling" || value === "websocket") {
    return value;
  }
  throw new Error(`Unsupported MARKET_DATA_MODE: ${value}`);
}
