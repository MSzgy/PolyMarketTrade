export interface GammaMarketRaw {
  id?: string;
  conditionId?: string;
  condition_id?: string;
  market?: string;
  slug: string;
  question: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  enableOrderBook?: boolean;
  outcomes?: string[] | string;
  outcomePrices?: string[] | string;
  clobTokenIds?: string[] | string;
  liquidity?: string | number;
  volume?: string | number;
  tickSize?: string | number;
  negRisk?: boolean;
  endDate?: string;
}

export interface MarketOutcome {
  name: string;
  tokenId: string;
  price: number | null;
}

export interface NormalizedMarket {
  id?: string;
  conditionId?: string;
  slug: string;
  question: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  enableOrderBook: boolean;
  liquidity: number | null;
  volume: number | null;
  tickSize: string;
  negRisk: boolean;
  endDate?: string;
  outcomes: MarketOutcome[];
}

export interface DataPosition {
  asset?: string;
  tokenId?: string;
  size?: string | number;
  avgPrice?: string | number;
  realizedPnl?: string | number;
  unrealizedPnl?: string | number;
  [key: string]: unknown;
}

export function normalizeGammaMarket(raw: GammaMarketRaw): NormalizedMarket {
  const outcomeNames = parseStringArray(raw.outcomes);
  const outcomePrices = parseStringArray(raw.outcomePrices).map((value) => toNumber(value));
  const tokenIds = parseStringArray(raw.clobTokenIds);

  const outcomes: MarketOutcome[] = outcomeNames.map((name, index) => ({
    name,
    tokenId: tokenIds[index] ?? "",
    price: outcomePrices[index] ?? null,
  }));

  return {
    id: raw.id,
    conditionId: normalizeIdentifier(raw.conditionId ?? raw.condition_id ?? raw.market ?? raw.id),
    slug: raw.slug,
    question: raw.question,
    active: Boolean(raw.active),
    closed: Boolean(raw.closed),
    archived: Boolean(raw.archived),
    enableOrderBook: Boolean(raw.enableOrderBook),
    liquidity: toNumber(raw.liquidity),
    volume: toNumber(raw.volume),
    tickSize: String(raw.tickSize ?? "0.01"),
    negRisk: Boolean(raw.negRisk),
    endDate: raw.endDate,
    outcomes,
  };
}

export function findOutcome(
  market: NormalizedMarket,
  outcomeName: string,
): MarketOutcome | undefined {
  return market.outcomes.find(
    (outcome) => outcome.name.toLowerCase() === outcomeName.trim().toLowerCase(),
  );
}

function parseStringArray(value: string[] | string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return [];
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }
  }

  return [trimmed];
}

function normalizeIdentifier(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const trimmed = String(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
