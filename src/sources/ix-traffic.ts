/**
 * @module sources/ix-traffic
 * Internet Exchange traffic statistics API client.
 *
 * Aggregates traffic data from major IXPs including DE-CIX, AMS-IX, and LINX.
 * Each IX provides public traffic statistics via their own API format; this
 * module normalizes them into a common interface.
 *
 * @see https://www.de-cix.net/en/locations/statistics
 * @see https://www.ams-ix.net/ams/statistics
 * @see https://www.linx.net/about/statistics/
 */

import { PeerCortexError } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

interface IXTrafficClientConfig {
  /** Request timeout in milliseconds */
  readonly timeoutMs?: number;
}

// ── Types ────────────────────────────────────────────────

/** Supported IX identifiers */
export type IXIdentifier =
  | "de-cix-frankfurt"
  | "de-cix-hamburg"
  | "de-cix-munich"
  | "de-cix-dusseldorf"
  | "ams-ix"
  | "linx-lon1"
  | "linx-lon2"
  | "nlix"
  | "six-seattle"
  | "any2-los-angeles";

/** Traffic data point */
export interface TrafficDataPoint {
  /** Timestamp (ISO 8601) */
  readonly timestamp: string;
  /** Ingress traffic in bits per second */
  readonly inBps: number;
  /** Egress traffic in bits per second */
  readonly outBps: number;
  /** Average traffic in bits per second */
  readonly avgBps: number;
  /** Peak traffic in bits per second */
  readonly peakBps: number;
}

/** Aggregated traffic statistics for an IX */
export interface IXTrafficStats {
  readonly ix: IXIdentifier;
  readonly displayName: string;
  /** Current peak traffic (bps) */
  readonly currentPeakBps: number;
  /** Current average traffic (bps) */
  readonly currentAvgBps: number;
  /** Number of connected networks */
  readonly connectedNetworks: number;
  /** Total port capacity (bps) */
  readonly totalCapacityBps: number;
  /** Historical traffic data points */
  readonly dataPoints: ReadonlyArray<TrafficDataPoint>;
  /** When this data was fetched */
  readonly fetchedAt: string;
}

/** Port utilization for a member at an IX */
export interface IXPortUtilization {
  readonly ix: IXIdentifier;
  readonly asn: number;
  readonly portSpeedBps: number;
  readonly avgUtilizationPercent: number;
  readonly peakUtilizationPercent: number;
  readonly lastUpdated: string;
}

/** Time granularity for traffic queries */
export type TrafficGranularity =
  | "5min"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly";

// ── Client Interface ─────────────────────────────────────

/**
 * IX traffic statistics client.
 *
 * Aggregates public traffic data from major IXPs into a unified interface.
 *
 * @example
 * ```typescript
 * const ixTraffic = createIXTrafficClient();
 *
 * // Get DE-CIX Frankfurt traffic for the last 30 days
 * const stats = await ixTraffic.getTrafficStats("de-cix-frankfurt", {
 *   period: "30d",
 *   granularity: "daily",
 * });
 * console.log(`Peak: ${(stats.currentPeakBps / 1e12).toFixed(1)} Tbps`);
 * ```
 */
export interface IXTrafficClient {
  /**
   * Get traffic statistics for an IX.
   *
   * @param ix - IX identifier
   * @param options - Query options (period, granularity)
   * @returns Traffic statistics with historical data points
   */
  getTrafficStats(
    ix: IXIdentifier,
    options?: {
      readonly period?: string;
      readonly granularity?: TrafficGranularity;
    }
  ): Promise<IXTrafficStats>;

  /**
   * Get traffic statistics for multiple IXes at once.
   *
   * @param ixes - Array of IX identifiers
   * @returns Map of IX identifier to traffic stats
   */
  getMultiIXStats(
    ixes: ReadonlyArray<IXIdentifier>
  ): Promise<ReadonlyArray<IXTrafficStats>>;

  /**
   * Get port utilization estimate for a member ASN at an IX.
   *
   * Note: This data may not be publicly available for all IXes.
   *
   * @param ix - IX identifier
   * @param asn - Member ASN
   * @returns Port utilization data
   */
  getPortUtilization(
    ix: IXIdentifier,
    asn: number
  ): Promise<IXPortUtilization | null>;

  /**
   * List all supported IXes with current summary stats.
   *
   * @returns Array of IX summaries
   */
  listSupportedIXes(): Promise<
    ReadonlyArray<{
      readonly id: IXIdentifier;
      readonly name: string;
      readonly city: string;
      readonly country: string;
      readonly currentPeakTbps: number;
    }>
  >;

