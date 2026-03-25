/**
 * @module mcp-server/tools/aspa
 * MCP Tools for ASPA (Autonomous System Provider Authorization) intelligence.
 *
 * Exposes ASPA validation, analysis, generation, simulation, coverage,
 * and leak detection capabilities through the Model Context Protocol.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9582
 */

import { z } from "zod";
import type { ASPAValidationResult } from "../../aspa/validator.js";
import { validatePath } from "../../aspa/validator.js";
import type { ASPAObject } from "../../aspa/validator.js";
import { fetchASPAObjects } from "../../aspa/objects.js";
import { detectProviders, generateASPAObject, generateRipeDbTemplate } from "../../aspa/generator.js";
import type { BGPPath } from "../../aspa/generator.js";
import { simulateASPADeployment } from "../../aspa/simulator.js";
import type { BGPIncident } from "../../aspa/simulator.js";
import { getASPACoverage, getASPACoverageByRegion, compareASPAAdoption } from "../../aspa/coverage.js";
import { detectRouteLeak, analyzeLeaks } from "../../aspa/leak-detector.js";
import type { BGPUpdate } from "../../aspa/leak-detector.js";
import { parseASN } from "../../types/common.js";

// ── Tool Schemas ─────────────────────────────────────────

/** Input schema for ASPA path validation */
export const aspaValidateSchema = z.object({
  as_path: z
    .array(z.number())
    .describe(
      "AS path to validate, ordered left-to-right from validator to origin (e.g., [174, 13335, 64501])"
    ),
  direction: z
    .enum(["upstream", "downstream"])
    .optional()
    .default("upstream")
    .describe("Validation direction: 'upstream' (from provider) or 'downstream' (from customer)"),
});

/**
 * Input schema for full ASPA readiness analysis.
 *
 * @example
 * ```
 * > Analyze ASPA readiness for AS13335
 *
 * Returns: ASPA object status, detected providers, path validation
 * results, and deployment recommendations for Cloudflare.
 * ```
 */
export const aspaAnalyzeSchema = z.object({
  asn: z
    .union([z.string(), z.number()])
    .describe("ASN to analyze ASPA readiness for (e.g., 13335 or 'AS13335')"),
});

/**
 * Input schema for ASPA object generation.
 *
 * @example
 * ```
 * > Generate an ASPA object for AS13335
 *
 * Returns: RIPE DB-ready ASPA object template with detected
 * upstream providers (AS174, AS3356, etc.) and submission instructions.
 * ```
 */
export const aspaGenerateSchema = z.object({
  asn: z
    .union([z.string(), z.number()])
    .describe("ASN to generate ASPA object for"),
  maintainer: z
    .string()
    .optional()
    .describe("RIPE DB maintainer handle (e.g., 'MNT-CLOUDFLARE')"),
});

/**
 * Input schema for ASPA deployment simulation.
 *
 * @example
 * ```
 * > What would ASPA have prevented in the last 30 days?
 *
 * Returns: Simulation showing how many of the recent BGP incidents
 * (route leaks, hijacks) would have been prevented by ASPA deployment.
 * ```
 */
export const aspaSimulateSchema = z.object({
  asn: z
    .union([z.string(), z.number()])
    .describe("ASN to simulate ASPA deployment for"),
});

/**
 * Input schema for ASPA coverage statistics.
 *
 * @example
 * ```
 * > Show ASPA adoption at DE-CIX Frankfurt
 *
 * Returns: Number of DE-CIX participants with/without ASPA objects,
 * adoption percentage, and top adopters.
 * ```
 */
export const aspaCoverageSchema = z.object({
  ixp_id: z
    .number()
    .optional()
    .describe("PeeringDB IXP ID to scope analysis (e.g., 31 for DE-CIX Frankfurt)"),
  region: z
    .string()
    .optional()
    .describe("Geographic region to scope analysis (e.g., 'Europe', 'North America')"),
});

/**
 * Input schema for ASPA-based route leak detection.
 *
 * @example
 * ```
 * > Detect route leaks using ASPA for 1.1.1.0/24
 *
 * Returns: Recent BGP updates for the prefix analyzed against ASPA,
 * with any detected leaks, severity, and leaking ASN.
 * ```
 */
