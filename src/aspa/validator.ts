/**
 * @module aspa/validator
 * RFC 9582 Section 6 — ASPA-based AS path validation algorithm.
 *
 * Implements the Autonomous System Provider Authorization (ASPA) path
 * validation procedure as defined in RFC 9582. ASPA enables detection
 * of route leaks and unauthorized path segments by verifying that each
 * AS in a BGP path has authorized its upstream provider relationship.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9582#section-6
 *
 * @example
 * ```typescript
 * const aspaObjects = new Map<number, ASPAObject>();
 * aspaObjects.set(64501, {
 *   customerAsn: 64501,
 *   providers: [{ asn: 64500, afi: ["ipv4", "ipv6"] }],
 * });
 *
 * const result = validatePath(
 *   [13335, 64501, 64500, 174],
 *   aspaObjects,
 *   "upstream"
 * );
 * console.log(result.status); // "valid" | "invalid" | "unknown" | "unverifiable"
 * ```
 */

// ── Interfaces ──────────────────────────────────────────

/**
 * An ASPA object as registered in the RPKI.
 *
 * Maps a customer AS to its authorized upstream providers,
 * optionally scoped to specific address families.
 *
 * @see RFC 9582 Section 3 — ASPA Profile
 */
export interface ASPAObject {
  /** The customer AS that created this authorization */
  readonly customerAsn: number;
  /** Authorized upstream provider ASNs with address family scope */
  readonly providers: ReadonlyArray<{
    readonly asn: number;
    readonly afi: ReadonlyArray<"ipv4" | "ipv6">;
  }>;
}

/**
 * Result of ASPA path validation.
 *
 * Contains the validation status, the analyzed path, any violations
 * found, and whether a route leak was detected.
 */
export interface ASPAValidationResult {
  /** Overall validation status per RFC 9582 Section 6 */
  readonly status: "valid" | "invalid" | "unknown" | "unverifiable";
  /** The AS path that was validated */
  readonly path: ReadonlyArray<number>;
  /** List of specific violations found in the path */
  readonly violations: ReadonlyArray<ASPAViolation>;
  /** Whether the path exhibits a route leak pattern */
  readonly leakDetected: boolean;
  /** The ASN responsible for the leak, if detected */
  readonly leakingAsn?: number;
  /** Confidence score from 0.0 to 1.0 based on ASPA coverage of the path */
  readonly confidence: number;
}

/**
 * A specific ASPA violation at a position in the AS path.
 *
 * Indicates that a hop in the path was not authorized by the
 * customer's ASPA object.
 */
export interface ASPAViolation {
  /** Zero-based position in the AS path where the violation occurs */
  readonly position: number;
  /** The ASN at this position */
  readonly asn: number;
  /** ASNs that are authorized providers for this ASN */
  readonly expectedProviders: ReadonlyArray<number>;
  /** The actual next-hop ASN in the path */
  readonly actualNextHop: number;
  /** Human-readable explanation of the violation */
  readonly reason: string;
}

// ── Helper Functions ────────────────────────────────────

/**
 * Check whether `providerAsn` is an authorized provider of `customerAsn`.
 *
 * @param customerAsn - The customer ASN to check
 * @param providerAsn - The candidate provider ASN
 * @param aspaObjects - Map of all known ASPA objects
 * @param afi - Address family to check ("ipv4" or "ipv6")
 * @returns "provider" if authorized, "not-provider" if explicitly not listed,
 *          or "no-attestation" if the customer has no ASPA object
 *
 * @see RFC 9582 Section 6 — Verification of Provider Authorization
 */
function checkProviderAuthorization(
  customerAsn: number,
  providerAsn: number,
  aspaObjects: ReadonlyMap<number, ASPAObject>,
  afi: "ipv4" | "ipv6" = "ipv4"
): "provider" | "not-provider" | "no-attestation" {
  const aspa = aspaObjects.get(customerAsn);

  if (!aspa) {
    return "no-attestation";
  }

  const isAuthorized = aspa.providers.some(
    (p) => p.asn === providerAsn && p.afi.includes(afi)
  );

  return isAuthorized ? "provider" : "not-provider";
}

/**
 * Remove consecutive duplicate ASNs from a path (AS path prepending).
 *
 * BGP speakers may prepend their own ASN multiple times for traffic
 * engineering. For ASPA validation, consecutive duplicates are collapsed.
 *
 * @param path - The raw AS path
 * @returns The path with consecutive duplicates removed
 */
function deduplicatePath(path: ReadonlyArray<number>): ReadonlyArray<number> {
  return path.filter((asn, index) => index === 0 || asn !== path[index - 1]);
}

// ── Core Validation Functions ───────────────────────────

/**
 * Validate an AS path in the upstream direction per RFC 9582 Section 6.
 *
 * Walks the path from the origin AS (rightmost) toward the validating AS
 * (leftmost). For each pair (customer, provider), verifies that the
 * customer has authorized the provider via an ASPA object.
 *
 * The upstream validation procedure (RFC 9582 Section 6):
 * - If the path has 0 or 1 unique ASNs, the result is "valid".
 * - Walk from index N-1 (origin) toward index 0.
 * - At each hop, check if path[i] authorizes path[i-1] as its provider.
 * - If any hop yields "not-provider", the path is "invalid".
 * - If all hops yield "provider", the path is "valid".
 * - Otherwise the path is "unknown".
 *
 * @param path - AS path to validate (leftmost = closest to validator)
 * @param aspaObjects - Map of customer ASN to ASPA object
 * @returns Validation result with status, violations, and confidence
 */
