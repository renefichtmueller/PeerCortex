/**
 * @module aspa/simulator
 * "What-if" ASPA deployment simulation.
 *
 * Simulates the impact of ASPA deployment on historical BGP incidents.
 * Answers questions like "How many route leaks would ASPA have prevented
 * if AS13335 had deployed it?" or "What is the aggregate prevention rate
 * across all incidents in the last 30 days?"
 *
 * @see https://www.rfc-editor.org/rfc/rfc9582
 *
 * @example
 * ```typescript
 * const result = simulateASPADeployment(13335, recentIncidents);
 * console.log(`ASPA would have prevented ${result.preventionRate}% of incidents`);
 * ```
 */

import type { ASPAObject } from "./validator.js";
import { validatePath } from "./validator.js";

// ── Types ───────────────────────────────────────────────

/** A historical BGP incident for simulation */
export interface BGPIncident {
  /** Unique identifier for the incident */
  readonly id: string;
  /** Type of BGP incident */
  readonly type: "route_leak" | "hijack" | "misconfiguration";
  /** The affected IP prefix */
  readonly prefix: string;
  /** The AS path observed during the incident */
  readonly asPath: ReadonlyArray<number>;
  /** The ASN that caused the incident (leaking/hijacking AS) */
  readonly offendingAsn: number;
  /** The victim ASN whose prefix was affected */
  readonly victimAsn: number;
  /** When the incident occurred */
  readonly timestamp: string;
  /** Human-readable description */
  readonly description: string;
  /** Severity of the incident */
  readonly severity: "critical" | "high" | "medium" | "low";
  /** Duration in seconds */
  readonly durationSeconds: number;
  /** Number of ASNs that accepted the leaked/hijacked route */
  readonly impactedAsns: number;
}

/** Result of a single incident simulation */
export interface SimulationDetail {
  /** The incident that was simulated */
  readonly incident: BGPIncident;
  /** Whether ASPA would have prevented this incident */
  readonly wouldHavePrevented: boolean;
  /** ASPA validation result status */
  readonly aspaStatus: "valid" | "invalid" | "unknown" | "unverifiable";
  /** Explanation of why ASPA would or would not have helped */
  readonly explanation: string;
  /** Which ASN's ASPA object would have caught the issue */
  readonly detectingAsn?: number;
}

/** Aggregate simulation results */
export interface SimulationResult {
  /** Total number of incidents analyzed */
  readonly totalIncidents: number;
  /** Number of incidents ASPA would have prevented */
  readonly wouldHavePrevented: number;
  /** Prevention rate as a percentage (0-100) */
  readonly preventionRate: number;
  /** Per-incident simulation details */
  readonly details: ReadonlyArray<SimulationDetail>;
  /** Breakdown by incident type */
  readonly byType: {
    readonly routeLeaks: { readonly total: number; readonly prevented: number };
    readonly hijacks: { readonly total: number; readonly prevented: number };
    readonly misconfigurations: { readonly total: number; readonly prevented: number };
  };
  /** The ASN that was the focus of this simulation */
  readonly targetAsn: number;
  /** Timestamp when the simulation was run */
  readonly simulatedAt: string;
}

// ── Simulation Functions ────────────────────────────────

/**
 * Simulate ASPA deployment for a target ASN against historical incidents.
 *
 * For each incident, creates a hypothetical ASPA object for the target ASN
 * (if it does not already have one) and runs ASPA path validation.
 * Incidents where the path would have been flagged as "invalid" are counted
 * as "prevented."
 *
 * @param targetAsn - The ASN to simulate ASPA deployment for
 * @param bgpIncidents - Historical BGP incidents to test against
 * @param existingAspaObjects - Optional existing ASPA objects to include
 * @returns Comprehensive simulation results with per-incident details
 *
 * @example
 * ```typescript
 * const incidents: BGPIncident[] = [
 *   {
 *     id: "INC-2026-001",
 *     type: "route_leak",
 *     prefix: "1.1.1.0/24",
 *     asPath: [3356, 64501, 13335],
 *     offendingAsn: 64501,
 *     victimAsn: 13335,
 *     timestamp: "2026-03-15T10:00:00Z",
 *     description: "AS64501 leaked Cloudflare prefix to AS3356",
 *     severity: "critical",
 *     durationSeconds: 1800,
 *     impactedAsns: 250,
 *   },
 * ];
 *
 * const result = simulateASPADeployment(13335, incidents);
 * // {
 * //   totalIncidents: 1,
 * //   wouldHavePrevented: 1,
 * //   preventionRate: 100,
 * //   ...
 * // }
 * ```
 */
