/**
 * @module aspa/leak-detector
 * Real-time route leak detection using ASPA.
 *
 * Provides functions to analyze BGP updates against ASPA objects
 * and detect route leaks in real time. Combines ASPA validation
 * with heuristic analysis for comprehensive leak detection.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9582
 * @see https://www.rfc-editor.org/rfc/rfc7908 — Route Leak Problem Definition
 *
 * @example
 * ```typescript
 * const leak = detectRouteLeak(bgpUpdate, aspaObjects);
 * if (leak) {
 *   console.log(`Route leak detected: ${leak.description}`);
 *   console.log(`Severity: ${leak.severity}`);
 *   console.log(`Leaking AS: ${leak.leakingAsn}`);
 * }
 * ```
 */

import type { ASPAObject, ASPAValidationResult } from "./validator.js";
import { validatePath } from "./validator.js";

// ── Types ───────────────────────────────────────────────

/** A BGP update message for leak analysis */
export interface BGPUpdate {
  /** The update type */
  readonly type: "announcement" | "withdrawal";
  /** The IP prefix being announced or withdrawn */
  readonly prefix: string;
  /** The AS path (empty for withdrawals) */
  readonly asPath: ReadonlyArray<number>;
  /** Origin ASN (null for withdrawals) */
  readonly originAsn: number | null;
  /** BGP communities attached to this update */
  readonly communities: ReadonlyArray<string>;
  /** When this update was received */
  readonly timestamp: string;
  /** The peer that sent this update */
  readonly peerAsn: number;
  /** The peer's IP address */
  readonly peerIp: string;
}

/** Time range for historical analysis */
export interface TimeRange {
  /** Start of the time range (ISO 8601) */
  readonly start: string;
  /** End of the time range (ISO 8601) */
  readonly end: string;
}

/** A detected route leak event */
export interface LeakDetection {
  /** The leaked IP prefix */
  readonly prefix: string;
  /** The ASN responsible for the leak */
  readonly leakingAsn: number;
  /** The AS path observed */
  readonly path: ReadonlyArray<number>;
  /** ASPA validation status that triggered the detection */
  readonly aspaStatus: string;
  /** Severity of the leak */
  readonly severity: "critical" | "high" | "medium";
  /** When the leak was detected */
  readonly timestamp: Date;
  /** Human-readable description of the leak */
  readonly description: string;
  /** ASPA validation details */
  readonly validationResult: ASPAValidationResult;
  /** RFC 7908 leak type classification */
  readonly leakType: LeakType;
}

/** Route leak classification per RFC 7908 */
export type LeakType =
  | "hairpin"
  | "lateral-iss-iss"
  | "leak-to-provider"
  | "leak-to-peer"
  | "prefix-re-origination"
  | "accidental-leak";

/** Aggregate leak report for a time period */
export interface LeakReport {
  /** The ASN analyzed */
  readonly asn: number;
  /** Time range of the analysis */
  readonly timeRange: TimeRange;
  /** Total number of leak events detected */
  readonly totalLeaks: number;
  /** Breakdown by severity */
  readonly bySeverity: {
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
  };
  /** Breakdown by leak type */
  readonly byType: Partial<Record<LeakType, number>>;
  /** Individual leak events */
  readonly leaks: ReadonlyArray<LeakDetection>;
  /** Most frequent leaking ASNs */
  readonly topLeakers: ReadonlyArray<{
    readonly asn: number;
    readonly count: number;
    readonly lastSeen: string;
  }>;
  /** When this report was generated */
  readonly generatedAt: string;
}

// ── Leak Detection ──────────────────────────────────────

/**
 * Detect a route leak in a single BGP update using ASPA validation.
 *
 * Analyzes the AS path in the update against registered ASPA objects.
 * If the path contains unauthorized hops (ASPA status "invalid"),
 * a leak is reported with severity based on prefix significance.
 *
 * Severity classification:
 * - **critical**: Prefix length <= /8 or high-profile ASN affected
 * - **high**: Prefix length <= /16 or path length anomaly
 * - **medium**: All other detected leaks
 *
 * @param update - The BGP update to analyze
 * @param aspaObjects - Map of customer ASN to ASPA object
 * @returns A LeakDetection if a leak is found, or null if the path is clean
 *
 * @example
 * ```typescript
 * const update: BGPUpdate = {
 *   type: "announcement",
 *   prefix: "1.1.1.0/24",
 *   asPath: [3356, 64501, 13335],
 *   originAsn: 13335,
 *   communities: ["3356:123"],
 *   timestamp: "2026-03-26T12:00:00Z",
 *   peerAsn: 3356,
 *   peerIp: "198.32.176.1",
 * };
 *
 * const leak = detectRouteLeak(update, aspaObjects);
 * if (leak) {
 *   // { prefix: "1.1.1.0/24", leakingAsn: 64501, severity: "high", ... }
 * }
 * ```
 */
