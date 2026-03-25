/**
 * @module sources/ripe-atlas
 * RIPE Atlas API client for network measurements, probes, and anchors.
 *
 * RIPE Atlas is a global network measurement platform with thousands of probes
 * distributed worldwide. This client supports creating measurements, retrieving
 * results, and querying probe/anchor metadata.
 *
 * @see https://atlas.ripe.net/docs/apis/
 */

import type { ASN } from "../types/common.js";
import { PeerCortexError } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

const RIPE_ATLAS_BASE_URL = "https://atlas.ripe.net/api/v2";

interface RIPEAtlasClientConfig {
  /** API key for creating measurements (required for write operations) */
  readonly apiKey?: string;
  /** Base URL override */
  readonly baseUrl?: string;
  /** Request timeout in milliseconds */
  readonly timeoutMs?: number;
}

// ── Types ────────────────────────────────────────────────

/** RIPE Atlas measurement type */
export type MeasurementType =
  | "ping"
  | "traceroute"
  | "dns"
  | "sslcert"
  | "ntp"
  | "http";

/** RIPE Atlas measurement status */
export type MeasurementStatus =
  | "Specified"
  | "Scheduled"
  | "Ongoing"
  | "Stopped"
  | "Forced to stop"
  | "No suitable probes"
  | "Failed";

/** RIPE Atlas probe */
export interface AtlasProbe {
  readonly id: number;
  readonly asnV4: number;
  readonly asnV6: number;
  readonly countryCode: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly status: {
    readonly id: number;
    readonly name: string;
    readonly since: string;
  };
  readonly tags: ReadonlyArray<string>;
  readonly isAnchor: boolean;
}

/** RIPE Atlas anchor */
export interface AtlasAnchor {
  readonly id: number;
  readonly fqdn: string;
  readonly probeId: number;
  readonly city: string;
  readonly country: string;
  readonly company: string;
  readonly asnV4: number;
  readonly asnV6: number;
  readonly isDisabled: boolean;
}

/** RIPE Atlas measurement definition */
export interface AtlasMeasurementDef {
  readonly type: MeasurementType;
  readonly target: string;
  readonly description?: string;
  readonly af?: 4 | 6;
  readonly isOneoff?: boolean;
  readonly probesRequested?: number;
  readonly probeType?: "area" | "country" | "prefix" | "asn" | "probes";
  readonly probeValue?: string;
}

/** RIPE Atlas measurement metadata */
export interface AtlasMeasurement {
  readonly id: number;
  readonly type: MeasurementType;
  readonly target: string;
  readonly description: string;
  readonly af: 4 | 6;
  readonly status: {
    readonly id: number;
    readonly name: MeasurementStatus;
  };
  readonly creationTime: number;
  readonly startTime: number;
  readonly stopTime: number | null;
  readonly participantCount: number;
  readonly probesRequested: number;
}

/** Traceroute hop in an Atlas result */
export interface TracerouteHop {
  readonly hop: number;
  readonly result: ReadonlyArray<{
    readonly from?: string;
    readonly rtt?: number;
    readonly ttl?: number;
    readonly err?: string;
  }>;
}

/** Traceroute measurement result */
export interface TracerouteResult {
  readonly probeId: number;
  readonly from: string;
  readonly dst: string;
  readonly timestamp: number;
  readonly result: ReadonlyArray<TracerouteHop>;
}

/** Ping measurement result */
export interface PingResult {
  readonly probeId: number;
  readonly from: string;
  readonly dst: string;
  readonly timestamp: number;
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly sent: number;
  readonly rcvd: number;
  readonly dup: number;
}

// ── Client Interface ─────────────────────────────────────

/**
 * RIPE Atlas API client.
 *
 * Provides access to RIPE Atlas measurements, probes, and anchors.
 *
 * @example
 * ```typescript
 * const atlas = createRIPEAtlasClient({ apiKey: process.env.RIPE_ATLAS_KEY });
 *
 * // Create a one-off traceroute from 50 global probes
 * const measurement = await atlas.createMeasurement({
 *   type: "traceroute",
 *   target: "1.1.1.1",
 *   isOneoff: true,
 *   probesRequested: 50,
 * });
 *
 * // Retrieve results once the measurement completes
 * const results = await atlas.getTracerouteResults(measurement.id);
 * ```
 */
export interface RIPEAtlasClient {
  /** Create a new measurement (requires API key) */
  createMeasurement(def: AtlasMeasurementDef): Promise<AtlasMeasurement>;

  /** Get measurement metadata by ID */
  getMeasurement(id: number): Promise<AtlasMeasurement>;

  /** Get traceroute results for a measurement */
  getTracerouteResults(measurementId: number): Promise<ReadonlyArray<TracerouteResult>>;

  /** Get ping results for a measurement */
  getPingResults(measurementId: number): Promise<ReadonlyArray<PingResult>>;

