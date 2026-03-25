/**
 * @module sources/irr
 * IRR (Internet Routing Registry) and WHOIS query client.
 *
 * Queries RIPE DB, RADB, ARIN, APNIC, and other IRR databases for
 * route objects, as-set expansions, and WHOIS data.
 *
 * @see https://www.irr.net/
 * @see https://www.ripe.net/manage-ips-and-asns/db/
 */

import type { ASN } from "../types/common.js";
import { PeerCortexError, formatASN } from "../types/common.js";

// ── Types ────────────────────────────────────────────────

/** IRR source database */
export type IRRSource =
  | "RIPE"
  | "RADB"
  | "ARIN"
  | "APNIC"
  | "AFRINIC"
  | "LACNIC"
  | "NTTCOM"
  | "LEVEL3"
  | "ALTDB";

/** IRR route object */
export interface IRRRouteObject {
  readonly prefix: string;
  readonly origin: string;
  readonly source: IRRSource;
  readonly description: string;
  readonly maintainer: string;
  readonly lastModified: string;
}

/** IRR as-set object */
export interface IRRAsSet {
  readonly name: string;
  readonly members: ReadonlyArray<string>;
  readonly source: IRRSource;
  readonly description: string;
  readonly maintainer: string;
}

/** WHOIS record for an ASN or prefix */
export interface WHOISRecord {
  readonly resource: string;
  readonly type: "aut-num" | "inetnum" | "inet6num" | "route" | "route6";
  readonly fields: Record<string, ReadonlyArray<string>>;
  readonly source: string;
  readonly rawText: string;
}

// ── Configuration ────────────────────────────────────────

interface IRRClientConfig {
  readonly defaultSources?: ReadonlyArray<IRRSource>;
  readonly ripeDbUrl?: string;
  readonly timeoutMs?: number;
}

// ── Client ───────────────────────────────────────────────

/**
 * IRR / WHOIS query client.
 *
 * Provides access to Internet Routing Registry data including route objects,
 * as-set expansions, and WHOIS records from multiple IRR sources.
 *
 * @example
 * ```typescript
 * const client = createIRRClient();
 * const routes = await client.getRouteObjects(13335);
 * const asSet = await client.expandAsSet("AS-CLOUDFLARE");
 * ```
 */
export interface IRRClient {
  /** Get all route/route6 objects for an ASN */
  getRouteObjects(asn: ASN): Promise<ReadonlyArray<IRRRouteObject>>;

  /** Expand an as-set to its member ASNs (recursive) */
  expandAsSet(asSetName: string): Promise<ReadonlyArray<string>>;

  /** Get the as-set name registered for an ASN */
  getAsSet(asn: ASN): Promise<IRRAsSet | null>;

  /** Perform a raw WHOIS query */
  whoisQuery(resource: string): Promise<WHOISRecord>;

  /** Look up the IRR registration for a prefix */
  lookupPrefix(prefix: string): Promise<ReadonlyArray<IRRRouteObject>>;

  /** Check consistency between IRR and BGP for an ASN */
  checkConsistency(
    asn: ASN
  ): Promise<{
    registeredPrefixes: ReadonlyArray<string>;
    announcedPrefixes: ReadonlyArray<string>;
    missingRegistrations: ReadonlyArray<string>;
    staleRegistrations: ReadonlyArray<string>;
  }>;

  /** Check if the service is reachable */
  healthCheck(): Promise<boolean>;
}

/**
 * Create a new IRR / WHOIS client.
 *
 * @param config - Client configuration
 * @returns A configured IRR client instance
 */
export function createIRRClient(config: IRRClientConfig = {}): IRRClient {
  const ripeDbUrl =
    config.ripeDbUrl ?? "https://rest.db.ripe.net";
  const timeoutMs = config.timeoutMs ?? 15000;
  const _defaultSources = config.defaultSources ?? ["RIPE", "RADB"];

  /**
   * Query the RIPE DB REST API.
   */
  async function queryRIPEDB<T>(path: string): Promise<T> {
    const url = `${ripeDbUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
          `RIPE DB query failed: ${response.status}`,
          "SOURCE_UNAVAILABLE",
          "irr"
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `IRR query failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "irr",
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getRouteObjects(asn: ASN): Promise<ReadonlyArray<IRRRouteObject>> {
      // TODO: Query RIPE DB for route objects with origin: AS{asn}
      // Use: /search?source=ripe&query-string=AS{asn}&type-filter=route,route6&flags=no-referenced
      const _asn = asn;

      try {
        const result = await queryRIPEDB<{
          objects: {
            object: ReadonlyArray<{
              attributes: {
                attribute: ReadonlyArray<{
                  name: string;
                  value: string;
                }>;
              };
              source: { id: string };
            }>;
          };
        }>(
          `/search?source=ripe&query-string=${formatASN(asn)}&type-filter=route,route6&flags=no-referenced`
        );

        return result.objects.object.map((obj) => {
          const attrs = obj.attributes.attribute;
          const getAttr = (name: string) =>
            attrs.find((a) => a.name === name)?.value ?? "";

          return {
            prefix: getAttr("route") || getAttr("route6"),
            origin: getAttr("origin"),
            source: obj.source.id as IRRSource,
            description: getAttr("descr"),
            maintainer: getAttr("mnt-by"),
            lastModified: getAttr("last-modified"),
          };
        });
      } catch {
        return []; // TODO: Handle gracefully, try alternative sources
      }
    },

    async expandAsSet(asSetName: string): Promise<ReadonlyArray<string>> {
      // TODO: Recursively expand as-set from RIPE DB
      // Use: /search?source=ripe&query-string={asSetName}&type-filter=as-set
      const _asSetName = asSetName;
      return []; // TODO: Implement recursive expansion
    },

    async getAsSet(asn: ASN): Promise<IRRAsSet | null> {
      // TODO: Look up as-set for an ASN
      const _asn = asn;
      return null; // TODO: Implement
    },

    async whoisQuery(resource: string): Promise<WHOISRecord> {
      // TODO: Implement WHOIS query via RIPE DB REST or raw WHOIS
      const _resource = resource;
      throw new PeerCortexError(
        "WHOIS query not yet implemented",
        "UNKNOWN",
        "irr"
      );
    },

    async lookupPrefix(
      prefix: string
    ): Promise<ReadonlyArray<IRRRouteObject>> {
      // TODO: Look up route objects for a specific prefix
      const _prefix = prefix;
      return []; // TODO: Implement
    },

    async checkConsistency(asn: ASN) {
      // TODO: Compare IRR registrations against BGP announcements
      const _asn = asn;
      return {
        registeredPrefixes: [] as ReadonlyArray<string>,
        announcedPrefixes: [] as ReadonlyArray<string>,
        missingRegistrations: [] as ReadonlyArray<string>,
        staleRegistrations: [] as ReadonlyArray<string>,
      };
    },

    async healthCheck(): Promise<boolean> {
      try {
        await queryRIPEDB("/search?source=ripe&query-string=AS13335&type-filter=aut-num");
        return true;
      } catch {
        return false;
      }
    },
  };
}
