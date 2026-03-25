/**
 * @module sources/dns
 * DNS resolver client for rDNS lookups, delegation checks, and WHOIS queries.
 *
 * Provides DNS resolution capabilities used by other modules for hostname
 * lookups, delegation verification, and domain intelligence gathering.
 *
 * @see https://dns.google/resolve
 * @see https://cloudflare-dns.com/dns-query
 */

import { PeerCortexError } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

interface DNSClientConfig {
  /** DNS-over-HTTPS resolver URL */
  readonly resolverUrl?: string;
  /** Request timeout in milliseconds */
  readonly timeoutMs?: number;
}

// ── Types ────────────────────────────────────────────────

/** DNS record types */
export type DNSRecordType =
  | "A"
  | "AAAA"
  | "CNAME"
  | "MX"
  | "NS"
  | "PTR"
  | "SOA"
  | "TXT"
  | "SRV"
  | "CAA"
  | "DNSKEY"
  | "DS"
  | "RRSIG";

/** A single DNS record */
export interface DNSRecord {
  readonly name: string;
  readonly type: DNSRecordType;
  readonly ttl: number;
  readonly data: string;
}

/** DNS resolution result */
export interface DNSResolutionResult {
  readonly query: string;
  readonly queryType: DNSRecordType;
  readonly status: number;
  readonly answers: ReadonlyArray<DNSRecord>;
  readonly authority: ReadonlyArray<DNSRecord>;
  readonly additional: ReadonlyArray<DNSRecord>;
  readonly truncated: boolean;
  readonly recursionDesired: boolean;
  readonly recursionAvailable: boolean;
  readonly authenticData: boolean;
  readonly checkingDisabled: boolean;
}

/** Reverse DNS lookup result */
export interface ReverseDNSResult {
  readonly ip: string;
  readonly hostname: string | null;
  readonly verified: boolean;
}

/** DNS delegation information */
export interface DelegationInfo {
  readonly domain: string;
  readonly nameservers: ReadonlyArray<{
    readonly hostname: string;
    readonly ipv4: ReadonlyArray<string>;
    readonly ipv6: ReadonlyArray<string>;
  }>;
  readonly dnssecEnabled: boolean;
  readonly dsRecords: ReadonlyArray<DNSRecord>;
  readonly registrar: string | null;
}

/** WHOIS summary for a resource */
export interface WHOISSummary {
  readonly resource: string;
  readonly type: "ip" | "asn" | "domain";
  readonly registrant: string;
  readonly organization: string;
  readonly country: string;
  readonly registrar: string;
  readonly creationDate: string;
  readonly expirationDate: string;
  readonly abuseContact: string;
  readonly rawText: string;
}

// ── Client Interface ─────────────────────────────────────

/**
 * DNS resolver client for network intelligence queries.
 *
 * Uses DNS-over-HTTPS (DoH) for reliable, privacy-preserving DNS lookups.
 *
 * @example
 * ```typescript
 * const dns = createDNSClient();
 *
 * // Reverse DNS lookup
 * const rdns = await dns.reverseLookup("1.1.1.1");
 * console.log(rdns.hostname); // "one.one.one.one"
 *
 * // Delegation check
 * const deleg = await dns.getDelegation("cloudflare.com");
 * console.log(deleg.dnssecEnabled); // true
 * ```
 */
export interface DNSClient {
  /** Resolve a DNS query */
  resolve(name: string, type: DNSRecordType): Promise<DNSResolutionResult>;

  /** Perform a reverse DNS lookup for an IP address */
  reverseLookup(ip: string): Promise<ReverseDNSResult>;

  /** Get delegation information for a domain */
  getDelegation(domain: string): Promise<DelegationInfo>;

  /** Perform a WHOIS lookup for an IP, ASN, or domain */
  whoisLookup(resource: string): Promise<WHOISSummary>;

  /** Batch reverse DNS for multiple IPs */
  batchReverseLookup(
    ips: ReadonlyArray<string>
  ): Promise<ReadonlyArray<ReverseDNSResult>>;

  /** Check if the DNS resolver is reachable */
  healthCheck(): Promise<boolean>;
}

// ── Client Factory ───────────────────────────────────────

/**
 * Create a new DNS client using DNS-over-HTTPS.
 *
 * @param config - Client configuration
 * @returns A configured DNS client instance
 */
