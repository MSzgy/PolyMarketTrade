import { getJson } from "../lib/http.js";
import {
  type GammaMarketRaw,
  type NormalizedMarket,
  normalizeGammaMarket,
} from "./types.js";

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
}
