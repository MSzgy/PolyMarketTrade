import { Wallet } from "@ethersproject/wallet";
import {
  ClobClient,
  OrderType,
  Side,
  type ApiKeyCreds,
  type TickSize,
} from "@polymarket/clob-client";
import type { AppConfig } from "../config.js";

export interface BookLevel {
  price: string;
  size: string;
}

export interface OrderBookSnapshot {
  bids: BookLevel[];
  asks: BookLevel[];
  tick_size?: TickSize;
}

export interface OrderRequest {
  tokenId: string;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  tickSize: TickSize;
  negRisk: boolean;
}

export class ClobService {
  private readonly publicClient: ClobClient;
  private tradingClient?: ClobClient;

  constructor(private readonly config: AppConfig) {
    this.publicClient = new ClobClient(config.clobUrl, config.chainId);
  }

  async initialize(): Promise<void> {
    if (this.config.dryRun) {
      return;
    }

    if (!this.config.privateKey || !this.config.funderAddress) {
      throw new Error("Live trading requires POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS");
    }

    const signer = new Wallet(this.config.privateKey);
    const creds = await this.resolveApiCreds(signer);

    this.tradingClient = new ClobClient(
      this.config.clobUrl,
      this.config.chainId,
      signer,
      creds,
      this.config.signatureType,
      this.config.funderAddress,
      this.config.geoBlockToken,
    );
  }

  async getOrderBook(tokenId: string): Promise<OrderBookSnapshot> {
    return (await this.publicClient.getOrderBook(tokenId)) as OrderBookSnapshot;
  }

  async getMidpoint(tokenId: string): Promise<number | null> {
    const midpoint = await this.publicClient.getMidpoint(tokenId);
    const parsed = Number(midpoint);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async getTickSize(tokenId: string): Promise<TickSize> {
    return this.publicClient.getTickSize(tokenId);
  }

  async createAndPostOrder(request: OrderRequest): Promise<unknown> {
    if (!this.tradingClient) {
      throw new Error("Trading client is not initialized. Set DRY_RUN=false and provide credentials.");
    }

    return this.tradingClient.createAndPostOrder(
      {
        tokenID: request.tokenId,
        price: request.price,
        side: request.side === "BUY" ? Side.BUY : Side.SELL,
        size: request.size,
      },
      {
        tickSize: request.tickSize,
        negRisk: request.negRisk,
      },
      OrderType.GTC,
    );
  }

  private async resolveApiCreds(signer: Wallet): Promise<ApiKeyCreds> {
    if (
      this.config.apiKey &&
      this.config.apiSecret &&
      this.config.apiPassphrase
    ) {
      return {
        key: this.config.apiKey,
        secret: this.config.apiSecret,
        passphrase: this.config.apiPassphrase,
      };
    }

    const authClient = new ClobClient(this.config.clobUrl, this.config.chainId, signer);
    return authClient.createOrDeriveApiKey();
  }
}
