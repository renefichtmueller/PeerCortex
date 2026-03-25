/**
 * @module aspa/generator
 * Auto-generate ASPA objects from BGP data.
 *
 * Analyzes BGP path data to detect upstream provider relationships,
 * then generates ASPA objects in RIPE DB format for registration.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9582
 *
 * @example
 * ```typescript
 * const providers = detectProviders(64501, bgpPaths);
 * console.log(providers);
 * // [{ asn: 174, name: "Cogent", confidence: 0.95, pathCount: 42 }]
 *
 * const template = generateRipeDbTemplate(64501, providers, "MNT-EXAMPLE");
 * console.log(template);
 * // Ready-to-paste RIPE DB ASPA object
 * ```
 */

// ── Types ───────────────────────────────────────────────

/** A BGP path observation used for provider inference */
export interface BGPPath {
  /** The AS path from collector perspective (leftmost = collector peer) */
  readonly asPath: ReadonlyArray<number>;
  /** IP prefix associated with this path */
  readonly prefix: string;
  /** The collector or vantage point that observed this path */
  readonly collector: string;
  /** When this path was observed */
  readonly timestamp: string;
}

/** A detected upstream provider with confidence scoring */
export interface Provider {
  /** The provider ASN */
  readonly asn: number;
  /** Human-readable name (if available) */
  readonly name: string;
  /** Confidence that this is a true provider (0.0 to 1.0) */
  readonly confidence: number;
  /** Number of BGP paths supporting this inference */
  readonly pathCount: number;
  /** Address families observed */
  readonly afi: ReadonlyArray<"ipv4" | "ipv6">;
}

// ── Provider Detection ──────────────────────────────────

/**
 * Detect upstream providers for an ASN by analyzing BGP path data.
 *
 * Uses the valley-free routing model: in a typical BGP path, a customer AS
 * appears to the right of its provider. By counting how often each AS appears
 * immediately to the left of the target ASN across many paths, we can infer
 * provider relationships with high confidence.
 *
 * Heuristics applied:
 * 1. An AS appearing left of the target in many paths is likely a provider.
 * 2. Higher path counts yield higher confidence.
 * 3. ASNs that only appear in a single path are treated as low-confidence.
 *
 * @param asn - The ASN to detect providers for
 * @param bgpPaths - Collection of observed BGP paths
 * @returns Sorted array of detected providers (highest confidence first)
 *
 * @example
 * ```typescript
 * const paths: BGPPath[] = [
 *   { asPath: [3356, 174, 64501], prefix: "192.0.2.0/24", collector: "rrc00", timestamp: "2026-03-26T00:00:00Z" },
 *   { asPath: [6939, 174, 64501], prefix: "192.0.2.0/24", collector: "rrc01", timestamp: "2026-03-26T00:00:00Z" },
 *   { asPath: [13335, 64501], prefix: "192.0.2.0/24", collector: "rrc03", timestamp: "2026-03-26T00:00:00Z" },
 * ];
 *
 * const providers = detectProviders(64501, paths);
 * // [
 * //   { asn: 174, name: "Unknown", confidence: 0.9, pathCount: 2, afi: ["ipv4"] },
 * //   { asn: 13335, name: "Unknown", confidence: 0.7, pathCount: 1, afi: ["ipv4"] },
 * // ]
 * ```
 */
export function detectProviders(
  asn: number,
  bgpPaths: ReadonlyArray<BGPPath>
): ReadonlyArray<Provider> {
  // Count occurrences of each ASN appearing immediately left of the target
  const providerCounts = new Map<number, { count: number; afiSet: Set<string> }>();

  for (const path of bgpPaths) {
    const { asPath, prefix } = path;
    const afi = prefix.includes(":") ? "ipv6" : "ipv4";

    for (let i = 1; i < asPath.length; i++) {
      if (asPath[i] === asn && asPath[i - 1] !== asn) {
        const providerAsn = asPath[i - 1];
        const existing = providerCounts.get(providerAsn);
        if (existing) {
          existing.count++;
          existing.afiSet.add(afi);
        } else {
          providerCounts.set(providerAsn, {
            count: 1,
            afiSet: new Set([afi]),
          });
        }
      }
    }
  }

  if (providerCounts.size === 0) {
    return [];
  }

  // Calculate confidence based on path count relative to max
  const maxCount = Math.max(...Array.from(providerCounts.values()).map((v) => v.count));

  const providers: Provider[] = [];
  for (const [providerAsn, data] of providerCounts) {
    // Confidence formula: normalized count with a floor of 0.3 for single observations
    const rawConfidence = data.count / maxCount;
    const confidence = Math.max(0.3, Math.min(1.0, rawConfidence * 0.9 + 0.1));

    providers.push({
      asn: providerAsn,
      name: "Unknown", // Name resolution requires external lookup
      confidence: Math.round(confidence * 100) / 100,
      pathCount: data.count,
      afi: Array.from(data.afiSet).sort() as Array<"ipv4" | "ipv6">,
    });
  }

  // Sort by confidence descending, then by path count descending
  return providers.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.pathCount - a.pathCount;
  });
}

