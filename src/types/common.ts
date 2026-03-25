/**
 * @module types/common
 * Shared type definitions used across PeerCortex.
 * These types represent the core domain objects for network intelligence.
 */

// ── ASN Types ────────────────────────────────────────────

/** Autonomous System Number (e.g., 13335 for Cloudflare) */
export type ASN = number;

/** String representation of an ASN (e.g., "AS13335") */
export type ASNString = `AS${number}`;

/** Parse an ASN from various formats */
export function parseASN(input: string | number): ASN {
  if (typeof input === "number") return input;
  const cleaned = input.toUpperCase().replace(/^AS/, "");
  const asn = parseInt(cleaned, 10);
  if (isNaN(asn) || asn < 0 || asn > 4294967295) {
    throw new Error(`Invalid ASN: ${input}`);
  }
  return asn;
}

/** Format an ASN number to string notation */
export function formatASN(asn: ASN): ASNString {
  return `AS${asn}` as ASNString;
}

// ── Prefix Types ─────────────────────────────────────────

/** IP version */
export type IPVersion = 4 | 6;

/** An IP prefix (e.g., "185.1.0.0/24") */
export interface Prefix {
  readonly prefix: string;
  readonly ip: string;
  readonly cidr: number;
  readonly version: IPVersion;
}

