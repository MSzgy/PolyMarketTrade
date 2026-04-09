import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import type { BotState } from "./lib/state-store.js";
import { readEnvFile, updateEnvFile } from "./lib/env-file.js";
import { ClobService } from "./polymarket/clob-service.js";
import { GammaClient } from "./polymarket/gamma-client.js";
import { findOutcome } from "./polymarket/types.js";

const cwd = process.cwd();
const publicDir = resolve(cwd, "public");
const envFilePath = resolve(cwd, process.env.ENV_FILE_PATH ?? ".env");
const defaultStatePath = resolve(cwd, ".data/bot-state.json");
const bootEnv = readEnvFile(envFilePath);
const dashboardHost = process.env.DASHBOARD_HOST ?? bootEnv.DASHBOARD_HOST ?? "127.0.0.1";
const port = parsePort(process.env.DASHBOARD_PORT ?? bootEnv.DASHBOARD_PORT ?? "3100");

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

    if (request.method === "GET" && url.pathname === "/api/market") {
      sendJson(response, 200, await getMarketPayload());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/config") {
      sendJson(response, 200, await saveEditableConfig(request));
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

async function getMarketPayload(): Promise<Record<string, unknown>> {
  const env = readRuntimeEnv();
  const config = loadConfig(env);
  const gammaClient = new GammaClient(config.gammaUrl);
  const clobService = new ClobService(config);
  const market = await gammaClient.getMarketBySlug(config.marketSlug);

  if (!market) {
    throw new Error(`Market not found for slug: ${config.marketSlug}`);
  }

  const selectedOutcome = findOutcome(market, config.outcome);
  if (!selectedOutcome) {
    throw new Error(`Outcome not found: ${config.outcome}`);
  }

  if (!selectedOutcome.tokenId) {
    throw new Error(`Outcome "${selectedOutcome.name}" does not have a tokenId`);
  }

  const book = await clobService.getOrderBook(selectedOutcome.tokenId);
  const bestBid = toNumber(book.bids[0]?.price);
  const bestAsk = toNumber(book.asks[0]?.price);

  return {
    fetchedAt: new Date().toISOString(),
    market: {
      id: market.id,
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
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return "true";
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return "false";
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
