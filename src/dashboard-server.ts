import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { TickSize } from "@polymarket/clob-client";
import { StandardBinaryScanner } from "./arbitrage/standard-binary-scanner.js";
import { loadConfig, type AppConfig } from "./config.js";
import { OrderManager } from "./execution/order-manager.js";
import { readEnvFile, updateEnvFile } from "./lib/env-file.js";
import { Logger } from "./lib/logger.js";
import { StateStore, type BotState } from "./lib/state-store.js";
import { ClobService } from "./polymarket/clob-service.js";
import { GammaClient } from "./polymarket/gamma-client.js";
import { GeoblockClient } from "./polymarket/geoblock-client.js";
import type { NormalizedMarket } from "./polymarket/types.js";
import type { UserChannelEvent } from "./polymarket/user-websocket.js";

const cwd = process.cwd();
const publicDir = resolve(cwd, "public");
const envFilePath = resolve(cwd, process.env.ENV_FILE_PATH ?? ".env");
const defaultStatePath = resolve(cwd, ".data/bot-state.json");
const bootEnv = readEnvFile(envFilePath);
const dashboardHost = process.env.DASHBOARD_HOST ?? bootEnv.DASHBOARD_HOST ?? "127.0.0.1";
const port = parsePort(process.env.DASHBOARD_PORT ?? bootEnv.DASHBOARD_PORT ?? "3100");
const defaultGammaUrl = "https://gamma-api.polymarket.com";

const editableConfigKeys = [
  "MARKET_SLUG",
  "OUTCOME",
  "BUY_BELOW_PRICE",
  "ORDER_SIZE",
  "POLL_INTERVAL_MS",
  "MAX_POSITION_SIZE",
  "MAX_NOTIONAL_PER_ORDER",
  "MARKET_DATA_MODE",
  "DRY_RUN",
  "RUN_ONCE",
  "ENABLE_GEOBLOCK_CHECK",
] as const;

type EditableConfigKey = (typeof editableConfigKeys)[number];

const booleanKeys = new Set<EditableConfigKey>([
  "DRY_RUN",
  "RUN_ONCE",
  "ENABLE_GEOBLOCK_CHECK",
]);

const server = createServer(async (request, response) => {
  try {
    if (!request.url) {
      sendJson(response, 400, { error: "Missing request URL" });
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        now: new Date().toISOString(),
        host: dashboardHost,
        port,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, await getStatusPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/markets") {
      sendJson(response, 200, await getMarketsPayload(url.searchParams));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/arbitrage") {
      sendJson(response, 200, await getArbitragePayload(url.searchParams));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/market") {
      sendJson(response, 200, await getMarketPayload(url.searchParams));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/config") {
      sendJson(response, 200, await saveEditableConfig(request));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/order") {
      sendJson(response, 200, await placeManualOrder(request));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: `Unknown endpoint: ${request.method} ${url.pathname}` });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: `Unsupported method for static asset: ${request.method}` });
      return;
    }

    serveStatic(url.pathname, response, request.method === "HEAD");
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, dashboardHost, () => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      message: "dashboard server started",
      context: {
        host: dashboardHost,
        port,
        url: `http://${dashboardHost}:${port}`,
        envFilePath,
      },
    }),
  );
});

async function getStatusPayload(): Promise<Record<string, unknown>> {
  const env = readRuntimeEnv();
  const { config, configError } = tryLoadConfig(env);
  const statePath = resolve(cwd, config?.stateFile ?? env.STATE_FILE ?? defaultStatePath);

  return {
    now: new Date().toISOString(),
    envFilePath,
    envFilePresent: existsSync(envFilePath),
    dashboard: {
      host: dashboardHost,
      port,
      publicDir,
    },
    configValid: Boolean(config),
    configError,
    config: sanitizeConfig(config, env),
    editableConfig: editableConfigFrom(config, env),
    editableKeys: editableConfigKeys,
    stateFile: statePath,
    stateFilePresent: existsSync(statePath),
    state: readStateFile(statePath),
  };
}

