/**
 * @module types/bgp
 * Type definitions for BGP data from RIPE Stat, Route Views, and bgp.he.net.
 */

// ── RIPE Stat Types ──────────────────────────────────────

/** RIPE Stat API response wrapper */
export interface RIPEStatResponse<T> {
  readonly status: "ok" | "error";
  readonly status_code: number;
  readonly data: T;
  readonly query_id: string;
  readonly process_time: number;
  readonly server_id: string;
  readonly build_version: string;
  readonly cached: boolean;
  readonly data_call_name: string;
  readonly data_call_status: string;
  readonly messages: ReadonlyArray<ReadonlyArray<string>>;
  readonly see_also: ReadonlyArray<unknown>;
  readonly time: string;
}

/** RIPE Stat — Network Info response */
export interface RIPENetworkInfo {
  readonly asns: ReadonlyArray<string>;
  readonly prefix: string;
}

/** RIPE Stat — AS Overview response */
export interface RIPEASOverview {
  readonly resource: string;
  readonly type: string;
  readonly block: {
    readonly resource: string;
    readonly desc: string;
    readonly name: string;
  };
  readonly holder: string;
  readonly announced: boolean;
}

/** RIPE Stat — Announced Prefixes response */
export interface RIPEAnnouncedPrefixes {
  readonly resource: string;
  readonly prefixes: ReadonlyArray<{
    readonly prefix: string;
    readonly timelines: ReadonlyArray<{
      readonly starttime: string;
      readonly endtime: string;
    }>;
  }>;
  readonly query_starttime: string;
  readonly query_endtime: string;
}

/** RIPE Stat — BGP State response */
export interface RIPEBGPState {
  readonly resource: string;
  readonly bgp_state: ReadonlyArray<{
    readonly target_prefix: string;
    readonly path: ReadonlyArray<number>;
    readonly source_id: string;
    readonly community: string;
  }>;
  readonly nr_routes: number;
  readonly query_time: string;
}

/** RIPE Stat — Looking Glass response */
export interface RIPELookingGlass {
  readonly rrcs: ReadonlyArray<{
    readonly rrc: string;
    readonly location: string;
    readonly peers: ReadonlyArray<{
      readonly asn_origin: number;
      readonly as_path: string;
      readonly community: string;
      readonly last_updated: string;
      readonly prefix: string;
      readonly peer: string;
      readonly origin: string;
      readonly next_hop: string;
      readonly latest_time: string;
    }>;
  }>;
}

/** RIPE Stat — RIS Peers response */
export interface RIPERISPeers {
  readonly peers: ReadonlyArray<{
    readonly asn: number;
    readonly ip: string;
    readonly prefix_count: number;
  }>;
  readonly peer_count: number;
}

/** RIPE Stat — BGP Updates response */
export interface RIPEBGPUpdates {
  readonly nr_updates: number;
  readonly updates: ReadonlyArray<{
    readonly type: string;
    readonly timestamp: string;
    readonly attrs: {
      readonly target_prefix: string;
      readonly path: ReadonlyArray<number>;
      readonly source_id: string;
      readonly community: ReadonlyArray<string>;
    };
  }>;
  readonly query_starttime: string;
  readonly query_endtime: string;
}

/** RIPE Stat — RPKI Validation response */
export interface RIPERPKIValidation {
  readonly resource: string;
  readonly prefix: string;
  readonly validating_roas: ReadonlyArray<{
    readonly origin: string;
    readonly prefix: string;
    readonly max_length: number;
    readonly validity: string;
    readonly source: string;
  }>;
  readonly status: string;
}

/** RIPE Stat — Visibility response */
export interface RIPEVisibility {
  readonly resource: string;
  readonly visibilities: ReadonlyArray<{
    readonly probe: {
      readonly city: string;
      readonly country: string;
      readonly name: string;
    };
    readonly ris_peers: number;
    readonly ris_peers_seeing: number;
  }>;
}

// ── bgp.he.net Scraped Types ────────────────────────────

/** bgp.he.net ASN info (scraped) */
export interface HENetASNInfo {
  readonly asn: number;
  readonly name: string;
  readonly description: string;
  readonly country: string;
  readonly emailContacts: ReadonlyArray<string>;
  readonly abuseContacts: ReadonlyArray<string>;
  readonly prefixesOriginated: {
    readonly v4: ReadonlyArray<string>;
    readonly v6: ReadonlyArray<string>;
  };
  readonly peers: ReadonlyArray<{
    readonly asn: number;
    readonly name: string;
    readonly v4: boolean;
    readonly v6: boolean;
  }>;
  readonly upstreams: ReadonlyArray<{
    readonly asn: number;
    readonly name: string;
  }>;
  readonly downstreams: ReadonlyArray<{
    readonly asn: number;
    readonly name: string;
  }>;
  readonly ixParticipation: ReadonlyArray<{
    readonly ix: string;
    readonly speed: string;
    readonly ipv4: string;
    readonly ipv6: string;
  }>;
}

// ── Route Views Types ────────────────────────────────────

