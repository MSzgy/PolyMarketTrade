import type { MarketOutcome, NormalizedMarket } from "../polymarket/types.js";

export interface MarketSnapshot {
  market: NormalizedMarket;
  selectedOutcome: MarketOutcome;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  currentPositionSize: number;
}

export interface TradeSignal {
  action: "BUY" | "SELL" | "HOLD";
  reason: string;
  tokenId?: string;
  price?: number;
  size?: number;
}

export interface Strategy {
  readonly name: string;
  evaluate(snapshot: MarketSnapshot): Promise<TradeSignal>;
}
