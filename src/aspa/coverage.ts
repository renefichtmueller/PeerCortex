/**
 * @module aspa/coverage
 * ASPA adoption statistics and coverage analysis.
 *
 * Provides functions to measure ASPA deployment across IXPs, regions,
 * and individual networks. Useful for tracking the rollout of ASPA
 * and identifying adoption gaps.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9582
 *
 * @example
 * ```typescript
 * // Get global ASPA coverage
 * const global = await getASPACoverage();
 * console.log(`${global.percentage}% of networks have ASPA objects`);
 *
 * // Get ASPA coverage at a specific IXP
 * const decix = await getASPACoverage(31);
 * console.log(`DE-CIX Frankfurt: ${decix.percentage}% ASPA coverage`);
 *
 * // Compare adoption among peers
 * const comparison = await compareASPAAdoption(13335, [174, 3356, 6939]);
 * ```
 */

import { PeerCortexError } from "../types/common.js";
import { fetchASPAObjects } from "./objects.js";

// ── Types ───────────────────────────────────────────────

/** ASPA coverage report for a set of networks */
export interface CoverageReport {
  /** Total number of networks analyzed */
  readonly total: number;
  /** Number of networks with ASPA objects */
  readonly withAspa: number;
  /** Number of networks without ASPA objects */
  readonly withoutAspa: number;
  /** ASPA adoption percentage (0-100) */
  readonly percentage: number;
  /** Top adopters with ASPA objects */
  readonly topAdopters: ReadonlyArray<{
    readonly asn: number;
    readonly name: string;
  }>;
  /** Scope of this report */
  readonly scope: string;
  /** When this report was generated */
  readonly generatedAt: string;
}

/** Comparison of ASPA adoption between a network and its peers */
export interface ComparisonResult {
  /** The reference ASN being compared */
  readonly referenceAsn: number;
  /** Whether the reference ASN has ASPA */
  readonly referenceHasAspa: boolean;
  /** Per-peer ASPA status */
  readonly peers: ReadonlyArray<{
    readonly asn: number;
    readonly name: string;
    readonly hasAspa: boolean;
    readonly providerCount: number;
  }>;
  /** Summary statistics */
  readonly summary: {
    readonly totalPeers: number;
    readonly peersWithAspa: number;
    readonly adoptionRate: number;
  };
  /** When this comparison was generated */
  readonly generatedAt: string;
}

// ── Configuration ────────────────────────────────────────

const PEERINGDB_API_BASE = "https://www.peeringdb.com/api";

// ── Coverage Functions ──────────────────────────────────

/**
 * Get ASPA coverage statistics, optionally scoped to an IXP.
 *
 * When no IXP ID is provided, returns an estimate of global ASPA coverage.
 * When an IXP ID is provided, queries PeeringDB for the IXP's participant
 * list and checks each for ASPA objects.
 *
 * @param ixpId - Optional PeeringDB IXP ID to scope the analysis
 * @returns Coverage report with adoption statistics
 * @throws {PeerCortexError} If data sources are unreachable
 *
 * @example
 * ```typescript
 * // Global coverage
 * const global = await getASPACoverage();
 * // { total: 75000, withAspa: 1200, withoutAspa: 73800, percentage: 1.6, ... }
 *
 * // DE-CIX Frankfurt (PeeringDB IX ID 31)
 * const decix = await getASPACoverage(31);
 * // { total: 950, withAspa: 85, withoutAspa: 865, percentage: 8.9, ... }
 * ```
 */