/** Route Views / RIPE RIS routing table entry */
export interface RouteViewsEntry {
  readonly prefix: string;
  readonly originASN: number;
  readonly asPath: ReadonlyArray<number>;
  readonly communities: ReadonlyArray<string>;
  readonly collector: string;
  readonly timestamp: string;
}

/** Route Views collector information */
export interface RouteViewsCollector {
  readonly name: string;
  readonly url: string;
  readonly location: string;
  readonly peerCount: number;
}

// ── bgproutes.io Types ──────────────────────────────────

/** ASPA (Autonomous System Provider Authorization) validation state */
export type ASPAValidationState = "valid" | "invalid" | "unknown";

/** ASPA validation result for a route */
export interface ASPAValidation {
  /** Overall ASPA validation state */
  readonly state: ASPAValidationState;
  /** Human-readable description of validation result */
  readonly description: string;
  /** Each hop in the AS path with its provider authorization status */
  readonly hopDetails: ReadonlyArray<{
    /** ASN at this position in the path */
    readonly asn: number;
    /** Whether this ASN authorizes the next-hop AS as its provider */
    readonly providerAuthorized: boolean;
    /** ASPA object source (if any) */
    readonly aspaSource: string | null;
  }>;
}

/** bgproutes.io RIB entry with RPKI and ASPA validation */
export interface BgpRoutesIoRibEntry {
  /** IP prefix */
  readonly prefix: string;
  /** Origin ASN */
  readonly originAsn: number;
  /** Full AS path */
  readonly asPath: ReadonlyArray<number>;
  /** Next-hop IP address */
  readonly nextHop: string;
  /** BGP communities */
  readonly communities: ReadonlyArray<string>;
  /** Vantage point that observed this route */
  readonly vantagePoint: string;
  /** When this entry was last updated */
  readonly lastUpdated: string;
  /** RPKI Route Origin Validation status */
  readonly rpkiStatus: "valid" | "invalid" | "not-found" | "unknown";
  /** ASPA validation result */
  readonly aspaValidation: ASPAValidation;
  /** MED (Multi-Exit Discriminator) value */
  readonly med: number | null;
  /** LOCAL_PREF value (if visible) */
  readonly localPref: number | null;
}

/** bgproutes.io BGP update message */
export interface BgpRoutesIoUpdate {
  /** Update type */
  readonly type: "announcement" | "withdrawal";
  /** IP prefix */
  readonly prefix: string;
  /** Timestamp (ISO 8601) */
  readonly timestamp: string;
  /** Origin ASN (null for withdrawals) */
  readonly originAsn: number | null;
  /** Full AS path (empty for withdrawals) */
  readonly asPath: ReadonlyArray<number>;
  /** Vantage point that observed this update */
  readonly vantagePoint: string;
  /** BGP communities */
  readonly communities: ReadonlyArray<string>;
  /** RPKI ROV status at time of update */
  readonly rpkiStatus: "valid" | "invalid" | "not-found" | "unknown";
  /** ASPA validation at time of update */
  readonly aspaValidation: ASPAValidation;
}

/** bgproutes.io vantage point (collector/peer) */
export interface BgpRoutesIoVantagePoint {
  /** Unique identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** ASN of the vantage point */
  readonly asn: number;
  /** Geographic location */
  readonly location: {
    readonly city: string;
    readonly country: string;
    readonly latitude: number;
    readonly longitude: number;
  };
  /** Number of prefixes seen */
  readonly prefixCount: number;
  /** Whether the vantage point is currently active */
  readonly active: boolean;
  /** Last data received timestamp */
  readonly lastSeen: string;
}

/** bgproutes.io AS-level topology link */
export interface BgpRoutesIoTopologyLink {
  /** Source ASN */
  readonly asnFrom: number;
  /** Destination ASN */
  readonly asnTo: number;
  /** Relationship type */
  readonly relationship: "provider" | "customer" | "peer" | "sibling";
  /** Number of paths where this link was observed */
  readonly pathCount: number;
  /** Whether this link is currently active */
  readonly active: boolean;
  /** First observed timestamp */
  readonly firstSeen: string;
  /** Last observed timestamp */
  readonly lastSeen: string;
}

// ── BGP Analysis Types ───────────────────────────────────

/** BGP path analysis result */
export interface BGPPathAnalysis {
  readonly prefix: string;
  readonly originASN: number;
  readonly paths: ReadonlyArray<{
    readonly asPath: ReadonlyArray<number>;
    readonly collector: string;
    readonly peer: string;
    readonly communities: ReadonlyArray<string>;
  }>;
  readonly pathDiversity: number;
  readonly upstreamASNs: ReadonlyArray<number>;
  readonly avgPathLength: number;
  readonly analysis: string;
}

/** BGP prefix visibility report */
export interface BGPVisibilityReport {
  readonly prefix: string;
  readonly originASN: number;
  readonly totalCollectors: number;
  readonly seenByCollectors: number;
  readonly visibilityPercent: number;
  readonly seenPaths: ReadonlyArray<ReadonlyArray<number>>;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

/** MOAS (Multiple Origin AS) conflict */
export interface MOASConflict {
  readonly prefix: string;
  readonly origins: ReadonlyArray<{
    readonly asn: number;
    readonly name: string;
    readonly firstSeen: string;
  }>;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly description: string;
}
