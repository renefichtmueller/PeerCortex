/**
 * @module sources/caida
 * CAIDA AS-Relationships dataset client.
 *
 * CAIDA publishes inferred AS-level relationships (provider-customer,
 * peer-to-peer, sibling) derived from BGP data. This client fetches and
 * parses the serial-2 relationship format.
 *
 * @see https://www.caida.org/catalog/datasets/as-relationships/
 * @see https://api.asrank.caida.org/v2/docs
 */

import type { ASN } from "../types/common.js";
import { PeerCortexError } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

const CAIDA_ASRANK_BASE_URL = "https://api.asrank.caida.org/v2";

interface CAIDAClientConfig {
  /** Base URL override */
  readonly baseUrl?: string;
  /** Request timeout in milliseconds */
  readonly timeoutMs?: number;
}

// ── Types ────────────────────────────────────────────────

/** Relationship type between two ASes */
export type ASRelationshipType =
  | "provider-customer"   // left provides transit to right
  | "customer-provider"   // left is customer of right
  | "peer-to-peer"        // settlement-free peering
  | "sibling";            // same organization

/** A single AS-level relationship */
export interface ASRelationship {
  readonly asnLeft: ASN;
  readonly asnRight: ASN;
  readonly relationship: ASRelationshipType;
  readonly source: string;
}

/** CAIDA AS Rank entry */
export interface ASRankEntry {
  readonly asn: ASN;
  readonly asnName: string;
  readonly rank: number;
  readonly organization: string;
  readonly country: string;
  readonly cone: {
    readonly numberAsns: number;
    readonly numberPrefixes: number;
    readonly numberAddresses: number;
  };
  readonly asnDegree: {
    readonly provider: number;
    readonly peer: number;
    readonly customer: number;
    readonly total: number;
  };
}

/** Cone (customer cone) of an AS */
export interface ASCone {
  readonly asn: ASN;
  readonly asns: ReadonlyArray<ASN>;
  readonly prefixes: ReadonlyArray<string>;
  readonly totalAddresses: number;
}

// ── Client Interface ─────────────────────────────────────

/**
 * CAIDA AS-Relationships and AS Rank client.
 *
 * @example
 * ```typescript
 * const caida = createCAIDAClient();
 * const rank = await caida.getASRank(13335);
 * console.log(`Cloudflare is ranked #${rank.rank}`);
 *
 * const rels = await caida.getRelationships(13335);
 * const providers = rels.filter(r => r.relationship === "customer-provider");
 * ```
 */
export interface CAIDAClient {
  /** Get AS Rank entry for an ASN */
  getASRank(asn: ASN): Promise<ASRankEntry>;

  /** Get top N ASes by rank */
  getTopASes(limit?: number): Promise<ReadonlyArray<ASRankEntry>>;

  /** Get all known relationships for an ASN */
  getRelationships(asn: ASN): Promise<ReadonlyArray<ASRelationship>>;

  /** Get the customer cone for an ASN */
  getCustomerCone(asn: ASN): Promise<ASCone>;

  /** Check if the CAIDA API is reachable */
  healthCheck(): Promise<boolean>;
}

// ── Client Factory ───────────────────────────────────────

/**
 * Create a new CAIDA AS-Relationships client.
 *
 * Uses the CAIDA AS Rank GraphQL/REST API for relationship and ranking data.
 *
 * @param config - Client configuration
 * @returns A configured CAIDA client instance
 */
