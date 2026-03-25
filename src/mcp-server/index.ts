#!/usr/bin/env node

/**
 * @module mcp-server/index
 * PeerCortex MCP Server — AI-Powered Network Intelligence Platform
 *
 * Exposes network intelligence tools via the Model Context Protocol (MCP),
 * enabling AI assistants like Claude to query PeeringDB, analyze BGP data,
 * monitor RPKI compliance, and find peering partners.
 *
 * @example Start the server:
 * ```bash
 * # Via stdio (for Claude Code / MCP clients)
 * npx peercortex
 *
 * # Via SSE (for web clients)
 * MCP_TRANSPORT=sse MCP_PORT=3100 npx peercortex
 * ```
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { asnLookupSchema, prefixLookupSchema, ixLookupSchema, handleASNLookup, handlePrefixLookup, handleIXLookup } from "./tools/lookup.js";
import { peeringDiscoverSchema, peeringEmailSchema, handlePeeringDiscover, handlePeeringEmail } from "./tools/peering.js";
import { bgpAnalysisSchema, bgpAnomalySchema, routeLeakSchema, handleBGPAnalysis, handleAnomalyDetection, handleRouteLeakDetection } from "./tools/bgp.js";
import { rpkiValidateSchema, rpkiComplianceSchema, rpkiIXCoverageSchema, handleRPKIValidation, handleRPKICompliance, handleRPKIIXCoverage } from "./tools/rpki.js";
import { networkCompareSchema, handleNetworkCompare } from "./tools/compare.js";
import { reportGenerateSchema, handleReportGenerate } from "./tools/report.js";

// Latency tools
import { rttMeasurementSchema, tracerouteSchema, handleRTTMeasurement, handleTraceroute } from "./tools/latency.js";

// Transit tools
import { upstreamAnalysisSchema, transitDiversitySchema, peeringVsTransitSchema, handleUpstreamAnalysis, handleTransitDiversity, handlePeeringVsTransit } from "./tools/transit.js";

// Topology tools
import { asGraphSchema, submarineCableSchema, facilityAnalysisSchema, handleASGraph, handleSubmarineCables, handleFacilityAnalysis } from "./tools/topology.js";

// Traffic tools
import { ixTrafficSchema, ixComparisonSchema, portUtilizationSchema, handleIXTraffic, handleIXComparison, handlePortUtilization } from "./tools/traffic.js";

// Security tools
import { hijackDetectionSchema, routeLeakDetectionSchema, bogonCheckSchema, blacklistCheckSchema, handleHijackDetection, handleRouteLeakDetection as handleRouteLeakDetectionSecurity, handleBogonCheck, handleBlacklistCheck } from "./tools/security.js";

// DNS tools
import { reverseDnsSchema, delegationCheckSchema, whoisLookupSchema, handleReverseDns, handleDelegationCheck, handleWhoisLookup } from "./tools/dns.js";

// Atlas tools
import { createMeasurementSchema, getMeasurementResultsSchema, searchProbesSchema, handleCreateMeasurement, handleGetMeasurementResults, handleSearchProbes } from "./tools/atlas.js";

// ── Server Configuration ─────────────────────────────────

const SERVER_NAME = "peercortex";
const SERVER_VERSION = "0.1.0";

// ── Initialize MCP Server ────────────────────────────────

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// ── Register Tools ───────────────────────────────────────

// Tool 1: Network Lookup
server.tool(
  "lookup",
  "Look up comprehensive information for an ASN, IP prefix, or Internet Exchange. " +
    "Queries PeeringDB, RIPE Stat, bgp.he.net, IRR databases, and RPKI validators.",
  {
    type: asnLookupSchema.shape.asn._def.description
      ? { asn: asnLookupSchema.shape.asn }
      : asnLookupSchema.shape,
  },
  async (params) => {
    try {
      const result = await handleASNLookup(params as { asn: string | number });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 2: Peering Partner Discovery
server.tool(
  "peering",
  "Find optimal peering partners for an ASN. Analyzes common IXs, facilities, " +
    "peering policies, and network types. Can also draft peering request emails.",
  peeringDiscoverSchema.shape,
  async (params) => {
    try {
      const result = await handlePeeringDiscover(
        params as { asn: string | number; ix?: string; policy?: "open" | "selective" | "restrictive" | "any"; limit?: number }
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 3: BGP Analysis
server.tool(
  "bgp",
  "Analyze BGP routing for an ASN or prefix. Detects route leaks, BGP hijacks, " +
    "MOAS conflicts, and path anomalies. Uses RIPE Stat, Route Views, and bgp.he.net.",
  bgpAnalysisSchema.shape,
  async (params) => {
    try {
      const result = await handleBGPAnalysis(
        params as { resource: string; include_paths?: boolean; include_anomalies?: boolean; time_range?: string }
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 4: RPKI Monitoring
server.tool(
  "rpki",
  "RPKI validation and compliance monitoring. Validate prefix-origin pairs, " +
    "generate compliance reports, and analyze RPKI coverage at Internet Exchanges.",
  rpkiComplianceSchema.shape,
  async (params) => {
    try {
      const result = await handleRPKICompliance(
        params as { asn: string | number; include_recommendations?: boolean }
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 5: Network Comparison
server.tool(
  "compare",
  "Compare two networks side by side. Shows common/unique IXs, facilities, " +
    "peering policies, RPKI deployment, and identifies peering opportunities.",
  networkCompareSchema.shape,
  async (params) => {
    try {
      const result = await handleNetworkCompare(
        params as { asn1: string | number; asn2: string | number; include_ai_analysis?: boolean }
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 6: Report Generation
server.tool(
  "report",
  "Generate comprehensive network analysis reports. Supports peering readiness, " +
    "RPKI compliance, network comparison, BGP health, and IX analysis reports. " +
    "Output in Markdown, JSON, or plain text.",
  reportGenerateSchema.shape,
  async (params) => {
    try {
      const result = await handleReportGenerate(
        params as {
          type: "peering_readiness" | "rpki_compliance" | "network_comparison" | "bgp_health" | "ix_analysis";
          asn?: string | number;
          asn2?: string | number;
          ix?: string;
          format?: "markdown" | "json" | "text";
        }
      );
      return {
        content: [
          {
            type: "text" as const,
            text: result.format === "json"
              ? JSON.stringify(result, null, 2)
              : result.content || JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Latency Tools ────────────────────────────────────────

server.tool(
  "measure_rtt",
  "Measure round-trip time (RTT) to a target using RIPE Atlas probes distributed globally.",
  rttMeasurementSchema.shape,
  async (params) => {
    try {
      const result = await handleRTTMeasurement(params as Parameters<typeof handleRTTMeasurement>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "traceroute",
  "Run a traceroute to a target via RIPE Atlas, annotating each hop with ASN, hostname, and IXP identification.",
  tracerouteSchema.shape,
  async (params) => {
    try {
      const result = await handleTraceroute(params as Parameters<typeof handleTraceroute>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

// ── Transit Tools ────────────────────────────────────────

server.tool(
  "upstream_analysis",
  "Analyze upstream transit providers for an ASN — identify providers, stability, and single-homed prefixes.",
  upstreamAnalysisSchema.shape,
  async (params) => {
    try {
      const result = await handleUpstreamAnalysis(params as Parameters<typeof handleUpstreamAnalysis>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "transit_diversity",
  "Assess transit diversity and resilience — identify single points of failure and geographic gaps.",
  transitDiversitySchema.shape,
  async (params) => {
    try {
      const result = await handleTransitDiversity(params as Parameters<typeof handleTransitDiversity>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "peering_vs_transit",
  "Compare direct peering vs. transit for reaching a target ASN — cost, latency, and path analysis.",
  peeringVsTransitSchema.shape,
  async (params) => {
    try {
      const result = await handlePeeringVsTransit(params as Parameters<typeof handlePeeringVsTransit>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

// ── Topology Tools ───────────────────────────────────────

server.tool(
  "as_graph",
  "Generate an AS-level topology graph showing providers, customers, and peers around a center ASN.",
  asGraphSchema.shape,
  async (params) => {
    try {
      const result = await handleASGraph(params as Parameters<typeof handleASGraph>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "submarine_cables",
  "Look up submarine cable information — capacity, owners, landing points, and regional connectivity.",
  submarineCableSchema.shape,
  async (params) => {
    try {
      const result = await handleSubmarineCables(params as Parameters<typeof handleSubmarineCables>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "facility_analysis",
  "Analyze facility/colocation presence for an ASN and find interconnection opportunities with a target.",
  facilityAnalysisSchema.shape,
  async (params) => {
    try {
      const result = await handleFacilityAnalysis(params as Parameters<typeof handleFacilityAnalysis>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

// ── Traffic Tools ────────────────────────────────────────

server.tool(
  "ix_traffic",
  "Get traffic statistics and trends for an Internet Exchange — peak, average, growth, and history.",
  ixTrafficSchema.shape,
  async (params) => {
    try {
      const result = await handleIXTraffic(params as Parameters<typeof handleIXTraffic>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "ix_comparison",
  "Compare traffic statistics across multiple Internet Exchanges side by side.",
  ixComparisonSchema.shape,
  async (params) => {
    try {
      const result = await handleIXComparison(params as Parameters<typeof handleIXComparison>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "port_utilization",
  "Analyze port utilization for an ASN across its IX connections with upgrade recommendations.",
  portUtilizationSchema.shape,
  async (params) => {
    try {
      const result = await handlePortUtilization(params as Parameters<typeof handlePortUtilization>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

// ── Security Tools ───────────────────────────────────────

server.tool(
  "hijack_detection",
  "Detect active and historical BGP hijacks for a prefix using RPKI ROV and MOAS analysis.",
  hijackDetectionSchema.shape,
  async (params) => {
    try {
      const result = await handleHijackDetection(params as Parameters<typeof handleHijackDetection>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "route_leak_detection_aspa",
  "Detect route leaks using ASPA validation — identifies unauthorized route propagation via bgproutes.io.",
  routeLeakDetectionSchema.shape,
  async (params) => {
    try {
      const result = await handleRouteLeakDetectionSecurity(params as Parameters<typeof handleRouteLeakDetectionSecurity>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "bogon_check",
  "Check for bogon prefix announcements and bogon ASNs in routing paths.",
  bogonCheckSchema.shape,
  async (params) => {
    try {
      const result = await handleBogonCheck(params as Parameters<typeof handleBogonCheck>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "blacklist_check",
  "Check an IP, prefix, or ASN against known blacklists and reputation databases.",
  blacklistCheckSchema.shape,
  async (params) => {
    try {
      const result = await handleBlacklistCheck(params as Parameters<typeof handleBlacklistCheck>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

// ── DNS Tools ────────────────────────────────────────────

server.tool(
  "reverse_dns",
  "Perform reverse DNS lookups for IP addresses with optional forward-confirmed verification.",
  reverseDnsSchema.shape,
  async (params) => {
    try {
      const result = await handleReverseDns(params as Parameters<typeof handleReverseDns>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "delegation_check",
  "Check DNS delegation for a domain — nameservers, DNSSEC, glue records, and issues.",
  delegationCheckSchema.shape,
  async (params) => {
    try {
      const result = await handleDelegationCheck(params as Parameters<typeof handleDelegationCheck>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "whois_lookup",
  "Perform a WHOIS lookup for an IP address, ASN, or domain.",
  whoisLookupSchema.shape,
  async (params) => {
    try {
      const result = await handleWhoisLookup(params as Parameters<typeof handleWhoisLookup>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

// ── Atlas Tools ──────────────────────────────────────────

server.tool(
  "atlas_create_measurement",
  "Create a new RIPE Atlas measurement (ping, traceroute, DNS, SSL, NTP, HTTP).",
  createMeasurementSchema.shape,
  async (params) => {
    try {
      const result = await handleCreateMeasurement(params as Parameters<typeof handleCreateMeasurement>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "atlas_get_results",
  "Get results for a RIPE Atlas measurement with summary statistics.",
  getMeasurementResultsSchema.shape,
  async (params) => {
    try {
      const result = await handleGetMeasurementResults(params as Parameters<typeof handleGetMeasurementResults>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "atlas_search_probes",
  "Search for RIPE Atlas probes by ASN, country, prefix, or anchor status.",
  searchProbesSchema.shape,
  async (params) => {
    try {
      const result = await handleSearchProbes(params as Parameters<typeof handleSearchProbes>[0]);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }], isError: true };
    }
  }
);

// ── Start Server ─────────────────────────────────────────

async function main(): Promise<void> {
  const transport = process.env.MCP_TRANSPORT ?? "stdio";

  if (transport === "stdio") {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error(`PeerCortex MCP Server v${SERVER_VERSION} running on stdio`);
  } else if (transport === "sse") {
    // TODO: Implement SSE transport
    // const port = parseInt(process.env.MCP_PORT ?? "3100", 10);
    // const sseTransport = new SSEServerTransport({ port });
    // await server.connect(sseTransport);
    console.error("SSE transport not yet implemented. Use stdio transport.");
    process.exit(1);
  } else {
    console.error(`Unknown transport: ${transport}. Use 'stdio' or 'sse'.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
