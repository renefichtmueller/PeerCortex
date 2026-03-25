# Data Sources

PeerCortex aggregates network intelligence from six data sources. Each source provides unique data that is combined to create a comprehensive picture.

## Source Overview

| Source | Data Provided | API Type | Auth Required | Rate Limits |
|--------|--------------|----------|---------------|-------------|
| PeeringDB | Network info, IXs, facilities, contacts | REST API v2 | Optional (API key) | 60 req/min (anonymous), higher with key |
| RIPE Stat | BGP state, prefixes, visibility, RPKI | REST API | No (source app ID recommended) | Fair use policy |
| bgp.he.net | Peers, upstreams, downstreams, prefixes | HTML scraping | No | Be respectful |
| Route Views | Global routing table, path diversity | Via RIPE Stat | No | Via RIPE Stat limits |
| IRR (RIPE DB) | Route objects, as-sets, WHOIS | REST + WHOIS | No | Fair use policy |
| RPKI | ROA validation, VRP list | REST API | No | Depends on validator |

## PeeringDB

**URL**: https://www.peeringdb.com/

The freely available, user-maintained database of networks. Primary source for:

- Network metadata (name, ASN, type, scope)
- Peering policy information
- Internet Exchange participation (with connection speeds)
- Facility/colocation presence
- Points of contact for peering

**API Documentation**: https://www.peeringdb.com/apidocs/

## RIPE Stat

**URL**: https://stat.ripe.net/

Comprehensive Internet resource analysis from RIPE NCC. Provides:

- AS overview and holder information
- Announced prefix lists
- BGP state from RIPE RIS collectors
- BGP update history
- Looking glass data
- RPKI validation
- Prefix visibility across collectors

**API Documentation**: https://stat.ripe.net/docs/02.data-api/

## bgp.he.net

**URL**: https://bgp.he.net/

Hurricane Electric's BGP Toolkit. Provides through web scraping:

- Peer lists (v4/v6)
- Upstream and downstream relationships
- Originated prefix lists
- IX participation details
- WHOIS information

**Note**: No official API. PeerCortex uses respectful HTML scraping.

## Route Views / RIPE RIS

**URL**: https://www.routeviews.org/ and https://ris.ripe.net/

Global routing data collected from BGP vantage points worldwide:

- Full routing table snapshots
- BGP update streams
- Path diversity analysis
- Prefix visibility reports

Accessed via RIPE Stat API data calls.

## IRR Databases

**Primary**: https://rest.db.ripe.net/ (RIPE DB REST API)

Internet Routing Registry data from RIPE, RADB, and others:

- Route and route6 objects
- AS-set definitions and expansion
- Aut-num objects
- Maintainer information
- WHOIS records

## RPKI Validators

**Routinator** (local): https://routinator.docs.nlnetlabs.nl/
**RIPE RPKI** (remote): https://rpki-validator.ripe.net/

Route Origin Authorization validation:

- Prefix-origin pair validation (valid/invalid/not-found)
- ROA listings per ASN
- Validated ROA Payload (VRP) list
- Trust Anchor information