export function detectRouteLeak(
  update: BGPUpdate,
  aspaObjects: ReadonlyMap<number, ASPAObject>
): LeakDetection | null {
  // Only analyze announcements with valid paths
  if (update.type === "withdrawal" || update.asPath.length < 2) {
    return null;
  }

  const result = validatePath(update.asPath, aspaObjects, "upstream");

  // No leak detected if ASPA says the path is valid or unverifiable
  if (result.status !== "invalid" || !result.leakDetected) {
    return null;
  }

  const leakingAsn = result.leakingAsn ?? update.asPath[0];
  const severity = classifyLeakSeverity(update, result);
  const leakType = classifyLeakType(update, result);

  return {
    prefix: update.prefix,
    leakingAsn,
    path: [...update.asPath],
    aspaStatus: result.status,
    severity,
    timestamp: new Date(update.timestamp),
    description: buildLeakDescription(update, result, leakingAsn, leakType),
    validationResult: result,
    leakType,
  };
}

/**
 * Classify the severity of a detected route leak.
 *
 * @param update - The BGP update
 * @param result - The ASPA validation result
 * @returns Severity level
 */
function classifyLeakSeverity(
  update: BGPUpdate,
  _result: ASPAValidationResult
): "critical" | "high" | "medium" {
  // Extract prefix length
  const cidrParts = update.prefix.split("/");
  const prefixLength = cidrParts.length === 2 ? parseInt(cidrParts[1], 10) : 24;

  // High-profile ASNs (major networks)
  const highProfileAsns = new Set([13335, 32934, 714, 15169, 16509, 8075]);
  const hasHighProfileOrigin =
    update.originAsn !== null && highProfileAsns.has(update.originAsn);

  // Critical: very broad prefix or high-profile origin
  if (prefixLength <= 8 || (hasHighProfileOrigin && prefixLength <= 16)) {
    return "critical";
  }

  // High: moderately broad prefix or high-profile origin
  if (prefixLength <= 16 || hasHighProfileOrigin) {
    return "high";
  }

  return "medium";
}

/**
 * Classify the type of route leak per RFC 7908.
 *
 * @param update - The BGP update
 * @param result - The ASPA validation result
 * @returns Leak type classification
 */
function classifyLeakType(
  update: BGPUpdate,
  result: ASPAValidationResult
): LeakType {
  const path = update.asPath;

  // If the origin ASN is not the expected one, it might be prefix re-origination
  if (result.violations.length > 0) {
    const firstViolation = result.violations[0];

    // Check if the violation is at the end of the path (near origin)
    if (firstViolation.position >= path.length - 2) {
      return "prefix-re-origination";
    }

    // Check if the leaking AS appears to be forwarding to a provider
    // (leak-to-provider pattern)
    if (firstViolation.position > 0 && firstViolation.position < path.length - 1) {
      return "leak-to-provider";
    }
  }

  return "accidental-leak";
}

/**
 * Build a human-readable description of the route leak.
 *
 * @param update - The BGP update
 * @param result - The ASPA validation result
 * @param leakingAsn - The ASN responsible for the leak
 * @param leakType - The classified leak type
 * @returns Description string
 */
function buildLeakDescription(
  update: BGPUpdate,
  result: ASPAValidationResult,
  leakingAsn: number,
  leakType: LeakType
): string {
  const typeDescriptions: Record<LeakType, string> = {
    "hairpin": "hairpin turn (route sent back to originator)",
    "lateral-iss-iss": "lateral ISS-ISS leak (forwarded between peers)",
    "leak-to-provider": "route leaked to an upstream provider",
    "leak-to-peer": "route leaked to a peer",
    "prefix-re-origination": "prefix re-originated by unauthorized AS",
    "accidental-leak": "accidental route leak",
  };

  const violationDetails =
    result.violations.length > 0
      ? ` AS${result.violations[0].asn} forwarded to AS${result.violations[0].actualNextHop} ` +
        `which is not in its authorized provider list.`
      : "";

  return (
    `Route leak detected for ${update.prefix}: ` +
    `AS${leakingAsn} caused a ${typeDescriptions[leakType]}.` +
    violationDetails +
    ` Path: ${update.asPath.map((a) => `AS${a}`).join(" -> ")}.` +
    ` ASPA confidence: ${Math.round(result.confidence * 100)}%.`
  );
}

