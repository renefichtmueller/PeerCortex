/**
 * @module sources/bgp-he
 * bgp.he.net scraper for ASN information, peering data, and prefix lists.
 *
 * Hurricane Electric's BGP Toolkit provides a comprehensive view of the
 * global routing table. This module scrapes the public web interface
 * since no official API is available.
 *
 * @see https://bgp.he.net/
 */

import * as cheerio from "cheerio";
import type { HENetASNInfo } from "../types/bgp.js";
import type { ASN } from "../types/common.js";
import { PeerCortexError } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

const HE_BGP_BASE_URL = "https://bgp.he.net";

interface BGPHEClientConfig {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

// ── Client ───────────────────────────────────────────────

/**
 * bgp.he.net scraper client.
 *
 * Scrapes ASN information, peer lists, prefix originations, and IX
 * participation from Hurricane Electric's BGP Toolkit.
 *
 * @example
 * ```typescript
 * const client = createBGPHEClient();
 * const info = await client.getASNInfo(13335);
 * console.log(info.name); // "CLOUDFLARENET"
 * ```
 */
export interface BGPHEClient {
  /** Get comprehensive ASN info including peers, prefixes, and IX participation */
  getASNInfo(asn: ASN): Promise<HENetASNInfo>;

  /** Get list of peers for an ASN */
  getPeers(asn: ASN): Promise<HENetASNInfo["peers"]>;

  /** Get originated prefixes for an ASN */
  getPrefixes(asn: ASN): Promise<HENetASNInfo["prefixesOriginated"]>;

  /** Get upstream providers for an ASN */
  getUpstreams(asn: ASN): Promise<HENetASNInfo["upstreams"]>;

  /** Get downstream customers for an ASN */
  getDownstreams(asn: ASN): Promise<HENetASNInfo["downstreams"]>;

  /** Check if bgp.he.net is reachable */
  healthCheck(): Promise<boolean>;
}

/**
 * Create a new bgp.he.net scraper client.
 *
 * @param config - Client configuration
 * @returns A configured bgp.he.net client instance
 */
export function createBGPHEClient(
  config: BGPHEClientConfig = {}
): BGPHEClient {
  const baseUrl = config.baseUrl ?? HE_BGP_BASE_URL;
  const timeoutMs = config.timeoutMs ?? 20000;

  /**
   * Fetch and parse an HTML page from bgp.he.net.
   */
  async function fetchPage(path: string): Promise<cheerio.CheerioAPI> {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; PeerCortex/0.1.0; +https://github.com/peercortex/peercortex)",
          Accept: "text/html",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `bgp.he.net returned ${response.status}`,
          "SOURCE_UNAVAILABLE",
          "bgp_he"
        );
      }

      const html = await response.text();
      return cheerio.load(html);
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `bgp.he.net scraping failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "bgp_he",
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse peer table rows from bgp.he.net HTML.
   */
  function parsePeerTable(
    $: cheerio.CheerioAPI,
    tableId: string
  ): ReadonlyArray<{ asn: number; name: string; v4: boolean; v6: boolean }> {
    const peers: Array<{ asn: number; name: string; v4: boolean; v6: boolean }> = [];

    $(`#${tableId} tbody tr`).each((_i, row) => {
      const cells = $(row).find("td");
      if (cells.length >= 4) {
        const asnText = $(cells[0]).text().trim().replace("AS", "");
        const asn = parseInt(asnText, 10);
        const name = $(cells[1]).text().trim();
        const v4 = $(cells[2]).text().trim() !== "";
        const v6 = $(cells[3]).text().trim() !== "";

        if (!isNaN(asn)) {
          peers.push({ asn, name, v4, v6 });
        }
      }
    });

    return peers;
  }

  return {
    async getASNInfo(asn: ASN): Promise<HENetASNInfo> {
      // TODO: Implement full scraping of bgp.he.net/AS{asn}
      // This requires parsing multiple pages:
      //   - /AS{asn} — overview page
      //   - /AS{asn}#_peers — peer table
      //   - /AS{asn}#_prefixes — originated prefixes
      //   - /AS{asn}#_graph — AS graph

      const $ = await fetchPage(`/AS${asn}`);

      // Parse ASN name from page title
      const title = $("title").text();
      const nameMatch = title.match(/AS\d+\s+(.+?)\s*[-|]/);
      const name = nameMatch ? nameMatch[1].trim() : "Unknown";

      // Parse description from whois block
      const description = $("#whois").text().trim().slice(0, 500);

      // TODO: Parse country, contacts, prefixes, peers from the HTML tables
      // For now, return a skeleton with the name populated

      return {
        asn,
        name,
        description,
        country: "", // TODO: Extract from whois data
        emailContacts: [], // TODO: Parse contact info
        abuseContacts: [], // TODO: Parse abuse contacts
        prefixesOriginated: {
          v4: [], // TODO: Scrape from prefixes tab
          v6: [], // TODO: Scrape from prefixes tab
        },
        peers: [...parsePeerTable($, "peers")],
        upstreams: [], // TODO: Scrape upstream table
        downstreams: [], // TODO: Scrape downstream table
        ixParticipation: [], // TODO: Scrape IX table
      };
    },

    async getPeers(asn: ASN): Promise<HENetASNInfo["peers"]> {
      const $ = await fetchPage(`/AS${asn}#_peers`);
      return parsePeerTable($, "peers");
    },

    async getPrefixes(asn: ASN): Promise<HENetASNInfo["prefixesOriginated"]> {
      // TODO: Scrape prefixes from /AS{asn}#_prefixes and /AS{asn}#_prefixes6
      const _$ = await fetchPage(`/AS${asn}#_prefixes`);
      return {
        v4: [], // TODO: Parse v4 prefix table
        v6: [], // TODO: Parse v6 prefix table
      };
    },

    async getUpstreams(asn: ASN): Promise<HENetASNInfo["upstreams"]> {
      // TODO: Scrape upstream ASNs from graph page
      const _asn = asn;
      return []; // TODO: Implement
    },

    async getDownstreams(asn: ASN): Promise<HENetASNInfo["downstreams"]> {
      // TODO: Scrape downstream ASNs from graph page
      const _asn = asn;
      return []; // TODO: Implement
    },

    async healthCheck(): Promise<boolean> {
      try {
        await fetchPage("/AS13335");
        return true;
      } catch {
        return false;
      }
    },
  };
}
