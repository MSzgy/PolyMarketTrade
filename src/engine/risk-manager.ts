import type { TradeSignal } from "./strategy.js";

export interface RiskConfig {
  maxPositionSize: number;
  maxNotionalPerOrder: number;
}

export interface RiskDecision {
  allowed: boolean;
  reason: string;
}

export class RiskManager {
  constructor(private readonly config: RiskConfig) {}

  evaluate(signal: TradeSignal, currentPositionSize: number): RiskDecision {
    if (signal.action === "HOLD") {
      return { allowed: false, reason: signal.reason };
    }

    if (!signal.tokenId || !signal.price || !signal.size) {
      return { allowed: false, reason: "Signal is missing token, price, or size" };
    }

    if (signal.size <= 0) {
      return { allowed: false, reason: "Order size must be positive" };
    }

    if (signal.price <= 0 || signal.price >= 1) {
      return { allowed: false, reason: "Order price must be within (0, 1)" };
    }

    if (currentPositionSize + signal.size > this.config.maxPositionSize) {
      return {
        allowed: false,
        reason: "Order would exceed MAX_POSITION_SIZE",
      };
    }

    const notional = signal.price * signal.size;
    if (notional > this.config.maxNotionalPerOrder) {
      return {
        allowed: false,
        reason: "Order would exceed MAX_NOTIONAL_PER_ORDER",
      };
    }

    return { allowed: true, reason: "Approved" };
  }
}
