import { GammaClient } from "../polymarket/gamma-client.js";
import { ClobService } from "../polymarket/clob-service.js";
import type { NormalizedMarket } from "../polymarket/types.js";

export interface StandardBinaryScannerOptions {
  marketScanLimit?: number;
  opportunityLimit?: number;
  minEdgeBps?: number;
}

export interface StandardBinaryOpportunity {
  kind: "buy_complete_set" | "sell_complete_set";
  marketId?: string;
  marketSlug: string;
  marketQuestion: string;
  endDate?: string;
  negRisk: boolean;
  maxExecutableSets: number;
  grossCostPerSet?: number;
  netProceedsPerSet?: number;
  estimatedEdgePerSet: number;
  estimatedEdgeBps: number;
  legs: {
    yes: OpportunityLeg;
    no: OpportunityLeg;
  };
}

export interface OpportunityLeg {
  tokenId: string;
  ask: number | null;
  askSize: number | null;
  bid: number | null;
  bidSize: number | null;
  feeRateBps: number;
  estimatedBuyFeePerShare: number | null;
  estimatedSellFeePerShare: number | null;
}

export interface StandardBinaryScanResult {
  fetchedAt: string;
  scannedMarketCount: number;
  candidateMarketCount: number;
  opportunities: StandardBinaryOpportunity[];
}

export class StandardBinaryScanner {
  constructor(
    private readonly gammaClient: GammaClient,
    private readonly clobService: ClobService,
  ) {}

  async scan(
    options: StandardBinaryScannerOptions = {},
  ): Promise<StandardBinaryScanResult> {
    const marketScanLimit = clampInteger(options.marketScanLimit, 1, 40, 12);
    const opportunityLimit = clampInteger(options.opportunityLimit, 1, 20, 8);
    const minEdgeBps = options.minEdgeBps ?? 0;

    const markets = await this.gammaClient.listMarkets({
      active: true,
      closed: false,
      archived: false,
      limit: marketScanLimit,
    });

    const candidates = markets
      .filter((market) => market.enableOrderBook)
      .filter(isStandardBinaryMarket)
      .sort(compareMarkets);

    const scanned = await Promise.allSettled(
      candidates.map(async (market) => this.scanMarket(market)),
    );

    const opportunities = scanned
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter((opportunity) => opportunity.estimatedEdgeBps >= minEdgeBps)
      .sort(compareOpportunities)
      .slice(0, opportunityLimit);

    return {
      fetchedAt: new Date().toISOString(),
      scannedMarketCount: markets.length,
      candidateMarketCount: candidates.length,
      opportunities,
    };
  }

  private async scanMarket(
    market: NormalizedMarket,
  ): Promise<StandardBinaryOpportunity[]> {
    const yes = market.outcomes.find((outcome) => outcome.name.toLowerCase() === "yes");
    const no = market.outcomes.find((outcome) => outcome.name.toLowerCase() === "no");
    if (!yes?.tokenId || !no?.tokenId) {
      return [];
    }

    const [yesBook, noBook, yesFeeRateBps, noFeeRateBps] = await Promise.all([
      this.clobService.getOrderBook(yes.tokenId),
      this.clobService.getOrderBook(no.tokenId),
      this.clobService.getFeeRateBps(yes.tokenId),
      this.clobService.getFeeRateBps(no.tokenId),
    ]);

    const yesLeg: OpportunityLeg = {
      tokenId: yes.tokenId,
      ask: toNumber(yesBook.asks[0]?.price),
      askSize: toNumber(yesBook.asks[0]?.size),
      bid: toNumber(yesBook.bids[0]?.price),
      bidSize: toNumber(yesBook.bids[0]?.size),
      feeRateBps: yesFeeRateBps,
      estimatedBuyFeePerShare: estimateTakerFeePerShare(toNumber(yesBook.asks[0]?.price), yesFeeRateBps),
      estimatedSellFeePerShare: estimateTakerFeePerShare(toNumber(yesBook.bids[0]?.price), yesFeeRateBps),
    };
    const noLeg: OpportunityLeg = {
      tokenId: no.tokenId,
      ask: toNumber(noBook.asks[0]?.price),
      askSize: toNumber(noBook.asks[0]?.size),
      bid: toNumber(noBook.bids[0]?.price),
      bidSize: toNumber(noBook.bids[0]?.size),
      feeRateBps: noFeeRateBps,
      estimatedBuyFeePerShare: estimateTakerFeePerShare(toNumber(noBook.asks[0]?.price), noFeeRateBps),
      estimatedSellFeePerShare: estimateTakerFeePerShare(toNumber(noBook.bids[0]?.price), noFeeRateBps),
    };

    const opportunities: StandardBinaryOpportunity[] = [];

    const buySet = buildBuyCompleteSetOpportunity(market, yesLeg, noLeg);
    if (buySet) {
      opportunities.push(buySet);
    }

    const sellSet = buildSellCompleteSetOpportunity(market, yesLeg, noLeg);
    if (sellSet) {
      opportunities.push(sellSet);
    }

    return opportunities;
  }
}