export function createDNSClient(config: DNSClientConfig = {}): DNSClient {
  const resolverUrl =
    config.resolverUrl ?? "https://cloudflare-dns.com/dns-query";
  const timeoutMs = config.timeoutMs ?? 10000;

  /**
   * Make a DoH GET request.
   */
  async function dohQuery(
    name: string,
    type: string
  ): Promise<{
    Status: number;
    TC: boolean;
    RD: boolean;
    RA: boolean;
    AD: boolean;
    CD: boolean;
    Question: ReadonlyArray<{ name: string; type: number }>;
    Answer?: ReadonlyArray<{ name: string; type: number; TTL: number; data: string }>;
    Authority?: ReadonlyArray<{ name: string; type: number; TTL: number; data: string }>;
    Additional?: ReadonlyArray<{ name: string; type: number; TTL: number; data: string }>;
  }> {
    const url = new URL(resolverUrl);
    url.searchParams.set("name", name);
    url.searchParams.set("type", type);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/dns-json",
          "User-Agent": "PeerCortex/0.1.0",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `DNS query failed: ${response.status}`,
          "SOURCE_UNAVAILABLE",
          "ripe_stat"
        );
      }

      return (await response.json()) as Awaited<ReturnType<typeof dohQuery>>;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `DNS query failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SOURCE_UNAVAILABLE",
        "ripe_stat",
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Map DoH record type number to string.
   */
  function mapRecordType(typeNum: number): DNSRecordType {
    const typeMap: Record<number, DNSRecordType> = {
      1: "A",
      28: "AAAA",
      5: "CNAME",
      15: "MX",
      2: "NS",
      12: "PTR",
      6: "SOA",
      16: "TXT",
      33: "SRV",
      257: "CAA",
      48: "DNSKEY",
      43: "DS",
      46: "RRSIG",
    };
    return typeMap[typeNum] ?? ("A" as DNSRecordType);
  }

  /**
   * Convert IP address to PTR record name.
   */
  function ipToPtrName(ip: string): string {
    if (ip.includes(":")) {
      // IPv6: expand and reverse nibbles
      // TODO: Implement full IPv6 expansion
      return ip.split(":").reverse().join(".") + ".ip6.arpa";
    }
    // IPv4: reverse octets
    return ip.split(".").reverse().join(".") + ".in-addr.arpa";
  }

  /**
   * Map DoH response records to typed DNSRecord array.
   */
  function mapRecords(
    records?: ReadonlyArray<{ name: string; type: number; TTL: number; data: string }>
  ): ReadonlyArray<DNSRecord> {
    if (!records) return [];
    return records.map((r) => ({
      name: r.name,
      type: mapRecordType(r.type),
      ttl: r.TTL,
      data: r.data,
    }));
  }

  return {
    async resolve(
      name: string,
      type: DNSRecordType
    ): Promise<DNSResolutionResult> {
      const result = await dohQuery(name, type);

      return {
        query: name,
        queryType: type,
        status: result.Status,
        answers: mapRecords(result.Answer),
        authority: mapRecords(result.Authority),
        additional: mapRecords(result.Additional),
        truncated: result.TC,
        recursionDesired: result.RD,
        recursionAvailable: result.RA,
        authenticData: result.AD,
        checkingDisabled: result.CD,
      };
    },

    async reverseLookup(ip: string): Promise<ReverseDNSResult> {
      const ptrName = ipToPtrName(ip);
      const result = await dohQuery(ptrName, "PTR");

      const hostname =
        result.Answer && result.Answer.length > 0
          ? result.Answer[0].data.replace(/\.$/, "")
          : null;

      // Verify forward-confirmed reverse DNS
      let verified = false;
      if (hostname) {
        try {
          const fwdType = ip.includes(":") ? "AAAA" : "A";
          const fwd = await dohQuery(hostname, fwdType);
          verified =
            fwd.Answer?.some((a) => a.data === ip) ?? false;
        } catch {
          verified = false;
        }
      }

      return { ip, hostname, verified };
    },

    async getDelegation(domain: string): Promise<DelegationInfo> {
      // Query NS records
      const nsResult = await dohQuery(domain, "NS");
      const nsRecords = nsResult.Answer ?? [];

      // Query DS records for DNSSEC status
      const dsResult = await dohQuery(domain, "DS");
      const dsRecords = dsResult.Answer ?? [];

      // Resolve NS hostnames to IPs
      // TODO: Parallelize these lookups
      const nameservers = await Promise.all(
        nsRecords.map(async (ns) => {
          const hostname = ns.data.replace(/\.$/, "");
          const [v4Result, v6Result] = await Promise.all([
            dohQuery(hostname, "A").catch(() => null),
            dohQuery(hostname, "AAAA").catch(() => null),
          ]);

          return {
            hostname,
            ipv4: (v4Result?.Answer ?? []).map((a) => a.data),
            ipv6: (v6Result?.Answer ?? []).map((a) => a.data),
          };
        })
      );

      return {
        domain,
        nameservers,
        dnssecEnabled: dsRecords.length > 0,
        dsRecords: mapRecords(dsRecords),
        registrar: null, // TODO: Parse from WHOIS
      };
    },

    async whoisLookup(resource: string): Promise<WHOISSummary> {
      // TODO: Implement via node-whois package or RIPE Stat WHOIS data call
      // TODO: Parse raw WHOIS text into structured fields
      // TODO: Detect resource type (IP, ASN, domain) automatically

      return {
        resource,
        type: resource.match(/^\d+$/) ? "asn" : resource.includes("/") ? "ip" : "domain",
        registrant: "",  // TODO: Parse from WHOIS response
        organization: "",
        country: "",
        registrar: "",
        creationDate: "",
        expirationDate: "",
        abuseContact: "",
        rawText: "",
      };
    },

    async batchReverseLookup(
      ips: ReadonlyArray<string>
    ): Promise<ReadonlyArray<ReverseDNSResult>> {
      // TODO: Implement rate limiting for large batches
      const results = await Promise.allSettled(
        ips.map((ip) => this.reverseLookup(ip))
      );

      return results.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : { ip: ips[i], hostname: null, verified: false }
      );
    },

    async healthCheck(): Promise<boolean> {
      try {
        const result = await this.resolve("cloudflare.com", "A");
        return result.answers.length > 0;
      } catch {
        return false;
      }
    },
  };
}
