import { getJson } from "../lib/http.js";
import type { DataPosition } from "./types.js";

export class DataClient {
  constructor(private readonly baseUrl: string) {}

  getPositions(user: string): Promise<DataPosition[]> {
    return getJson<DataPosition[]>(this.baseUrl, "/positions", { user });
  }

  getClosedPositions(user: string): Promise<DataPosition[]> {
    return getJson<DataPosition[]>(this.baseUrl, "/closed-positions", { user });
  }

  getActivity(user: string, limit = 20): Promise<Record<string, unknown>[]> {
    return getJson<Record<string, unknown>[]>(this.baseUrl, "/activity", { user, limit });
  }

  getValue(user: string): Promise<Record<string, unknown>> {
    return getJson<Record<string, unknown>>(this.baseUrl, "/value", { user });
  }

  getTrades(params: Record<string, string | number | boolean | undefined>) {
    return getJson<Record<string, unknown>[]>(this.baseUrl, "/trades", params);
  }
}
