import { getJson } from "../lib/http.js";
import {
  type GammaMarketRaw,
  type MarketOutcome,
  type NormalizedMarket,
  findOutcome,
  normalizeGammaMarket,
} from "./types.js";

export interface ResolvedMarketSelection {
  market: NormalizedMarket;
  selectedOutcome: MarketOutcome;
}

export class GammaClient {
  constructor(private readonly baseUrl: string) {}

  async listMarkets(
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<NormalizedMarket[]> {
    const response = await getJson<GammaMarketRaw[]>(this.baseUrl, "/markets", params);
    return response.map(normalizeGammaMarket);
  }

  async getMarketBySlug(slug: string): Promise<NormalizedMarket | undefined> {
    const response = await getJson<GammaMarketRaw[] | GammaMarketRaw>(
      this.baseUrl,
      "/markets",
      { slug },
    );

    if (Array.isArray(response)) {
      return response[0] ? normalizeGammaMarket(response[0]) : undefined;
    }

    return normalizeGammaMarket(response);
  }

  async getRequiredMarketBySlug(slug: string): Promise<NormalizedMarket> {
    const market = await this.getMarketBySlug(slug);
    if (!market) {
      throw new Error(`Market not found for slug: ${slug}`);
    }

    return market;
  }

  async resolveMarketOutcome(
    slug: string,
    outcomeName: string,
  ): Promise<ResolvedMarketSelection> {
    const market = await this.getRequiredMarketBySlug(slug);
    const selectedOutcome = findOutcome(market, outcomeName);

    if (!selectedOutcome) {
      throw new Error(
        `Outcome "${outcomeName}" not found. Available outcomes: ${market.outcomes.map((outcome) => outcome.name).join(", ")}`,
      );
    }

    if (!selectedOutcome.tokenId) {
      throw new Error(`Outcome "${selectedOutcome.name}" does not have a CLOB token id`);
    }

    return {
      market,
      selectedOutcome,
    };
  }
}