  /** Check if IX traffic APIs are reachable */
  healthCheck(): Promise<boolean>;
}

// ── IX API URLs ──────────────────────────────────────────

const IX_ENDPOINTS: Record<string, string> = {
  "de-cix-frankfurt": "https://www.de-cix.net/traffic_data/fra.json",
  "de-cix-hamburg": "https://www.de-cix.net/traffic_data/ham.json",
  "de-cix-munich": "https://www.de-cix.net/traffic_data/muc.json",
  "ams-ix": "https://stats-api.ams-ix.net/v1/stats",
  "linx-lon1": "https://www.linx.net/api/traffic/lon1",
  "linx-lon2": "https://www.linx.net/api/traffic/lon2",
};

// ── Client Factory ───────────────────────────────────────

/**
 * Create a new IX traffic statistics client.
 *
 * @param config - Client configuration
 * @returns A configured IX traffic client instance
 */
export function createIXTrafficClient(
  config: IXTrafficClientConfig = {}
): IXTrafficClient {
  const timeoutMs = config.timeoutMs ?? 30000;

  /**
   * Fetch JSON from a URL with timeout.
   */
  async function fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "PeerCortex/0.1.0",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `IX traffic API error: ${response.status} for ${url}`,
          "SOURCE_UNAVAILABLE",
          "peeringdb" // TODO: Add ix_traffic as DataSourceName
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `IX traffic fetch failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "peeringdb",
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getTrafficStats(
      ix: IXIdentifier,
      options?: {
        readonly period?: string;
        readonly granularity?: TrafficGranularity;
      }
    ): Promise<IXTrafficStats> {
      const endpoint = IX_ENDPOINTS[ix];
      if (!endpoint) {
        throw new PeerCortexError(
          `Unsupported IX: ${ix}`,
          "INVALID_PREFIX",
          "peeringdb"
        );
      }

      // TODO: Parse period string (e.g., "30d", "12m", "1y") into date range
      // TODO: Each IX has a different JSON schema — normalize here
      // TODO: Map granularity to IX-specific query params

      const _options = options;
      const rawData = await fetchJson<Record<string, unknown>>(endpoint);

      // TODO: Parse IX-specific response format into normalized TrafficDataPoint[]
      const _rawData = rawData;

      return {
        ix,
        displayName: ix.replace(/-/g, " ").toUpperCase(),
        currentPeakBps: 0,  // TODO: Extract from response
        currentAvgBps: 0,   // TODO: Extract from response
        connectedNetworks: 0,
        totalCapacityBps: 0,
        dataPoints: [],      // TODO: Parse time series
        fetchedAt: new Date().toISOString(),
      };
    },

    async getMultiIXStats(
      ixes: ReadonlyArray<IXIdentifier>
    ): Promise<ReadonlyArray<IXTrafficStats>> {
      // Fetch all IXes in parallel
      const results = await Promise.allSettled(
        ixes.map((ix) => this.getTrafficStats(ix))
      );

      return results
        .filter(
          (r): r is PromiseFulfilledResult<IXTrafficStats> =>
            r.status === "fulfilled"
        )
        .map((r) => r.value);
    },

    async getPortUtilization(
      ix: IXIdentifier,
      asn: number
    ): Promise<IXPortUtilization | null> {
      // TODO: Not all IXes expose per-member utilization publicly
      // TODO: May require IX-specific API credentials
      const _ix = ix;
      const _asn = asn;
      return null;
    },

    async listSupportedIXes() {
      return [
        { id: "de-cix-frankfurt" as IXIdentifier, name: "DE-CIX Frankfurt", city: "Frankfurt", country: "DE", currentPeakTbps: 0 },
        { id: "de-cix-hamburg" as IXIdentifier, name: "DE-CIX Hamburg", city: "Hamburg", country: "DE", currentPeakTbps: 0 },
        { id: "de-cix-munich" as IXIdentifier, name: "DE-CIX Munich", city: "Munich", country: "DE", currentPeakTbps: 0 },
        { id: "ams-ix" as IXIdentifier, name: "AMS-IX", city: "Amsterdam", country: "NL", currentPeakTbps: 0 },
        { id: "linx-lon1" as IXIdentifier, name: "LINX LON1", city: "London", country: "GB", currentPeakTbps: 0 },
        { id: "linx-lon2" as IXIdentifier, name: "LINX LON2", city: "London", country: "GB", currentPeakTbps: 0 },
      ];
    },

    async healthCheck(): Promise<boolean> {
      try {
        await this.getTrafficStats("de-cix-frankfurt");
        return true;
      } catch {
        return false;
      }
    },
  };
}
