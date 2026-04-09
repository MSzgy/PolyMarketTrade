import type { OpenOrder, TickSize } from "@polymarket/clob-client";
import type { AppConfig } from "../config.js";
import { Logger } from "../lib/logger.js";
import { ClobService } from "../polymarket/clob-service.js";
import type { NormalizedMarket } from "../polymarket/types.js";
import {
  UserWebSocketFeed,
  type UserChannelEvent,
} from "../polymarket/user-websocket.js";

export interface OrderManagerHooks {
  onHeartbeat?: (heartbeat: OrderHeartbeatState) => void;
  onUserEvent?: (event: UserChannelEvent) => void;
}

export interface OrderHeartbeatState {
  updatedAt: string;
  heartbeatId?: string;
  error?: string;
}

export interface SubmitOrderRequest {
  market: NormalizedMarket;
  tokenId: string;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  tickSize: TickSize;
  negRisk: boolean;
  reason: string;
}

export interface OrderExecutionResult {
  createdAt: string;
  mode: "dry-run" | "live";
  tokenId: string;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  reason: string;
  status?: string;
  orderId?: string;
  response?: unknown;
  userStreamConnected: boolean;
}

export class OrderManager {
  private readonly userFeed?: UserWebSocketFeed;
  private heartbeatId: string | null = null;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatInFlight?: Promise<void>;
  private subscribedMarketId?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly clobService: ClobService,
    private readonly logger: Logger,
    private readonly hooks: OrderManagerHooks = {},
  ) {
    this.userFeed = config.dryRun
      ? undefined
      : new UserWebSocketFeed(
          config.userWsUrl,
          config.marketWsReadyTimeoutMs,
          logger,
          (event) => {
          this.hooks.onUserEvent?.(event);
          },
        );
  }

  async submit(request: SubmitOrderRequest): Promise<OrderExecutionResult> {
    const createdAt = new Date().toISOString();

    if (this.config.dryRun) {
      return {
        createdAt,
        mode: "dry-run",
        tokenId: request.tokenId,
        price: request.price,
        size: request.size,
        side: request.side,
        reason: request.reason,
        userStreamConnected: false,
      };
    }

    const userStreamConnected = await this.ensureUserFeedSubscribed(request.market);
    const response = await this.clobService.createAndPostOrder({
      tokenId: request.tokenId,
      price: request.price,
      size: request.size,
      side: request.side,
      tickSize: request.tickSize,
      negRisk: request.negRisk,
    });

    this.startHeartbeatLoop();
    await this.postHeartbeat();

    return {
      createdAt,
      mode: "live",
      tokenId: request.tokenId,
      price: request.price,
      size: request.size,
      side: request.side,
      reason: request.reason,
      orderId: pickString(response, "orderID"),
      status: pickString(response, "status"),
      response,
      userStreamConnected,
    };
  }

  async reconcileOpenOrders(params: {
    market: NormalizedMarket;
    tokenId: string;
  }): Promise<OpenOrder[]> {
    if (this.config.dryRun) {
      return [];
    }

    await this.ensureUserFeedSubscribed(params.market);
    const marketId = resolveMarketId(params.market);
    const orders = await this.clobService.getOpenOrders({
      market: marketId,
      assetId: params.tokenId,
    });

    if (orders.length === 0) {
      this.stopHeartbeatLoop();
      return orders;
    }

    this.startHeartbeatLoop();
    return orders;
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    if (this.config.dryRun) {
      return undefined;
    }

    return this.clobService.cancelOrder(orderId);
  }

  async cancelAll(): Promise<unknown> {
    if (this.config.dryRun) {
      return undefined;
    }

    const response = await this.clobService.cancelAll();
    this.stopHeartbeatLoop();
    return response;
  }

  close(): void {
    this.stopHeartbeatLoop();
    this.userFeed?.close();
  }

  private async ensureUserFeedSubscribed(market: NormalizedMarket): Promise<boolean> {
    const marketId = resolveMarketId(market);
    const creds = this.clobService.getApiCreds();
    if (!this.userFeed || !marketId || !creds) {
      return false;
    }

    if (
      this.subscribedMarketId === marketId &&
      this.userFeed.isOpen()
    ) {
      return true;
    }

    await this.userFeed.connect({
      auth: creds,
      markets: [marketId],
    });
    this.subscribedMarketId = marketId;
    return true;
  }

  private startHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      return;
    }

    // Once heartbeats begin, Polymarket expects another heartbeat within 10s.
    const intervalMs = Math.min(this.config.heartbeatIntervalMs, 9_000);
    this.heartbeatTimer = setInterval(() => {
      void this.postHeartbeat();
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async postHeartbeat(): Promise<void> {
    if (this.config.dryRun) {
      return;
    }

    if (this.heartbeatInFlight) {
      await this.heartbeatInFlight;
      return;
    }

    const run = (async () => {
      try {
        const response = await this.clobService.postHeartbeat(this.heartbeatId);
        this.heartbeatId = response.heartbeat_id ?? this.heartbeatId;
        this.hooks.onHeartbeat?.({
          updatedAt: new Date().toISOString(),
          heartbeatId: this.heartbeatId ?? undefined,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        this.logger.warn("order heartbeat failed", { error: message });
        this.hooks.onHeartbeat?.({
          updatedAt: new Date().toISOString(),
          heartbeatId: this.heartbeatId ?? undefined,
          error: message,
        });
      } finally {
        this.heartbeatInFlight = undefined;
      }
    })();

    this.heartbeatInFlight = run;
    await run;
  }
}

function resolveMarketId(market: NormalizedMarket): string | undefined {
  return market.conditionId ?? market.id;
}

function pickString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