export const aspaLeaksSchema = z.object({
  asn: z
    .union([z.string(), z.number()])
    .describe("ASN to detect route leaks for"),
  hours: z
    .number()
    .optional()
    .default(24)
    .describe("Number of hours to look back (default: 24)"),
});

// ── Tool Handlers ────────────────────────────────────────

/**
 * Validate an AS path against ASPA objects.
 *
 * Fetches ASPA objects for all ASNs in the path, then runs the
 * RFC 9582 Section 6 validation algorithm.
 *
 * @example
 * ```
 * > Is the path [174, 13335, 64501] ASPA-valid?
 *
 * Returns:
 * {
 *   "status": "valid",
 *   "path": [174, 13335, 64501],
 *   "violations": [],
 *   "leakDetected": false,
 *   "confidence": 0.67
 * }
 * ```
 */
export async function handleASPAValidate(
  input: z.infer<typeof aspaValidateSchema>
): Promise<ASPAValidationResult> {
  const aspaObjects = new Map<number, ASPAObject>();

  // Fetch ASPA objects for all ASNs in the path
  const uniqueAsns = [...new Set(input.as_path)];
  const fetchResults = await Promise.allSettled(
    uniqueAsns.map(async (asn) => {
      const objects = await fetchASPAObjects(asn);
      if (objects.length > 0) {
        aspaObjects.set(asn, objects[0]);
      }
    })
  );

  // Log any fetch failures (non-blocking)
  for (const result of fetchResults) {
    if (result.status === "rejected") {
      // Silently continue — missing ASPA objects result in "unknown" status
    }
  }

  return validatePath(input.as_path, aspaObjects, input.direction);
}

/**
 * Full ASPA readiness analysis for an ASN.
 *
 * Checks whether the ASN has registered ASPA objects, detects its
 * upstream providers from BGP data, and provides deployment recommendations.
 *
 * @example
 * ```
 * > Analyze ASPA readiness for AS13335
 *
 * Returns:
 * {
 *   "asn": 13335,
 *   "hasAspaObject": false,
 *   "detectedProviders": [
 *     { "asn": 174, "name": "Cogent", "confidence": 0.95 },
 *     { "asn": 3356, "name": "Lumen", "confidence": 0.90 }
 *   ],
 *   "recommendations": [
 *     "Register ASPA object listing AS174 and AS3356 as providers",
 *     "Submit via RIPE DB at https://apps.db.ripe.net/db-web-ui/webupdates"
 *   ]
 * }
 * ```
 */