async function getMarketsPayload(searchParams: URLSearchParams): Promise<Record<string, unknown>> {
  const gammaUrl = readRuntimeEnv().POLYMARKET_GAMMA_URL ?? defaultGammaUrl;
  const gammaClient = new GammaClient(gammaUrl);
  const query = searchParams.get("q")?.trim().toLowerCase() ?? "";
  const limit = clampInteger(searchParams.get("limit"), 1, 40, 18);
  const fetchLimit = query ? Math.max(limit * 4, 80) : limit;

  const markets = await gammaClient.listMarkets({
    active: true,
    closed: false,
    archived: false,
    limit: fetchLimit,
  });

  const filtered = markets
    .filter((market) => market.enableOrderBook && market.outcomes.some((outcome) => outcome.tokenId))
    .filter((market) => matchesMarketSearch(market, query))
    .sort(compareMarkets)
    .slice(0, limit);

  return {
    fetchedAt: new Date().toISOString(),
    query,
    count: filtered.length,
    markets: filtered.map((market) => ({
      id: market.id,
      conditionId: market.conditionId ?? null,
      slug: market.slug,
      question: market.question,
      active: market.active,
      closed: market.closed,
      archived: market.archived,
      liquidity: market.liquidity,
      volume: market.volume,
      negRisk: market.negRisk,
      endDate: market.endDate ?? null,
      outcomes: market.outcomes
        .filter((outcome) => outcome.tokenId)
        .map((outcome) => ({
          name: outcome.name,
          tokenId: outcome.tokenId,
          impliedPrice: outcome.price,
        })),
    })),
  };
}

async function getArbitragePayload(
  searchParams: URLSearchParams,
): Promise<Record<string, unknown>> {
  const config = loadPublicDashboardConfig();
  const scanner = new StandardBinaryScanner(
    new GammaClient(config.gammaUrl),
    new ClobService(config),
  );

  const result = await scanner.scan({
    marketScanLimit: clampInteger(searchParams.get("scan"), 1, 40, 12),
    opportunityLimit: clampInteger(searchParams.get("limit"), 1, 20, 8),
    minEdgeBps: clampFloat(searchParams.get("minEdgeBps"), -10_000, 10_000, 0),
  });

  return {
    ...result,
    notes: {
      scope: "standard binary markets only",
      pricing: "top-of-book only",
      fees: "estimated taker fee equivalent",
      gas: "not included",
    },
  };
}

async function getMarketPayload(searchParams: URLSearchParams): Promise<Record<string, unknown>> {
  const { config, market, selectedOutcome, orderbook } = await loadMarketSnapshot({
    marketSlug: searchParams.get("marketSlug") ?? undefined,
    outcome: searchParams.get("outcome") ?? undefined,
  });

  return marketPayloadFromSnapshot(config, market, selectedOutcome, orderbook);
}

async function saveEditableConfig(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const payload = await readJsonBody(request);
  const updates = normalizeEditableUpdates(payload);
  const mergedEnv = {
    ...process.env,
    ...readEnvFile(envFilePath),
    ...updates,
  };

  loadConfig(mergedEnv);
  const result = updateEnvFile(envFilePath, updates);
  const status = await getStatusPayload();

  return {
    ok: true,
    message: "Saved editable settings to the env file. Restart the bot process to apply them.",
    envFilePath,
    backupPath: result.backupPath ?? null,
    updatedKeys: Object.keys(updates),
    ...status,
  };
}

