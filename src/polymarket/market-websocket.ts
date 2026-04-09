import type { TickSize } from "@polymarket/clob-client";
import { Logger } from "../lib/logger.js";

export interface MarketSocketSnapshot {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  tickSize?: TickSize;
  source: "websocket";
  market?: string;
  updatedAt: string;
}

interface SubscriptionMessage {
  assets_ids: string[];
  type: "market";
  custom_feature_enabled: boolean;
}

interface BookMessage {
  event_type: "book";
  asset_id: string;
  market?: string;
  bids?: Array<{ price?: string }>;
  asks?: Array<{ price?: string }>;
  timestamp?: string;
}

interface BestBidAskMessage {
  event_type: "best_bid_ask";
  asset_id: string;
  market?: string;
  best_bid?: string;
  best_ask?: string;
  timestamp?: string;
}

interface TickSizeChangeMessage {
  event_type: "tick_size_change";
  asset_id: string;
  new_tick_size?: TickSize;
  timestamp?: string;
}

type MarketMessage =
  | BookMessage
  | BestBidAskMessage
  | TickSizeChangeMessage
  | Record<string, unknown>;

export class MarketWebSocketFeed {
  private socket?: WebSocket;
  private activeTokenId?: string;
  private latest?: MarketSocketSnapshot;
  private readyResolver?: () => void;
  private readyPromise?: Promise<void>;
  private intentionalClose = false;

  constructor(
    private readonly url: string,
    private readonly readyTimeoutMs: number,
    private readonly logger: Logger,
  ) {}

  async subscribe(tokenId: string): Promise<void> {
    if (this.activeTokenId === tokenId && this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    this.close();
    this.activeTokenId = tokenId;
    this.intentionalClose = false;
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolver = resolve;
    });

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      const payload: SubscriptionMessage = {
        assets_ids: [tokenId],
        type: "market",
        custom_feature_enabled: true,
      };
      socket.send(JSON.stringify(payload));
    });

    socket.addEventListener("message", (event) => {
      this.onMessage(event.data);
    });

    socket.addEventListener("error", () => {
      this.logger.warn("market websocket emitted an error", { tokenId });
    });

    socket.addEventListener("close", (event) => {
      if (this.intentionalClose) {
        return;
      }

      this.logger.warn("market websocket closed", {
        tokenId,
        code: event.code,
        reason: event.reason,
      });
    });

    await Promise.race([
      this.readyPromise,
      timeout(this.readyTimeoutMs, "Timed out waiting for market websocket snapshot"),
    ]);
  }

  getLatest(tokenId: string): MarketSocketSnapshot | undefined {
    if (this.latest?.tokenId !== tokenId) {
      return undefined;
    }

    return this.latest;
  }

  close(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      this.intentionalClose = true;
      this.socket.close();
    }

    this.socket = undefined;
    this.activeTokenId = undefined;
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
      this.applyMessage(message as MarketMessage);
    }
  }

  private applyMessage(message: MarketMessage): void {
    const eventType = typeof message.event_type === "string" ? message.event_type : undefined;
    if (!eventType || typeof message.asset_id !== "string") {
      return;
    }

    if (!this.latest || this.latest.tokenId !== message.asset_id) {
      this.latest = {
        tokenId: message.asset_id,
        bestBid: null,
        bestAsk: null,
        source: "websocket",
        updatedAt: new Date().toISOString(),
      };
    }

    const snapshot = this.latest;
    snapshot.updatedAt = timestampToIso(
      typeof message.timestamp === "string" ? message.timestamp : undefined,
    );

    if (eventType === "book") {
      const book = message as BookMessage;
      snapshot.market = typeof book.market === "string" ? book.market : snapshot.market;
      snapshot.bestBid = toNumber(book.bids?.[0]?.price);
      snapshot.bestAsk = toNumber(book.asks?.[0]?.price);
      this.readyResolver?.();
      this.readyResolver = undefined;
      return;
    }

    if (eventType === "best_bid_ask") {
      const bestBidAsk = message as BestBidAskMessage;
      snapshot.market =
        typeof bestBidAsk.market === "string" ? bestBidAsk.market : snapshot.market;
      snapshot.bestBid = toNumber(bestBidAsk.best_bid);
      snapshot.bestAsk = toNumber(bestBidAsk.best_ask);
      this.readyResolver?.();
      this.readyResolver = undefined;
      return;
    }

    if (eventType === "tick_size_change") {
      snapshot.tickSize = (message as TickSizeChangeMessage).new_tick_size;
    }
  }
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function toText(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  return undefined;
}

function toNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampToIso(timestamp: string | undefined): string {
  const parsed = Number(timestamp);
  if (Number.isFinite(parsed) && parsed > 0) {
    return new Date(parsed).toISOString();
  }

  return new Date().toISOString();
}
