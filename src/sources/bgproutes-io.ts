/**
 * @module sources/bgproutes-io
 * bgproutes.io REST API client for RIB, updates, vantage points, and topology.
 *
 * bgproutes.io provides a real-time BGP data platform with RPKI ROV and ASPA
 * validation on every route entry. This client wraps four REST endpoints plus
 * a real-time streaming interface.
 *
 * @see https://bgproutes.io/docs/api
 */

import type {
  BgpRoutesIoRibEntry,
  BgpRoutesIoUpdate,
  BgpRoutesIoVantagePoint,
  BgpRoutesIoTopologyLink,
} from "../types/bgp.js";
import type { ASN } from "../types/common.js";
import { PeerCortexError } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

const BGPROUTES_IO_BASE_URL = "https://api.bgproutes.io/v1";

interface BgpRoutesIoClientConfig {
  /** API key for authenticated access (optional for public endpoints) */
  readonly apiKey?: string;
  /** Base URL override for testing */
  readonly baseUrl?: string;
  /** Request timeout in milliseconds */
  readonly timeoutMs?: number;
}

// ── Time Range ───────────────────────────────────────────

/** Time range for update queries */
export interface TimeRange {
  /** Start of the window (ISO 8601) */
  readonly start: string;
  /** End of the window (ISO 8601) */
  readonly end: string;
}

// ── Client Interface ─────────────────────────────────────

/**
 * bgproutes.io API client.
 *
 * Provides typed access to RIB entries, BGP updates, vantage points, and
 * AS-level topology data. Every route entry includes RPKI ROV status and
 * ASPA validation results.
 *
 * @example
 * ```typescript
 * const client = createBgpRoutesIoClient({ apiKey: process.env.BGPROUTES_API_KEY });
 * const rib = await client.getRibEntries("1.1.1.0/24");
 * console.log(rib[0].rpkiStatus); // "valid"
 * console.log(rib[0].aspaValidation.state); // "valid"
 * ```
 */
export interface BgpRoutesIoClient {
  /**
   * Fetch current RIB entries for a prefix.
   *
   * Returns all routes seen across vantage points, each annotated with
   * RPKI ROV status and ASPA validation.
   *
   * @param prefix - IP prefix (e.g., "1.1.1.0/24" or "2606:4700::/32")
   * @returns Array of RIB entries with validation metadata
   */
  getRibEntries(prefix: string): Promise<ReadonlyArray<BgpRoutesIoRibEntry>>;

  /**
   * Fetch BGP updates for a prefix within a time range.
   *
   * @param prefix - IP prefix to query updates for
   * @param timeRange - Start and end time (ISO 8601)
   * @returns Array of BGP update messages
   */
  getUpdates(
    prefix: string,
    timeRange: TimeRange
  ): Promise<ReadonlyArray<BgpRoutesIoUpdate>>;

  /**
   * List all available vantage points (BGP collectors/peers).
   *
   * @returns Array of vantage point metadata
   */
  getVantagePoints(): Promise<ReadonlyArray<BgpRoutesIoVantagePoint>>;

  /**
   * Fetch AS-level topology links for an ASN.
   *
   * Returns upstream, downstream, and peer relationships observed
   * from BGP data, with link classification.
   *
   * @param asn - Autonomous System Number
   * @returns Array of topology links involving the given ASN
   */
  getTopology(asn: ASN): Promise<ReadonlyArray<BgpRoutesIoTopologyLink>>;

  /**
   * Subscribe to real-time BGP updates for a prefix.
   *
   * Returns an async iterable that yields updates as they are observed.
   * The caller is responsible for breaking out of the loop to stop streaming.
   *
   * @param prefix - IP prefix to monitor
   * @returns Async iterable of real-time BGP updates
   */
  getRealtimeStream(
    prefix: string
  ): AsyncIterable<BgpRoutesIoUpdate>;

