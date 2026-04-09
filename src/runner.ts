import type { TickSize } from "@polymarket/clob-client";
import type { AppConfig } from "./config.js";
import { RiskManager } from "./engine/risk-manager.js";
import type { MarketSnapshot, Strategy } from "./engine/strategy.js";
import { Logger } from "./lib/logger.js";
import { StateStore, type BotState } from "./lib/state-store.js";
import { ClobService } from "./polymarket/clob-service.js";
import { DataClient } from "./polymarket/data-client.js";
import { GammaClient } from "./polymarket/gamma-client.js";
import { GeoblockClient } from "./polymarket/geoblock-client.js";
import { MarketWebSocketFeed } from "./polymarket/market-websocket.js";
import { findOutcome } from "./polymarket/types.js";

export class TradingRunner {
  private readonly gammaClient: GammaClient;
  private readonly dataClient: DataClient;
  private readonly riskManager: RiskManager;
  private readonly geoblockClient: GeoblockClient;
  private readonly stateStore: StateStore;
  private readonly marketFeed?: MarketWebSocketFeed;
  private readonly reservedPositionByToken = new Map<string, number>();
  private state: BotState;
  private stopped = false;

  constructor(
    private readonly config: AppConfig,
    private readonly strategy: Strategy,
    private readonly clobService: ClobService,
    private readonly logger: Logger,
  ) {
    this.gammaClient = new GammaClient(config.gammaUrl);
    this.dataClient = new DataClient(config.dataUrl);
    this.geoblockClient = new GeoblockClient(config.geoblockUrl);
    this.stateStore = new StateStore(config.stateFile, config.marketSlug, config.outcome);
    this.state = this.stateStore.load();
    this.restoreReservedPositions();
    this.riskManager = new RiskManager({
      maxPositionSize: config.maxPositionSize,
      maxNotionalPerOrder: config.maxNotionalPerOrder,
    });
    this.marketFeed =
      config.marketDataMode === "websocket"
        ? new MarketWebSocketFeed(config.marketWsUrl, config.marketWsReadyTimeoutMs, logger)
        : undefined;
  }

  async start(): Promise<void> {
    await this.checkGeoblock();
    await this.clobService.initialize();

    this.logger.info("bot started", {
      dryRun: this.config.dryRun,
      marketSlug: this.config.marketSlug,
      outcome: this.config.outcome,
      strategy: this.strategy.name,
      marketDataMode: this.config.marketDataMode,
    });

    try {
      do {
        await this.tick();

        if (this.config.runOnce) {
          break;
        }

        if (!this.stopped) {
          await sleep(this.config.pollIntervalMs);
        }
      } while (!this.stopped);
    } finally {
      this.marketFeed?.close();
      this.persistState();
    }
  }

  stop(): void {
    this.stopped = true;
    this.marketFeed?.close();
  }

  private async tick(): Promise<void> {
    const market = await this.gammaClient.getMarketBySlug(this.config.marketSlug);
    if (!market) {
      throw new Error(`Market not found for slug: ${this.config.marketSlug}`);
    }

    if (!market.enableOrderBook) {
      throw new Error(`Market ${market.slug} does not have enableOrderBook=true`);
    }

    const selectedOutcome = findOutcome(market, this.config.outcome);
    if (!selectedOutcome) {
      throw new Error(
        `Outcome "${this.config.outcome}" not found. Available outcomes: ${market.outcomes.map((outcome) => outcome.name).join(", ")}`,
      );
    }

    if (!selectedOutcome.tokenId) {
      throw new Error(`Outcome "${selectedOutcome.name}" does not have a CLOB token id`);
    }

    const { bestBid, bestAsk, tickSize, source } = await this.getMarketPrices(
      selectedOutcome.tokenId,
    );
    const midpoint = midpointFromBook(bestBid, bestAsk);
    const currentPositionSize = await this.getCurrentPositionSize(selectedOutcome.tokenId);

    const snapshot: MarketSnapshot = {
      market,
      selectedOutcome,
      bestBid,
      bestAsk,
      midpoint,
      currentPositionSize,
    };

    this.state.stats.ticks += 1;
    this.state.lastSnapshot = {
      updatedAt: new Date().toISOString(),
      tokenId: selectedOutcome.tokenId,
      bestBid,
      bestAsk,
      midpoint,
      currentPositionSize,
      source,
    };
    this.persistState();

    this.logger.debug("market snapshot", {
      slug: market.slug,
      outcome: selectedOutcome.name,
      bestBid,
      bestAsk,
      midpoint,
      currentPositionSize,
      source,
    });

    const signal = await this.strategy.evaluate(snapshot);
    this.state.lastSignal = {
      updatedAt: new Date().toISOString(),
      action: signal.action,
      reason: signal.reason,
      tokenId: signal.tokenId,
      price: signal.price,
      size: signal.size,
    };
    const decision = this.riskManager.evaluate(signal, currentPositionSize);

    if (!decision.allowed) {
      this.state.stats.skippedSignals += 1;
      this.persistState();
      this.logger.info("no order sent", {
        reason: decision.reason,
        signal: signal.action,
      });
      return;
    }

    if (!signal.tokenId || !signal.price || !signal.size) {
      throw new Error("Approved signal is missing token, price, or size");
    }

    if (signal.action === "HOLD") {
      return;
    }

    if (this.config.dryRun) {
      this.state.stats.dryRunOrders += 1;
      this.state.recentOrders.push({
        createdAt: new Date().toISOString(),
        mode: "dry-run",
        tokenId: signal.tokenId,
        side: signal.action,
        price: signal.price,
        size: signal.size,
        reason: signal.reason,
      });
      this.state.recentOrders = this.state.recentOrders.slice(-50);
      this.persistState();
      this.logger.info("dry-run order", {
        tokenId: signal.tokenId,
        side: signal.action,
        price: signal.price,
        size: signal.size,
        reason: signal.reason,
      });
      return;
    }

    const response = await this.clobService.createAndPostOrder({
      tokenId: signal.tokenId,
      price: signal.price,
      size: signal.size,
      side: signal.action,
      tickSize,
      negRisk: market.negRisk,
    });

    this.reservePosition(signal.tokenId, signal.size);
    this.state.stats.liveOrders += 1;
    this.state.recentOrders.push({
      createdAt: new Date().toISOString(),
      mode: "live",
      tokenId: signal.tokenId,
      side: signal.action,
      price: signal.price,
      size: signal.size,
      reason: signal.reason,
    });
    this.state.recentOrders = this.state.recentOrders.slice(-50);
    this.persistState();

    this.logger.info("live order submitted", {
      tokenId: signal.tokenId,
      side: signal.action,
      price: signal.price,
      size: signal.size,
      response,
    });
  }