  /** Search for probes by ASN, country, or prefix */
  searchProbes(params: {
    readonly asn?: ASN;
    readonly countryCode?: string;
    readonly prefix?: string;
    readonly isAnchor?: boolean;
    readonly limit?: number;
  }): Promise<ReadonlyArray<AtlasProbe>>;

  /** List all anchors, optionally filtered by country */
  listAnchors(countryCode?: string): Promise<ReadonlyArray<AtlasAnchor>>;

  /** Check if the Atlas API is reachable */
  healthCheck(): Promise<boolean>;
}

// ── Client Factory ───────────────────────────────────────

/**
 * Create a new RIPE Atlas API client.
 *
 * @param config - Client configuration
 * @returns A configured RIPE Atlas client instance
 */
export function createRIPEAtlasClient(
  config: RIPEAtlasClientConfig = {}
): RIPEAtlasClient {
  const baseUrl = config.baseUrl ?? RIPE_ATLAS_BASE_URL;
  const apiKey = config.apiKey ?? process.env.RIPE_ATLAS_API_KEY;
  const timeoutMs = config.timeoutMs ?? 30000;

  /**
   * Make a typed GET request to the Atlas API.
   */
  async function get<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {}
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
        headers: {
          Accept: "application/json",
          "User-Agent": "PeerCortex/0.1.0",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `RIPE Atlas API error: ${response.status} ${response.statusText}`,
          response.status === 429 ? "RATE_LIMITED" : "SOURCE_UNAVAILABLE",
          "ripe_stat"
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `RIPE Atlas request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "ripe_stat",
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Make a typed POST request to the Atlas API.
   */
  async function post<T>(path: string, body: unknown): Promise<T> {
    if (!apiKey) {
      throw new PeerCortexError(
        "RIPE Atlas API key required for write operations. Set RIPE_ATLAS_API_KEY.",
        "SOURCE_UNAVAILABLE",
        "ripe_stat"
      );
    }

    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("key", apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "PeerCortex/0.1.0",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `RIPE Atlas API error: ${response.status} ${response.statusText}`,
          response.status === 429 ? "RATE_LIMITED" : "SOURCE_UNAVAILABLE",
          "ripe_stat"
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `RIPE Atlas POST failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "ripe_stat",
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async createMeasurement(
      def: AtlasMeasurementDef
    ): Promise<AtlasMeasurement> {
      // TODO: Map AtlasMeasurementDef to Atlas API v2 measurement creation body
      // TODO: Handle probe selection (area, country, prefix, asn)
      const body = {
        definitions: [
          {
            type: def.type,
            af: def.af ?? 4,
            target: def.target,
            description: def.description ?? `PeerCortex ${def.type} to ${def.target}`,
            is_oneoff: def.isOneoff ?? true,
          },
        ],
        probes: [
          {
            type: def.probeType ?? "area",
            value: def.probeValue ?? "WW",
            requested: def.probesRequested ?? 10,
          },
        ],
      };

      const result = await post<{ measurements: ReadonlyArray<number> }>(
        "/measurements",
        body
      );

      // Fetch the full measurement metadata
      return this.getMeasurement(result.measurements[0]);
    },

    async getMeasurement(id: number): Promise<AtlasMeasurement> {
      return get<AtlasMeasurement>(`/measurements/${id}`);
    },

    async getTracerouteResults(
      measurementId: number
    ): Promise<ReadonlyArray<TracerouteResult>> {
      // TODO: Handle pagination for large result sets
      return get<ReadonlyArray<TracerouteResult>>(
        `/measurements/${measurementId}/results`
      );
    },

    async getPingResults(
      measurementId: number
    ): Promise<ReadonlyArray<PingResult>> {
      // TODO: Handle pagination for large result sets
      return get<ReadonlyArray<PingResult>>(
        `/measurements/${measurementId}/results`
      );
    },

    async searchProbes(params): Promise<ReadonlyArray<AtlasProbe>> {
      // TODO: Map params to Atlas API query parameters
      const queryParams: Record<string, string | number | boolean | undefined> = {
        asn_v4: params.asn,
        country_code: params.countryCode,
        prefix_v4: params.prefix,
        is_anchor: params.isAnchor,
        limit: params.limit ?? 100,
      };

      const result = await get<{ results: ReadonlyArray<AtlasProbe> }>(
        "/probes",
        queryParams
      );
      return result.results;
    },

    async listAnchors(countryCode?: string): Promise<ReadonlyArray<AtlasAnchor>> {
      const params: Record<string, string | undefined> = {
        country: countryCode,
      };

      const result = await get<{ results: ReadonlyArray<AtlasAnchor> }>(
        "/anchors",
        params
      );
      return result.results;
    },

    async healthCheck(): Promise<boolean> {
      try {
        await get("/status-check");
        return true;
      } catch {
        return false;
      }
    },
  };
}
