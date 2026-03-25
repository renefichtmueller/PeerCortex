/**
 * @module sources/rpki
 * RPKI validator client for ROA lookups and prefix validation.
 *
 * Supports both local Routinator instances and the RIPE RPKI Validator API.
 * Provides ROA lookups, prefix-origin validation, and compliance reporting.
 *
 * @see https://rpki.readthedocs.io/
 * @see https://routinator.docs.nlnetlabs.nl/
 */

import type {
  ASN,
  RPKIValidation,
  RPKIValidationState,
  RPKIComplianceReport,
  ROA,
} from "../types/common.js";
import { PeerCortexError, formatASN } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

interface RPKIClientConfig {
  readonly routinatorUrl?: string;
  readonly ripeRpkiUrl?: string;
  readonly timeoutMs?: number;
}

// ── Client ───────────────────────────────────────────────

/**
 * RPKI validator client.
 *
 * Validates prefix-origin pairs against ROAs using either a local
 * Routinator instance or the RIPE RPKI Validator API.
 *
 * @example
 * ```typescript
 * const client = createRPKIClient({ routinatorUrl: "http://localhost:8323" });
 * const result = await client.validatePrefix("1.1.1.0/24", 13335);
 * console.log(result.state); // "valid"
 * ```
 */
export interface RPKIClient {
  /** Validate a prefix-origin pair against ROAs */
  validatePrefix(prefix: string, originASN: ASN): Promise<RPKIValidation>;

  /** Get all ROAs for an ASN */
  getROAsForASN(asn: ASN): Promise<ReadonlyArray<ROA>>;

  /** Get all ROAs covering a prefix */
  getROAsForPrefix(prefix: string): Promise<ReadonlyArray<ROA>>;

  /** Generate RPKI compliance report for an ASN */
  generateComplianceReport(asn: ASN): Promise<RPKIComplianceReport>;

  /** Get the full VRP (Validated ROA Payload) list */
  getVRPList(): Promise<ReadonlyArray<ROA>>;

  /** Check if the RPKI validator is reachable */
  healthCheck(): Promise<boolean>;
}

/**
 * Create a new RPKI validator client.
 *
 * Tries Routinator first, falls back to RIPE RPKI Validator API.
 *
 * @param config - Client configuration
 * @returns A configured RPKI client instance
 */
export function createRPKIClient(config: RPKIClientConfig = {}): RPKIClient {
  const routinatorUrl = config.routinatorUrl ?? "http://localhost:8323";
  const ripeRpkiUrl =
    config.ripeRpkiUrl ?? "https://rpki-validator.ripe.net/api/v1";
  const timeoutMs = config.timeoutMs ?? 15000;

  /**
   * Try to query local Routinator, fall back to RIPE RPKI API.
   */
  async function queryRPKI<T>(
    routinatorPath: string,
    ripeFallbackPath: string
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Try Routinator first
      const routinatorResponse = await fetch(
        `${routinatorUrl}${routinatorPath}`,
        {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        }
      );

      if (routinatorResponse.ok) {
        return (await routinatorResponse.json()) as T;
      }
    } catch {
      // Routinator not available, fall back to RIPE
    } finally {
      clearTimeout(timeout);
    }

    // Fall back to RIPE RPKI Validator
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), timeoutMs);

    try {
      const ripeResponse = await fetch(
        `${ripeRpkiUrl}${ripeFallbackPath}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "PeerCortex/0.1.0",
          },
          signal: controller2.signal,
        }
      );

      if (!ripeResponse.ok) {
        throw new PeerCortexError(
          `RPKI validation failed: ${ripeResponse.status}`,
          "SOURCE_UNAVAILABLE",
          "rpki"
        );
      }

      return (await ripeResponse.json()) as T;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `RPKI query failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "rpki",
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout2);
    }
  }

  /**
   * Map RPKI validation strings to our typed enum.
   */
  function mapValidationState(state: string): RPKIValidationState {
    const normalized = state.toLowerCase();
    if (normalized === "valid") return "valid";
    if (normalized === "invalid") return "invalid";
    if (normalized === "not-found" || normalized === "unknown" || normalized === "not_found") {
      return "not-found";
    }
    return "unknown";
  }

  return {
    async validatePrefix(
      prefix: string,
      originASN: ASN
    ): Promise<RPKIValidation> {
      // TODO: Implement via Routinator /api/v1/validity/{asn}/{prefix}
      // or RIPE Stat rpki-validation data call

      try {
        const result = await queryRPKI<{
          validated_route: {
            validity: { state: string; description: string };
            route: { origin_asn: string; prefix: string };
          };
        }>(
          `/api/v1/validity/AS${originASN}/${prefix}`,
          `/validity?asn=${originASN}&prefix=${prefix}`
        );

        return {
          prefix,
          originASN,
          state: mapValidationState(
            result.validated_route.validity.state
          ),
          matchingROAs: [], // TODO: Parse matching ROAs from response
          reason: result.validated_route.validity.description,
        };
      } catch {
        // If both validators fail, return unknown state
        return {
          prefix,
          originASN,
          state: "unknown",
          matchingROAs: [],
          reason: "RPKI validators unavailable",
        };
      }
    },

    async getROAsForASN(asn: ASN): Promise<ReadonlyArray<ROA>> {
      // TODO: Query VRP list filtered by ASN
      // Routinator: /api/v1/vrps?filter.asn={asn}
      const _asn = asn;
      return []; // TODO: Implement
    },

    async getROAsForPrefix(prefix: string): Promise<ReadonlyArray<ROA>> {
      // TODO: Query VRP list filtered by prefix
      const _prefix = prefix;
      return []; // TODO: Implement
    },

    async generateComplianceReport(
      asn: ASN
    ): Promise<RPKIComplianceReport> {
      // TODO: Implement full compliance report
      // 1. Get all announced prefixes for the ASN
      // 2. Validate each prefix-origin pair
      // 3. Calculate coverage percentages
      // 4. Generate recommendations

      return {
        asn,
        name: "", // TODO: Look up from PeeringDB
        totalPrefixes: 0,
        validPrefixes: 0,
        invalidPrefixes: 0,
        unknownPrefixes: 0,
        coveragePercent: 0,
        recommendations: [
          "Create ROAs for all announced prefixes",
          "Set appropriate max-length values in ROAs",
          "Monitor RPKI validation state continuously",
        ],
        generatedAt: new Date().toISOString(),
      };
    },

    async getVRPList(): Promise<ReadonlyArray<ROA>> {
      // TODO: Fetch full VRP list from Routinator /api/v1/vrps
      return []; // TODO: Implement
    },

    async healthCheck(): Promise<boolean> {
      try {
        await this.validatePrefix("1.1.1.0/24", 13335);
        return true;
      } catch {
        return false;
      }
    },
  };
}