  private async checkGeoblock(): Promise<void> {
    if (!this.config.enableGeoblockCheck) {
      return;
    }

    const status = await this.geoblockClient.check();
    this.state.geoblock = {
      checkedAt: new Date().toISOString(),
      blocked: status.blocked,
      country: status.country,
      region: status.region,
      ip: status.ip,
    };
    this.persistState();

    if (!status.blocked) {
      return;
    }

    const reason = `Geoblock prevented trading for ${status.country}-${status.region}`;
    if (this.config.dryRun) {
      this.logger.warn(reason, {
        blocked: status.blocked,
        country: status.country,
        region: status.region,
        ip: status.ip,
      });
      return;
    }

    throw new Error(reason);
  }

  private restoreReservedPositions(): void {
    for (const [tokenId, size] of Object.entries(this.state.reservedPositionByToken)) {
      this.reservedPositionByToken.set(tokenId, size);
    }
  }

  private persistState(): void {
    this.state.reservedPositionByToken = Object.fromEntries(this.reservedPositionByToken.entries());
    this.stateStore.save(this.state);
  }

  private async getMarketPrices(tokenId: string): Promise<{
    bestBid: number | null;
    bestAsk: number | null;
    tickSize: TickSize;
    source: "polling" | "websocket";
  }> {
    if (this.marketFeed) {
      try {
        await this.marketFeed.subscribe(tokenId);
        const latest = this.marketFeed.getLatest(tokenId);
        if (latest) {
          return {
            bestBid: latest.bestBid,
            bestAsk: latest.bestAsk,
            tickSize: latest.tickSize ?? (await this.clobService.getTickSize(tokenId)),
            source: "websocket",
          };
        }
      } catch (error) {
        this.logger.warn("market websocket unavailable; falling back to REST orderbook", {
          tokenId,
          error: toErrorMessage(error),
        });
      }
    }

    const book = await this.clobService.getOrderBook(tokenId);
    return {
      bestBid: toPrice(book.bids[0]?.price),
      bestAsk: toPrice(book.asks[0]?.price),
      tickSize: book.tick_size ?? (await this.clobService.getTickSize(tokenId)),
      source: "polling",
    };
  }

  private async getCurrentPositionSize(tokenId: string): Promise<number> {
    const reserved = this.reservedPositionByToken.get(tokenId) ?? 0;

    if (!this.config.portfolioAddress) {
      return reserved;
    }

    try {
      const positions = await this.dataClient.getPositions(this.config.portfolioAddress);
      const remote = positions
        .filter((position) => matchesToken(position, tokenId))
        .reduce((sum, position) => sum + Number(position.size ?? 0), 0);

      return remote + reserved;
    } catch (error) {
      this.logger.warn("failed to load remote positions; using reserved exposure only", {
        tokenId,
        error: toErrorMessage(error),
      });
      return reserved;
    }
  }

  private reservePosition(tokenId: string, size: number): void {
    const current = this.reservedPositionByToken.get(tokenId) ?? 0;
    this.reservedPositionByToken.set(tokenId, current + size);
    this.persistState();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPrice(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function midpointFromBook(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid === null || bestAsk === null) {
    return null;
  }

  return (bestBid + bestAsk) / 2;
}

function matchesToken(position: Record<string, unknown>, tokenId: string): boolean {
  return (
    position.tokenId === tokenId ||
    position.asset === tokenId ||
    position.asset_id === tokenId
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
