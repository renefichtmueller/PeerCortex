/**
 * @module sources/ripe-stat
 * RIPE Stat API client for BGP, routing, and resource information.
 *
 * RIPE Stat provides a rich set of data calls for Internet resource analysis
 * including AS overview, announced prefixes, BGP state, visibility, and RPKI.
 *
 * @see https://stat.ripe.net/docs/02.data-api/
 */

import type {
  RIPEStatResponse,
  RIPEASOverview,
  RIPEAnnouncedPrefixes,
  RIPEBGPState,
  RIPEBGPUpdates,
  RIPELookingGlass,
  RIPERPKIValidation,
  RIPEVisibility,
} from "../types/bgp.js";
import type { ASN } from "../types/common.js";
import { PeerCortexError } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

const RIPE_STAT_BASE_URL = "https://stat.ripe.net/data";

interface RIPEStatClientConfig {
  readonly sourceApp?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

// ── Client ───────────────────────────────────────────────

/**
 * RIPE Stat API client.
 *
 * Provides typed access to RIPE Stat data calls for routing analysis,
 * BGP monitoring, and RPKI validation.
 *
 * @example
 * ```typescript
 * const client = createRIPEStatClient({ sourceApp: "peercortex" });
 * const overview = await client.getASOverview(13335);
 * console.log(overview.holder); // "CLOUDFLARENET"
 * ```
 */
export interface RIPEStatClient {
  /** Get AS overview (holder, type, block) */
  getASOverview(asn: ASN): Promise<RIPEASOverview>;

  /** Get all announced prefixes for an ASN */
  getAnnouncedPrefixes(asn: ASN): Promise<RIPEAnnouncedPrefixes>;

  /** Get BGP state for a resource (ASN or prefix) */
  getBGPState(resource: string): Promise<RIPEBGPState>;

  /** Get BGP updates for a resource over a time period */
  getBGPUpdates(
    resource: string,
    startTime?: string,
    endTime?: string
  ): Promise<RIPEBGPUpdates>;

  /** Get looking glass data for a resource */
  getLookingGlass(resource: string): Promise<RIPELookingGlass>;

  /** Validate a prefix-origin pair via RPKI */
  getRPKIValidation(prefix: string, originASN: ASN): Promise<RIPERPKIValidation>;

  /** Get visibility information for a prefix */
  getVisibility(resource: string): Promise<RIPEVisibility>;

  /** Check if the API is reachable */
  healthCheck(): Promise<boolean>;
}

/**
 * Create a new RIPE Stat API client.
 *
 * @param config - Client configuration
 * @returns A configured RIPE Stat client instance
 */
export function createRIPEStatClient(
  config: RIPEStatClientConfig = {}
): RIPEStatClient {
  const baseUrl = config.baseUrl ?? RIPE_STAT_BASE_URL;
  const sourceApp = config.sourceApp ?? "peercortex";
  const timeoutMs = config.timeoutMs ?? 30000;

  /**
   * Make a request to the RIPE Stat API.
   */
  async function request<T>(
    dataCall: string,
    params: Record<string, string | number | undefined> = {}
  ): Promise<T> {
    const url = new URL(`${baseUrl}/${dataCall}/data.json`);
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
          `RIPE Stat API error: ${response.status} ${response.statusText}`,
          response.status === 429 ? "RATE_LIMITED" : "SOURCE_UNAVAILABLE",
          "ripe_stat"
        );
      }

      const body = (await response.json()) as RIPEStatResponse<T>;

      if (body.status !== "ok") {
        throw new PeerCortexError(
          `RIPE Stat data call failed: ${body.data_call_status}`,
          "SOURCE_UNAVAILABLE",
          "ripe_stat"
        );
      }

      return body.data;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `RIPE Stat request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "ripe_stat",
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getASOverview(asn: ASN): Promise<RIPEASOverview> {
      return request<RIPEASOverview>("as-overview", { resource: `AS${asn}` });
    },

    async getAnnouncedPrefixes(asn: ASN): Promise<RIPEAnnouncedPrefixes> {
      return request<RIPEAnnouncedPrefixes>("announced-prefixes", {
        resource: `AS${asn}`,
      });
    },

    async getBGPState(resource: string): Promise<RIPEBGPState> {
      return request<RIPEBGPState>("bgp-state", { resource });
    },

    async getBGPUpdates(
      resource: string,
      startTime?: string,
      endTime?: string
    ): Promise<RIPEBGPUpdates> {
      return request<RIPEBGPUpdates>("bgp-updates", {
        resource,
        starttime: startTime,
        endtime: endTime,
      });
    },

    async getLookingGlass(resource: string): Promise<RIPELookingGlass> {
      return request<RIPELookingGlass>("looking-glass", { resource });
    },

    async getRPKIValidation(
      prefix: string,
      originASN: ASN
    ): Promise<RIPERPKIValidation> {
      return request<RIPERPKIValidation>("rpki-validation", {
        resource: `AS${originASN}`,
        prefix,
      });
    },

    async getVisibility(resource: string): Promise<RIPEVisibility> {
      return request<RIPEVisibility>("visibility", { resource });
    },

    async healthCheck(): Promise<boolean> {
      try {
        await this.getASOverview(13335);
        return true;
      } catch {
        return false;
      }
    },
  };
}
