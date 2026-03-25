/**
 * @module sources/peeringdb
 * PeeringDB API v2 client for network, IX, and facility lookups.
 *
 * PeeringDB is the freely available, user-maintained database of networks
 * and the go-to location for interconnection data.
 *
 * @see https://www.peeringdb.com/apidocs/
 */

import type {
  PDBNetwork,
  PDBInternetExchange,
  PDBFacility,
  PDBNetworkIXLan,
  PDBNetworkSearchParams,
  PDBIXSearchParams,
  PeeringDBResponse,
} from "../types/peeringdb.js";
import type { ASN } from "../types/common.js";
import { PeerCortexError } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

const PEERINGDB_BASE_URL = "https://www.peeringdb.com/api";

interface PeeringDBClientConfig {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

// ── Client ───────────────────────────────────────────────

/**
 * PeeringDB API v2 client.
 *
 * Provides typed access to PeeringDB data including networks, IXs, and facilities.
 * Supports optional API key authentication for higher rate limits.
 *
 * @example
 * ```typescript
 * const client = createPeeringDBClient({ apiKey: process.env.PEERINGDB_API_KEY });
 * const network = await client.getNetwork(13335);
 * console.log(network.name); // "Cloudflare, Inc."
 * ```
 */
export interface PeeringDBClient {
  /** Look up a network by ASN */
  getNetwork(asn: ASN): Promise<PDBNetwork>;

  /** Search networks with filters */
  searchNetworks(params: PDBNetworkSearchParams): Promise<ReadonlyArray<PDBNetwork>>;

  /** Get all IX connections for an ASN */
  getNetworkIXLans(asn: ASN): Promise<ReadonlyArray<PDBNetworkIXLan>>;

  /** Look up an Internet Exchange by ID */
  getIX(id: number): Promise<PDBInternetExchange>;

  /** Search Internet Exchanges with filters */
  searchIXs(params: PDBIXSearchParams): Promise<ReadonlyArray<PDBInternetExchange>>;

  /** Get all participants at an IX */
  getIXParticipants(ixId: number): Promise<ReadonlyArray<PDBNetworkIXLan>>;

  /** Look up a facility by ID */
  getFacility(id: number): Promise<PDBFacility>;

  /** Get all networks at a facility */
  getNetworksAtFacility(facId: number): Promise<ReadonlyArray<PDBNetwork>>;

  /** Find common IXs between two ASNs */
  findCommonIXs(asn1: ASN, asn2: ASN): Promise<ReadonlyArray<string>>;

  /** Check if the API is reachable */
  healthCheck(): Promise<boolean>;
}

/**
 * Create a new PeeringDB API client.
 *
 * @param config - Client configuration
 * @returns A configured PeeringDB client instance
 */
export function createPeeringDBClient(
  config: PeeringDBClientConfig = {}
): PeeringDBClient {
  const baseUrl = config.baseUrl ?? PEERINGDB_BASE_URL;
  const timeoutMs = config.timeoutMs ?? 15000;

  /**
   * Make an authenticated request to the PeeringDB API.
   */
  async function request<T>(
    endpoint: string,
    params: Record<string, string | number | undefined> = {}
  ): Promise<PeeringDBResponse<T>> {
    const url = new URL(`${baseUrl}/${endpoint}`);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "PeerCortex/0.1.0",
    };

    if (config.apiKey) {
      headers["Authorization"] = `Api-Key ${config.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `PeeringDB API error: ${response.status} ${response.statusText}`,
          response.status === 429 ? "RATE_LIMITED" : "SOURCE_UNAVAILABLE",
          "peeringdb"
        );
      }

      return (await response.json()) as PeeringDBResponse<T>;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `PeeringDB request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "peeringdb",
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getNetwork(asn: ASN): Promise<PDBNetwork> {
      const result = await request<PDBNetwork>("net", { asn, depth: 2 });
      if (result.data.length === 0) {
        throw new PeerCortexError(
          `Network not found for ASN ${asn}`,
          "INVALID_ASN",
          "peeringdb"
        );
      }
      return result.data[0];
    },

    async searchNetworks(
      params: PDBNetworkSearchParams
    ): Promise<ReadonlyArray<PDBNetwork>> {
      const result = await request<PDBNetwork>("net", params as Record<string, string | number>);
      return result.data;
    },

    async getNetworkIXLans(asn: ASN): Promise<ReadonlyArray<PDBNetworkIXLan>> {
      const result = await request<PDBNetworkIXLan>("netixlan", { asn });
      return result.data;
    },

    async getIX(id: number): Promise<PDBInternetExchange> {
      const result = await request<PDBInternetExchange>(`ix/${id}`);
      if (result.data.length === 0) {
        throw new PeerCortexError(
          `IX not found: ${id}`,
          "PARSE_ERROR",
          "peeringdb"
        );
      }
      return result.data[0];
    },

    async searchIXs(
      params: PDBIXSearchParams
    ): Promise<ReadonlyArray<PDBInternetExchange>> {
      const result = await request<PDBInternetExchange>("ix", params as Record<string, string>);
      return result.data;
    },

    async getIXParticipants(ixId: number): Promise<ReadonlyArray<PDBNetworkIXLan>> {
      const result = await request<PDBNetworkIXLan>("netixlan", { ix_id: ixId });
      return result.data;
    },

    async getFacility(id: number): Promise<PDBFacility> {
      const result = await request<PDBFacility>(`fac/${id}`);
      if (result.data.length === 0) {
        throw new PeerCortexError(
          `Facility not found: ${id}`,
          "PARSE_ERROR",
          "peeringdb"
        );
      }
      return result.data[0];
    },

    async getNetworksAtFacility(facId: number): Promise<ReadonlyArray<PDBNetwork>> {
      // TODO: Implement via netfac -> net lookup
      const _facId = facId;
      throw new PeerCortexError(
        "getNetworksAtFacility not yet implemented",
        "UNKNOWN",
        "peeringdb"
      );
    },

    async findCommonIXs(asn1: ASN, asn2: ASN): Promise<ReadonlyArray<string>> {
      const [ixlans1, ixlans2] = await Promise.all([
        this.getNetworkIXLans(asn1),
        this.getNetworkIXLans(asn2),
      ]);

      const ixIds1 = new Set(ixlans1.map((ix) => ix.ix_id));
      const commonIXLans = ixlans2.filter((ix) => ixIds1.has(ix.ix_id));
      return commonIXLans.map((ix) => ix.name);
    },

    async healthCheck(): Promise<boolean> {
      try {
        await request("net", { asn: 13335 });
        return true;
      } catch {
        return false;
      }
    },
  };
}
