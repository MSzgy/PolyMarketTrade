import type { OpenOrder, TickSize } from "@polymarket/clob-client";
import type { AppConfig } from "./config.js";
import {
  OrderManager,
  type OrderExecutionResult,
} from "./execution/order-manager.js";
import { RiskManager } from "./engine/risk-manager.js";
import type { MarketSnapshot, Strategy } from "./engine/strategy.js";
import { Logger } from "./lib/logger.js";
import { StateStore, type BotState } from "./lib/state-store.js";
import { ClobService } from "./polymarket/clob-service.js";
import { DataClient } from "./polymarket/data-client.js";
import { GammaClient } from "./polymarket/gamma-client.js";
import { GeoblockClient } from "./polymarket/geoblock-client.js";
import { MarketWebSocketFeed } from "./polymarket/market-websocket.js";
import type { NormalizedMarket } from "./polymarket/types.js";
import type { UserChannelEvent } from "./polymarket/user-websocket.js";

export class TradingRunner {
  private readonly gammaClient: GammaClient;
  private readonly dataClient: DataClient;
  private readonly riskManager: RiskManager;
  private readonly geoblockClient: GeoblockClient;
  private readonly stateStore: StateStore;
  private readonly marketFeed?: MarketWebSocketFeed;
  private readonly orderManager: OrderManager;
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
    this.orderManager = new OrderManager(config, clobService, logger, {
      onHeartbeat: (heartbeat) => {
        this.state.heartbeat = heartbeat;
        this.persistState();
      },
      onUserEvent: (event) => {
        this.state.lastOrderEvent = toStateOrderEvent(event);
        this.persistState();
      },
    });
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
      this.orderManager.close();
      this.persistState();
    }
  }

  stop(): void {
    this.stopped = true;
    this.marketFeed?.close();
    this.orderManager.close();
  }

  private async tick(): Promise<void> {
    const { market, selectedOutcome } = await this.gammaClient.resolveMarketOutcome(
      this.config.marketSlug,
      this.config.outcome,
    );

    if (!market.enableOrderBook) {
      throw new Error(`Market ${market.slug} does not have enableOrderBook=true`);
    }

    await this.syncOpenOrders(market, selectedOutcome.tokenId);

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

    if (!signal.tokenId || !signal.price || !signal.size || signal.action === "HOLD") {
      throw new Error("Approved signal is missing token, price, or size");
    }

    const execution = await this.orderManager.submit({
      market,
      tokenId: signal.tokenId,
      price: signal.price,
      size: signal.size,
      side: signal.action,
      tickSize,
      negRisk: market.negRisk,
      reason: signal.reason,
    });

    this.recordExecution(execution, market, selectedOutcome.name);
    await this.syncOpenOrders(market, selectedOutcome.tokenId);
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

  private recordExecution(
    execution: OrderExecutionResult,
    market: NormalizedMarket,
    outcomeName: string,
  ): void {
    if (execution.mode === "dry-run") {
      this.state.stats.dryRunOrders += 1;
    } else {
      this.state.stats.liveOrders += 1;
      this.reservePosition(execution.tokenId, execution.size);
    }

    this.state.recentOrders.push({
      createdAt: execution.createdAt,
      mode: execution.mode,
      tokenId: execution.tokenId,
      marketSlug: market.slug,
      marketQuestion: market.question,
      outcomeName,
      side: execution.side,
      price: execution.price,
      size: execution.size,
      reason: execution.reason,
      orderId: execution.orderId,
      status: execution.status,
    });
    this.state.recentOrders = this.state.recentOrders.slice(-50);
    this.persistState();

    const logContext = {
      tokenId: execution.tokenId,
      side: execution.side,
      price: execution.price,
      size: execution.size,
      reason: execution.reason,
      orderId: execution.orderId,
      status: execution.status,
      userStreamConnected: execution.userStreamConnected,
      response: execution.response,
    };

    if (execution.mode === "dry-run") {
      this.logger.info("dry-run order", logContext);
      return;
    }

    this.logger.info("live order submitted", logContext);
  }

  private async syncOpenOrders(market: NormalizedMarket, tokenId: string): Promise<void> {
    if (this.config.dryRun) {
      this.state.openOrders = [];
      this.persistState();
      return;
    }

    try {
      const orders = await this.orderManager.reconcileOpenOrders({ market, tokenId });
      this.state.openOrders = orders.map(toStateOpenOrder).slice(-50);
      this.replaceReservedPosition(tokenId, reservedBuySize(orders));
      this.persistState();
    } catch (error) {
      this.logger.warn("failed to reconcile open orders", {
        tokenId,
        error: toErrorMessage(error),
      });
    }
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

  private replaceReservedPosition(tokenId: string, size: number): void {
    if (size <= 0) {
      this.reservedPositionByToken.delete(tokenId);
      return;
    }

    this.reservedPositionByToken.set(tokenId, size);
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

function reservedBuySize(orders: OpenOrder[]): number {
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

function toStateOpenOrder(order: OpenOrder): BotState["openOrders"][number] {
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
