/**
 * @module sources/route-views
 * Route Views and RIPE RIS client for global routing table data.
 *
 * Route Views (University of Oregon) and RIPE RIS collect BGP routing data
 * from multiple vantage points worldwide. This module uses RIPE Stat as
 * the primary API to access this data.
 *
 * @see https://www.routeviews.org/
 * @see https://ris.ripe.net/
 */

import type { RouteViewsEntry, BGPPathAnalysis, BGPVisibilityReport } from "../types/bgp.js";
import type { ASN } from "../types/common.js";
import { PeerCortexError, formatASN } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

interface RouteViewsClientConfig {
  readonly ripeStatBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly sourceApp?: string;
}

// ── Client ───────────────────────────────────────────────

/**
 * Route Views / RIPE RIS client.
 *
 * Uses RIPE Stat API as the access layer to Route Views and RIPE RIS
 * collector data. Provides routing table lookups, path analysis, and
 * visibility reports.
 *
 * @example
 * ```typescript
 * const client = createRouteViewsClient();
 * const analysis = await client.analyzePaths("185.1.0.0/24");
 * console.log(analysis.pathDiversity); // Number of unique paths
 * ```
 */
export interface RouteViewsClient {
  /** Get routing table entries for a prefix from multiple collectors */
  getRoutingEntries(prefix: string): Promise<ReadonlyArray<RouteViewsEntry>>;

  /** Analyze BGP path diversity for a prefix */
  analyzePaths(prefix: string): Promise<BGPPathAnalysis>;

  /** Get visibility report for a prefix across collectors */
  getVisibilityReport(prefix: string): Promise<BGPVisibilityReport>;

  /** Get all prefixes originated by an ASN as seen in the global table */
  getOriginatedPrefixes(asn: ASN): Promise<ReadonlyArray<string>>;

  /** Get upstream ASNs for a given ASN based on AS paths */
  getUpstreams(asn: ASN): Promise<ReadonlyArray<{ asn: ASN; name: string }>>;

  /** Check if the data source is reachable */
  healthCheck(): Promise<boolean>;
}

/**
 * Create a new Route Views / RIPE RIS client.
 *
 * @param config - Client configuration
 * @returns A configured Route Views client instance
 */
export function createRouteViewsClient(
  config: RouteViewsClientConfig = {}
): RouteViewsClient {
  const ripeStatBaseUrl =
    config.ripeStatBaseUrl ?? "https://stat.ripe.net/data";
  const sourceApp = config.sourceApp ?? "peercortex";
  const timeoutMs = config.timeoutMs ?? 30000;

  /**
   * Query RIPE Stat API for Route Views / RIS data.
   */
  async function queryRIPEStat<T>(
    dataCall: string,
    params: Record<string, string | number | undefined> = {}
  ): Promise<T> {
    const url = new URL(`${ripeStatBaseUrl}/${dataCall}/data.json`);
    url.searchParams.set("sourceapp", sourceApp);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "User-Agent": "PeerCortex/0.1.0",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `Route Views query failed: ${response.status}`,
          "SOURCE_UNAVAILABLE",
          "route_views"
        );
      }

      const body = await response.json();
      return (body as { data: T }).data;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `Route Views request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "route_views",
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getRoutingEntries(
      prefix: string
    ): Promise<ReadonlyArray<RouteViewsEntry>> {
      // TODO: Implement via RIPE Stat looking-glass and bgp-state data calls
      // Each RRC provides entries from different vantage points
      const _prefix = prefix;
      return []; // TODO: Parse and return RouteViewsEntry objects
    },

    async analyzePaths(prefix: string): Promise<BGPPathAnalysis> {
      // TODO: Implement path diversity analysis
      // 1. Query bgp-state for all paths to the prefix
      // 2. Analyze path diversity, upstream ASNs, path lengths
      // 3. Optionally use AI to generate analysis text

      const bgpState = await queryRIPEStat<{
        resource: string;
        bgp_state: ReadonlyArray<{
          target_prefix: string;
          path: ReadonlyArray<number>;
          source_id: string;
        }>;
      }>("bgp-state", { resource: prefix });

      const paths = bgpState.bgp_state.map((entry) => ({
        asPath: entry.path,
        collector: entry.source_id,
        peer: "", // TODO: Extract peer from source_id
        communities: [] as ReadonlyArray<string>,
      }));

      const uniquePaths = new Set(
        paths.map((p) => p.asPath.join(","))
      );

      const upstreamSet = new Set<number>();
      for (const entry of bgpState.bgp_state) {
        if (entry.path.length >= 2) {
          upstreamSet.add(entry.path[entry.path.length - 2]);
        }
      }

      const totalPathLength = paths.reduce(
        (sum, p) => sum + p.asPath.length,
        0
      );

      const originASN =
        bgpState.bgp_state.length > 0
          ? bgpState.bgp_state[0].path[bgpState.bgp_state[0].path.length - 1]
          : 0;

      return {
        prefix,
        originASN,
        paths,
        pathDiversity: uniquePaths.size,
        upstreamASNs: Array.from(upstreamSet),
        avgPathLength:
          paths.length > 0 ? totalPathLength / paths.length : 0,
        analysis: "", // TODO: Generate AI analysis
      };
    },

    async getVisibilityReport(
      prefix: string
    ): Promise<BGPVisibilityReport> {
      // TODO: Implement via RIPE Stat visibility data call
      const _prefix = prefix;
      return {
        prefix,
        originASN: 0,
        totalCollectors: 0,
        seenByCollectors: 0,
        visibilityPercent: 0,
        seenPaths: [],
        firstSeen: "",
        lastSeen: "",
      };
    },

    async getOriginatedPrefixes(asn: ASN): Promise<ReadonlyArray<string>> {
      const data = await queryRIPEStat<{
        prefixes: ReadonlyArray<{ prefix: string }>;
      }>("announced-prefixes", { resource: formatASN(asn) });

      return data.prefixes.map((p) => p.prefix);
    },

    async getUpstreams(
      asn: ASN
    ): Promise<ReadonlyArray<{ asn: ASN; name: string }>> {
      // TODO: Implement via AS path analysis
      const _asn = asn;
      return []; // TODO: Analyze AS paths to determine upstreams
    },

    async healthCheck(): Promise<boolean> {
      try {
        await queryRIPEStat("bgp-state", { resource: "1.1.1.0/24" });
        return true;
      } catch {
        return false;
      }
    },
  };
}