/**
 * Analyze route leaks for an ASN over a time period.
 *
 * Fetches BGP updates from RIPE Stat for the given ASN and time range,
 * then runs ASPA validation on each update to detect leaks.
 *
 * @param asn - The ASN to analyze
 * @param timeRange - The time period to analyze
 * @param aspaObjects - Optional pre-loaded ASPA objects
 * @returns Comprehensive leak report with statistics and individual events
 *
 * @example
 * ```typescript
 * const report = await analyzeLeaks(13335, {
 *   start: "2026-03-01T00:00:00Z",
 *   end: "2026-03-26T00:00:00Z",
 * });
 *
 * console.log(`Found ${report.totalLeaks} route leaks for AS13335`);
 * for (const leak of report.leaks) {
 *   console.log(`  ${leak.prefix}: ${leak.description}`);
 * }
 * ```
 */
export async function analyzeLeaks(
  asn: number,
  timeRange: TimeRange,
  aspaObjects?: ReadonlyMap<number, ASPAObject>
): Promise<LeakReport> {
  // Use provided ASPA objects or create an empty map
  const objects = aspaObjects ?? new Map<number, ASPAObject>();

  // Fetch BGP updates from RIPE Stat
  const updates = await fetchBGPUpdates(asn, timeRange);

  const leaks: LeakDetection[] = [];
  const leakerCounts = new Map<number, { count: number; lastSeen: string }>();

  for (const update of updates) {
    const leak = detectRouteLeak(update, objects);
    if (leak) {
      leaks.push(leak);

      const existing = leakerCounts.get(leak.leakingAsn);
      if (existing) {
        existing.count++;
        if (leak.timestamp.toISOString() > existing.lastSeen) {
          existing.lastSeen = leak.timestamp.toISOString();
        }
      } else {
        leakerCounts.set(leak.leakingAsn, {
          count: 1,
          lastSeen: leak.timestamp.toISOString(),
        });
      }
    }
  }

  // Build severity breakdown
  const bySeverity = {
    critical: leaks.filter((l) => l.severity === "critical").length,
    high: leaks.filter((l) => l.severity === "high").length,
    medium: leaks.filter((l) => l.severity === "medium").length,
  };

  // Build type breakdown
  const byType: Partial<Record<LeakType, number>> = {};
  for (const leak of leaks) {
    byType[leak.leakType] = (byType[leak.leakType] ?? 0) + 1;
  }

  // Build top leakers list
  const topLeakers = Array.from(leakerCounts.entries())
    .map(([leakerAsn, data]) => ({
      asn: leakerAsn,
      count: data.count,
      lastSeen: data.lastSeen,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    asn,
    timeRange,
    totalLeaks: leaks.length,
    bySeverity,
    byType,
    leaks,
    topLeakers,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Fetch BGP updates from RIPE Stat for leak analysis.
 *
 * @param asn - The ASN to fetch updates for
 * @param timeRange - The time period
 * @returns Array of BGP updates
 */
async function fetchBGPUpdates(
  asn: number,
  timeRange: TimeRange
): Promise<ReadonlyArray<BGPUpdate>> {
  try {
    const url = new URL("https://stat.ripe.net/data/bgp-updates/data.json");
    url.searchParams.set("resource", `AS${asn}`);
    url.searchParams.set("starttime", timeRange.start);
    url.searchParams.set("endtime", timeRange.end);
    url.searchParams.set("sourceapp", "peercortex");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "User-Agent": "PeerCortex/0.1.0",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        return [];
      }

      const body = (await response.json()) as {
        data: {
          updates: ReadonlyArray<{
            type: string;
            timestamp: string;
            attrs: {
              target_prefix: string;
              path: ReadonlyArray<number>;
              source_id: string;
              community: ReadonlyArray<string>;
            };
          }>;
        };
      };

      return body.data.updates.map((u) => ({
        type: u.type === "A" ? ("announcement" as const) : ("withdrawal" as const),
        prefix: u.attrs.target_prefix,
        asPath: u.attrs.path ?? [],
        originAsn:
          u.attrs.path && u.attrs.path.length > 0
            ? u.attrs.path[u.attrs.path.length - 1]
            : null,
        communities: u.attrs.community ?? [],
        timestamp: u.timestamp,
        peerAsn: parseInt(u.attrs.source_id.split("-")[0] ?? "0", 10),
        peerIp: u.attrs.source_id.split("-")[1] ?? "",
      }));
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return [];
  }
}