/** Parse a prefix string into a structured object */
export function parsePrefix(input: string): Prefix {
  const parts = input.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid prefix format: ${input}`);
  }
  const ip = parts[0];
  const cidr = parseInt(parts[1], 10);
  const version: IPVersion = ip.includes(":") ? 6 : 4;

  return { prefix: input, ip, cidr, version };
}

// ── Internet Exchange Types ──────────────────────────────

/** Internet Exchange Point identifier */
export interface InternetExchange {
  readonly id: number;
  readonly name: string;
  readonly nameLong: string;
  readonly city: string;
  readonly country: string;
  readonly website: string;
  readonly peeringdbUrl: string;
  readonly participantCount: number;
}

// ── Network Information ──────────────────────────────────

/** Peering policy classification */
export type PeeringPolicy =
  | "open"
  | "selective"
  | "restrictive"
  | "no"
  | "by-agreement";

/** Network type classification */
export type NetworkType =
  | "NSP"
  | "Content"
  | "Enterprise"
  | "Non-Profit"
  | "Educational/Research"
  | "Route Server"
  | "Government"
  | "Cable/DSL/ISP"
  | "Route Collector";

/** Network scope */
export type NetworkScope =
  | "Regional"
  | "North America"
  | "Asia Pacific"
  | "Europe"
  | "South America"
  | "Africa"
  | "Middle East"
  | "Global";

/** Unified network information gathered from multiple sources */
export interface NetworkInfo {
  readonly asn: ASN;
  readonly name: string;
  readonly aka: string;
  readonly description: string;
  readonly website: string;
  readonly lookingGlass: string;
  readonly peeringPolicy: PeeringPolicy;
  readonly networkType: NetworkType;
  readonly scope: NetworkScope;
  readonly prefixCount4: number;
  readonly prefixCount6: number;
  readonly ixCount: number;
  readonly facilityCount: number;
  readonly irr: {
    readonly asSet: string;
    readonly routeObjects: ReadonlyArray<string>;
  };
  readonly rpki: {
    readonly roaCount: number;
    readonly coveragePercent: number;
    readonly validPrefixes: number;
    readonly invalidPrefixes: number;
    readonly unknownPrefixes: number;
  };
  readonly sources: ReadonlyArray<DataSourceName>;
  readonly lastUpdated: string;
}

// ── Peering Types ────────────────────────────────────────

/** A potential peering partner match */
export interface PeeringMatch {
  readonly asn: ASN;
  readonly name: string;
  readonly peeringPolicy: PeeringPolicy;
  readonly commonIXs: ReadonlyArray<string>;
  readonly commonFacilities: ReadonlyArray<string>;
  readonly score: number;
  readonly reason: string;
  readonly contactEmail: string;
}

/** Peering request draft */
export interface PeeringRequest {
  readonly targetASN: ASN;
  readonly targetName: string;
  readonly ix: string;
  readonly subject: string;
  readonly body: string;
}

// ── BGP Types ────────────────────────────────────────────

/** BGP route entry */
export interface BGPRoute {
  readonly prefix: string;
  readonly originASN: ASN;
  readonly asPath: ReadonlyArray<ASN>;
  readonly nextHop: string;
  readonly communities: ReadonlyArray<string>;
  readonly timestamp: string;
}

/** BGP anomaly severity levels */
export type AnomalySeverity = "critical" | "high" | "medium" | "low" | "info";

/** BGP anomaly type classification */
export type AnomalyType =
  | "route_leak"
  | "bgp_hijack"
  | "moas_conflict"
  | "path_anomaly"
  | "prefix_more_specific"
  | "withdrawal_storm"
  | "rpki_invalid";

/** A detected BGP anomaly */
export interface BGPAnomaly {
  readonly type: AnomalyType;
  readonly severity: AnomalySeverity;
  readonly prefix: string;
  readonly description: string;
  readonly affectedASNs: ReadonlyArray<ASN>;
  readonly detectedAt: string;
  readonly source: DataSourceName;
  readonly details: Record<string, unknown>;
}

// ── RPKI Types ───────────────────────────────────────────

/** RPKI validation state */
export type RPKIValidationState = "valid" | "invalid" | "not-found" | "unknown";

/** RPKI Route Origin Authorization */
export interface ROA {
  readonly prefix: string;
  readonly maxLength: number;
  readonly asn: ASN;
  readonly ta: string;
  readonly validityStart: string;
  readonly validityEnd: string;
}

/** RPKI validation result for a prefix */
export interface RPKIValidation {
  readonly prefix: string;
  readonly originASN: ASN;
  readonly state: RPKIValidationState;
  readonly matchingROAs: ReadonlyArray<ROA>;
  readonly reason: string;
}

/** RPKI compliance report for an ASN */
export interface RPKIComplianceReport {
  readonly asn: ASN;
  readonly name: string;
  readonly totalPrefixes: number;
  readonly validPrefixes: number;
  readonly invalidPrefixes: number;
  readonly unknownPrefixes: number;
  readonly coveragePercent: number;
  readonly recommendations: ReadonlyArray<string>;
  readonly generatedAt: string;
}

// ── Report Types ─────────────────────────────────────────

/** Report format options */
export type ReportFormat = "markdown" | "json" | "text";

/** Report type classification */
export type ReportType =
  | "peering_readiness"
  | "rpki_compliance"
  | "network_comparison"
  | "bgp_health"
  | "ix_analysis";

/** Generated report */
export interface Report {
  readonly type: ReportType;
  readonly title: string;
  readonly format: ReportFormat;
  readonly content: string;
  readonly metadata: {
    readonly generatedAt: string;
    readonly sources: ReadonlyArray<DataSourceName>;
    readonly dataFreshness: string;
  };
}

// ── Data Source Types ────────────────────────────────────

/** Supported data source names */
export type DataSourceName =
  | "peeringdb"
  | "ripe_stat"
  | "bgp_he"
  | "route_views"
  | "irr"
  | "rpki";

/** Health status of a data source */
export interface DataSourceHealth {
  readonly name: DataSourceName;
  readonly available: boolean;
  readonly latencyMs: number;
  readonly lastChecked: string;
  readonly error?: string;
}

// ── Cache Types ──────────────────────────────────────────

/** Cache entry metadata */
export interface CacheEntry<T> {
  readonly key: string;
  readonly data: T;
  readonly source: DataSourceName;
  readonly cachedAt: string;
  readonly expiresAt: string;
}

// ── Error Types ──────────────────────────────────────────

/** PeerCortex error codes */
export type ErrorCode =
  | "INVALID_ASN"
  | "INVALID_PREFIX"
  | "SOURCE_UNAVAILABLE"
  | "RATE_LIMITED"
  | "CACHE_ERROR"
  | "AI_UNAVAILABLE"
  | "PARSE_ERROR"
  | "TIMEOUT"
  | "UNKNOWN";

/** Structured error for PeerCortex operations */
export class PeerCortexError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly source?: DataSourceName,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "PeerCortexError";
  }
}