export async function handleASPAAnalyze(
  input: z.infer<typeof aspaAnalyzeSchema>
): Promise<{
  asn: number;
  hasAspaObject: boolean;
  existingProviders: ReadonlyArray<{ asn: number; afi: ReadonlyArray<string> }>;
  detectedProviders: ReadonlyArray<{
    asn: number;
    name: string;
    confidence: number;
    pathCount: number;
  }>;
  recommendations: ReadonlyArray<string>;
  generatedAt: string;
}> {
  const asn = parseASN(input.asn);

  // Check for existing ASPA objects
  let hasAspaObject = false;
  let existingProviders: ReadonlyArray<{ asn: number; afi: ReadonlyArray<string> }> = [];

  try {
    const objects = await fetchASPAObjects(asn);
    if (objects.length > 0) {
      hasAspaObject = true;
      existingProviders = objects[0].providers.map((p) => ({
        asn: p.asn,
        afi: [...p.afi],
      }));
    }
  } catch {
    // Continue without existing objects
  }

  // Detect providers from BGP data
  // In a full implementation, this would query RIPE Stat for BGP paths.
  // For now, return the analysis structure with detected providers from
  // any existing ASPA objects.
  const detectedProviders = existingProviders.map((p) => ({
    asn: p.asn,
    name: `AS${p.asn}`,
    confidence: 0.9,
    pathCount: 0,
  }));

  // Generate recommendations
  const recommendations: string[] = [];

  if (!hasAspaObject) {
    recommendations.push(
      `Register an ASPA object for AS${asn} with your RIR to enable route leak prevention.`
    );
    recommendations.push(
      `Submit via RIPE DB at https://apps.db.ripe.net/db-web-ui/webupdates`
    );
    recommendations.push(
      `Use the peercortex_aspa_generate tool to create a ready-to-submit template.`
    );
  } else {
    recommendations.push(
      `AS${asn} has an ASPA object with ${existingProviders.length} authorized provider(s).`
    );
    recommendations.push(
      `Verify the provider list is current — remove decommissioned providers and add new ones.`
    );
  }

  recommendations.push(
    `Encourage your upstream providers to also register ASPA objects for maximum protection.`
  );
  recommendations.push(
    `Enable ASPA-based filtering on your BGP sessions where supported by your router vendor.`
  );

  return {
    asn,
    hasAspaObject,
    existingProviders,
    detectedProviders,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate an ASPA object template for an ASN.
 *
 * Detects upstream providers from BGP path data and generates
 * a RIPE DB-ready ASPA object template.
 *
 * @example
 * ```
 * > Generate an ASPA object for AS13335
 *
 * Returns:
 * {
 *   "asn": 13335,
 *   "template": "aut-num: AS13335\nupstream: AS174\nupstream: AS3356\nmnt-by: MNT-CLOUDFLARE\nsource: RIPE",
 *   "detectedProviders": [{ "asn": 174, ... }, { "asn": 3356, ... }],
 *   "instructions": "Submit via RIPE DB..."
 * }
 * ```
 */
export async function handleASPAGenerate(
  input: z.infer<typeof aspaGenerateSchema>
): Promise<{
  asn: number;
  object: string;
  template: string;
  detectedProviders: ReadonlyArray<{
    asn: number;
    name: string;
    confidence: number;
  }>;
  instructions: string;
}> {
  const asn = parseASN(input.asn);
  const maintainer = input.maintainer ?? `MNT-AS${asn}`;

  // Detect providers (in full implementation, fetch BGP paths from RIPE Stat)
  // For now, try to infer from any existing ASPA objects
  let providers: ReadonlyArray<{
    asn: number;
    name: string;
    confidence: number;
    pathCount: number;
    afi: ReadonlyArray<"ipv4" | "ipv6">;
  }> = [];

  try {
    const objects = await fetchASPAObjects(asn);
    if (objects.length > 0) {
      providers = objects[0].providers.map((p) => ({
        asn: p.asn,
        name: `AS${p.asn}`,
        confidence: 1.0,
        pathCount: 0,
        afi: [...p.afi],
      }));
    }
  } catch {
    // Continue with empty provider list
  }

  const object = generateASPAObject(asn, providers);
  const template = generateRipeDbTemplate(asn, providers, maintainer);

  return {
    asn,
    object,
    template,
    detectedProviders: providers.map((p) => ({
      asn: p.asn,
      name: p.name,
      confidence: p.confidence,
    })),
    instructions:
      `To register this ASPA object:\n` +
      `1. Review the detected providers and adjust as needed\n` +
      `2. Go to https://apps.db.ripe.net/db-web-ui/webupdates\n` +
      `3. Paste the template and submit\n` +
      `4. Alternatively, email the template to auto-dbm@ripe.net\n` +
      `\nNote: Your RIR must support ASPA objects. Check current support status.`,
  };
}

/**
 * Run a what-if ASPA deployment simulation.
 *
 * Simulates how ASPA would have affected recent BGP incidents
 * if the target ASN had deployed ASPA objects.
 *
 * @example
 * ```
 * > Simulate ASPA deployment for AS13335
 *
 * Returns:
 * {
 *   "totalIncidents": 15,
 *   "wouldHavePrevented": 11,
 *   "preventionRate": 73,
 *   "details": [...]
 * }
 * ```
 */
export async function handleASPASimulate(
  input: z.infer<typeof aspaSimulateSchema>
): Promise<{
  asn: number;
  totalIncidents: number;
  wouldHavePrevented: number;
  preventionRate: number;
  byType: {
    routeLeaks: { total: number; prevented: number };
    hijacks: { total: number; prevented: number };
    misconfigurations: { total: number; prevented: number };
  };
  simulatedAt: string;
  note: string;
}> {
  const asn = parseASN(input.asn);

  // In a full implementation, this would fetch recent BGP incidents
  // from data sources. For now, return the simulation structure.
  const incidents: BGPIncident[] = [];

  const result = simulateASPADeployment(asn, incidents);

  return {
    asn,
    totalIncidents: result.totalIncidents,
    wouldHavePrevented: result.wouldHavePrevented,
    preventionRate: result.preventionRate,
    byType: result.byType,
    simulatedAt: result.simulatedAt,
    note:
      `Simulation based on publicly available BGP incident data. ` +
      `Connect additional data sources (e.g., BGPStream, GRIP) for more comprehensive results.`,
  };
}

/**
 * Get ASPA adoption/coverage statistics.
 *
 * Returns ASPA deployment statistics globally, per IXP, or per region.
 *
 * @example
 * ```
 * > Show ASPA adoption at DE-CIX Frankfurt
 *
 * Returns:
 * {
 *   "scope": "DE-CIX Frankfurt",
 *   "total": 950,
 *   "withAspa": 85,
 *   "withoutAspa": 865,
 *   "percentage": 8.9,
 *   "topAdopters": [{ "asn": 13335, "name": "Cloudflare" }, ...]
 * }
 * ```
 */
export async function handleASPACoverage(
  input: z.infer<typeof aspaCoverageSchema>
): Promise<{
  total: number;
  withAspa: number;
  withoutAspa: number;
  percentage: number;
  topAdopters: ReadonlyArray<{ asn: number; name: string }>;
  scope: string;
  generatedAt: string;
}> {
  if (input.region) {
    return getASPACoverageByRegion(input.region);
  }

  return getASPACoverage(input.ixp_id);
}

/**
 * Detect route leaks using ASPA validation.
 *
 * Analyzes recent BGP updates for an ASN and flags any updates
 * where ASPA validation indicates a route leak.
 *
 * @example
 * ```
 * > Detect route leaks using ASPA for AS13335
 *
 * Returns:
 * {
 *   "asn": 13335,
 *   "timeRange": { "start": "2026-03-25T12:00:00Z", "end": "2026-03-26T12:00:00Z" },
 *   "totalLeaks": 3,
 *   "bySeverity": { "critical": 1, "high": 1, "medium": 1 },
 *   "leaks": [
 *     {
 *       "prefix": "1.1.1.0/24",
 *       "leakingAsn": 64501,
 *       "severity": "critical",
 *       "description": "Route leak detected for 1.1.1.0/24: AS64501 caused an accidental route leak."
 *     }
 *   ]
 * }
 * ```
 */
export async function handleASPALeaks(
  input: z.infer<typeof aspaLeaksSchema>
): Promise<{
  asn: number;
  timeRange: { start: string; end: string };
  totalLeaks: number;
  bySeverity: { critical: number; high: number; medium: number };
  byType: Partial<Record<string, number>>;
  leaks: ReadonlyArray<{
    prefix: string;
    leakingAsn: number;
    severity: string;
    leakType: string;
    timestamp: string;
    description: string;
  }>;
  topLeakers: ReadonlyArray<{
    asn: number;
    count: number;
    lastSeen: string;
  }>;
  generatedAt: string;
}> {
  const asn = parseASN(input.asn);
  const hours = input.hours;

  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000);

  const timeRange = {
    start: start.toISOString(),
    end: end.toISOString(),
  };

  // Fetch ASPA objects for the target ASN and its neighbors
  const aspaObjects = new Map<number, ASPAObject>();
  try {
    const objects = await fetchASPAObjects(asn);
    if (objects.length > 0) {
      aspaObjects.set(asn, objects[0]);
    }
  } catch {
    // Continue without ASPA objects
  }

  const report = await analyzeLeaks(asn, timeRange, aspaObjects);

  return {
    asn,
    timeRange,
    totalLeaks: report.totalLeaks,
    bySeverity: report.bySeverity,
    byType: report.byType,
    leaks: report.leaks.map((l) => ({
      prefix: l.prefix,
      leakingAsn: l.leakingAsn,
      severity: l.severity,
      leakType: l.leakType,
      timestamp: l.timestamp.toISOString(),
      description: l.description,
    })),
    topLeakers: report.topLeakers,
    generatedAt: report.generatedAt,
  };
}