  /** Check if the bgproutes.io API is reachable */
  healthCheck(): Promise<boolean>;
}

// ── Client Factory ───────────────────────────────────────

/**
 * Create a new bgproutes.io API client.
 *
 * @param config - Client configuration
 * @returns A configured bgproutes.io client instance
 *
 * @example
 * ```typescript
 * const client = createBgpRoutesIoClient();
 * const vps = await client.getVantagePoints();
 * console.log(`${vps.length} vantage points available`);
 * ```
 */
export function createBgpRoutesIoClient(
  config: BgpRoutesIoClientConfig = {}
): BgpRoutesIoClient {
  const baseUrl = config.baseUrl ?? BGPROUTES_IO_BASE_URL;
  const apiKey = config.apiKey ?? process.env.BGPROUTES_API_KEY;
  const timeoutMs = config.timeoutMs ?? 30000;

  /**
   * Build common request headers.
   */
  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "PeerCortex/0.1.0",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    return headers;
  }

  /**
   * Make a typed GET request to the bgproutes.io API.
   */
  async function request<T>(
    path: string,
    params: Record<string, string | number | undefined> = {}
  ): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        headers: buildHeaders(),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `bgproutes.io API error: ${response.status} ${response.statusText}`,
          response.status === 429 ? "RATE_LIMITED" : "SOURCE_UNAVAILABLE",
          "bgproutes_io" as never
        );
      }

      const body = (await response.json()) as { data: T };
      return body.data;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `bgproutes.io request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "bgproutes_io" as never,
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getRibEntries(
      prefix: string
    ): Promise<ReadonlyArray<BgpRoutesIoRibEntry>> {
      // TODO: Validate prefix format before sending request
      return request<ReadonlyArray<BgpRoutesIoRibEntry>>("/rib", { prefix });
    },

    async getUpdates(
      prefix: string,
      timeRange: TimeRange
    ): Promise<ReadonlyArray<BgpRoutesIoUpdate>> {
      // TODO: Validate time range (start < end, max window)
      return request<ReadonlyArray<BgpRoutesIoUpdate>>("/updates", {
        prefix,
        start: timeRange.start,
        end: timeRange.end,
      });
    },

    async getVantagePoints(): Promise<
      ReadonlyArray<BgpRoutesIoVantagePoint>
    > {
      return request<ReadonlyArray<BgpRoutesIoVantagePoint>>(
        "/vantage_points"
      );
    },

    async getTopology(
      asn: ASN
    ): Promise<ReadonlyArray<BgpRoutesIoTopologyLink>> {
      return request<ReadonlyArray<BgpRoutesIoTopologyLink>>(
        `/topology/${asn}`
      );
    },

    async *getRealtimeStream(
      prefix: string
    ): AsyncIterable<BgpRoutesIoUpdate> {
      // TODO: Implement SSE / WebSocket streaming connection
      // TODO: Handle reconnection with exponential backoff
      // TODO: Parse streaming JSON lines into typed updates

      const url = new URL(`${baseUrl}/stream`);
      url.searchParams.set("prefix", prefix);

      const controller = new AbortController();

      try {
        const response = await fetch(url.toString(), {
          headers: {
            ...buildHeaders(),
            Accept: "text/event-stream",
          },
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new PeerCortexError(
            `bgproutes.io stream failed: ${response.status}`,
            "SOURCE_UNAVAILABLE",
            "bgproutes_io" as never
          );
        }

        // TODO: Replace with proper SSE parser (e.g., eventsource-parser)
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n").filter((l) => l.startsWith("data:"));

            for (const line of lines) {
              const json = line.slice(5).trim();
              if (json) {
                yield JSON.parse(json) as BgpRoutesIoUpdate;
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } finally {
        controller.abort();
      }
    },

    async healthCheck(): Promise<boolean> {
      try {
        const vps = await this.getVantagePoints();
        return vps.length > 0;
      } catch {
        return false;
      }
    },
  };
}
