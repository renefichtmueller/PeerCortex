/**
 * @module mcp-server/tools/compare
 * MCP Tool: Network comparison — side-by-side analysis of two ASNs.
 *
 * Compares networks across multiple dimensions: size, IX presence,
 * peering policy, RPKI deployment, and geographic coverage.
 */

import { z } from "zod";
import { parseASN } from "../../types/common.js";
import type { PeeringPolicy, NetworkScope, NetworkType } from "../../types/common.js";

// ── Tool Schemas ─────────────────────────────────────────

/** Input schema for network comparison */
export const networkCompareSchema = z.object({
  asn1: z
    .union([z.string(), z.number()])
    .describe("First ASN to compare (e.g., 13335 or 'AS13335')"),
  asn2: z
    .union([z.string(), z.number()])
    .describe("Second ASN to compare"),
  include_ai_analysis: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include AI-generated comparison narrative"),
});

// ── Types ────────────────────────────────────────────────

/** Network comparison result */
export interface NetworkComparison {
  readonly network1: NetworkSummary;
  readonly network2: NetworkSummary;
  readonly commonIXs: ReadonlyArray<string>;
  readonly commonFacilities: ReadonlyArray<string>;
  readonly uniqueIXs1: ReadonlyArray<string>;
  readonly uniqueIXs2: ReadonlyArray<string>;
  readonly peeringPotential: {
    readonly score: number;
    readonly canPeerAt: ReadonlyArray<string>;
    readonly recommendation: string;
  };
  readonly aiAnalysis?: string;
}

/** Summary of a single network for comparison */
export interface NetworkSummary {
  readonly asn: number;
  readonly name: string;
  readonly networkType: NetworkType;
  readonly peeringPolicy: PeeringPolicy;
  readonly scope: NetworkScope;
  readonly prefixCount: { readonly v4: number; readonly v6: number };
  readonly ixCount: number;
  readonly facilityCount: number;
  readonly rpkiCoverage: number;
  readonly ixList: ReadonlyArray<string>;
  readonly facilityList: ReadonlyArray<string>;
}

// ── Tool Handlers ────────────────────────────────────────

/**
 * Compare two networks side by side.
 *
 * Fetches data for both networks from PeeringDB, RIPE Stat, and RPKI,
 * then generates a structured comparison with overlap analysis.
 *
 * @example
 * ```
 * > Compare AS13335 and AS32934 — where do they peer?
 *
 * Returns: Side-by-side metrics, common/unique IXs, common facilities,
 *          peering potential score, and AI analysis.
 * ```
 */
export async function handleNetworkCompare(
  input: z.infer<typeof networkCompareSchema>
): Promise<NetworkComparison> {
  const asn1 = parseASN(input.asn1);
  const asn2 = parseASN(input.asn2);

  // TODO: Implementation steps:
  // 1. Fetch both networks from PeeringDB (parallel)
  // 2. Get IX connections for both (parallel)
  // 3. Get RPKI coverage for both (parallel)
  // 4. Calculate common and unique IXs/facilities
  // 5. Score peering potential
  // 6. If include_ai_analysis, generate narrative comparison

  const emptySummary = (asn: number): NetworkSummary => ({
    asn,
    name: "", // TODO: From PeeringDB
    networkType: "Content",
    peeringPolicy: "open",
    scope: "Global",
    prefixCount: { v4: 0, v6: 0 },
    ixCount: 0,
    facilityCount: 0,
    rpkiCoverage: 0,
    ixList: [],
    facilityList: [],
  });

  return {
    network1: emptySummary(asn1),
    network2: emptySummary(asn2),
    commonIXs: [], // TODO: Compute intersection
    commonFacilities: [],
    uniqueIXs1: [],
    uniqueIXs2: [],
    peeringPotential: {
      score: 0,
      canPeerAt: [],
      recommendation: "",
    },
    aiAnalysis: input.include_ai_analysis ? "" : undefined,
  };
}

/**
 * Find the intersection of two arrays.
 * Returns elements present in both arrays.
 */
export function findIntersection<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): ReadonlyArray<T> {
  const setB = new Set(b);
  return a.filter((item) => setB.has(item));
}

/**
 * Find elements in array A that are not in array B.
 */
export function findDifference<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): ReadonlyArray<T> {
  const setB = new Set(b);
  return a.filter((item) => !setB.has(item));
}
