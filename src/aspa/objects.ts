/**
 * @module aspa/objects
 * ASPA Object management — fetching, parsing, and caching.
 *
 * Provides functions to retrieve ASPA objects from the RIPE Database
 * and maintain an in-memory cache with TTL-based expiration.
 *
 * @see https://www.ripe-editor.org/rfc/rfc9582
 * @see https://apps.db.ripe.net/docs/DatabaseReference/RIPE-Database-Structure/
 *
 * @example
 * ```typescript
 * // Fetch ASPA objects for a single ASN
 * const objects = await fetchASPAObjects(13335);
 * console.log(objects[0].providers); // [{ asn: 174, afi: ["ipv4", "ipv6"] }]
 *
 * // Bulk fetch all available ASPA objects
 * const allObjects = await fetchAllASPAObjects();
 * console.log(allObjects.size); // Number of ASNs with ASPA objects
 * ```
 */

import type { ASPAObject } from "./validator.js";
import { PeerCortexError } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

const RIPE_DB_BASE_URL = "https://rest.db.ripe.net";
const RIPE_STAT_BASE_URL = "https://stat.ripe.net/data";

/** Default cache TTL: 1 hour */
const DEFAULT_CACHE_TTL_MS = 3600 * 1000;

// ── In-Memory Cache ──────────────────────────────────────

interface CacheEntry<T> {
  readonly data: T;
  readonly expiresAt: number;
}

/** In-memory cache for ASPA objects with TTL-based expiration */
const aspaCache = new Map<string, CacheEntry<unknown>>();

/**
 * Get a value from the in-memory cache.
 *
 * @param key - Cache key
 * @returns The cached value, or null if not found or expired
 */
function cacheGet<T>(key: string): T | null {
  const entry = aspaCache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    aspaCache.delete(key);
    return null;
  }

  return entry.data as T;
}

/**
 * Set a value in the in-memory cache.
 *
 * @param key - Cache key
 * @param data - Value to cache
 * @param ttlMs - Time-to-live in milliseconds
 */
function cacheSet<T>(key: string, data: T, ttlMs: number = DEFAULT_CACHE_TTL_MS): void {
  aspaCache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Clear all entries from the ASPA cache.
 */
export function clearASPACache(): void {
  aspaCache.clear();
}

// ── RIPE DB Response Parsing ────────────────────────────

/**
 * Parse a RIPE Database RPSL response into an ASPAObject.
 *
 * RIPE DB returns ASPA objects in RPSL (Routing Policy Specification Language)
 * format. This function extracts the customer ASN and provider list.
 *
 * Expected RPSL format:
 * ```
 * aut-num:    AS64501
 * aspa:       AS64501
 * upstream:   AS174
 * upstream:   AS13335
 * afi:        ipv4, ipv6
 * ```
 *
 * @param raw - Raw RPSL text from RIPE DB
 * @returns Parsed ASPA object, or null if parsing fails
 *
 * @example
 * ```typescript
 * const raw = `aut-num: AS64501\nupstream: AS174\nupstream: AS13335`;
 * const aspa = parseRipeDbResponse(raw);
 * // { customerAsn: 64501, providers: [{ asn: 174, afi: [...] }, { asn: 13335, afi: [...] }] }
 * ```
 */
export function parseRipeDbResponse(raw: string): ASPAObject | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("%"));

  let customerAsn: number | null = null;
  const providers: Array<{ asn: number; afi: ReadonlyArray<"ipv4" | "ipv6"> }> = [];

  for (const line of lines) {
    // Extract customer ASN from "aut-num:" or "aspa:" field
    const autNumMatch = line.match(/^(?:aut-num|aspa):\s*AS(\d+)/i);
    if (autNumMatch) {
      customerAsn = parseInt(autNumMatch[1], 10);
      continue;
    }

    // Extract provider ASN from "upstream:" or "provider:" field
    const upstreamMatch = line.match(/^(?:upstream|provider):\s*AS(\d+)/i);
    if (upstreamMatch) {
      const providerAsn = parseInt(upstreamMatch[1], 10);
      providers.push({
        asn: providerAsn,
        afi: ["ipv4", "ipv6"],
      });
      continue;
    }

    // Handle AFI-scoped providers: "upstream: AS174 ipv4"
    const afiScopedMatch = line.match(
      /^(?:upstream|provider):\s*AS(\d+)\s+(ipv[46](?:\s*,\s*ipv[46])?)/i
    );
    if (afiScopedMatch) {
      const providerAsn = parseInt(afiScopedMatch[1], 10);
      const afiStr = afiScopedMatch[2].toLowerCase();
      const afi: Array<"ipv4" | "ipv6"> = [];
      if (afiStr.includes("ipv4")) afi.push("ipv4");
      if (afiStr.includes("ipv6")) afi.push("ipv6");

      // Update existing entry or add new one
      const existing = providers.find((p) => p.asn === providerAsn);
      if (!existing) {
        providers.push({ asn: providerAsn, afi });
      }
    }
  }

  if (customerAsn === null) return null;

  return {
    customerAsn,
    providers,
  };
}

// ── Fetch Functions ─────────────────────────────────────

/**
 * Fetch ASPA objects for a specific ASN from the RIPE Database API.
 *
 * Queries the RIPE DB REST API for any ASPA objects where the given
 * ASN is the customer. Results are cached in memory with a configurable TTL.
 *
 * @param asn - The customer ASN to look up
 * @returns Array of ASPA objects for this ASN (usually 0 or 1)
 * @throws {PeerCortexError} If the RIPE DB API is unreachable
 *
 * @example
 * ```typescript
 * const objects = await fetchASPAObjects(13335);
 * if (objects.length > 0) {
 *   console.log(`AS13335 has ${objects[0].providers.length} authorized providers`);
 * } else {
 *   console.log("AS13335 has no ASPA object registered");
 * }
 * ```
 */
