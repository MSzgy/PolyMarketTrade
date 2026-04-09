import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Logger } from "../lib/logger.js";

export interface UserWebSocketSubscription {
  auth: ApiKeyCreds;
  markets: string[];
}

export interface UserOrderEvent {
  eventType: "order";
  statusType: string;
  orderId: string;
  market?: string;
  assetId?: string;
  outcome?: string;
  side?: "BUY" | "SELL";
  price: number | null;
  originalSize: number | null;
  sizeMatched: number | null;
  timestamp: string;
}

export interface UserTradeEvent {
  eventType: "trade";
  statusType: string;
  tradeId: string;
  orderId?: string;
  market?: string;
  assetId?: string;
  outcome?: string;
  side?: "BUY" | "SELL";
  price: number | null;
  size: number | null;
  timestamp: string;
}

export type UserChannelEvent = UserOrderEvent | UserTradeEvent;

interface UserSubscriptionMessage {
  auth: {
    apiKey: string;
    secret: string;
    passphrase: string;
  };
  markets: string[];
  type: "user";
}

type UserSocketMessage = Record<string, unknown>;

export class UserWebSocketFeed {
  private socket?: WebSocket;
  private activeMarkets: string[] = [];
  private readyPromise?: Promise<void>;
  private readyResolver?: () => void;
  private intentionalClose = false;
  private readonly recentEvents: UserChannelEvent[] = [];

  constructor(
    private readonly url: string,
    private readonly readyTimeoutMs: number,
    private readonly logger: Logger,
    private readonly onEvent?: (event: UserChannelEvent) => void,
  ) {}

  async connect(subscription: UserWebSocketSubscription): Promise<void> {
    const markets = uniqueMarkets(subscription.markets);
    if (markets.length === 0) {
      throw new Error("User websocket subscription requires at least one market id");
    }

    if (
      sameMarkets(markets, this.activeMarkets) &&
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      await this.readyPromise;
      return;
    }

    this.close();
    this.activeMarkets = markets;
    this.intentionalClose = false;
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolver = resolve;
    });

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      const payload: UserSubscriptionMessage = {
        auth: {
          apiKey: subscription.auth.key,
          secret: subscription.auth.secret,
          passphrase: subscription.auth.passphrase,
        },
        markets,
        type: "user",
      };
      socket.send(JSON.stringify(payload));
      this.readyResolver?.();
      this.readyResolver = undefined;
    });

    socket.addEventListener("message", (event) => {
      this.onMessage(event.data);
    });

    socket.addEventListener("error", () => {
      this.logger.warn("user websocket emitted an error", { markets });
    });

    socket.addEventListener("close", (event) => {
      if (this.intentionalClose) {
        return;
      }

      this.logger.warn("user websocket closed", {
        code: event.code,
        reason: event.reason,
        markets,
      });
    });

    try {
      await Promise.race([
        this.readyPromise,
        timeout(this.readyTimeoutMs, "Timed out waiting for user websocket connection"),
      ]);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  getRecentEvents(limit = 20): UserChannelEvent[] {
    return this.recentEvents.slice(-limit);
  }

  close(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      this.intentionalClose = true;
      this.socket.close();
    }

    this.socket = undefined;
    this.activeMarkets = [];
    this.readyResolver = undefined;
    this.readyPromise = undefined;
  }

  private onMessage(data: unknown): void {
    const text = toText(data);
    if (!text) {
      return;
    }

    const parsed = JSON.parse(text) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      this.applyMessage(message as UserSocketMessage);
    }
  }

  private applyMessage(message: UserSocketMessage): void {
    const event = normalizeUserChannelEvent(message);
    if (!event) {
      return;
    }

    this.recentEvents.push(event);
    if (this.recentEvents.length > 100) {
      this.recentEvents.splice(0, this.recentEvents.length - 100);
    }
    this.onEvent?.(event);
  }
}

function normalizeUserChannelEvent(message: UserSocketMessage): UserChannelEvent | undefined {
  const eventType = asString(message.event_type);
  if (eventType === "order") {
    const orderId = asString(message.id);
    if (!orderId) {
      return undefined;
    }

    return {
      eventType,
      statusType: asString(message.type) ?? "UNKNOWN",
      orderId,
      market: asString(message.market),
      assetId: asString(message.asset_id),
      outcome: asString(message.outcome),
      side: asSide(message.side),
      price: asNumber(message.price),
      originalSize: asNumber(message.original_size),
      sizeMatched: asNumber(message.size_matched),
      timestamp: toIsoTimestamp(message.timestamp),
    };
  }

  if (eventType === "trade") {
    const tradeId = asString(message.id);
    if (!tradeId) {
      return undefined;
    }

    return {
      eventType,
      statusType: asString(message.status) ?? asString(message.type) ?? "UNKNOWN",
      tradeId,
      orderId: asString(message.taker_order_id),
      market: asString(message.market),
      assetId: asString(message.asset_id),
      outcome: asString(message.outcome),
      side: asSide(message.side),
      price: asNumber(message.price),
      size: asNumber(message.size),
      timestamp: toIsoTimestamp(message.timestamp ?? message.last_update ?? message.matchtime),
    };
  }

  return undefined;
}

function uniqueMarkets(markets: string[]): string[] {
  return Array.from(
    new Set(
      markets
        .map((market) => market.trim())
        .filter((market) => market !== ""),
    ),
  );
}

function sameMarkets(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((market, index) => market === right[index]);
}

function toText(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }

  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function asNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asSide(value: unknown): "BUY" | "SELL" | undefined {
  if (value === "BUY" || value === "SELL") {
    return value;
  }

  return undefined;
}

function toIsoTimestamp(value: unknown): string {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    const epochMs = parsed > 1_000_000_000_000 ? parsed : parsed * 1_000;
    return new Date(epochMs).toISOString();
  }

  return new Date().toISOString();
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
