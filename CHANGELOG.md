# Changelog

All notable changes to PeerCortex are documented here.

## [0.5.0] — 2026-03-26

### Added
- **RPKI-based ASPA detection** via Cloudflare RPKI JSON feed — 1,455+ ASPA objects worldwide, cached and refreshed every 10 minutes
- **RFC-compliant ASPA path verification** (draft-ietf-sidrops-aspa-verification-14) — upstream/downstream verification, valley detection, AS_SET flagging, per-hop status
- **ASPA Readiness Score** (0–100) with four dimensions: ROA coverage, ASPA object existence, provider match completeness, path validation rate
- **Provider Audit** — compares RPKI-declared providers vs BGP-detected providers, highlights missing and extra entries with frequency data
- **Network Health Report** — 13 automated checks (Bogon, RPKI ROA, Blocklist, IRR, MANRS, BGP Visibility, Reverse DNS, Abuse Contact, Resource Cert, IX Route Servers, BGP Communities, Geolocation, IRR Object) with traffic-light scoring
- **RIPE Atlas probe integration** — shows total probes, connected/disconnected counts, and anchors per ASN
- **Route Views** as data source and header navigation link
- **bgproutes.io integration** — 3,294+ vantage points, RIB queries, ROV and ASPA status
- **RPKI-Declared Providers section** — green badges showing providers from the actual RPKI ASPA object
- **Collapsible lists** — "Show X more..." for Detected Upstream Providers (limit 10), Missing/Extra in Provider Audit (limit 5)
- **Numerical ASN sorting** across all badge lists and tables
- **WHOIS Details** endpoint and dashboard card
- **Network Topology** endpoint via CAIDA AS-Relationships
- **Peering Partner Finder** — `/api/peers/find` endpoint
- **Prefix Detail View** — `/api/prefix/detail` endpoint
- **IX Detail View** — `/api/ix/detail` endpoint
- **Recent Lookups** with localStorage persistence and quick-click badges
- **Network Compare** — side-by-side comparison of two ASNs (common IXPs, shared upstreams, overlapping facilities)
- **Copy button** on Recommended ASPA Object code block
- **Demo animation** (SVG) in README

### Changed
- ASPA detection switched from broken RIPE DB `aut-num` remarks search to Cloudflare RPKI JSON feed (`rpki.cloudflare.com/rpki.json`)
- Upstream providers now resolved with AS names via RIPE Stat AS Overview API
- Version bumped to 0.5.0
- Dashboard footer updated with all data sources including Cloudflare RPKI and Route Views
- Server User-Agent updated to PeerCortex/0.5.0

### Fixed
- **Critical: ASPA objects not detected** — networks with valid ASPA (e.g., AS8283 Coloclue, AS6830 Liberty Global) were incorrectly shown as "Not Found" because the old code searched RIPE DB remarks instead of RPKI repositories
- **SyntaxError in frontend** — CSS routing styles were embedded as a multiline JS string (single quotes don't allow newlines), moved to proper `<style>` block
- **Double ASN display** — provider badges showed "AS1031 AS1031" when AS name wasn't available, now shows clean single ASN with resolved name
- **Empty brackets in ASPA template** — provider names showed "()" when not resolved, now omitted or fetched via RIPE Stat
- **Port conflict on startup** — multiple PM2 instances caused EADDRINUSE, resolved with proper process cleanup
- **RPKI per-prefix timeout** — limited batch size to 10 prefixes with 8s fetch timeout to prevent hanging on large ASNs

## [0.4.0] — 2026-03-25

### Added
- Initial public release
- Web dashboard with Tokyo Night dark theme
- PeeringDB API v2 integration (network profile, IX presence, facilities)
- RIPE Stat Data API integration (prefixes, neighbours, visibility, routing status)
- bgp.he.net scraping for supplementary BGP data
- Per-prefix RPKI validation via RIPE Stat
- AS neighbour resolution with names
- IPv4/IPv6 route propagation bars with RIS peer visibility
- Prefix size distribution badges
- MCP Server skeleton with 34 tool definitions
- Docker support
- Cloudflare Tunnel deployment on Erik server
- Live demo at peercortex.org

### Infrastructure
- Node.js single-file server (server.js) — zero dependencies beyond Node.js built-ins
- PM2 process management on Erik (217.154.82.179)
- Cloudflare Tunnel via `eo-pulse` tunnel
- Domains: peercortex.org, www.peercortex.org, peercortex.context-x.org

---

## Data Sources

| Source | API | Usage |
|--------|-----|-------|
| [PeeringDB](https://www.peeringdb.com/) | REST API v2 | Network profiles, IX connections, facilities |
| [RIPE Stat](https://stat.ripe.net/) | Data API | Prefixes, neighbours, visibility, routing status, abuse contacts |
| [RIPE Atlas](https://atlas.ripe.net/) | REST API v2 | Probe and anchor detection per ASN |
| [Route Views](http://www.routeviews.org/) | Via RIPE Stat | BGP path data, AS relationships |
| [bgp.he.net](https://bgp.he.net/) | HTML scraping | Supplementary BGP data |
| [bgproutes.io](https://bgproutes.io/) | REST API v1 | 3,294+ vantage points, RIB data, ROV/ASPA status |
| [Cloudflare RPKI](https://rpki.cloudflare.com/) | JSON feed | 1,455+ ASPA objects, ROA validation |
| [RIPE DB](https://rest.db.ripe.net/) | REST API | IRR objects, WHOIS data |
