/**
 * @module mcp-server/tools/report
 * MCP Tool: Generate comprehensive network analysis reports.
 *
 * Produces presentation-ready reports for peering readiness, RPKI compliance,
 * BGP health, and network comparison. Suitable for NANOG, RIPE, DENOG meetings.
 */

import { z } from "zod";
import type { Report, ReportFormat, ReportType } from "../../types/common.js";
import { parseASN } from "../../types/common.js";

// ── Tool Schemas ─────────────────────────────────────────

/** Input schema for report generation */
export const reportGenerateSchema = z.object({
  type: z
    .enum([
      "peering_readiness",
      "rpki_compliance",
      "network_comparison",
      "bgp_health",
      "ix_analysis",
    ])
    .describe("Type of report to generate"),
  asn: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Primary ASN for the report"),
  asn2: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Second ASN (for comparison reports)"),
  ix: z
    .string()
    .optional()
    .describe("IX name (for IX analysis reports)"),
  format: z
    .enum(["markdown", "json", "text"])
    .optional()
    .default("markdown")
    .describe("Output format"),
});

// ── Tool Handlers ────────────────────────────────────────

/**
 * Generate a comprehensive network analysis report.
 *
 * Report types:
 * - **peering_readiness**: Evaluates an ASN's readiness for peering
 * - **rpki_compliance**: Full RPKI deployment status and recommendations
 * - **network_comparison**: Side-by-side comparison of two networks
 * - **bgp_health**: BGP routing health assessment
 * - **ix_analysis**: Internet Exchange participation analysis
 *
 * @example
 * ```
 * > Generate an RPKI compliance report for AS13335
 *
 * Returns: Markdown report with coverage metrics, findings,
 *          recommendations, and data source attribution.
 * ```
 */
export async function handleReportGenerate(
  input: z.infer<typeof reportGenerateSchema>
): Promise<Report> {
  const reportType = input.type as ReportType;
  const format = input.format as ReportFormat;

  // TODO: Implementation steps per report type:
  //
  // peering_readiness:
  //   1. Get network info from PeeringDB
  //   2. Analyze IX presence and facility coverage
  //   3. Check peering policy and contact info
  //   4. Assess RPKI readiness
  //   5. Score overall peering readiness
  //   6. AI-generate recommendations
  //
  // rpki_compliance:
  //   1. Get all announced prefixes
  //   2. Validate each against RPKI
  //   3. Check IRR consistency
  //   4. Generate coverage report
  //   5. AI-generate remediation steps
  //
  // network_comparison:
  //   1. Run full comparison tool
  //   2. Format as detailed report
  //   3. AI-generate narrative
  //
  // bgp_health:
  //   1. Analyze all prefixes for anomalies
  //   2. Check visibility and path diversity
  //   3. Assess RPKI state
  //   4. Check for recent incidents
  //   5. AI-generate health assessment
  //
  // ix_analysis:
  //   1. Get IX details from PeeringDB
  //   2. Analyze participant mix
  //   3. Check RPKI coverage
  //   4. Identify peering opportunities
  //   5. AI-generate IX analysis

  const title = getReportTitle(reportType, input);

  return {
    type: reportType,
    title,
    format,
    content: "", // TODO: Generate report content
    metadata: {
      generatedAt: new Date().toISOString(),
      sources: ["peeringdb", "ripe_stat", "rpki"],
      dataFreshness: "Data retrieved in real-time from source APIs",
    },
  };
}

/**
 * Generate a human-readable title for a report.
 */
function getReportTitle(
  type: ReportType,
  input: z.infer<typeof reportGenerateSchema>
): string {
  const asnStr = input.asn ? `AS${parseASN(input.asn)}` : "";
  const asn2Str = input.asn2 ? `AS${parseASN(input.asn2)}` : "";

  const titles: Record<ReportType, string> = {
    peering_readiness: `Peering Readiness Report — ${asnStr}`,
    rpki_compliance: `RPKI Compliance Report — ${asnStr}`,
    network_comparison: `Network Comparison — ${asnStr} vs ${asn2Str}`,
    bgp_health: `BGP Health Report — ${asnStr}`,
    ix_analysis: `IX Analysis Report — ${input.ix ?? "Unknown IX"}`,
  };

  return titles[type] ?? `Network Report — ${asnStr}`;
}

/**
 * Format a report section as markdown.
 */
export function formatMarkdownSection(
  heading: string,
  level: number,
  content: string
): string {
  const prefix = "#".repeat(Math.min(level, 6));
  return `${prefix} ${heading}\n\n${content}\n\n`;
}

/**
 * Format a data table as markdown.
 */
export function formatMarkdownTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
): string {
  const headerRow = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const dataRows = rows.map((row) => `| ${row.join(" | ")} |`);

  return [headerRow, separator, ...dataRows].join("\n");
}
