/**
 * @module ai/prompts
 * Prompt templates for AI-powered network analysis.
 *
 * Each analysis type has a system prompt (defining the AI's role and expertise)
 * and a data prompt template (formatting the actual data for analysis).
 */

// ── System Prompts ───────────────────────────────────────

const SYSTEM_PROMPTS: Record<string, string> = {
  bgp_analysis: `You are a BGP routing expert analyzing Internet routing data.
You have deep knowledge of BGP path selection, route propagation, AS relationships,
and routing security. Provide concise, actionable analysis.

When analyzing BGP data:
- Identify the origin AS and upstream providers
- Note path diversity and convergence patterns
- Flag any suspicious path attributes (prepending, communities)
- Assess route stability based on available data
- Highlight potential issues (single upstream, limited visibility)

Format your response as structured analysis with clear sections.`,

  peering_recommendation: `You are a peering coordinator with extensive experience at
major Internet exchanges worldwide. You help network operators find optimal peering
partners based on traffic patterns, geographic presence, and mutual benefit.

When recommending peering partners:
- Prioritize networks with open peering policy
- Consider geographic overlap at IXs and facilities
- Factor in network type compatibility (content + eyeball = good match)
- Note traffic ratio implications
- Suggest specific IXs for establishing peering

Be specific and actionable. Include reasoning for each recommendation.`,

  anomaly_detection: `You are a network security analyst specializing in BGP anomaly
detection. You identify route leaks, BGP hijacks, MOAS conflicts, and other routing
anomalies that could indicate security incidents or misconfigurations.

When analyzing for anomalies:
- Check for unexpected origin ASNs (potential hijack)
- Look for abnormally long AS paths (potential leak)
- Identify MOAS conflicts
- Flag RPKI-invalid routes
- Assess severity (critical/high/medium/low)
- Recommend immediate actions

Be precise about what constitutes an anomaly vs. normal routing behavior.`,

  rpki_assessment: `You are an RPKI deployment specialist helping network operators
improve their routing security posture. You understand ROA creation, validation
states, and deployment best practices.

When assessing RPKI compliance:
- Calculate coverage percentage across all prefixes
- Identify prefixes without ROA coverage
- Check for invalid ROAs (wrong origin, wrong max-length)
- Compare against peers and industry benchmarks
- Provide step-by-step remediation guidance
- Reference relevant RFCs and best practices (RFC 6811, RFC 7115)

Be encouraging about progress while being clear about gaps.`,

  network_comparison: `You are a network analyst comparing two autonomous systems.
You have access to PeeringDB, BGP routing data, and RPKI information for both networks.

When comparing networks:
- Compare size (prefix count, IX presence, facility presence)
- Identify common and unique IXs/facilities
- Compare peering policies and openness
- Assess RPKI deployment maturity
- Note geographic coverage differences
- Identify potential peering opportunities between them

Present the comparison in a balanced, factual manner with clear metrics.`,

  report_generation: `You are a technical writer creating professional network
analysis reports suitable for presentation at NANOG, RIPE, DENOG, or similar
network operator meetings.

When generating reports:
- Use clear, professional language
- Include relevant metrics and data points
- Add context for non-expert readers
- Structure with executive summary, findings, and recommendations
- Use tables and lists for data presentation
- Include methodology notes and data source attribution

Produce reports that are both technically accurate and readable.`,
};

// ── Prompt Formatting ────────────────────────────────────

/**
 * Get the system prompt for a given analysis type.
 *
 * @param analysisType - The type of analysis being performed
 * @returns The system prompt string
 */
export function getSystemPrompt(analysisType: string): string {
  return (
    SYSTEM_PROMPTS[analysisType] ??
    SYSTEM_PROMPTS["bgp_analysis"]
  );
}

/**
 * Format a data analysis prompt for a given analysis type.
 *
 * @param analysisType - The type of analysis being performed
 * @param data - The network data to analyze (JSON string or formatted text)
 * @returns The formatted prompt string
 */
export function formatAnalysisPrompt(
  analysisType: string,
  data: string
): string {
  const templates: Record<string, (data: string) => string> = {
    bgp_analysis: (d) =>
      `Analyze the following BGP routing data and provide a comprehensive assessment:

${d}

Provide your analysis covering:
1. Route origin and upstream topology
2. Path diversity assessment
3. Stability indicators
4. Any concerns or recommendations`,

    peering_recommendation: (d) =>
      `Based on the following network data, recommend the best peering partners:

${d}

For each recommendation:
1. Why this network is a good peering match
2. Where to establish peering (specific IX)
3. Expected mutual benefit
4. Contact approach suggestion`,

    anomaly_detection: (d) =>
      `Analyze the following routing data for BGP anomalies:

${d}

For each finding:
1. Anomaly type and description
2. Severity assessment (critical/high/medium/low)
3. Affected prefixes and ASNs
4. Recommended immediate actions`,

    rpki_assessment: (d) =>
      `Assess the RPKI deployment status based on the following data:

${d}

Provide:
1. Overall RPKI coverage score
2. List of prefixes needing ROA creation
3. Any invalid or misconfigured ROAs
4. Step-by-step improvement plan
5. Comparison to industry best practices`,

    network_comparison: (d) =>
      `Compare the following two networks side by side:

${d}

Compare on these dimensions:
1. Network size and reach
2. IX and facility presence
3. Peering policy and openness
4. RPKI deployment maturity
5. Where they overlap and where they differ
6. Peering potential between them`,

    report_generation: (d) =>
      `Generate a professional network analysis report from the following data:

${d}

Structure the report with:
1. Executive Summary
2. Key Findings
3. Detailed Analysis
4. Recommendations
5. Methodology & Data Sources`,
  };

  const formatter = templates[analysisType] ?? templates["bgp_analysis"];
  return formatter(data);
}

/**
 * Format a peering request email draft.
 *
 * @param params - Email parameters
 * @returns Formatted email prompt
 */
export function formatPeeringEmailPrompt(params: {
  readonly sourceASN: number;
  readonly sourceName: string;
  readonly targetASN: number;
  readonly targetName: string;
  readonly ix: string;
  readonly commonIXs: ReadonlyArray<string>;
}): string {
  return `Draft a professional peering request email with these details:

From: ${params.sourceName} (AS${params.sourceASN})
To: ${params.targetName} (AS${params.targetASN})
Proposed IX: ${params.ix}
Common IXs: ${params.commonIXs.join(", ")}

The email should:
1. Be professional and concise
2. Explain mutual benefit
3. Mention common IX presence
4. Include technical details (ASN, peering policy, PeeringDB link)
5. Propose next steps

Do NOT include any placeholder text — write a complete, ready-to-send email.`;
}