export function simulateASPADeployment(
  targetAsn: number,
  bgpIncidents: ReadonlyArray<BGPIncident>,
  existingAspaObjects?: ReadonlyMap<number, ASPAObject>
): SimulationResult {
  // Build a mutable copy of existing ASPA objects
  const aspaObjects = new Map<number, ASPAObject>(existingAspaObjects ?? []);

  // If the target ASN doesn't have an ASPA object, create a hypothetical one.
  // We infer providers from the incident data.
  if (!aspaObjects.has(targetAsn)) {
    const inferredProviders = inferProvidersFromIncidents(targetAsn, bgpIncidents);
    aspaObjects.set(targetAsn, {
      customerAsn: targetAsn,
      providers: inferredProviders.map((asn) => ({
        asn,
        afi: ["ipv4", "ipv6"] as ReadonlyArray<"ipv4" | "ipv6">,
      })),
    });
  }

  const details: SimulationDetail[] = [];
  let routeLeaksTotal = 0;
  let routeLeaksPrevented = 0;
  let hijacksTotal = 0;
  let hijacksPrevented = 0;
  let misconfigTotal = 0;
  let misconfigPrevented = 0;

  for (const incident of bgpIncidents) {
    const detail = simulateIncident(incident, targetAsn, aspaObjects);
    details.push(detail);

    switch (incident.type) {
      case "route_leak":
        routeLeaksTotal++;
        if (detail.wouldHavePrevented) routeLeaksPrevented++;
        break;
      case "hijack":
        hijacksTotal++;
        if (detail.wouldHavePrevented) hijacksPrevented++;
        break;
      case "misconfiguration":
        misconfigTotal++;
        if (detail.wouldHavePrevented) misconfigPrevented++;
        break;
    }
  }

  const totalPrevented = details.filter((d) => d.wouldHavePrevented).length;
  const preventionRate =
    bgpIncidents.length > 0
      ? Math.round((totalPrevented / bgpIncidents.length) * 100)
      : 0;

  return {
    totalIncidents: bgpIncidents.length,
    wouldHavePrevented: totalPrevented,
    preventionRate,
    details,
    byType: {
      routeLeaks: { total: routeLeaksTotal, prevented: routeLeaksPrevented },
      hijacks: { total: hijacksTotal, prevented: hijacksPrevented },
      misconfigurations: { total: misconfigTotal, prevented: misconfigPrevented },
    },
    targetAsn,
    simulatedAt: new Date().toISOString(),
  };
}

/**
 * Simulate a single incident against ASPA objects.
 *
 * @param incident - The BGP incident to simulate
 * @param targetAsn - The ASN we are simulating deployment for
 * @param aspaObjects - The ASPA objects to validate against
 * @returns Simulation detail for this incident
 */
function simulateIncident(
  incident: BGPIncident,
  targetAsn: number,
  aspaObjects: ReadonlyMap<number, ASPAObject>
): SimulationDetail {
  const path = incident.asPath;
  const result = validatePath(path, aspaObjects, "upstream");

  if (result.status === "invalid" && result.leakDetected) {
    return {
      incident,
      wouldHavePrevented: true,
      aspaStatus: result.status,
      explanation:
        `ASPA validation would have flagged this path as invalid. ` +
        `AS${result.leakingAsn ?? incident.offendingAsn} is not an authorized provider ` +
        `in the ASPA object, so the route leak would have been detected and the path rejected.`,
      detectingAsn: targetAsn,
    };
  }

  if (result.status === "invalid") {
    return {
      incident,
      wouldHavePrevented: true,
      aspaStatus: result.status,
      explanation:
        `ASPA validation detected an unauthorized hop in the path. ` +
        `The path would have been rejected, preventing propagation of this incident.`,
      detectingAsn: targetAsn,
    };
  }

  if (result.status === "unknown") {
    return {
      incident,
      wouldHavePrevented: false,
      aspaStatus: result.status,
      explanation:
        `ASPA validation returned "unknown" because one or more ASNs in the path ` +
        `do not have ASPA objects. Broader ASPA deployment would be needed to detect this incident. ` +
        `Current ASPA coverage confidence: ${Math.round(result.confidence * 100)}%.`,
    };
  }

  return {
    incident,
    wouldHavePrevented: false,
    aspaStatus: result.status,
    explanation:
      result.status === "valid"
        ? `The path appears valid under ASPA. This incident type (${incident.type}) ` +
          `may not be preventable by ASPA alone, or the ASPA objects may need updating.`
        : `The path is unverifiable — insufficient data for ASPA validation.`,
  };
}

/**
 * Infer legitimate providers for an ASN from incident data.
 *
 * Looks at incidents where the target ASN is the victim and identifies
 * ASNs that appear as legitimate upstream providers (not the offending ASN).
 *
 * @param targetAsn - The ASN to infer providers for
 * @param incidents - Historical incident data
 * @returns Array of inferred provider ASNs
 */
function inferProvidersFromIncidents(
  targetAsn: number,
  incidents: ReadonlyArray<BGPIncident>
): ReadonlyArray<number> {
  const providerSet = new Set<number>();

  for (const incident of incidents) {
    const { asPath, offendingAsn } = incident;

    for (let i = 1; i < asPath.length; i++) {
      if (asPath[i] === targetAsn && asPath[i - 1] !== offendingAsn) {
        providerSet.add(asPath[i - 1]);
      }
    }
  }

  return Array.from(providerSet);
}

/**
 * Calculate the aggregate prevention rate of ASPA across a set of incidents.
 *
 * A convenience function that runs validation on each incident's AS path
 * and returns the percentage that would have been caught.
 *
 * @param incidents - BGP incidents to evaluate
 * @param aspaObjects - ASPA objects to validate against
 * @returns Prevention rate as a percentage (0-100)
 *
 * @example
 * ```typescript
 * const rate = calculatePreventionRate(recentIncidents, aspaObjects);
 * console.log(`ASPA would prevent ${rate}% of incidents`);
 * ```
 */
export function calculatePreventionRate(
  incidents: ReadonlyArray<BGPIncident>,
  aspaObjects: ReadonlyMap<number, ASPAObject>
): number {
  if (incidents.length === 0) return 0;

  let prevented = 0;

  for (const incident of incidents) {
    const result = validatePath(incident.asPath, aspaObjects, "upstream");
    if (result.status === "invalid") {
      prevented++;
    }
  }

  return Math.round((prevented / incidents.length) * 100);
}
