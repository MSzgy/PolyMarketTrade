import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TradeSignal } from "../engine/strategy.js";

export interface BotState {
  version: number;
  marketSlug: string;
  outcome: string;
  reservedPositionByToken: Record<string, number>;
  stats: {
    ticks: number;
    dryRunOrders: number;
    liveOrders: number;
    skippedSignals: number;
  };
  geoblock?: {
    checkedAt: string;
    blocked: boolean;
    country: string;
    region: string;
    ip: string;
  };
  lastSnapshot?: {
    updatedAt: string;
    tokenId: string;
    bestBid: number | null;
    bestAsk: number | null;
    midpoint: number | null;
    currentPositionSize: number;
    source: "polling" | "websocket";
  };
  lastSignal?: {
    updatedAt: string;
    action: TradeSignal["action"];
    reason: string;
    tokenId?: string;
    price?: number;
    size?: number;
  };
  recentOrders: Array<{
    createdAt: string;
    mode: "dry-run" | "live";
    tokenId: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    reason: string;
  }>;
}

export class StateStore {
  constructor(
    private readonly path: string,
    private readonly marketSlug: string,
    private readonly outcome: string,
  ) {}

  load(): BotState {
    const defaults = this.createDefaultState();
    if (!existsSync(this.path)) {
      return defaults;
    }

    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BotState>;
      return {
        ...defaults,
        ...raw,
        marketSlug: this.marketSlug,
        outcome: this.outcome,
        reservedPositionByToken: {
          ...defaults.reservedPositionByToken,
          ...(raw.reservedPositionByToken ?? {}),
        },
        stats: {
          ...defaults.stats,
          ...(raw.stats ?? {}),
        },
        recentOrders: Array.isArray(raw.recentOrders) ? raw.recentOrders.slice(-50) : [],
      };
    } catch {
      return defaults;
    }
  }

  save(state: BotState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private createDefaultState(): BotState {
    return {
      version: 1,
      marketSlug: this.marketSlug,
      outcome: this.outcome,
      reservedPositionByToken: {},
      stats: {
        ticks: 0,
        dryRunOrders: 0,
        liveOrders: 0,
        skippedSignals: 0,
      },
      recentOrders: [],
    };
  }
}