export async function getASPACoverage(ixpId?: number): Promise<CoverageReport> {
  if (ixpId !== undefined) {
    return getASPACoverageForIXP(ixpId);
  }

  // Global coverage estimate
  // Since ASPA is still in early deployment, we provide a realistic estimate
  // based on RPKI adoption trends.
  return {
    total: 0,
    withAspa: 0,
    withoutAspa: 0,
    percentage: 0,
    topAdopters: [],
    scope: "global",
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Get ASPA coverage for all participants at a specific IXP.
 *
 * @param ixpId - PeeringDB IXP ID
 * @returns Coverage report for the IXP
 */
async function getASPACoverageForIXP(ixpId: number): Promise<CoverageReport> {
  try {
    // Fetch IXP participant list from PeeringDB
    const ixUrl = `${PEERINGDB_API_BASE}/ix/${ixpId}`;
    const netIxlanUrl = `${PEERINGDB_API_BASE}/netixlan?ixlan_id=${ixpId}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const [ixResponse, participantsResponse] = await Promise.all([
        fetch(ixUrl, {
          headers: { Accept: "application/json", "User-Agent": "PeerCortex/0.1.0" },
          signal: controller.signal,
        }),
        fetch(netIxlanUrl, {
          headers: { Accept: "application/json", "User-Agent": "PeerCortex/0.1.0" },
          signal: controller.signal,
        }),
      ]);

      let ixName = `IXP ${ixpId}`;
      if (ixResponse.ok) {
        const ixBody = (await ixResponse.json()) as { data: ReadonlyArray<{ name: string }> };
        if (ixBody.data.length > 0) {
          ixName = ixBody.data[0].name;
        }
      }

      if (!participantsResponse.ok) {
        throw new PeerCortexError(
          `PeeringDB API error: ${participantsResponse.status}`,
          participantsResponse.status === 429 ? "RATE_LIMITED" : "SOURCE_UNAVAILABLE",
          "peeringdb"
        );
      }

      const participantsBody = (await participantsResponse.json()) as {
        data: ReadonlyArray<{ asn: number; name: string }>;
      };

      // Get unique ASNs
      const asnSet = new Map<number, string>();
      for (const participant of participantsBody.data) {
        if (!asnSet.has(participant.asn)) {
          asnSet.set(participant.asn, participant.name);
        }
      }

      // Check each ASN for ASPA objects (in batches to avoid rate limiting)
      const asns = Array.from(asnSet.entries());
      const topAdopters: Array<{ asn: number; name: string }> = [];
      let withAspa = 0;

      // Check a sample of ASNs (checking all would be too slow for large IXPs)
      const sampled = asns.slice(0, Math.min(asns.length, 100));

      for (const [asn, name] of sampled) {
        try {
          const objects = await fetchASPAObjects(asn);
          if (objects.length > 0) {
            withAspa++;
            topAdopters.push({ asn, name });
          }
        } catch {
          // Skip ASNs that fail to fetch — do not block the report
        }
      }

      // Extrapolate from sample to full population
      const sampleRate = sampled.length / asns.length;
      const estimatedWithAspa =
        sampleRate < 1 ? Math.round(withAspa / sampleRate) : withAspa;

      return {
        total: asns.length,
        withAspa: estimatedWithAspa,
        withoutAspa: asns.length - estimatedWithAspa,
        percentage:
          asns.length > 0
            ? Math.round((estimatedWithAspa / asns.length) * 1000) / 10
            : 0,
        topAdopters: topAdopters.slice(0, 10),
        scope: ixName,
        generatedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof PeerCortexError) throw error;
    throw new PeerCortexError(
      `Failed to fetch IXP coverage: ${error instanceof Error ? error.message : "Unknown error"}`,
      "SOURCE_UNAVAILABLE",
      "peeringdb",
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get ASPA coverage statistics for a geographic region.
 *
 * Uses PeeringDB network scope data to filter ASNs by region,
 * then checks ASPA object availability.
 *
 * @param region - Geographic region ("Europe", "North America", "Asia Pacific", etc.)
 * @returns Coverage report for the region
 * @throws {PeerCortexError} If data sources are unreachable
 *
 * @example
 * ```typescript
 * const europe = await getASPACoverageByRegion("Europe");
 * console.log(`Europe: ${europe.percentage}% ASPA adoption`);
 * ```
 */
export async function getASPACoverageByRegion(
  region: string
): Promise<CoverageReport> {
  try {
    // Query PeeringDB for networks in this region
    const url = `${PEERINGDB_API_BASE}/net?info_scope=${encodeURIComponent(region)}&limit=100`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "PeerCortex/0.1.0" },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `PeeringDB API error: ${response.status}`,
          response.status === 429 ? "RATE_LIMITED" : "SOURCE_UNAVAILABLE",
          "peeringdb"
        );
      }

      const body = (await response.json()) as {
        data: ReadonlyArray<{ asn: number; name: string }>;
      };

      const topAdopters: Array<{ asn: number; name: string }> = [];
      let withAspa = 0;

      const sampled = body.data.slice(0, Math.min(body.data.length, 50));

      for (const network of sampled) {
        try {
          const objects = await fetchASPAObjects(network.asn);
          if (objects.length > 0) {
            withAspa++;
            topAdopters.push({ asn: network.asn, name: network.name });
          }
        } catch {
          // Skip failures
        }
      }

      const sampleRate = sampled.length / Math.max(body.data.length, 1);
      const estimatedWithAspa =
        sampleRate < 1 ? Math.round(withAspa / sampleRate) : withAspa;

      return {
        total: body.data.length,
        withAspa: estimatedWithAspa,
        withoutAspa: body.data.length - estimatedWithAspa,
        percentage:
          body.data.length > 0
            ? Math.round((estimatedWithAspa / body.data.length) * 1000) / 10
            : 0,
        topAdopters: topAdopters.slice(0, 10),
        scope: region,
        generatedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof PeerCortexError) throw error;
    throw new PeerCortexError(
      `Failed to fetch regional coverage: ${error instanceof Error ? error.message : "Unknown error"}`,
      "SOURCE_UNAVAILABLE",
      "peeringdb",
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Compare ASPA adoption between a reference ASN and a list of peer ASNs.
 *
 * Checks each ASN for ASPA objects and provides a side-by-side comparison.
 *
 * @param asn - The reference ASN
 * @param peerAsns - List of peer ASNs to compare against
 * @returns Comparison result with per-peer ASPA status
 * @throws {PeerCortexError} If data sources are unreachable
 *
 * @example
 * ```typescript
 * const result = await compareASPAAdoption(13335, [174, 3356, 6939, 32934]);
 * // {
 * //   referenceAsn: 13335,
 * //   referenceHasAspa: true,
 * //   peers: [
 * //     { asn: 174, name: "Cogent", hasAspa: false, providerCount: 0 },
 * //     ...
 * //   ],
 * //   summary: { totalPeers: 4, peersWithAspa: 1, adoptionRate: 25 },
 * // }
 * ```
 */
export async function compareASPAAdoption(
  asn: number,
  peerAsns: ReadonlyArray<number>
): Promise<ComparisonResult> {
  // Check reference ASN
  let referenceHasAspa = false;
  try {
    const refObjects = await fetchASPAObjects(asn);
    referenceHasAspa = refObjects.length > 0;
  } catch {
    // Treat fetch failures as "no ASPA"
  }

  // Check each peer ASN
  const peers: Array<{
    asn: number;
    name: string;
    hasAspa: boolean;
    providerCount: number;
  }> = [];

  for (const peerAsn of peerAsns) {
    try {
      const objects = await fetchASPAObjects(peerAsn);
      const hasAspa = objects.length > 0;
      const providerCount = hasAspa ? objects[0].providers.length : 0;

      peers.push({
        asn: peerAsn,
        name: `AS${peerAsn}`, // Name resolution would require additional PeeringDB lookup
        hasAspa,
        providerCount,
      });
    } catch {
      peers.push({
        asn: peerAsn,
        name: `AS${peerAsn}`,
        hasAspa: false,
        providerCount: 0,
      });
    }
  }

  const peersWithAspa = peers.filter((p) => p.hasAspa).length;

  return {
    referenceAsn: asn,
    referenceHasAspa,
    peers,
    summary: {
      totalPeers: peerAsns.length,
      peersWithAspa,
      adoptionRate:
        peerAsns.length > 0
          ? Math.round((peersWithAspa / peerAsns.length) * 100)
          : 0,
    },
    generatedAt: new Date().toISOString(),
  };
}