function isStandardBinaryMarket(market: NormalizedMarket): boolean {
  if (market.negRisk) {
    return false;
  }

  if (market.outcomes.length !== 2) {
    return false;
  }

  const names = new Set(market.outcomes.map((outcome) => outcome.name.trim().toLowerCase()));
  return names.has("yes") && names.has("no");
}

function buildBuyCompleteSetOpportunity(
  market: NormalizedMarket,
  yes: OpportunityLeg,
  no: OpportunityLeg,
): StandardBinaryOpportunity | undefined {
  if (yes.ask === null || no.ask === null || yes.askSize === null || no.askSize === null) {
    return undefined;
  }

  const yesNetFactor = buyNetShareFactor(yes.ask, yes.feeRateBps);
  const noNetFactor = buyNetShareFactor(no.ask, no.feeRateBps);
  if (yesNetFactor <= 0 || noNetFactor <= 0) {
    return undefined;
  }

  const yesCostPerSet = yes.ask / yesNetFactor;
  const noCostPerSet = no.ask / noNetFactor;
  const grossCostPerSet = yesCostPerSet + noCostPerSet;
  const estimatedEdgePerSet = 1 - grossCostPerSet;
  const maxExecutableSets = Math.min(yes.askSize * yesNetFactor, no.askSize * noNetFactor);
  if (!Number.isFinite(maxExecutableSets) || maxExecutableSets <= 0) {
    return undefined;
  }

  return {
    kind: "buy_complete_set",
    marketId: market.id,
    marketSlug: market.slug,
    marketQuestion: market.question,
    endDate: market.endDate,
    negRisk: market.negRisk,
    maxExecutableSets,
    grossCostPerSet,
    estimatedEdgePerSet,
    estimatedEdgeBps: estimatedEdgePerSet * 10_000,
    legs: {
      yes,
      no,
    },
  };
}

function buildSellCompleteSetOpportunity(
  market: NormalizedMarket,
  yes: OpportunityLeg,
  no: OpportunityLeg,
): StandardBinaryOpportunity | undefined {
  if (yes.bid === null || no.bid === null || yes.bidSize === null || no.bidSize === null) {
    return undefined;
  }

  const yesNetProceeds = yes.bid - (yes.estimatedSellFeePerShare ?? 0);
  const noNetProceeds = no.bid - (no.estimatedSellFeePerShare ?? 0);
  const netProceedsPerSet = yesNetProceeds + noNetProceeds;
  const estimatedEdgePerSet = netProceedsPerSet - 1;
  const maxExecutableSets = Math.min(yes.bidSize, no.bidSize);
  if (!Number.isFinite(maxExecutableSets) || maxExecutableSets <= 0) {
    return undefined;
  }

  return {
    kind: "sell_complete_set",
    marketId: market.id,
    marketSlug: market.slug,
    marketQuestion: market.question,
    endDate: market.endDate,
    negRisk: market.negRisk,
    maxExecutableSets,
    netProceedsPerSet,
    estimatedEdgePerSet,
    estimatedEdgeBps: estimatedEdgePerSet * 10_000,
    legs: {
      yes,
      no,
    },
  };
}

function estimateTakerFeePerShare(price: number | null, feeRateBps: number): number | null {
  if (price === null) {
    return null;
  }

  const feeRate = feeRateBps / 10_000;
  return roundFeeEquivalent(feeRate * price * (1 - price));
}

function buyNetShareFactor(price: number, feeRateBps: number): number {
  const feeRate = feeRateBps / 10_000;
  return 1 - feeRate * (1 - price);
}

function roundFeeEquivalent(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

function compareMarkets(left: NormalizedMarket, right: NormalizedMarket): number {
  return (
    (right.volume ?? 0) - (left.volume ?? 0) ||
    (right.liquidity ?? 0) - (left.liquidity ?? 0) ||
    left.question.localeCompare(right.question)
  );
}

function compareOpportunities(
  left: StandardBinaryOpportunity,
  right: StandardBinaryOpportunity,
): number {
  return (
    right.estimatedEdgePerSet - left.estimatedEdgePerSet ||
    right.maxExecutableSets - left.maxExecutableSets ||
    left.marketQuestion.localeCompare(right.marketQuestion)
  );
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isInteger(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Number(value)));
}

function toNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