async function placeManualOrder(request: IncomingMessage): Promise<Record<string, unknown>> {
  const payload = normalizeOrderPayload(await readJsonBody(request));
  const env = readRuntimeEnv();
  const config = loadConfig({
    ...env,
    MARKET_SLUG: payload.marketSlug,
    OUTCOME: payload.outcome,
    ORDER_SIZE: String(payload.size),
    ...(payload.dryRun === undefined ? {} : { DRY_RUN: payload.dryRun ? "true" : "false" }),
  });
  const logger = new Logger(config.logLevel);
  const clobService = new ClobService(config);
  const geoblockClient = new GeoblockClient(config.geoblockUrl);

  const geoblock = await checkGeoblockStatus(config, geoblockClient);
  const { market, selectedOutcome, orderbook } = await loadMarketSnapshot(
    {
      marketSlug: payload.marketSlug,
      outcome: payload.outcome,
    },
    config,
    clobService,
  );

  const price =
    payload.limitPrice ??
    (payload.side === "BUY" ? orderbook.bestAsk : orderbook.bestBid);
  if (price === null) {
    throw new Error(
      payload.side === "BUY"
        ? "No best ask is available for this outcome"
        : "No best bid is available for this outcome",
    );
  }

  if (!config.dryRun) {
    await clobService.initialize();
  }

  const stateStore = new StateStore(config.stateFile, market.slug, selectedOutcome.name);
  const state = stateStore.load();
  const persistState = (): void => {
    stateStore.save(state);
  };

  if (geoblock) {
    state.geoblock = geoblock;
    persistState();
  }

  const orderManager = new OrderManager(config, clobService, logger, {
    onHeartbeat: (heartbeat) => {
      state.heartbeat = heartbeat;
      persistState();
    },
    onUserEvent: (event) => {
      state.lastOrderEvent = toStateOrderEvent(event);
      persistState();
    },
  });

  try {
    const execution = await orderManager.submit({
      market,
      tokenId: selectedOutcome.tokenId,
      price,
      size: payload.size,
      side: payload.side,
      tickSize: orderbook.tickSize,
      negRisk: market.negRisk,
      reason: buildManualOrderReason(payload, orderbook),
    });

    const openOrders = config.dryRun
      ? []
      : await orderManager.reconcileOpenOrders({
          market,
          tokenId: selectedOutcome.tokenId,
        });

    updateStateAfterManualOrder(
      state,
      market,
      selectedOutcome.name,
      selectedOutcome.tokenId,
      orderbook,
      execution,
      openOrders,
    );
    persistState();

    return {
      ok: true,
      message:
        execution.mode === "dry-run"
          ? "Dry-run order recorded."
          : "Live order submitted.",
      geoblock,
      execution,
      marketSnapshot: marketPayloadFromSnapshot(config, market, selectedOutcome, orderbook),
      openOrders: openOrders.map(toStateOpenOrder),
      stateFile: resolve(cwd, config.stateFile),
    };
  } finally {
    orderManager.close();
  }
}

async function loadMarketSnapshot(
  overrides: {
    marketSlug?: string;
    outcome?: string;
  },
  providedConfig?: AppConfig,
  providedClobService?: ClobService,
): Promise<{
  config: AppConfig;
  market: NormalizedMarket;
  selectedOutcome: { name: string; tokenId: string; price: number | null };
  orderbook: {
    bestBid: number | null;
    bestAsk: number | null;
    midpoint: number | null;
    tickSize: TickSize;
    topBids: Array<{ price: string; size: string }>;
    topAsks: Array<{ price: string; size: string }>;
  };
}> {
  const config =
    providedConfig ??
    loadConfig({
      ...readRuntimeEnv(),
      ...(overrides.marketSlug ? { MARKET_SLUG: overrides.marketSlug } : {}),
      ...(overrides.outcome ? { OUTCOME: overrides.outcome } : {}),
    });
  const gammaClient = new GammaClient(config.gammaUrl);
  const clobService = providedClobService ?? new ClobService(config);
  const { market, selectedOutcome } = await gammaClient.resolveMarketOutcome(
    overrides.marketSlug ?? config.marketSlug,
    overrides.outcome ?? config.outcome,
  );

  const book = await clobService.getOrderBook(selectedOutcome.tokenId);
  const bestBid = toNumber(book.bids[0]?.price);
  const bestAsk = toNumber(book.asks[0]?.price);

  return {
    config,
    market,
    selectedOutcome,
    orderbook: {
      bestBid,
      bestAsk,
      midpoint: midpointFromBook(bestBid, bestAsk),
      tickSize: book.tick_size ?? (await clobService.getTickSize(selectedOutcome.tokenId)),
      topBids: book.bids.slice(0, 5),
      topAsks: book.asks.slice(0, 5),
    },
  };
}