export function validateUpstream(
  path: ReadonlyArray<number>,
  aspaObjects: ReadonlyMap<number, ASPAObject>
): ASPAValidationResult {
  const dedupedPath = deduplicatePath(path);

  // Trivial paths are always valid
  if (dedupedPath.length <= 1) {
    return {
      status: "valid",
      path: [...dedupedPath],
      violations: [],
      leakDetected: false,
      confidence: 1.0,
    };
  }

  const violations: ASPAViolation[] = [];
  let hasNoAttestation = false;
  let coveredHops = 0;
  const totalHops = dedupedPath.length - 1;

  // Walk from origin (rightmost) toward the validator (leftmost).
  // path[i] is the customer; path[i-1] is the alleged provider.
  for (let i = dedupedPath.length - 1; i >= 1; i--) {
    const customerAsn = dedupedPath[i];
    const providerAsn = dedupedPath[i - 1];

    const authResult = checkProviderAuthorization(
      customerAsn,
      providerAsn,
      aspaObjects
    );

    if (authResult === "provider") {
      coveredHops++;
    } else if (authResult === "not-provider") {
      coveredHops++;
      const aspa = aspaObjects.get(customerAsn);
      violations.push({
        position: i,
        asn: customerAsn,
        expectedProviders: aspa
          ? aspa.providers.map((p) => p.asn)
          : [],
        actualNextHop: providerAsn,
        reason: `AS${customerAsn} has an ASPA object but does not list AS${providerAsn} as an authorized provider. ` +
          `This indicates a potential route leak or unauthorized path segment.`,
      });
    } else {
      hasNoAttestation = true;
    }
  }

  const confidence = totalHops > 0 ? coveredHops / totalHops : 1.0;

  // Determine overall status per RFC 9582 Section 6
  if (violations.length > 0) {
    const leakingViolation = violations[0];
    return {
      status: "invalid",
      path: [...dedupedPath],
      violations,
      leakDetected: true,
      leakingAsn: leakingViolation.asn,
      confidence,
    };
  }

  if (hasNoAttestation) {
    return {
      status: "unknown",
      path: [...dedupedPath],
      violations: [],
      leakDetected: false,
      confidence,
    };
  }

  return {
    status: "valid",
    path: [...dedupedPath],
    violations: [],
    leakDetected: false,
    confidence,
  };
}

/**
 * Validate an AS path in the downstream direction per RFC 9582 Section 6.
 *
 * Reverses the path and applies the upstream validation procedure.
 * Downstream validation is used when the validating AS is receiving
 * a route from a customer rather than a provider.
 *
 * Per RFC 9582, the downstream verification is the mirror image of upstream:
 * - Reverse the path so the "origin" from the downstream perspective is leftmost.
 * - Apply the same provider-authorization checks.
 *
 * @param path - AS path to validate (leftmost = closest to validator)
 * @param aspaObjects - Map of customer ASN to ASPA object
 * @returns Validation result with status, violations, and confidence
 */
export function validateDownstream(
  path: ReadonlyArray<number>,
  aspaObjects: ReadonlyMap<number, ASPAObject>
): ASPAValidationResult {
  // Downstream: reverse the path and apply upstream logic.
  const reversedPath = [...path].reverse();
  const result = validateUpstream(reversedPath, aspaObjects);

  // Map violations back to original path positions
  const originalLength = deduplicatePath(path).length;
  const remappedViolations: ReadonlyArray<ASPAViolation> = result.violations.map(
    (v) => ({
      ...v,
      position: originalLength - 1 - v.position,
    })
  );

  return {
    ...result,
    path: [...deduplicatePath(path)],
    violations: remappedViolations,
  };
}

/**
 * Validate an AS path against ASPA objects.
 *
 * This is the main entry point for ASPA path validation. It dispatches
 * to either upstream or downstream validation based on the direction
 * parameter.
 *
 * @param path - The AS path to validate. Leftmost ASN is closest to the
 *               validating router; rightmost is the origin.
 * @param aspaObjects - Map of customer ASN to its ASPA object
 * @param direction - "upstream" when receiving from a provider,
 *                    "downstream" when receiving from a customer
 * @returns Full validation result including status, violations, leak
 *          detection, and confidence score
 *
 * @see RFC 9582 Section 6 — Procedure for Verifying the AS_PATH Attribute
 *
 * @example
 * ```typescript
 * // Upstream validation: AS174 -> AS13335 -> AS64501 (origin)
 * const result = validatePath(
 *   [174, 13335, 64501],
 *   aspaObjects,
 *   "upstream"
 * );
 *
 * if (result.leakDetected) {
 *   console.log(`Route leak by AS${result.leakingAsn}`);
 * }
 * ```
 */
export function validatePath(
  path: ReadonlyArray<number>,
  aspaObjects: ReadonlyMap<number, ASPAObject>,
  direction: "upstream" | "downstream"
): ASPAValidationResult {
  if (path.length === 0) {
    return {
      status: "unverifiable",
      path: [],
      violations: [],
      leakDetected: false,
      confidence: 0,
    };
  }

  return direction === "upstream"
    ? validateUpstream(path, aspaObjects)
    : validateDownstream(path, aspaObjects);
}
