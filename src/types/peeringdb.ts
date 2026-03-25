/**
 * @module types/peeringdb
 * Type definitions for PeeringDB API v2 responses.
 * @see https://www.peeringdb.com/apidocs/
 */

// ── PeeringDB API Envelope ───────────────────────────────

/** Standard PeeringDB API response wrapper */
export interface PeeringDBResponse<T> {
  readonly data: ReadonlyArray<T>;
  readonly meta: Record<string, unknown>;
}

// ── Organization ─────────────────────────────────────────

/** PeeringDB Organization (org) object */
export interface PDBOrganization {
  readonly id: number;
  readonly name: string;
  readonly aka: string;
  readonly website: string;
  readonly notes: string;
  readonly address1: string;
  readonly address2: string;
  readonly city: string;
  readonly state: string;
  readonly zipcode: string;
  readonly country: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly created: string;
  readonly updated: string;
  readonly status: string;
}

// ── Network ──────────────────────────────────────────────

/** PeeringDB Network (net) object */
export interface PDBNetwork {
  readonly id: number;
  readonly org_id: number;
  readonly org: PDBOrganization;
  readonly name: string;
  readonly aka: string;
  readonly name_long: string;
  readonly website: string;
  readonly asn: number;
  readonly looking_glass: string;
  readonly route_server: string;
  readonly irr_as_set: string;
  readonly info_type: string;
  readonly info_prefixes4: number;
  readonly info_prefixes6: number;
  readonly info_traffic: string;
  readonly info_ratio: string;
  readonly info_scope: string;
  readonly info_unicast: boolean;
  readonly info_multicast: boolean;
  readonly info_ipv6: boolean;
  readonly info_never_via_route_servers: boolean;
  readonly policy_url: string;
  readonly policy_general: string;
  readonly policy_locations: string;
  readonly policy_ratio: boolean;
  readonly policy_contracts: string;
  readonly netfac_set: ReadonlyArray<PDBNetworkFacility>;
  readonly netixlan_set: ReadonlyArray<PDBNetworkIXLan>;
  readonly poc_set: ReadonlyArray<PDBPointOfContact>;
  readonly created: string;
  readonly updated: string;
  readonly status: string;
}

// ── Internet Exchange ────────────────────────────────────

/** PeeringDB Internet Exchange (ix) object */
export interface PDBInternetExchange {
  readonly id: number;
  readonly org_id: number;
  readonly name: string;
  readonly name_long: string;
  readonly city: string;
  readonly country: string;
  readonly region_continent: string;
  readonly media: string;
  readonly notes: string;
  readonly proto_unicast: boolean;
  readonly proto_multicast: boolean;
  readonly proto_ipv6: boolean;
  readonly website: string;
  readonly url_stats: string;
  readonly tech_email: string;
  readonly tech_phone: string;
  readonly policy_email: string;
  readonly policy_phone: string;
  readonly fac_set: ReadonlyArray<PDBIXFacility>;
  readonly ixlan_set: ReadonlyArray<PDBIXLan>;
  readonly created: string;
  readonly updated: string;
  readonly status: string;
}

/** PeeringDB IX LAN object */
export interface PDBIXLan {
  readonly id: number;
  readonly ix_id: number;
  readonly name: string;
  readonly descr: string;
  readonly mtu: number;
  readonly dot1q_support: boolean;
  readonly rs_asn: number;
  readonly arp_sponge: string;
  readonly ixpfx_set: ReadonlyArray<PDBIXPrefix>;
  readonly created: string;
  readonly updated: string;
  readonly status: string;
}

/** PeeringDB IX Prefix object */
export interface PDBIXPrefix {
  readonly id: number;
  readonly ixlan_id: number;
  readonly protocol: string;
  readonly prefix: string;
  readonly in_dfz: boolean;
  readonly created: string;
  readonly updated: string;
  readonly status: string;
}

// ── Facility ─────────────────────────────────────────────

/** PeeringDB Facility (fac) object */
export interface PDBFacility {
  readonly id: number;
  readonly org_id: number;
  readonly name: string;
  readonly website: string;
  readonly clli: string;
  readonly rencode: string;
  readonly npanxx: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly notes: string;
  readonly city: string;
  readonly state: string;
  readonly zipcode: string;
  readonly country: string;
  readonly address1: string;
  readonly address2: string;
  readonly created: string;
  readonly updated: string;
  readonly status: string;
}

/** PeeringDB Network-Facility link */
export interface PDBNetworkFacility {
  readonly id: number;
  readonly name: string;
  readonly net_id: number;
  readonly fac_id: number;
  readonly local_asn: number;
  readonly city: string;
  readonly country: string;
  readonly created: string;
  readonly updated: string;
  readonly status: string;
}

/** PeeringDB IX-Facility link */
export interface PDBIXFacility {
  readonly id: number;
  readonly name: string;
  readonly ix_id: number;
  readonly fac_id: number;
  readonly created: string;
  readonly updated: string;
  readonly status: string;
}

// ── Network-IX LAN ───────────────────────────────────────

/** PeeringDB Network-IX LAN connection */
export interface PDBNetworkIXLan {
  readonly id: number;
  readonly net_id: number;
  readonly ix_id: number;
  readonly name: string;
  readonly ixlan_id: number;
  readonly notes: string;
  readonly speed: number;
  readonly asn: number;
  readonly ipaddr4: string | null;
  readonly ipaddr6: string | null;
  readonly is_rs_peer: boolean;
  readonly operational: boolean;
  readonly created: string;
  readonly updated: string;
  readonly status: string;
}

// ── Point of Contact ─────────────────────────────────────

/** PeeringDB Point of Contact (poc) object */
export interface PDBPointOfContact {
  readonly id: number;
  readonly net_id: number;
  readonly role: string;
  readonly visible: string;
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly url: string;
  readonly created: string;
  readonly updated: string;
  readonly status: string;
}

// ── Search Types ─────────────────────────────────────────

/** PeeringDB search parameters for networks */
export interface PDBNetworkSearchParams {
  readonly asn?: number;
  readonly name?: string;
  readonly name_long?: string;
  readonly irr_as_set?: string;
  readonly info_type?: string;
  readonly policy_general?: string;
  readonly country?: string;
  readonly city?: string;
}

/** PeeringDB search parameters for IXs */
export interface PDBIXSearchParams {
  readonly name?: string;
  readonly country?: string;
  readonly city?: string;
  readonly region_continent?: string;
}