function marketPayloadFromSnapshot(
  config: AppConfig,
  market: NormalizedMarket,
  selectedOutcome: { name: string; tokenId: string; price: number | null },
  orderbook: {
    bestBid: number | null;
    bestAsk: number | null;
    midpoint: number | null;
    tickSize: TickSize;
    topBids: Array<{ price: string; size: string }>;
    topAsks: Array<{ price: string; size: string }>;
  },
): Record<string, unknown> {
  return {
    fetchedAt: new Date().toISOString(),
    market: {
      id: market.id,
      conditionId: market.conditionId ?? null,
      slug: market.slug,
      question: market.question,
      active: market.active,
      closed: market.closed,
      archived: market.archived,
      liquidity: market.liquidity,
      volume: market.volume,
      negRisk: market.negRisk,
      endDate: market.endDate,
    },
    outcome: {
      name: selectedOutcome.name,
      tokenId: selectedOutcome.tokenId,
      impliedPrice: selectedOutcome.price,
    },
    orderbook,
    mode: {
      dryRun: config.dryRun,
      marketDataMode: config.marketDataMode,
    },
  };
}

function normalizeEditableUpdates(payload: unknown): Record<EditableConfigKey, string> {
  const input = extractPayloadObject(payload);
  const unknownKeys = Object.keys(input).filter(
    (key) => !editableConfigKeys.includes(key as EditableConfigKey),
  );

  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported editable keys: ${unknownKeys.join(", ")}`);
  }

  const updates = {} as Record<EditableConfigKey, string>;
  for (const key of editableConfigKeys) {
    if (!Object.hasOwn(input, key)) {
      continue;
    }

    const value = input[key];
    if (value === null || value === undefined) {
      continue;
    }

    if (booleanKeys.has(key)) {
      updates[key] = normalizeBooleanInput(value);
      continue;
    }

    updates[key] = String(value).trim();
  }

  return updates;
}

function normalizeOrderPayload(payload: unknown): {
  marketSlug: string;
  outcome: string;
  side: "BUY" | "SELL";
  size: number;
  limitPrice?: number;
  dryRun?: boolean;
} {
  const input = extractPayloadObject(payload);
  const marketSlug = requiredText(input.marketSlug, "marketSlug");
  const outcome = requiredText(input.outcome, "outcome");
  const side = normalizeSide(input.side);
  const size = parsePositiveNumber(input.size, "size");
  const dryRun = input.dryRun === undefined ? undefined : normalizeBooleanValue(input.dryRun);
  const limitPrice =
    input.limitPrice === undefined || input.limitPrice === null || String(input.limitPrice) === ""
      ? undefined
      : parseProbability(input.limitPrice, "limitPrice");

  return {
    marketSlug,
    outcome,
    side,
    size,
    limitPrice,
    dryRun,
  };
}

function editableConfigFrom(
  config: AppConfig | undefined,
  env: Record<string, string | undefined>,
): Record<EditableConfigKey, string | boolean> {
  const fallbackMode = env.MARKET_DATA_MODE === "polling" ? "polling" : "websocket";

  return {
    MARKET_SLUG: config?.marketSlug ?? env.MARKET_SLUG ?? "",
    OUTCOME: config?.outcome ?? env.OUTCOME ?? "Yes",
    BUY_BELOW_PRICE: String(config?.buyBelowPrice ?? env.BUY_BELOW_PRICE ?? "0.45"),
    ORDER_SIZE: String(config?.orderSize ?? env.ORDER_SIZE ?? "25"),
    POLL_INTERVAL_MS: String(config?.pollIntervalMs ?? env.POLL_INTERVAL_MS ?? "15000"),
    MAX_POSITION_SIZE: String(config?.maxPositionSize ?? env.MAX_POSITION_SIZE ?? "200"),
    MAX_NOTIONAL_PER_ORDER: String(
      config?.maxNotionalPerOrder ?? env.MAX_NOTIONAL_PER_ORDER ?? "100",
    ),
    MARKET_DATA_MODE: config?.marketDataMode ?? fallbackMode,
    DRY_RUN: config?.dryRun ?? normalizeNullableBoolean(env.DRY_RUN) ?? true,
    RUN_ONCE: config?.runOnce ?? normalizeNullableBoolean(env.RUN_ONCE) ?? false,
    ENABLE_GEOBLOCK_CHECK:
      config?.enableGeoblockCheck ?? normalizeNullableBoolean(env.ENABLE_GEOBLOCK_CHECK) ?? true,
  };
}

function sanitizeConfig(
  config: AppConfig | undefined,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  if (!config) {
    return {
      marketSlug: env.MARKET_SLUG ?? null,
      outcome: env.OUTCOME ?? "Yes",
      dryRun: normalizeNullableBoolean(env.DRY_RUN),
      runOnce: normalizeNullableBoolean(env.RUN_ONCE),
      marketDataMode: env.MARKET_DATA_MODE ?? null,
      dashboardHost: env.DASHBOARD_HOST ?? dashboardHost,
      dashboardPort: env.DASHBOARD_PORT ?? String(port),
      stateFile: env.STATE_FILE ?? ".data/bot-state.json",
      enableGeoblockCheck: normalizeNullableBoolean(env.ENABLE_GEOBLOCK_CHECK),
      hasPrivateKey: Boolean(env.POLYMARKET_PRIVATE_KEY),
      hasApiKeySet: Boolean(
        env.POLYMARKET_API_KEY && env.POLYMARKET_API_SECRET && env.POLYMARKET_API_PASSPHRASE,
      ),
    };
  }

  return {
    dryRun: config.dryRun,
    runOnce: config.runOnce,
    marketDataMode: config.marketDataMode,
    dashboardHost,
    marketSlug: config.marketSlug,
    outcome: config.outcome,
    buyBelowPrice: config.buyBelowPrice,
    orderSize: config.orderSize,
    pollIntervalMs: config.pollIntervalMs,
    maxPositionSize: config.maxPositionSize,
    maxNotionalPerOrder: config.maxNotionalPerOrder,
    stateFile: config.stateFile,
    enableGeoblockCheck: config.enableGeoblockCheck,
    portfolioAddress: config.portfolioAddress ?? null,
    gammaUrl: config.gammaUrl,
    dataUrl: config.dataUrl,
    clobUrl: config.clobUrl,
    geoblockUrl: config.geoblockUrl,
    marketWsUrl: config.marketWsUrl,
    userWsUrl: config.userWsUrl,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    marketWsReadyTimeoutMs: config.marketWsReadyTimeoutMs,
    hasPrivateKey: Boolean(config.privateKey),
    hasApiKeySet: Boolean(config.apiKey && config.apiSecret && config.apiPassphrase),
    hasFunderAddress: Boolean(config.funderAddress),
  };
}

function readRuntimeEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    ...readEnvFile(envFilePath),
  };
}

function tryLoadConfig(
  env: Record<string, string | undefined>,
): { config?: AppConfig; configError?: string } {
  try {
    return { config: loadConfig(env) };
  } catch (error) {
    return {
      configError: error instanceof Error ? error.message : String(error),
    };
  }
}

function loadPublicDashboardConfig(): AppConfig {
  return loadConfig({
    DRY_RUN: "true",
    MARKET_SLUG: "__dashboard_market__",
    OUTCOME: "Yes",
  });
}

function readStateFile(path: string): BotState | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as BotState;
  } catch {
    return null;
  }
}

function serveStatic(pathname: string, response: ServerResponse, headOnly: boolean): void {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(publicDir, `.${requestPath}`);

  if (!filePath.startsWith(publicDir)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendText(response, 404, "Not found");
    return;
  }

  const body = readFileSync(filePath);
  response.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-cache",
  });
  if (!headOnly) {
    response.end(body);
    return;
  }
  response.end();
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    throw new Error("Missing JSON request body");
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as unknown;
}

function extractPayloadObject(payload: unknown): Record<string, unknown> {
  if (!isObject(payload)) {
    throw new Error("Request body must be a JSON object");
  }

  if (isObject(payload.values)) {
    return payload.values;
  }

  return payload;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBooleanInput(value: unknown): string {
  return normalizeBooleanValue(value) ? "true" : "false";
}

function normalizeBooleanValue(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  throw new Error(`Invalid boolean value: ${String(value)}`);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function contentTypeFor(path: string): string {
  const extension = extname(path);
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function midpointFromBook(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid === null || bestAsk === null) {
    return null;
  }

  return (bestBid + bestAsk) / 2;
}

function toNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNullableBoolean(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null;
  }

  return value === "true" || value === "1" || value === "yes";
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid DASHBOARD_PORT: ${value}`);
  }
  return parsed;
}