export function createCAIDAClient(
  config: CAIDAClientConfig = {}
): CAIDAClient {
  const baseUrl = config.baseUrl ?? CAIDA_ASRANK_BASE_URL;
  const timeoutMs = config.timeoutMs ?? 30000;

  /**
   * Execute a GraphQL query against the CAIDA AS Rank API.
   */
  async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/graphql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "PeerCortex/0.1.0",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `CAIDA API error: ${response.status} ${response.statusText}`,
          "SOURCE_UNAVAILABLE",
          "ripe_stat" // TODO: Add caida as DataSourceName
        );
      }

      const body = (await response.json()) as { data: T; errors?: ReadonlyArray<{ message: string }> };

      if (body.errors && body.errors.length > 0) {
        throw new PeerCortexError(
          `CAIDA GraphQL error: ${body.errors[0].message}`,
          "SOURCE_UNAVAILABLE",
          "ripe_stat"
        );
      }

      return body.data;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `CAIDA request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "ripe_stat",
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Map CAIDA relationship code to typed enum.
   */
  function mapRelationship(code: number): ASRelationshipType {
    switch (code) {
      case -1: return "provider-customer";
      case 0: return "peer-to-peer";
      case 1: return "customer-provider";
      case 2: return "sibling";
      default: return "peer-to-peer";
    }
  }

  return {
    async getASRank(asn: ASN): Promise<ASRankEntry> {
      const query = `
        query GetASRank($asn: String!) {
          asn(asn: $asn) {
            asn
            asnName
            rank
            organization { orgName }
            country { iso }
            cone { numberAsns numberPrefixes numberAddresses }
            asnDegree { provider peer customer total }
          }
        }
      `;

      const result = await graphql<{
        asn: {
          asn: number;
          asnName: string;
          rank: number;
          organization: { orgName: string };
          country: { iso: string };
          cone: { numberAsns: number; numberPrefixes: number; numberAddresses: number };
          asnDegree: { provider: number; peer: number; customer: number; total: number };
        };
      }>(query, { asn: String(asn) });

      return {
        asn: result.asn.asn,
        asnName: result.asn.asnName,
        rank: result.asn.rank,
        organization: result.asn.organization.orgName,
        country: result.asn.country.iso,
        cone: result.asn.cone,
        asnDegree: result.asn.asnDegree,
      };
    },

    async getTopASes(limit: number = 20): Promise<ReadonlyArray<ASRankEntry>> {
      // TODO: Implement via CAIDA AS Rank API with pagination
      const query = `
        query GetTopASes($first: Int!) {
          asns(first: $first, sort: "rank") {
            edges {
              node {
                asn
                asnName
                rank
                organization { orgName }
                country { iso }
                cone { numberAsns numberPrefixes numberAddresses }
                asnDegree { provider peer customer total }
              }
            }
          }
        }
      `;

      const result = await graphql<{
        asns: {
          edges: ReadonlyArray<{
            node: {
              asn: number;
              asnName: string;
              rank: number;
              organization: { orgName: string };
              country: { iso: string };
              cone: { numberAsns: number; numberPrefixes: number; numberAddresses: number };
              asnDegree: { provider: number; peer: number; customer: number; total: number };
            };
          }>;
        };
      }>(query, { first: limit });

      return result.asns.edges.map((edge) => ({
        asn: edge.node.asn,
        asnName: edge.node.asnName,
        rank: edge.node.rank,
        organization: edge.node.organization.orgName,
        country: edge.node.country.iso,
        cone: edge.node.cone,
        asnDegree: edge.node.asnDegree,
      }));
    },

    async getRelationships(
      asn: ASN
    ): Promise<ReadonlyArray<ASRelationship>> {
      // TODO: Implement via AS Rank API asnLinks query
      // TODO: Parse provider/customer/peer relationships
      const query = `
        query GetRelationships($asn: String!) {
          asn(asn: $asn) {
            asnLinks(first: 500) {
              edges {
                node {
                  asn0 { asn }
                  asn1 { asn }
                  relationship
                }
              }
            }
          }
        }
      `;

      const result = await graphql<{
        asn: {
          asnLinks: {
            edges: ReadonlyArray<{
              node: {
                asn0: { asn: number };
                asn1: { asn: number };
                relationship: number;
              };
            }>;
          };
        };
      }>(query, { asn: String(asn) });

      return result.asn.asnLinks.edges.map((edge) => ({
        asnLeft: edge.node.asn0.asn,
        asnRight: edge.node.asn1.asn,
        relationship: mapRelationship(edge.node.relationship),
        source: "caida",
      }));
    },

    async getCustomerCone(asn: ASN): Promise<ASCone> {
      // TODO: Implement via CAIDA AS Rank cone query
      // TODO: This may require downloading the cone dataset for full data
      const _asn = asn;
      return {
        asn,
        asns: [],
        prefixes: [],
        totalAddresses: 0,
      };
    },

    async healthCheck(): Promise<boolean> {
      try {
        // Use Cloudflare (AS13335) as a known-good test
        await this.getASRank(13335);
        return true;
      } catch {
        return false;
      }
    },
  };
}
