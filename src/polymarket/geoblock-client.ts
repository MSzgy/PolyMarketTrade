export interface GeoblockStatus {
  blocked: boolean;
  ip: string;
  country: string;
  region: string;
}

export class GeoblockClient {
  constructor(private readonly url: string) {}

  async check(): Promise<GeoblockStatus> {
    const response = await fetch(this.url, {
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Geoblock request failed with status ${response.status}`);
    }

    return (await response.json()) as GeoblockStatus;
  }
}