function clampInteger(
  value: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === null || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function clampFloat(
  value: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === null || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function matchesMarketSearch(market: NormalizedMarket, query: string): boolean {
  if (!query) {
    return true;
  }

  const haystacks = [
    market.slug,
    market.question,
    ...market.outcomes.map((outcome) => outcome.name),
  ];

  return haystacks.some((value) => value.toLowerCase().includes(query));
}

function compareMarkets(left: NormalizedMarket, right: NormalizedMarket): number {
  return (
    (right.volume ?? 0) - (left.volume ?? 0) ||
    (right.liquidity ?? 0) - (left.liquidity ?? 0) ||
    left.question.localeCompare(right.question)
  );
}

function requiredText(value: unknown, name: string): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${name} is required`);
  }
  return text;
}

function normalizeSide(value: unknown): "BUY" | "SELL" {
  const text = String(value ?? "BUY").trim().toUpperCase();
  if (text === "BUY" || text === "SELL") {
    return text;
  }

  throw new Error(`Unsupported side: ${String(value)}`);
}

function parsePositiveNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return parsed;
}

function parseProbability(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new Error(`${name} must be within (0, 1)`);
  }

  return parsed;
}

async function checkGeoblockStatus(
  config: AppConfig,
  geoblockClient: GeoblockClient,
): Promise<BotState["geoblock"] | undefined> {
  if (!config.enableGeoblockCheck) {
    return undefined;
  }

  const status = await geoblockClient.check();
  const result = {
    checkedAt: new Date().toISOString(),
    blocked: status.blocked,
    country: status.country,
    region: status.region,
    ip: status.ip,
  };

  if (status.blocked && !config.dryRun) {
    throw new Error(`Geoblock prevented trading for ${status.country}-${status.region}`);
  }

  return result;
}

function buildManualOrderReason(
  payload: {
    side: "BUY" | "SELL";
    limitPrice?: number;
  },
  orderbook: {
    bestBid: number | null;
    bestAsk: number | null;
  },
): string {
  if (payload.limitPrice !== undefined) {
    return `Manual ${payload.side} order from dashboard using explicit limit price ${payload.limitPrice.toFixed(4)}`;
  }

  const marketPrice = payload.side === "BUY" ? orderbook.bestAsk : orderbook.bestBid;
  const source = payload.side === "BUY" ? "best ask" : "best bid";
  return `Manual ${payload.side} order from dashboard using ${source} ${marketPrice?.toFixed(4) ?? "N/A"}`;
}

function updateStateAfterManualOrder(
  state: BotState,
  market: NormalizedMarket,
  outcome: string,
  tokenId: string,
  orderbook: {
    bestBid: number | null;
    bestAsk: number | null;
    midpoint: number | null;
  },
  execution: {
    createdAt: string;
    mode: "dry-run" | "live";
    tokenId: string;
    price: number;
    size: number;
    side: "BUY" | "SELL";
    reason: string;
    orderId?: string;
    status?: string;
  },
  openOrders: Array<{
    id: string;
    status: string;
    market: string;
    asset_id: string;
    side: string;
    original_size: string;
    size_matched: string;
    price: string;
    outcome: string;
    created_at: number;
  }>,
): void {
  state.marketSlug = market.slug;
  state.outcome = outcome;
  state.lastSnapshot = {
    updatedAt: new Date().toISOString(),
    tokenId,
    bestBid: orderbook.bestBid,
    bestAsk: orderbook.bestAsk,
    midpoint: orderbook.midpoint,
    currentPositionSize: state.lastSnapshot?.currentPositionSize ?? 0,
    source: "polling",
  };
  state.lastSignal = {
    updatedAt: execution.createdAt,
    action: execution.side,
    reason: execution.reason,
    tokenId: execution.tokenId,
    price: execution.price,
    size: execution.size,
  };

  if (execution.mode === "dry-run") {
    state.stats.dryRunOrders += 1;
  } else {
    state.stats.liveOrders += 1;
  }

  state.recentOrders.push({
    createdAt: execution.createdAt,
    mode: execution.mode,
    tokenId: execution.tokenId,
    marketSlug: market.slug,
    marketQuestion: market.question,
    outcomeName: outcome,
    side: execution.side,
    price: execution.price,
    size: execution.size,
    reason: execution.reason,
    orderId: execution.orderId,
    status: execution.status,
  });
  state.recentOrders = state.recentOrders.slice(-50);
  state.openOrders = openOrders.map(toStateOpenOrder).slice(-50);

  const reserved = reservedBuySize(openOrders);
  if (reserved > 0) {
    state.reservedPositionByToken[tokenId] = reserved;
  } else {
    delete state.reservedPositionByToken[tokenId];
  }
}

function reservedBuySize(
  orders: Array<{
    side: string;
    original_size: string;
    size_matched: string;
  }>,
): number {
  return orders.reduce((sum, order) => {
    if (order.side !== "BUY") {
      return sum;
    }

    const original = Number(order.original_size);
    const matched = Number(order.size_matched);
    if (!Number.isFinite(original) || !Number.isFinite(matched)) {
      return sum;
    }

    return sum + Math.max(0, original - matched);
  }, 0);
}

function toStateOrderEvent(event: UserChannelEvent): BotState["lastOrderEvent"] {
  if (event.eventType === "order") {
    return {
      observedAt: new Date().toISOString(),
      eventType: event.eventType,
      status: event.statusType,
      market: event.market,
      assetId: event.assetId,
      orderId: event.orderId,
      outcome: event.outcome,
      side: event.side,
      price: event.price,
      size: event.originalSize,
      sizeMatched: event.sizeMatched,
    };
  }

  return {
    observedAt: new Date().toISOString(),
    eventType: event.eventType,
    status: event.statusType,
    market: event.market,
    assetId: event.assetId,
    orderId: event.orderId,
    tradeId: event.tradeId,
    outcome: event.outcome,
    side: event.side,
    price: event.price,
    size: event.size,
  };
}

function toStateOpenOrder(order: {
  id: string;
  status: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  outcome: string;
  created_at: number;
}): BotState["openOrders"][number] {
  const originalSize = toNullableNumber(order.original_size);
  const sizeMatched = toNullableNumber(order.size_matched);

  return {
    orderId: order.id,
    status: order.status,
    market: order.market,
    assetId: order.asset_id,
    side: order.side === "SELL" ? "SELL" : "BUY",
    price: toNullableNumber(order.price),
    originalSize,
    sizeMatched,
    remainingSize:
      originalSize === null || sizeMatched === null
        ? null
        : Math.max(0, originalSize - sizeMatched),
    outcome: order.outcome,
    createdAt: unixSecondsToIso(order.created_at),
  };
}

function toNullableNumber(value: string | number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unixSecondsToIso(value: number): string {
  return new Date(value * 1_000).toISOString();
}
