import type { MarketSnapshot, Strategy, TradeSignal } from "../engine/strategy.js";

interface PriceThresholdStrategyConfig {
  buyBelowPrice: number;
  orderSize: number;
}

export class PriceThresholdStrategy implements Strategy {
  readonly name = "price-threshold";

  constructor(private readonly config: PriceThresholdStrategyConfig) {}

  async evaluate(snapshot: MarketSnapshot): Promise<TradeSignal> {
    const referencePrice =
      snapshot.bestAsk ?? snapshot.midpoint ?? snapshot.selectedOutcome.price;

    if (referencePrice === null) {
      return {
        action: "HOLD",
        reason: "No usable price source found for the selected outcome",
      };
    }

    if (referencePrice <= this.config.buyBelowPrice) {
      return {
        action: "BUY",
        reason: `Best executable price ${referencePrice.toFixed(4)} is below threshold ${this.config.buyBelowPrice.toFixed(4)}`,
        tokenId: snapshot.selectedOutcome.tokenId,
        price: referencePrice,
        size: this.config.orderSize,
      };
    }

    return {
      action: "HOLD",
      reason: `Reference price ${referencePrice.toFixed(4)} is above threshold ${this.config.buyBelowPrice.toFixed(4)}`,
    };
  }
}