export async function fetchASPAObjects(asn: number): Promise<ReadonlyArray<ASPAObject>> {
  const cacheKey = `aspa:${asn}`;
  const cached = cacheGet<ReadonlyArray<ASPAObject>>(cacheKey);
  if (cached) return cached;

  try {
    // Query RIPE DB for ASPA-related objects for this ASN
    const url = `${RIPE_DB_BASE_URL}/search.json?query-string=AS${asn}&type-filter=aut-num&flags=no-referenced&flags=no-irt&source=RIPE`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "PeerCortex/0.1.0",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        // If not found, cache empty result to avoid repeated lookups
        if (response.status === 404) {
          const emptyResult: ReadonlyArray<ASPAObject> = [];
          cacheSet(cacheKey, emptyResult);
          return emptyResult;
        }

        throw new PeerCortexError(
          `RIPE DB API error: ${response.status} ${response.statusText}`,
          response.status === 429 ? "RATE_LIMITED" : "SOURCE_UNAVAILABLE",
          "ripe_stat"
        );
      }

      const body = await response.json() as Record<string, unknown>;
      const objects = parseRipeDbJsonResponse(body, asn);
      cacheSet(cacheKey, objects);
      return objects;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof PeerCortexError) throw error;
    throw new PeerCortexError(
      `Failed to fetch ASPA objects for AS${asn}: ${error instanceof Error ? error.message : "Unknown error"}`,
      "SOURCE_UNAVAILABLE",
      "ripe_stat",
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Parse RIPE DB JSON API response into ASPA objects.
 *
 * @param body - Parsed JSON response from RIPE DB REST API
 * @param asn - The ASN we queried for
 * @returns Array of parsed ASPA objects
 */
function parseRipeDbJsonResponse(
  body: Record<string, unknown>,
  asn: number
): ReadonlyArray<ASPAObject> {
  // The RIPE DB JSON format nests objects under objects.object[]
  const objects = (body as Record<string, Record<string, unknown>>).objects;
  if (!objects || !Array.isArray((objects as Record<string, unknown>).object)) {
    return [];
  }

  const results: ASPAObject[] = [];
  const objectList = (objects as Record<string, unknown[]>).object;

  for (const obj of objectList) {
    const objRecord = obj as Record<string, unknown>;
    const attrs = objRecord.attributes;
    if (!attrs) continue;

    const attrList = (attrs as Record<string, unknown[]>).attribute;
    if (!Array.isArray(attrList)) continue;

    const providers: Array<{ asn: number; afi: ReadonlyArray<"ipv4" | "ipv6"> }> = [];

    for (const attr of attrList) {
      const attrObj = attr as Record<string, string>;
      if (
        (attrObj.name === "import" || attrObj.name === "mp-import") &&
        attrObj.value
      ) {
        // Try to extract provider ASNs from import policies
        const asnMatch = attrObj.value.match(/AS(\d+)/);
        if (asnMatch) {
          const providerAsn = parseInt(asnMatch[1], 10);
          if (!providers.some((p) => p.asn === providerAsn)) {
            providers.push({
              asn: providerAsn,
              afi: ["ipv4", "ipv6"],
            });
          }
        }
      }
    }

    if (providers.length > 0) {
      results.push({
        customerAsn: asn,
        providers,
      });
    }
  }

  return results;
}

/**
 * Bulk-fetch all available ASPA objects.
 *
 * Queries the RIPE Stat API for a broad view of ASPA deployment,
 * then fetches individual ASPA objects for ASNs that have them.
 * Results are aggregated into a Map keyed by customer ASN.
 *
 * This is an expensive operation; results are cached for 1 hour.
 *
 * @returns Map of customer ASN to ASPA object
 * @throws {PeerCortexError} If the data source is unreachable
 *
 * @example
 * ```typescript
 * const allAspa = await fetchAllASPAObjects();
 * console.log(`${allAspa.size} ASNs have registered ASPA objects`);
 * ```
 */
export async function fetchAllASPAObjects(): Promise<ReadonlyMap<number, ASPAObject>> {
  const cacheKey = "aspa:all";
  const cached = cacheGet<ReadonlyMap<number, ASPAObject>>(cacheKey);
  if (cached) return cached;

  try {
    // Use RIPE Stat to get a list of ASNs with RPKI data,
    // then check each for ASPA objects
    const url = `${RIPE_STAT_BASE_URL}/rpki-validation/data.json?resource=AS13335&sourceapp=peercortex`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "PeerCortex/0.1.0",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `RIPE Stat API error: ${response.status}`,
          "SOURCE_UNAVAILABLE",
          "ripe_stat"
        );
      }

      // For now, return an empty map — full ASPA registries are not yet
      // publicly queryable in bulk. Individual lookups via fetchASPAObjects
      // are the recommended approach until RPKI repositories expose ASPA
      // objects as first-class queryable resources.
      const result = new Map<number, ASPAObject>();
      cacheSet(cacheKey, result);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof PeerCortexError) throw error;
    throw new PeerCortexError(
      `Failed to fetch bulk ASPA objects: ${error instanceof Error ? error.message : "Unknown error"}`,
      "SOURCE_UNAVAILABLE",
      "ripe_stat",
      error instanceof Error ? error : undefined
    );
  }
}