// ── ASPA Object Generation ──────────────────────────────

/**
 * Generate an ASPA object in RPSL text format.
 *
 * Produces a human-readable ASPA object suitable for display or
 * manual registration. Includes comments explaining each field.
 *
 * @param asn - The customer ASN
 * @param providers - Detected upstream providers
 * @returns RPSL-formatted ASPA object text
 *
 * @example
 * ```typescript
 * const text = generateASPAObject(64501, [
 *   { asn: 174, name: "Cogent", confidence: 0.95, pathCount: 42, afi: ["ipv4", "ipv6"] },
 * ]);
 * console.log(text);
 * // aut-num:     AS64501
 * // aspa:        AS64501
 * // upstream:    AS174  # Cogent (confidence: 95%, seen in 42 paths)
 * // ...
 * ```
 */
export function generateASPAObject(
  asn: number,
  providers: ReadonlyArray<Provider>
): string {
  const lines: string[] = [
    `% ASPA object for AS${asn}`,
    `% Generated by PeerCortex on ${new Date().toISOString()}`,
    `% Based on BGP path analysis — review before submitting to your RIR`,
    `%`,
    `% ASPA (Autonomous System Provider Authorization) declares which ASNs`,
    `% are authorized upstream providers of this AS. This helps prevent`,
    `% route leaks by allowing RPKI validators to verify AS path legitimacy.`,
    `%`,
    `% Reference: RFC 9582 — Autonomous System Provider Authorization`,
    ``,
    `aut-num:     AS${asn}`,
    `aspa:        AS${asn}`,
  ];

  for (const provider of providers) {
    const afiStr = provider.afi.join(", ");
    const comment = `# ${provider.name} (confidence: ${Math.round(provider.confidence * 100)}%, seen in ${provider.pathCount} paths)`;
    lines.push(`upstream:    AS${provider.asn}  ${comment}`);
    if (provider.afi.length === 1) {
      lines.push(`             afi: ${afiStr}`);
    }
  }

  lines.push(``);

  return lines.join("\n");
}

/**
 * Generate a complete RIPE DB template ready for submission.
 *
 * Produces a full RPSL object including maintainer, source, and
 * administrative fields required for RIPE DB submission.
 *
 * @param asn - The customer ASN
 * @param providers - Detected upstream providers
 * @param maintainer - RIPE DB maintainer handle (e.g., "MNT-EXAMPLE")
 * @returns Complete RIPE DB template text
 *
 * @example
 * ```typescript
 * const template = generateRipeDbTemplate(
 *   13335,
 *   [{ asn: 174, name: "Cogent", confidence: 0.95, pathCount: 100, afi: ["ipv4", "ipv6"] }],
 *   "MNT-CLOUDFLARE"
 * );
 * // Paste this into https://apps.db.ripe.net/db-web-ui/webupdates
 * ```
 */
export function generateRipeDbTemplate(
  asn: number,
  providers: ReadonlyArray<Provider>,
  maintainer: string
): string {
  const lines: string[] = [
    `% ============================================================`,
    `% ASPA Object Template for AS${asn}`,
    `% Generated by PeerCortex — ${new Date().toISOString()}`,
    `% ============================================================`,
    `%`,
    `% INSTRUCTIONS:`,
    `% 1. Review the provider list below for accuracy`,
    `% 2. Remove any providers you no longer use`,
    `% 3. Add any providers that were not detected`,
    `% 4. Submit via: https://apps.db.ripe.net/db-web-ui/webupdates`,
    `% 5. Or via email to auto-dbm@ripe.net`,
    `%`,
    `% NOTE: ASPA objects are part of the RPKI framework.`,
    `% Your RIR must support ASPA object creation.`,
    `% Check with your RIR for current ASPA support status.`,
    `%`,
    ``,
  ];

  // Build the main object
  lines.push(`aut-num:      AS${asn}`);

  for (const provider of providers) {
    // Only include high-confidence providers in the template
    if (provider.confidence >= 0.5) {
      const afiComment =
        provider.afi.length === 2
          ? ""
          : `  # ${provider.afi[0]} only`;
      lines.push(
        `upstream:     AS${provider.asn}${afiComment}`
      );
    }
  }

  lines.push(`mnt-by:       ${maintainer}`);
  lines.push(`source:       RIPE`);
  lines.push(``);

  // Add low-confidence providers as comments
  const lowConfidence = providers.filter((p) => p.confidence < 0.5);
  if (lowConfidence.length > 0) {
    lines.push(`% The following providers were detected with low confidence.`);
    lines.push(`% Uncomment and add them if they are legitimate providers:`);
    for (const provider of lowConfidence) {
      lines.push(
        `% upstream:     AS${provider.asn}  # ${provider.name} (confidence: ${Math.round(provider.confidence * 100)}%)`
      );
    }
    lines.push(``);
  }

  return lines.join("\n");
}
