const fs = require("fs");
const http = require("http");
const https = require("https");

// Load .env file
const envPath = "/opt/peercortex-app/.env";
try {
  const envContent = fs.readFileSync(envPath, "utf8");
  envContent.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.substring(0, eqIdx).trim();
      const val = trimmed.substring(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  });
} catch (_e) {
  console.warn("Warning: Could not read .env file at", envPath);
}

const BGPROUTES_API_KEY = process.env.BGPROUTES_API_KEY || "";
const BGPROUTES_API_URL = process.env.BGPROUTES_API_URL || "https://api.bgproutes.io/v1";

const PEERINGDB_API_KEY = process.env.PEERINGDB_API_KEY || "";
const PEERINGDB_API_URL = process.env.PEERINGDB_API_URL || "https://www.peeringdb.com/api";

const UA = "PeerCortex/0.5.0 (+https://peercortex.org; contact: rene.fichtmueller@flexoptix.net)";

// ============================================================
// Task 6: In-memory cache with TTL + Rate Limiting
// ============================================================
const responseCache = new Map();

function cacheGet(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    responseCache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data, ttlMs) {
  responseCache.set(key, { data, expires: Date.now() + ttlMs });
  // Evict old entries periodically (keep cache under 500 entries)
  if (responseCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (now > v.expires) responseCache.delete(k);
    }
  }
}

const CACHE_TTL_LOOKUP = 5 * 60 * 1000;   // 5 minutes
const CACHE_TTL_ASPA = 10 * 60 * 1000;    // 10 minutes
const CACHE_TTL_NEWS = 10 * 60 * 1000;    // 10 minutes
const CACHE_TTL_DEFAULT = 5 * 60 * 1000;  // 5 minutes

// ============================================================
// RPKI ASPA Cache from Cloudflare RPKI JSON feed
// ============================================================
const rpkiAspaMap = new Map(); // customer_asid -> Set<provider_asn>
let rpkiAspaLastFetch = 0;
let rpkiAspaFetching = false;

function fetchRpkiAspaFeed() {
  if (rpkiAspaFetching) return Promise.resolve();
  rpkiAspaFetching = true;
  console.log("[RPKI-ASPA] Fetching Cloudflare RPKI feed...");
  return new Promise((resolve) => {
    const options = {
      headers: { "User-Agent": UA },
      timeout: 30000,
    };
    https.get("https://rpki.cloudflare.com/rpki.json", options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const aspas = parsed.aspas || [];
          rpkiAspaMap.clear();
          aspas.forEach((a) => {
            const customerAsid = Number(a.customer_asid);
            const providers = (a.providers || []).map(Number);
            rpkiAspaMap.set(customerAsid, new Set(providers));
          });
          rpkiAspaLastFetch = Date.now();
          console.log("[RPKI-ASPA] Loaded " + rpkiAspaMap.size + " ASPA objects from Cloudflare RPKI feed");
        } catch (e) {
          console.error("[RPKI-ASPA] Failed to parse RPKI feed:", e.message);
        }
        rpkiAspaFetching = false;
        resolve();
      });
    }).on("error", (e) => {
      console.error("[RPKI-ASPA] Fetch failed:", e.message);
      rpkiAspaFetching = false;
      resolve();
    });
  });
}

// Ensure ASPA cache is fresh (fetch if older than 10 minutes)
async function ensureAspaCache() {
  if (Date.now() - rpkiAspaLastFetch > 10 * 60 * 1000) {
    await fetchRpkiAspaFeed();
  }
}

// Lookup ASPA object for a given ASN from the RPKI feed cache
function lookupAspaFromRpki(asn) {
  const asnNum = Number(asn);
  if (rpkiAspaMap.has(asnNum)) {
    const providers = rpkiAspaMap.get(asnNum);
    return { exists: true, providers: [...providers].sort((a, b) => a - b) };
  }
  return { exists: false, providers: [] };
}



// PeeringDB authenticated fetch helper
function fetchPeeringDB(path, options) {
  const url = PEERINGDB_API_URL + path;
  const headers = { "User-Agent": UA };
  if (PEERINGDB_API_KEY) {
    headers["Authorization"] = "Api-Key " + PEERINGDB_API_KEY;
  }
  return fetchJSON(url, { ...options, headers: { ...(options && options.headers || {}), ...headers } });
}

// bgproutes.io visibility fallback helper
// Queries the RIB endpoint to estimate prefix visibility across vantage points
function fetchBgproutesVisibility(prefix) {
  if (!BGPROUTES_API_KEY) return Promise.resolve(null);
  const url = BGPROUTES_API_URL + "/rib?prefix=" + encodeURIComponent(prefix) + "&prefix_match=exact";
  return fetchJSON(url, {
    timeout: 15000,
    headers: {
      "Authorization": "Bearer " + BGPROUTES_API_KEY,
      "User-Agent": UA,
    },
  }).then(function(data) {
    if (!data || !data.data) return null;
    // data.data should be an array of RIB entries from different vantage points
    var entries = Array.isArray(data.data) ? data.data : (data.data.entries || data.data.routes || []);
    var vpSet = new Set();
    entries.forEach(function(e) {
      if (e.vantage_point || e.vp || e.collector || e.peer_asn) {
        vpSet.add(e.vantage_point || e.vp || e.collector || e.peer_asn);
      }
    });
    return { vps_seeing: vpSet.size, total_entries: entries.length, source: "bgproutes.io" };
  }).catch(function() { return null; });
}

// Rate limiting: max 60 requests per minute per IP
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 60;

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.windowStart + RATE_LIMIT_WINDOW) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  // Clean old entries periodically
  if (rateLimitMap.size > 1000) {
    for (const [k, v] of rateLimitMap) {
      if (now > v.windowStart + RATE_LIMIT_WINDOW) rateLimitMap.delete(k);
    }
  }
  return entry.count <= RATE_LIMIT_MAX;
}

function fetchJSON(url, options) {
  const timeoutMs = (options && options.timeout) || 20000;
  return new Promise((resolve) => {
    const reqOptions = {
      headers: { "User-Agent": UA, ...(options && options.headers ? options.headers : {}) },
      timeout: timeoutMs,
    };
    const timer = setTimeout(() => resolve(null), timeoutMs + 500);
    https
      .get(url, reqOptions, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(data));
          } catch (_e) {
            resolve(null);
          }
        });
      })
      .on("timeout", () => { clearTimeout(timer); resolve(null); })
      .on("error", () => { clearTimeout(timer); resolve(null); });
  });
}


function fetchHTML(url, options) {
  return new Promise((resolve) => {
    const reqOptions = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...(options && options.headers ? options.headers : {}),
      },
    };
    const lib = url.startsWith("https") ? require("https") : require("http");
    lib
      .get(url, reqOptions, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchHTML(res.headers.location, options).then(resolve);
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", () => resolve(null));
  });
}

function postJSON(url, body, options) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...(options && options.headers ? options.headers : {}),
      },
    };
    const req = https.request(reqOptions, (res) => {
      let chunks = "";
      res.on("data", (chunk) => (chunks += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(chunks));
        } catch (_e) {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.write(data);
    req.end();
  });
}

async function resolveASNames(providers) {
  // Batch resolve AS names via RIPE Stat AS overview API
  const batchSize = 10;
  for (let i = 0; i < providers.length; i += batchSize) {
    const batch = providers.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(p =>
        fetchJSON("https://stat.ripe.net/data/as-overview/data.json?resource=AS" + p.asn)
          .then(r => ({ asn: p.asn, name: r?.data?.holder || "" }))
          .catch(() => ({ asn: p.asn, name: "" }))
      )
    );
    results.forEach(r => {
      const provider = providers.find(p => p.asn === r.asn);
      if (provider && r.name) provider.name = r.name;
    });
  }
  return providers;
}

function fetchRPKIPerPrefix(asn, prefix) {
  return fetchJSON(
    "https://stat.ripe.net/data/rpki-validation/data.json?resource=AS" +
      asn +
      "&prefix=" +
      encodeURIComponent(prefix)
  ).then((r) => {
    const status = r?.data?.status || "not_found";
    const validating = r?.data?.validating_roas || [];
    return { prefix, status, validating_roas: validating.length };
  });
}

// ============================================================
// RFC-Compliant ASPA Verification Engine
// ============================================================

// Check if AS path contains AS_SET segments (curly braces indicate sets)
function hasAsSet(asPath) {
  if (typeof asPath === "string") {
    return asPath.includes("{") || asPath.includes("}");
  }
  return false;
}

// Hop Check function (core of ASPA verification)
// aspaStore = Map<number, Set<number>> (CAS -> provider set)
function hopCheck(asI, asJ, aspaStore) {
  const providers = aspaStore.get(asI);
  if (!providers) return "NoAttestation";
  return providers.has(asJ) ? "ProviderPlus" : "NotProviderPlus";
}

// Collapse AS path prepends (remove consecutive duplicates)
function collapsePrepends(path) {
  return path.filter((as, i) => i === 0 || as !== path[i - 1]);
}

// Upstream Verification (RFC Section 6.1)
function verifyUpstream(asPath, aspaStore, rawPathStr) {
  if (rawPathStr && hasAsSet(rawPathStr)) return { result: "Invalid", reason: "Path contains AS_SET" };
  const collapsed = collapsePrepends(asPath);
  if (collapsed.length <= 1) return { result: "Valid", reason: "Single-hop path" };

  const hops = [];
  let hasNoAttestation = false;

  for (let i = 1; i < collapsed.length; i++) {
    const check = hopCheck(collapsed[i - 1], collapsed[i], aspaStore);
    hops.push({
      from: collapsed[i - 1],
      to: collapsed[i],
      result: check,
    });
    if (check === "NotProviderPlus") {
      return { result: "Invalid", reason: "Hop AS" + collapsed[i - 1] + " -> AS" + collapsed[i] + " is NotProviderPlus", hops };
    }
    if (check === "NoAttestation") hasNoAttestation = true;
  }

  return {
    result: hasNoAttestation ? "Unknown" : "Valid",
    reason: hasNoAttestation ? "Some hops lack ASPA attestation" : "All hops verified as ProviderPlus",
    hops,
  };
}

// Downstream Verification (RFC Section 6.2)
function verifyDownstream(asPath, aspaStore, rawPathStr) {
  if (rawPathStr && hasAsSet(rawPathStr)) return { result: "Invalid", reason: "Path contains AS_SET" };
  const collapsed = collapsePrepends(asPath);
  const N = collapsed.length;
  if (N <= 2) return { result: "Valid", reason: "Path length <= 2" };

  const hops = [];
  for (let i = 1; i < N; i++) {
    hops.push({
      from: collapsed[i - 1],
      to: collapsed[i],
      result: hopCheck(collapsed[i - 1], collapsed[i], aspaStore),
    });
  }

  // Find u_min: first index where forward hop is NotProviderPlus
  let uMin = N + 1;
  for (let u = 1; u < N; u++) {
    if (hopCheck(collapsed[u - 1], collapsed[u], aspaStore) === "NotProviderPlus") {
      uMin = u;
      break;
    }
  }

  // Find v_max: last index where reverse hop is NotProviderPlus
  let vMax = 0;
  for (let v = N - 2; v >= 0; v--) {
    if (hopCheck(collapsed[v + 1], collapsed[v], aspaStore) === "NotProviderPlus") {
      vMax = v;
      break;
    }
  }

  if (uMin <= vMax) {
    return { result: "Invalid", reason: "uMin(" + uMin + ") <= vMax(" + vMax + "): valley detected", hops };
  }

  // Compute up-ramp K
  let K = 0;
  for (let i = 1; i < N; i++) {
    if (hopCheck(collapsed[i - 1], collapsed[i], aspaStore) === "ProviderPlus") {
      K = i;
    } else {
      break;
    }
  }

  // Compute down-ramp L
  let L = N - 1;
  for (let j = N - 2; j >= 0; j--) {
    if (hopCheck(collapsed[j + 1], collapsed[j], aspaStore) === "ProviderPlus") {
      L = j;
    } else {
      break;
    }
  }

  const gap = L - K;
  if (gap <= 1) {
    return { result: "Valid", reason: "Valid up-down path (K=" + K + ", L=" + L + ")", hops };
  }

  return { result: "Unknown", reason: "Gap between up-ramp and down-ramp (K=" + K + ", L=" + L + ", gap=" + gap + ")", hops };
}

// Valley Detection: scan path for up-down-up pattern (route leak indicator)
function detectValleys(asPath, aspaStore) {
  const collapsed = collapsePrepends(asPath);
  if (collapsed.length < 4) return [];

  const valleys = [];
  // Walk the path and look at relationship transitions
  const relationships = [];
  for (let i = 1; i < collapsed.length; i++) {
    const fwd = hopCheck(collapsed[i - 1], collapsed[i], aspaStore);
    const rev = hopCheck(collapsed[i], collapsed[i - 1], aspaStore);
    let rel = "unknown";
    if (fwd === "ProviderPlus") rel = "customer-to-provider";
    else if (rev === "ProviderPlus") rel = "provider-to-customer";
    else if (fwd === "NotProviderPlus" && rev === "NotProviderPlus") rel = "peer-to-peer";
    relationships.push({ from: collapsed[i - 1], to: collapsed[i], rel });
  }

  // Detect c2p -> p2c -> c2p pattern
  for (let i = 0; i < relationships.length - 2; i++) {
    if (
      relationships[i].rel === "customer-to-provider" &&
      relationships[i + 1].rel === "provider-to-customer" &&
      relationships[i + 2].rel === "customer-to-provider"
    ) {
      valleys.push({
        position: i,
        path_segment: [
          relationships[i].from,
          relationships[i].to,
          relationships[i + 1].to,
          relationships[i + 2].to,
        ].map((a) => "AS" + a),
        description:
          "Route leak: AS" + relationships[i].from + " -> AS" + relationships[i].to +
          " (c2p) -> AS" + relationships[i + 1].to +
          " (p2c) -> AS" + relationships[i + 2].to + " (c2p)",
      });
    }
  }

  return valleys;
}

// Build ASPA store from detected provider relationships
function buildAspaStore(detectedProviders, targetAsn) {
  const store = new Map();
  // Add the target ASN's providers
  if (detectedProviders.length > 0) {
    const providerSet = new Set(detectedProviders.map((p) => p.asn));
    store.set(targetAsn, providerSet);
  }
  return store;
}

// Calculate ASPA Readiness Score (0-100)
function calculateAspaReadinessScore(params) {
  const { rpkiCoverage, aspaObjectExists, providerCompleteness, pathValidationPct } = params;

  // ROA coverage (0-25 points)
  const roaScore = Math.round((Math.min(rpkiCoverage, 100) / 100) * 25);

  // ASPA object exists (0-25 points)
  const aspaScore = aspaObjectExists ? 25 : 0;

  // Provider completeness (0-25 points)
  const provScore = Math.round((Math.min(providerCompleteness, 100) / 100) * 25);

  // Path validation results (0-25 points)
  const pathScore = Math.round((Math.min(pathValidationPct, 100) / 100) * 25);

  return {
    total: roaScore + aspaScore + provScore + pathScore,
    breakdown: {
      roa_coverage: { score: roaScore, max: 25, value: rpkiCoverage },
      aspa_object: { score: aspaScore, max: 25, value: aspaObjectExists },
      provider_completeness: { score: provScore, max: 25, value: providerCompleteness },
      path_validation: { score: pathScore, max: 25, value: pathValidationPct },
    },
  };
}


// ============================================================
// Feature 24: bgp.he.net Integration
// ============================================================
async function fetchBgpHeNet(asn) {
  try {
    const html = await fetchHTML("https://bgp.he.net/AS" + asn);
    if (!html) return null;
    const result = {};
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) result.title = titleMatch[1].trim();
    const peerMatch = html.match(/Observed\s+Peers[^<]*<[^>]*>\s*(\d+)/i) || html.match(/(\d+)\s+Peers/i);
    if (peerMatch) result.peer_count = parseInt(peerMatch[1]);
    const countryMatch = html.match(/Country[^<]*<[^>]*>[^<]*<[^>]*>\s*<[^>]*>([^<]+)/i);
    if (countryMatch) result.country = countryMatch[1].trim();
    const lgMatch = html.match(/Looking\s+Glass[^<]*<[^>]*href="([^"]+)"/i);
    if (lgMatch) result.looking_glass = lgMatch[1];
    const descMatch = html.match(/AS\s+Name[^<]*<[^>]*>[^<]*<[^>]*>([^<]+)/i);
    if (descMatch) result.description = descMatch[1].trim();
    const irrMatch = html.match(/IRR\s+Record[^<]*<[^>]*>[^<]*<[^>]*>([^<]+)/i);
    if (irrMatch) result.irr_record = irrMatch[1].trim();
    const v4Match = html.match(/Prefixes\s+v4[^<]*<[^>]*>\s*(\d+)/i) || html.match(/IPv4\s+Prefixes[^<]*<[^>]*>\s*(\d+)/i);
    if (v4Match) result.prefixes_v4 = parseInt(v4Match[1]);
    const v6Match = html.match(/Prefixes\s+v6[^<]*<[^>]*>\s*(\d+)/i) || html.match(/IPv6\s+Prefixes[^<]*<[^>]*>\s*(\d+)/i);
    if (v6Match) result.prefixes_v6 = parseInt(v6Match[1]);
    result.source_url = "https://bgp.he.net/AS" + asn;
    return result;
  } catch (_e) {
    return null;
  }
}

// ============================================================
// Feature 25: Topology / AS-Relationships
// ============================================================
async function fetchTopology(targetAsn, depth) {
  const maxDepth = Math.min(depth || 2, 3);
  const nodes = new Map();
  const edges = [];
  async function fetchNeighboursForAsn(asn, currentDepth) {
    if (nodes.has(asn) && nodes.get(asn).depth <= currentDepth) return;
    const [data, overview] = await Promise.all([
      fetchJSON("https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS" + asn),
      fetchJSON("https://stat.ripe.net/data/as-overview/data.json?resource=AS" + asn),
    ]);
    const name = overview?.data?.holder || "";
    const neighbours = data?.data?.neighbours || [];
    const upstreams = neighbours.filter((n) => n.type === "left");
    const downstreams = neighbours.filter((n) => n.type === "right");
    const peers = neighbours.filter((n) => n.type === "uncertain" || n.type === "peer");
    const nodeType = asn === targetAsn ? "target" : currentDepth === 1 ? "direct" : "indirect";
    nodes.set(asn, { asn, name, type: nodeType, depth: currentDepth });
    upstreams.forEach((n) => {
      if (!nodes.has(n.asn)) nodes.set(n.asn, { asn: n.asn, name: n.as_name || "", type: "upstream", depth: currentDepth + 1 });
      edges.push({ from: n.asn, to: asn, relationship: "provider-to-customer" });
    });
    downstreams.forEach((n) => {
      if (!nodes.has(n.asn)) nodes.set(n.asn, { asn: n.asn, name: n.as_name || "", type: "downstream", depth: currentDepth + 1 });
      edges.push({ from: asn, to: n.asn, relationship: "provider-to-customer" });
    });
    peers.slice(0, 10).forEach((n) => {
      if (!nodes.has(n.asn)) nodes.set(n.asn, { asn: n.asn, name: n.as_name || "", type: "peer", depth: currentDepth + 1 });
      edges.push({ from: asn, to: n.asn, relationship: "peer" });
    });
    if (currentDepth < maxDepth && upstreams.length > 0) {
      const top5 = upstreams.sort((a, b) => (b.power || 0) - (a.power || 0)).slice(0, 5);
      await Promise.all(top5.map((u) => fetchNeighboursForAsn(u.asn, currentDepth + 1)));
    }
  }
  await fetchNeighboursForAsn(targetAsn, 0);
  const edgeSet = new Set();
  const uniqueEdges = edges.filter((e) => {
    const key = e.from + "-" + e.to + "-" + e.relationship;
    if (edgeSet.has(key)) return false;
    edgeSet.add(key);
    return true;
  });
  return { nodes: [...nodes.values()], edges: uniqueEdges, target_asn: targetAsn, depth: maxDepth };
}

// ============================================================
// Feature 27: WHOIS via RIPE DB
// ============================================================
async function fetchWhois(resource) {
  const result = { resource, type: null, data: null, error: null };
  try {
    const trimmed = resource.trim();
    if (/^(AS)?\d+$/i.test(trimmed)) {
      result.type = "aut-num";
      const asn = trimmed.replace(/^AS/i, "");
      const ripeData = await fetchJSON("https://rest.db.ripe.net/search.json?query-string=AS" + asn + "&type-filter=aut-num&source=ripe");
      if (ripeData && ripeData.objects && ripeData.objects.object) {
        const obj = ripeData.objects.object[0];
        const attrs = obj.attributes?.attribute || [];
        const parsed = {};
        attrs.forEach((a) => { if (!parsed[a.name]) parsed[a.name] = []; parsed[a.name].push(a.value); });
        result.data = {
          aut_num: (parsed["aut-num"] || [])[0] || "",
          as_name: (parsed["as-name"] || [])[0] || "",
          descr: parsed["descr"] || [],
          org: (parsed["org"] || [])[0] || "",
          admin_c: parsed["admin-c"] || [],
          tech_c: parsed["tech-c"] || [],
          mnt_by: parsed["mnt-by"] || [],
          status: (parsed["status"] || [])[0] || "",
          created: (parsed["created"] || [])[0] || "",
          last_modified: (parsed["last-modified"] || [])[0] || "",
          source: (parsed["source"] || [])[0] || "",
          import: parsed["import"] || [],
          export: parsed["export"] || [],
          remarks: parsed["remarks"] || [],
        };
      } else { result.error = "Not found in RIPE DB"; }
    } else if (/[\/:]/.test(trimmed) || /^\d+\.\d+\.\d+/.test(trimmed)) {
      result.type = "inetnum";
      const ripeData = await fetchJSON("https://rest.db.ripe.net/search.json?query-string=" + encodeURIComponent(trimmed) + "&type-filter=inetnum,inet6num");
      if (ripeData && ripeData.objects && ripeData.objects.object) {
        const results = ripeData.objects.object.map((obj) => {
          const attrs = obj.attributes?.attribute || [];
          const parsed = {};
          attrs.forEach((a) => { if (!parsed[a.name]) parsed[a.name] = []; parsed[a.name].push(a.value); });
          return {
            inetnum: (parsed["inetnum"] || parsed["inet6num"] || [])[0] || "",
            netname: (parsed["netname"] || [])[0] || "",
            descr: parsed["descr"] || [],
            country: (parsed["country"] || [])[0] || "",
            org: (parsed["org"] || [])[0] || "",
            admin_c: parsed["admin-c"] || [],
            tech_c: parsed["tech-c"] || [],
            mnt_by: parsed["mnt-by"] || [],
            status: (parsed["status"] || [])[0] || "",
            created: (parsed["created"] || [])[0] || "",
            last_modified: (parsed["last-modified"] || [])[0] || "",
            source: (parsed["source"] || [])[0] || "",
          };
        });
        result.data = results.length === 1 ? results[0] : results;
      } else { result.error = "Not found in RIPE DB"; }
    } else {
      result.type = "domain";
      const ripeData = await fetchJSON("https://rest.db.ripe.net/search.json?query-string=" + encodeURIComponent(trimmed) + "&type-filter=domain");
      if (ripeData && ripeData.objects && ripeData.objects.object) {
        const obj = ripeData.objects.object[0];
        const attrs = obj.attributes?.attribute || [];
        const parsed = {};
        attrs.forEach((a) => { if (!parsed[a.name]) parsed[a.name] = []; parsed[a.name].push(a.value); });
        result.data = {
          domain: (parsed["domain"] || [])[0] || "",
          descr: parsed["descr"] || [],
          admin_c: parsed["admin-c"] || [],
          tech_c: parsed["tech-c"] || [],
          zone_c: parsed["zone-c"] || [],
          nserver: parsed["nserver"] || [],
          mnt_by: parsed["mnt-by"] || [],
          created: (parsed["created"] || [])[0] || "",
          last_modified: (parsed["last-modified"] || [])[0] || "",
          source: (parsed["source"] || [])[0] || "",
        };
      } else { result.error = "Not found in RIPE DB"; }
    }
  } catch (err) { result.error = err.message; }
  return result;
}

// ============================================================
// HTTP Server
// ============================================================

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, "http://localhost");
  const reqPath = url.pathname;

  // Serve static files
  if (reqPath === "/" || reqPath === "/index.html") {
    try {
      const html = fs.readFileSync("/opt/peercortex-app/public/index.html", "utf8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(html);
    } catch (_e) {
      res.writeHead(500);
      return res.end("index.html not found");
    }
  }

  // Serve favicon
  if (reqPath === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  // Lia's Atlas Paradise - Easter egg page
  if (reqPath === "/lia" || reqPath === "/lia/") {
    try {
      const liaHtml = fs.readFileSync(__dirname + "/public/lia.html", "utf8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(liaHtml);
    } catch (_e) {
      res.writeHead(500);
      return res.end("lia.html not found");
    }
  }


  // ============================================================
  // Lia's Atlas Paradise: Atlas probe coverage endpoint
  // ============================================================
  if (reqPath === "/api/atlas/coverage") {
    res.setHeader("Content-Type", "application/json");
    if (!atlasProbeCache) {
      res.writeHead(503);
      return res.end(JSON.stringify({ error: "Atlas probe data is still loading. Please try again in a minute." }));
    }
    return res.end(JSON.stringify(atlasProbeCache, null, 2));
  }

  // ============================================================
  // Lia's Paradise: Combined PeeringDB + Atlas coverage data
  // ============================================================
  if (reqPath === "/api/lia/coverage") {
    res.setHeader("Content-Type", "application/json");
    if (!atlasProbeCache) {
      res.writeHead(503);
      return res.end(JSON.stringify({ error: "Atlas probe data is still loading. Please try again in a minute." }));
    }

    // Cache this expensive response for 30 min
    var liaCacheKey = "lia_coverage";
    var liaCached = cacheGet(liaCacheKey);
    if (liaCached) return res.end(liaCached);

    // Fetch PeeringDB network list (all networks with status "ok")
    fetchPeeringDB("/net?status=ok&depth=0").then(function(pdbData) {
      if (!pdbData || !pdbData.data) {
        return res.end(JSON.stringify({ error: "Could not fetch PeeringDB networks" }));
      }

      var probeAsns = new Set(atlasProbeCache.asns_with_probes || []);
      // Country name lookup
      var countryNames = {};
      try { countryNames = require("./country-names.json"); } catch(_e) { /* optional */ }

      var networks = pdbData.data.map(function(n) {
        return {
          asn: n.asn,
          name: n.name || "",
          country: n.info_prefixes4 > 0 || n.info_prefixes6 > 0 ? "" : "", // PeeringDB doesn't have country directly on net
          info_type: n.info_type || "",
          has_probe: probeAsns.has(n.asn),
        };
      });

      // We need countries — fetch from RIPE Stat for each unique ASN is too slow.
      // Instead, use the Atlas byCountry data to enrich. For PeeringDB, we need netfac or netixlan for country.
      // Better approach: Use PeeringDB org country. Fetch with depth=1 to get org.
      // But that's too heavy (50MB+). Instead, use a separate PeeringDB call for orgs.
      // Pragmatic: Fetch net with depth=1 but limit fields
      // Actually the simplest: PeeringDB net API doesn't expose country directly.
      // Use the ix_count/fac_count fields and the "org" for country.
      // Let's just add a second call for orgs.

      // Simplest approach: use RIPE Stat resource-overview for country from ASN prefix
      // But that's per-ASN. Instead, build country from Atlas probes data.
      // Atlas byCountry has {CC: {asnSet}} — we can reverse-map ASN→country from there.

      // Build ASN→country from atlas data
      // We stored asnSet in byCountry but only in the internal function.
      // atlasProbeCache.by_country has {CC: {total, connected, asn_count}} — no ASN list!
      // We need to store ASN→country mapping. Let's add it.

      // For now, return without country and let frontend handle it via RIR mapping
      // Actually: PeeringDB net objects have no country, but we can batch-fetch orgs.
      // The org object has country. Let's do net?depth=1 but that's huge.
      // Compromise: Get first 5000 networks and their org_id, then batch-fetch orgs.

      // PRAGMATIC FIX: Use net?depth=0 + a separate org fetch
      // PeeringDB org API: /org?status=ok&limit=0 returns all orgs with country.

      fetchPeeringDB("/org?status=ok&depth=0").then(function(orgData) {
        // Build org_id → country map
        var orgCountry = {};
        if (orgData && orgData.data) {
          orgData.data.forEach(function(o) {
            orgCountry[o.id] = { country: o.country || "", name: o.name || "" };
          });
        }

        // Enrich networks with org country
        var enriched = pdbData.data.map(function(n) {
          var org = orgCountry[n.org_id] || {};
          var cc = org.country || "";
          return {
            asn: n.asn,
            name: n.name || "",
            org_name: org.name || "",
            country: cc,
            country_name: cc, // frontend will display full name from its own mapping
            info_type: n.info_type || "",
            has_probe: probeAsns.has(n.asn),
          };
        }).filter(function(n) { return n.asn > 0; });

        var result = JSON.stringify({
          networks: enriched,
          total: enriched.length,
          with_probes: enriched.filter(function(n) { return n.has_probe; }).length,
          without_probes: enriched.filter(function(n) { return !n.has_probe; }).length,
          atlas_unique_asns: probeAsns.size,
          fetched_at: new Date().toISOString(),
        });

        cacheSet(liaCacheKey, result, 30 * 60 * 1000); // 30 min cache
        res.end(result);
      }).catch(function(e) {
        // If org fetch fails, return without country
        var result = JSON.stringify({
          networks: networks,
          total: networks.length,
          with_probes: networks.filter(function(n) { return n.has_probe; }).length,
          without_probes: networks.filter(function(n) { return !n.has_probe; }).length,
          atlas_unique_asns: probeAsns.size,
          error_note: "Country data unavailable: " + e.message,
          fetched_at: new Date().toISOString(),
        });
        cacheSet(liaCacheKey, result, 5 * 60 * 1000);
        res.end(result);
      });
    }).catch(function(e) {
      res.end(JSON.stringify({ error: "PeeringDB fetch failed: " + e.message }));
    });
    return;
  }

  res.setHeader("Content-Type", "application/json");

  // Health endpoint
  if (reqPath === "/api/health") {
    return res.end(
      JSON.stringify({
        status: "ok",
        service: "PeerCortex",
        version: "0.5.0",
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.floor(process.uptime()),
        bgproutes_configured: !!BGPROUTES_API_KEY,
      })
    );
  }

  // ============================================================
  // ASPA Deep Verification endpoint: /api/aspa/verify?asn=X
  // ============================================================
  if (reqPath === "/api/aspa/verify") {
    const rawAsn = (url.searchParams.get("asn") || "").replace(/[^0-9]/g, "");
    if (!rawAsn) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing or invalid ASN parameter" }));
    }
    const targetAsn = parseInt(rawAsn);
    const start = Date.now();

    try {
      // Fetch neighbour and prefix data first
      const [neighbourData, prefixData] = await Promise.all([
        fetchJSON("https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS" + rawAsn),
        fetchJSON("https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS" + rawAsn),
      ]);

      // Use looking-glass with actual prefixes to get BGP paths
      const announcedPrefixes = prefixData?.data?.prefixes || [];
      const samplePrefixes = announcedPrefixes.slice(0, 5).map((p) => p.prefix);

      // Fetch looking-glass data for up to 5 prefixes in parallel
      const lgResults = await Promise.all(
        samplePrefixes.map((pfx) =>
          fetchJSON("https://stat.ripe.net/data/looking-glass/data.json?resource=" + encodeURIComponent(pfx))
        )
      );

      // Extract AS paths from looking glass results
      const allPaths = [];
      const upstreamSet = new Set();

      lgResults.forEach((lgData) => {
        const rrcs = lgData?.data?.rrcs || [];
        rrcs.forEach((rrc) => {
          const peers = rrc.peers || [];
          peers.forEach((peer) => {
            const rawPath = peer.as_path || "";
            const pathArr = rawPath.split(" ").map(Number).filter(Boolean);
            if (pathArr.length > 1) {
              allPaths.push({
                rrc: rrc.rrc,
                path: pathArr,
                rawPath: rawPath,
                prefix: peer.prefix || "",
                hasAsSet: hasAsSet(rawPath),
              });
              const idx = pathArr.indexOf(targetAsn);
              if (idx > 0) {
                upstreamSet.add(pathArr[idx - 1]);
              }
            }
          });
        });
      });

      // Get neighbours for provider relationships
      const neighbours = neighbourData?.data?.neighbours || [];
      const leftNeighbours = neighbours.filter((n) => n.type === "left");
      leftNeighbours.forEach((n) => upstreamSet.add(n.asn));

      const detectedProviders = [...upstreamSet].map((asn) => {
        const nb = leftNeighbours.find((n) => n.asn === asn);
        return { asn, name: nb && nb.as_name ? nb.as_name : "" };
      });

      await resolveASNames(detectedProviders);

      // Count how often each provider appears in paths
      const providerFrequency = new Map();
      allPaths.forEach((p) => {
        const idx = p.path.indexOf(targetAsn);
        if (idx > 0) {
          const prov = p.path[idx - 1];
          providerFrequency.set(prov, (providerFrequency.get(prov) || 0) + 1);
        }
      });

      // Check Cloudflare RPKI feed for ASPA object
      await ensureAspaCache();
      const aspaLookup = lookupAspaFromRpki(targetAsn);
      const aspaObjectExists = aspaLookup.exists;
      const aspaDeclaredProviders = aspaLookup.providers;

      // Build ASPA store from RPKI feed data (real ASPA objects)
      const aspaStore = new Map();
      // Add the target ASN's RPKI-declared providers
      if (aspaObjectExists) {
        aspaStore.set(targetAsn, new Set(aspaDeclaredProviders));
      } else {
        // Fallback: use detected providers for path verification
        const providerSet = new Set(detectedProviders.map((p) => p.asn));
        aspaStore.set(targetAsn, providerSet);
      }
      // Also populate store with all known ASPA objects from the RPKI feed
      // for providers that have their own ASPA objects (enables full path verification)
      for (const [cas, provSet] of rpkiAspaMap) {
        if (!aspaStore.has(cas)) {
          aspaStore.set(cas, provSet);
        }
      }

      // Also add reverse relationships for providers we know about
      // (each provider has the target as customer)
      detectedProviders.forEach((p) => {
        if (!aspaStore.has(p.asn)) {
          aspaStore.set(p.asn, new Set());
        }
      });

      // Sample paths for verification (up to 50)
      const samplePaths = allPaths.slice(0, 50);
      const pathResults = samplePaths.map((p) => {
        const upstream = verifyUpstream(p.path, aspaStore, p.rawPath);
        const downstream = verifyDownstream(p.path, aspaStore, p.rawPath);
        const valleys = detectValleys(p.path, aspaStore);

        return {
          rrc: p.rrc,
          prefix: p.prefix,
          path: p.path.map((a) => "AS" + a).join(" "),
          collapsed_path: collapsePrepends(p.path).map((a) => "AS" + a).join(" "),
          has_as_set: p.hasAsSet,
          upstream_verification: upstream,
          downstream_verification: downstream,
          valleys: valleys,
          overall: p.hasAsSet
            ? "Invalid"
            : upstream.result === "Valid" && downstream.result === "Valid"
            ? "Valid"
            : upstream.result === "Invalid" || downstream.result === "Invalid"
            ? "Invalid"
            : "Unknown",
        };
      });

      // Calculate statistics
      const validPaths = pathResults.filter((p) => p.overall === "Valid").length;
      const invalidPaths = pathResults.filter((p) => p.overall === "Invalid").length;
      const unknownPaths = pathResults.filter((p) => p.overall === "Unknown").length;
      const asSetPaths = pathResults.filter((p) => p.has_as_set).length;
      const valleyPaths = pathResults.filter((p) => p.valleys.length > 0).length;

      // For readiness scoring: Valid = full credit, Unknown = partial (no ASPA data is normal),
      // only Invalid actually indicates problems
      const pathNotInvalidPct = pathResults.length > 0
        ? Math.round(((validPaths + unknownPaths) / pathResults.length) * 100)
        : 0;
      const pathValidPct = pathResults.length > 0 ? Math.round((validPaths / pathResults.length) * 100) : 0;

      // Provider audit: compare detected vs declared
      const detectedSet = new Set(detectedProviders.map((p) => p.asn));
      const declaredSet = new Set(aspaDeclaredProviders);

      const missingFromAspa = detectedProviders
        .filter((p) => !declaredSet.has(p.asn))
        .map((p) => ({
          asn: p.asn,
          name: p.name,
          frequency: providerFrequency.get(p.asn) || 0,
          frequency_pct: allPaths.length > 0
            ? Math.round(((providerFrequency.get(p.asn) || 0) / allPaths.length) * 100)
            : 0,
        }))
        .sort((a, b) => b.frequency - a.frequency);

      const extraInAspa = aspaDeclaredProviders
        .filter((asn) => !detectedSet.has(asn))
        .map((asn) => ({
          asn,
          name: "",
          seen_in_paths: false,
        }));

      const providerCompleteness = detectedProviders.length > 0
        ? Math.round(
            (detectedProviders.filter((p) => declaredSet.has(p.asn)).length /
              detectedProviders.length) *
              100
          )
        : aspaObjectExists ? 100 : 0;

      // Get RPKI coverage for readiness score
      const rpkiBatch = announcedPrefixes.slice(0, 20).map((p) => p.prefix);
      const rpkiResults = await Promise.all(rpkiBatch.map((pfx) => fetchRPKIPerPrefix(rawAsn, pfx)));
      const rpkiValid = rpkiResults.filter((r) => r.status === "valid").length;
      const rpkiCoverage = rpkiResults.length > 0 ? Math.round((rpkiValid / rpkiResults.length) * 100) : 0;

      // Calculate readiness score
      const readinessScore = calculateAspaReadinessScore({
        rpkiCoverage,
        aspaObjectExists,
        providerCompleteness,
        pathValidationPct: pathNotInvalidPct,
      });

      const duration = Date.now() - start;

      return res.end(
        JSON.stringify(
          {
            meta: {
              query: "AS" + rawAsn,
              duration_ms: duration,
              timestamp: new Date().toISOString(),
              paths_analyzed: pathResults.length,
              total_paths_seen: allPaths.length,
            },
            asn: targetAsn,
            readiness_score: readinessScore,
            aspa_object_exists: aspaObjectExists,
            detected_providers: detectedProviders.map((p) => ({
              ...p,
              frequency: providerFrequency.get(p.asn) || 0,
              frequency_pct: allPaths.length > 0
                ? Math.round(((providerFrequency.get(p.asn) || 0) / allPaths.length) * 100)
                : 0,
            })),
            provider_audit: {
              declared_count: aspaDeclaredProviders.length,
              detected_count: detectedProviders.length,
              completeness_pct: providerCompleteness,
              missing_from_aspa: missingFromAspa,
              extra_in_aspa: extraInAspa,
            },
            path_verification: {
              total: pathResults.length,
              valid: validPaths,
              invalid: invalidPaths,
              unknown: unknownPaths,
              as_set_flagged: asSetPaths,
              valley_detected: valleyPaths,
              valid_pct: pathValidPct,
              not_invalid_pct: pathNotInvalidPct,
              results: pathResults,
            },
            rpki_coverage: rpkiCoverage,
          },
          null,
          2
        )
      );
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: "ASPA verification failed", message: err.message }));
    }
  }

  // ============================================================
  // ASPA Check endpoint: /api/aspa?asn=X (existing, kept for compat)
  // ============================================================
  if (reqPath === "/api/aspa") {
    const rawAsn = (url.searchParams.get("asn") || "").replace(/[^0-9]/g, "");
    if (!rawAsn) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing or invalid ASN parameter" }));
    }
    const start = Date.now();
    try {
      const [lgData, neighbourData] = await Promise.all([
        fetchJSON("https://stat.ripe.net/data/looking-glass/data.json?resource=AS" + rawAsn),
        fetchJSON("https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS" + rawAsn),
      ]);

      const rrcs = lgData?.data?.rrcs || [];
      const asPaths = [];
      const upstreamSet = new Set();

      rrcs.forEach((rrc) => {
        const peers = rrc.peers || [];
        peers.forEach((peer) => {
          const path = peer.as_path || "";
          const pathArr = path.split(" ").map(Number).filter(Boolean);
          if (pathArr.length > 1) {
            asPaths.push({ rrc: rrc.rrc, path: pathArr, prefix: peer.prefix || "" });
            const idx = pathArr.indexOf(parseInt(rawAsn));
            if (idx > 0) {
              upstreamSet.add(pathArr[idx - 1]);
            }
          }
        });
      });

      const neighbours = neighbourData?.data?.neighbours || [];
      const leftNeighbours = neighbours.filter((n) => n.type === "left");
      leftNeighbours.forEach((n) => upstreamSet.add(n.asn));

      const detectedProviders = [...upstreamSet].map((asn) => {
        const nb = leftNeighbours.find((n) => n.asn === asn);
        return { asn, name: nb && nb.as_name ? nb.as_name : "" };
      });

      await resolveASNames(detectedProviders);

      // Check Cloudflare RPKI feed for ASPA object
      await ensureAspaCache();
      const aspaLookup = lookupAspaFromRpki(rawAsn);
      const aspaObjectExists = aspaLookup.exists;
      const aspaDeclaredProviders = aspaLookup.providers;

      const providerList = detectedProviders.map((p) => "AS" + p.asn).join(", ");
      let recommendedAspa =
        "aut-num:        AS" + rawAsn + "\n" +
        "# Recommended ASPA object:\n" +
        "# customer:     AS" + rawAsn + "\n" +
        "# provider-set: " + providerList + "\n" +
        "# AFI:          ipv4, ipv6\n" +
        "#\n" +
        "# Detected providers from BGP path analysis:\n" +
        detectedProviders.map((p) => "#   AS" + p.asn + (p.name ? " (" + p.name + ")" : "")).join("\n");

      // If ASPA object exists, show RPKI-declared providers
      if (aspaObjectExists && aspaDeclaredProviders.length > 0) {
        recommendedAspa += "\n#\n# RPKI-declared providers (from Cloudflare RPKI feed):\n" +
          aspaDeclaredProviders.map((a) => "#   AS" + a).join("\n");
      }

      const samplePaths = asPaths.slice(0, 10).map((p) => {
        const pathStr = p.path.map((a) => "AS" + a).join(" -> ");
        const idx = p.path.indexOf(parseInt(rawAsn));
        const provider = idx > 0 ? p.path[idx - 1] : null;
        return {
          rrc: p.rrc,
          prefix: p.prefix,
          path: pathStr,
          detected_provider: provider ? "AS" + provider : null,
          provider_in_set: provider ? upstreamSet.has(provider) : false,
        };
      });

      const duration = Date.now() - start;
      return res.end(
        JSON.stringify(
          {
            meta: { query: "AS" + rawAsn, duration_ms: duration, timestamp: new Date().toISOString() },
            asn: parseInt(rawAsn),
            detected_providers: detectedProviders,
            provider_count: detectedProviders.length,
            aspa_object_exists: aspaObjectExists,
            aspa_declared_providers: aspaDeclaredProviders.map((a) => ({ asn: a })),
            aspa_declared_count: aspaDeclaredProviders.length,
            recommended_aspa: recommendedAspa,
            path_analysis: {
              total_paths_seen: asPaths.length,
              sample_paths: samplePaths,
            },
          },
          null,
          2
        )
      );
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: "ASPA check failed", message: err.message }));
    }
  }

  // ============================================================
  // bgproutes.io endpoint: /api/bgproutes?asn=X (or prefix=X)
  // ============================================================
  if (reqPath === "/api/bgproutes") {
    const rawAsn = (url.searchParams.get("asn") || "").replace(/[^0-9]/g, "");
    const prefix = url.searchParams.get("prefix") || "";
    if (!rawAsn && !prefix) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Need asn or prefix parameter" }));
    }
    const start = Date.now();
    try {
      const result = { meta: { timestamp: new Date().toISOString() }, vantage_points: null, routes: null };

      const vpData = await fetchJSON(BGPROUTES_API_URL + "/vantage_points", {
        headers: { "x-api-key": BGPROUTES_API_KEY },
      });

      if (vpData && !vpData.error) {
        const vpList = vpData?.data?.bgp || (Array.isArray(vpData) ? vpData : vpData.data || []);
        const readyVPs = Array.isArray(vpList) ? vpList.filter((vp) => !vp.status || (Array.isArray(vp.status) && vp.status.includes("ready"))) : [];
        result.vantage_points = {
          count: readyVPs.length,
          total: Array.isArray(vpList) ? vpList.length : 0,
          list: readyVPs.slice(0, 20).map((vp) => ({
            id: vp.id,
            asn: vp.asn,
            ip: vp.ip,
            source: vp.source || "",
            org_name: vp.org_name || "",
            country: vp.org_country || vp.country || "",
            rib_v4: vp.rib_size_v4 || 0,
            rib_v6: vp.rib_size_v6 || 0,
          })),
        };
      } else {
        result.vantage_points = { count: 0, error: "Could not fetch vantage points" };
      }

      let ribSuccess = false;
      const readyVPsForRib = result.vantage_points && result.vantage_points.list
        ? result.vantage_points.list.filter((vp) => vp.rib_v4 > 500000).slice(0, 1)
        : [];

      if (readyVPsForRib.length > 0) {
        const vpId = readyVPsForRib[0].id;
        const now = new Date().toISOString().replace(/\.\d+Z$/, "");
        const ribBody = {
          vp_bgp_ids: String(vpId),
          date: now,
          return_aspath: true,
          return_rov_status: true,
          return_aspa_status: true,
        };

        if (prefix) {
          ribBody.prefix_exact_match = prefix;
        } else if (rawAsn) {
          ribBody.aspath_regexp = rawAsn + "$";
        }

        try {
          const ribData = await postJSON(BGPROUTES_API_URL + "/rib", ribBody, {
            headers: { "x-api-key": BGPROUTES_API_KEY },
          });

          if (ribData && ribData.data) {
            const bgpData = ribData.data.bgp || {};
            const vpRoutes = bgpData[String(vpId)] || {};
            const routeEntries = Object.entries(vpRoutes).map(([pfx, arr]) => {
              const asPath = Array.isArray(arr) ? arr[0] || "" : "";
              const rovStatus = Array.isArray(arr) ? arr[2] || "" : "";
              const aspaStatus = Array.isArray(arr) ? arr[3] || "" : "";
              return {
                prefix: pfx,
                as_path: asPath,
                rov_status: (function(rs) {
                  var parts = rs.split(",").map(function(s) { return s === "V" ? "valid" : s === "I" ? "invalid" : s === "U" ? "unknown" : s; });
                  if (parts.indexOf("invalid") >= 0) return "invalid";
                  if (parts.indexOf("unknown") >= 0) return "unknown";
                  if (parts.indexOf("valid") >= 0) return "valid";
                  return parts[0] || "unknown";
                })(rovStatus),
                aspa_status: (function(as) {
                  var parts = as.split(",").map(function(s) { return s === "V" ? "valid" : s === "I" ? "invalid" : s === "U" ? "unknown" : s; });
                  if (parts.indexOf("invalid") >= 0) return "invalid";
                  if (parts.indexOf("unknown") >= 0) return "unknown";
                  if (parts.indexOf("valid") >= 0) return "valid";
                  return parts[0] || "unknown";
                })(aspaStatus),
              };
            });

            if (routeEntries.length > 0) {
              result.routes = {
                count: routeEntries.length,
                vp_used: { id: vpId, org: readyVPsForRib[0].org_name, country: readyVPsForRib[0].country },
                sample: routeEntries.slice(0, 20),
              };
              ribSuccess = true;
            }
          }
        } catch (_e) {}
      }

      if (!ribSuccess) {
        result.routes = {
          status: "unavailable",
          message: readyVPsForRib.length === 0
            ? "No ready VPs with sufficient RIB size found"
            : "bgproutes.io: VPs available but RIB query returned no data for this ASN",
        };
      }

      result.meta.duration_ms = Date.now() - start;
      return res.end(JSON.stringify(result, null, 2));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: "bgproutes.io query failed", message: err.message }));
    }
  }


  // ============================================================
  // Unified Validation endpoint: /api/validate?asn=X
  // Runs ALL validations in parallel, returns comprehensive report
  // ============================================================
  if (reqPath === "/api/validate") {
    const rawAsn = (url.searchParams.get("asn") || "").replace(/[^0-9]/g, "");
    if (!rawAsn) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing or invalid ASN parameter" }));
    }
    const start = Date.now();
    const targetAsn = parseInt(rawAsn);

    try {
      // Phase 1: Fetch core data needed by multiple validations
      const [prefixData, pdbNet, neighbourData, overviewData] = await Promise.all([
        fetchJSON("https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS" + rawAsn, { timeout: 30000 }),
        fetchPeeringDB("/net?asn=" + rawAsn),
        fetchJSON("https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS" + rawAsn, { timeout: 30000 }),
        fetchJSON("https://stat.ripe.net/data/as-overview/data.json?resource=AS" + rawAsn),
      ]);

      const allPrefixes = (prefixData && prefixData.data && prefixData.data.prefixes ? prefixData.data.prefixes : []).map(function(p) { return p.prefix; });
      const samplePrefixes = allPrefixes.slice(0, 10);
      const net = pdbNet && pdbNet.data && pdbNet.data[0] ? pdbNet.data[0] : {};
      const netId = net.id;
      const neighbours = neighbourData && neighbourData.data && neighbourData.data.neighbours ? neighbourData.data.neighbours : [];

      // ---- 11. Bogon Detection (local check) ----
      function checkBogonPrefix(prefix) {
        var bogonV4 = [
          { net: "0.0.0.0", mask: 8 }, { net: "10.0.0.0", mask: 8 },
          { net: "100.64.0.0", mask: 10 }, { net: "127.0.0.0", mask: 8 },
          { net: "169.254.0.0", mask: 16 }, { net: "172.16.0.0", mask: 12 },
          { net: "192.0.2.0", mask: 24 }, { net: "192.168.0.0", mask: 16 },
          { net: "198.51.100.0", mask: 24 }, { net: "203.0.113.0", mask: 24 },
          { net: "240.0.0.0", mask: 4 },
        ];
        if (prefix.includes(":")) return { prefix: prefix, is_bogon: false, reason: "IPv6 bogon check skipped" };
        var split = prefix.split("/");
        var addr = split[0];
        var mask = parseInt(split[1] || "0");
        var parts = addr.split(".").map(Number);
        var ip = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
        for (var bi = 0; bi < bogonV4.length; bi++) {
          var b = bogonV4[bi];
          var bParts = b.net.split(".").map(Number);
          var bIp = ((bParts[0] << 24) | (bParts[1] << 16) | (bParts[2] << 8) | bParts[3]) >>> 0;
          var bMask = (~((1 << (32 - b.mask)) - 1)) >>> 0;
          if ((ip & bMask) === (bIp & bMask) && mask >= b.mask) {
            return { prefix: prefix, is_bogon: true, reason: "Matches bogon " + b.net + "/" + b.mask };
          }
        }
        return { prefix: prefix, is_bogon: false };
      }

      function checkBogonAsn(asnNum) {
        if (asnNum === 0 || asnNum === 23456 || asnNum === 65535) return true;
        if (asnNum >= 64496 && asnNum <= 64511) return true;
        if (asnNum >= 64512 && asnNum <= 65534) return true;
        return false;
      }

      var bogonPrefixResults = allPrefixes.map(checkBogonPrefix);
      var bogonPrefixes = bogonPrefixResults.filter(function(r) { return r.is_bogon; });
      var asnInPaths = neighbours.map(function(n) { return n.asn; });
      var bogonAsns = asnInPaths.filter(checkBogonAsn);
      var bogonResult = {
        status: bogonPrefixes.length === 0 && bogonAsns.length === 0 ? "pass" : "fail",
        bogon_prefixes: bogonPrefixes,
        bogon_asns_in_paths: bogonAsns,
        total_prefixes_checked: allPrefixes.length,
      };

      // Phase 2: All API-dependent validations in parallel
      var validationPromises = {};

      // 12. IRR Validation
      validationPromises.irr = fetchJSON("https://irrexplorer.nlnog.net/api/prefixes/asn/" + rawAsn).then(function(irrData) {
        var entries = Array.isArray(irrData) ? irrData : [];
        var mismatches = entries.filter(function(e) {
          if (!e.bgpOrigins && !e.bgp_origins) return false;
          if (!e.irrRoutes && !e.irr_origins) return false;
          var bgpArr = e.bgpOrigins || e.bgp_origins || [];
          var irrArr = e.irrRoutes || e.irr_origins || [];
          var bgpSet = {};
          bgpArr.forEach(function(a) { bgpSet[String(typeof a === "object" ? a.asn : a)] = true; });
          var match = false;
          irrArr.forEach(function(a) { if (bgpSet[String(typeof a === "object" ? a.asn : a)]) match = true; });
          return Object.keys(bgpSet).length > 0 && irrArr.length > 0 && !match;
        });
        return {
          status: mismatches.length === 0 ? "pass" : "warning",
          total_entries: entries.length,
          mismatches: mismatches.slice(0, 10).map(function(e) { return { prefix: e.prefix, bgp_origins: e.bgpOrigins || e.bgp_origins, irr_origins: e.irrRoutes || e.irr_origins }; }),
          mismatch_count: mismatches.length,
        };
      }).catch(function(e) { return { status: "error", error: String(e) }; });

      // 13. RPKI ROA Completeness
      validationPromises.rpki_completeness = Promise.all(
        samplePrefixes.map(function(pfx) { return fetchRPKIPerPrefix(rawAsn, pfx); })
      ).then(function(rpkiResults) {
        var withRoa = rpkiResults.filter(function(r) { return r.status === "valid"; });
        var coverage = rpkiResults.length > 0 ? Math.round((withRoa.length / rpkiResults.length) * 100) : 0;
        var overSpecific = rpkiResults.filter(function(r) {
          var mask = parseInt((r.prefix || "").split("/")[1] || "0");
          return !r.prefix.includes(":") && mask >= 25 && r.status !== "valid";
        });
        return {
          status: coverage >= 90 ? "pass" : coverage >= 50 ? "warning" : "fail",
          coverage_pct: coverage,
          total_checked: rpkiResults.length,
          with_roa: withRoa.length,
          over_specific: overSpecific.map(function(r) { return r.prefix; }),
          details: rpkiResults,
        };
      }).catch(function(e) { return { status: "error", error: String(e) }; });

      // 14. Abuse Contact Validation
      validationPromises.abuse_contact = fetchJSON("https://stat.ripe.net/data/abuse-contact-finder/data.json?resource=AS" + rawAsn).then(function(data) {
        var contacts = data && data.data && data.data.abuse_contacts ? data.data.abuse_contacts : [];
        var hasEmail = contacts.length > 0 && contacts.some(function(c) { return c && c.includes("@"); });
        return { status: hasEmail ? "pass" : "fail", contacts: contacts, has_valid_email: hasEmail };
      }).catch(function(e) { return { status: "error", error: String(e) }; });

      // 15. Spamhaus DROP/Blocklist
      validationPromises.blocklist = Promise.all(
        samplePrefixes.slice(0, 5).map(function(pfx) {
          return fetchJSON("https://stat.ripe.net/data/blocklist/data.json?resource=" + encodeURIComponent(pfx)).then(function(data) {
            var sources = data && data.data && data.data.sources ? data.data.sources : [];
            var listed = sources.filter(function(s) { return s.prefix_count > 0 || (s.entries && s.entries.length > 0); });
            return { prefix: pfx, listed: listed.length > 0, sources: listed.map(function(s) { return s.source || s.name || "unknown"; }) };
          }).catch(function() { return { prefix: pfx, listed: false, error: true }; });
        })
      ).then(function(results) {
        var listedPrefixes = results.filter(function(r) { return r.listed; });
        return { status: listedPrefixes.length === 0 ? "pass" : "fail", checked: results.length, listed_prefixes: listedPrefixes };
      }).catch(function(e) { return { status: "error", error: String(e) }; });

      // 16. MANRS Compliance
      validationPromises.manrs = fetchJSON("https://observatory.manrs.org/api/v2/asn/" + rawAsn + "/conformance").then(function(data) {
        if (!data || data.error || data.detail) return { status: "warning", participant: false, message: (data && data.detail) || "Not a MANRS participant" };
        var score = data.conformance_score || data.score || 0;
        return { status: score >= 50 ? "pass" : "warning", participant: true, score: score, details: data };
      }).catch(function(e) { return { status: "warning", participant: false, error: String(e) }; });

      // 17. Reverse DNS Coverage
      validationPromises.rdns = Promise.all(
        samplePrefixes.slice(0, 5).map(function(pfx) {
          return fetchJSON("https://stat.ripe.net/data/reverse-dns-consistency/data.json?resource=" + encodeURIComponent(pfx)).then(function(data) {
            var prefixes = data && data.data && data.data.prefixes ? data.data.prefixes : [];
            var hasDelegation = prefixes.some(function(p) { return p.ipv4 || p.ipv6 || (p.delegations && p.delegations.length > 0); });
            return { prefix: pfx, has_rdns: hasDelegation };
          }).catch(function() { return { prefix: pfx, has_rdns: false, error: true }; });
        })
      ).then(function(results) {
        var withRdns = results.filter(function(r) { return r.has_rdns; });
        var coverage = results.length > 0 ? Math.round((withRdns.length / results.length) * 100) : 0;
        return { status: coverage >= 80 ? "pass" : coverage >= 50 ? "warning" : "fail", coverage_pct: coverage, checked: results.length, results: results };
      }).catch(function(e) { return { status: "error", error: String(e) }; });

      // 18. Historical BGP Visibility
      validationPromises.visibility = (samplePrefixes.length > 0
        ? Promise.all([
            fetchJSON("https://stat.ripe.net/data/visibility/data.json?resource=" + encodeURIComponent(samplePrefixes[0])),
            fetchJSON("https://stat.ripe.net/data/routing-history/data.json?resource=" + encodeURIComponent(samplePrefixes[0])),
          ])
        : Promise.resolve([null, null])
      ).then(function(arr) {
        var visData = arr[0]; var histData = arr[1];
        var visibilities = visData && visData.data && visData.data.visibilities ? visData.data.visibilities : [];
        var totalRrcs = visibilities.length;
        var seenBy = visibilities.filter(function(v) { return (v.rrcs_seeing || v.ipv4_full_table_peer_count || 0) > 0; }).length;
        var score = totalRrcs > 0 ? Math.round((seenBy / totalRrcs) * 100) : 0;
        var history = histData && histData.data && histData.data.by_origin ? histData.data.by_origin : [];
        // If RIPE Stat returned no data, try bgproutes.io fallback
        if (totalRrcs === 0 && samplePrefixes[0]) {
          return fetchBgproutesVisibility(samplePrefixes[0]).then(function(bgprFb) {
            if (bgprFb && bgprFb.vps_seeing > 0) {
              seenBy = bgprFb.vps_seeing;
              totalRrcs = Math.max(bgprFb.vps_seeing, 300);
              score = Math.round((seenBy / totalRrcs) * 100);
            }
            return { status: score >= 80 ? "pass" : score >= 50 ? "warning" : "fail", visibility_score: score, total_rrcs: totalRrcs, seen_by: seenBy, origin_changes: history.length, sample_prefix: samplePrefixes[0] || null };
          }).catch(function() {
            return { status: score >= 80 ? "pass" : score >= 50 ? "warning" : "fail", visibility_score: score, total_rrcs: totalRrcs, seen_by: seenBy, origin_changes: history.length, sample_prefix: samplePrefixes[0] || null };
          });
        }
        return { status: score >= 80 ? "pass" : score >= 50 ? "warning" : "fail", visibility_score: score, total_rrcs: totalRrcs, seen_by: seenBy, origin_changes: history.length, sample_prefix: samplePrefixes[0] || null };
      }).catch(function(e) { return { status: "error", error: String(e) }; });

      // 19. BGP Communities Analysis
      validationPromises.communities = (samplePrefixes.length > 0
        ? (function() {
            var now = new Date();
            var end = now.toISOString().replace(/\.\d+Z/, "");
            var startTime = new Date(now.getTime() - 3600000).toISOString().replace(/\.\d+Z/, "");
            return fetchJSON("https://stat.ripe.net/data/bgp-updates/data.json?resource=" + encodeURIComponent(samplePrefixes[0]) + "&starttime=" + startTime + "&endtime=" + end);
          })()
        : Promise.resolve(null)
      ).then(function(data) {
        var updates = data && data.data && data.data.updates ? data.data.updates : [];
        var communityMap = {};
        var wellKnown = { "65535:0": "GRACEFUL_SHUTDOWN", "65535:65281": "NO_EXPORT", "65535:65282": "NO_ADVERTISE", "65535:666": "BLACKHOLE" };
        updates.forEach(function(u) {
          var attrs = u.attrs || {};
          var communities = attrs.community || [];
          communities.forEach(function(c) {
            var key = Array.isArray(c) ? c.join(":") : String(c);
            if (!communityMap[key]) communityMap[key] = { community: key, count: 0, well_known: wellKnown[key] || null };
            communityMap[key].count++;
          });
        });
        var sorted = Object.values(communityMap).sort(function(a, b) { return b.count - a.count; });
        var hasBlackhole = sorted.some(function(c) { return c.well_known === "BLACKHOLE"; });
        return { status: hasBlackhole ? "warning" : "pass", total_updates: updates.length, unique_communities: sorted.length, top_communities: sorted.slice(0, 20), well_known_detected: sorted.filter(function(c) { return c.well_known; }) };
      }).catch(function(e) { return { status: "error", error: String(e) }; });

      // 20. Geolocation Verification
      validationPromises.geolocation = (samplePrefixes.length > 0
        ? fetchJSON("https://stat.ripe.net/data/maxmind-geo-lite-pfx/data.json?resource=" + encodeURIComponent(samplePrefixes[0]))
        : Promise.resolve(null)
      ).then(function(data) {
        var locatedPfxs = data && data.data && data.data.located_resources ? data.data.located_resources : [];
        var countries = {};
        locatedPfxs.forEach(function(l) { var locs = l.locations || []; locs.forEach(function(loc) { if (loc.country) countries[loc.country] = true; }); });
        return { status: Object.keys(countries).length > 0 ? "pass" : "warning", geo_countries: Object.keys(countries), sample_prefix: samplePrefixes[0] || null, located_resources: locatedPfxs.length };
      }).catch(function(e) { return { status: "error", error: String(e) }; });

      // 21. RPSL/IRR Object Validation
      validationPromises.rpsl = fetchJSON("https://rest.db.ripe.net/lookup/ripe/aut-num/AS" + rawAsn + ".json").then(function(data) {
        var objects = data && data.objects && data.objects.object ? data.objects.object : [];
        if (objects.length === 0) return { status: "warning", exists: false, has_policy: false };
        var attrs = objects[0] && objects[0].attributes && objects[0].attributes.attribute ? objects[0].attributes.attribute : [];
        var hasImport = attrs.some(function(a) { return a.name === "import" || a.name === "mp-import"; });
        var hasExport = attrs.some(function(a) { return a.name === "export" || a.name === "mp-export"; });
        var hasRemarks = attrs.some(function(a) { return a.name === "remarks"; });
        return { status: (hasImport || hasExport) ? "pass" : "warning", exists: true, has_import: hasImport, has_export: hasExport, has_remarks: hasRemarks, has_policy: hasImport || hasExport };
      }).catch(function(e) { return { status: "warning", exists: false, error: String(e) }; });

      // 22. IXP Route Server Participation
      if (netId) {
        validationPromises.ix_route_server = fetchPeeringDB("/netixlan?net_id=" + netId).then(function(ixData) {
          var connections = ixData && ixData.data ? ixData.data : [];
          var rsParticipants = connections.filter(function(c) { return c.is_rs_peer === true; });
          return { status: connections.length > 0 && rsParticipants.length > 0 ? "pass" : "warning", total_ix_connections: connections.length, rs_peer_count: rsParticipants.length, rs_peer_pct: connections.length > 0 ? Math.round((rsParticipants.length / connections.length) * 100) : 0 };
        }).catch(function(e) { return { status: "error", error: String(e) }; });
      } else {
        validationPromises.ix_route_server = Promise.resolve({ status: "warning", message: "No PeeringDB record found" });
      }

      // 23. Resource Certification
      validationPromises.resource_cert = Promise.all(
        samplePrefixes.slice(0, 3).map(function(pfx) { return fetchRPKIPerPrefix(rawAsn, pfx); })
      ).then(function(results) {
        var hasRoa = results.some(function(r) { return r.status === "valid" || r.validating_roas > 0; });
        return { status: hasRoa ? "pass" : "fail", has_roas: hasRoa, checked: results.length, roa_count: results.filter(function(r) { return r.status === "valid"; }).length };
      }).catch(function(e) { return { status: "error", error: String(e) }; });

      // Geolocation cross-ref with PeeringDB facilities
      var facCountriesPromise = netId
        ? fetchPeeringDB("/netfac?net_id=" + netId).then(function(facData) {
            return (facData && facData.data ? facData.data : []).map(function(f) { return f.country; }).filter(Boolean);
          }).catch(function() { return []; })
        : Promise.resolve([]);

      // Run all validations in parallel
      var keys = Object.keys(validationPromises);
      var promises = keys.map(function(k) { return validationPromises[k]; });
      var settled = await Promise.allSettled(promises);
      var facCountries = await facCountriesPromise;

      var validations = {};
      keys.forEach(function(key, i) {
        if (settled[i].status === "fulfilled") {
          validations[key] = settled[i].value;
        } else {
          validations[key] = { status: "error", error: settled[i].reason ? String(settled[i].reason) : "Unknown error" };
        }
      });

      // Enrich geolocation
      if (validations.geolocation && validations.geolocation.status !== "error") {
        var uniqueFacCountries = {};
        facCountries.forEach(function(c) { uniqueFacCountries[c] = true; });
        validations.geolocation.pdb_facility_countries = Object.keys(uniqueFacCountries);
        var geoSet = {};
        (validations.geolocation.geo_countries || []).forEach(function(c) { geoSet[c] = true; });
        var mismatches = Object.keys(geoSet).filter(function(c) { return !uniqueFacCountries[c] && Object.keys(uniqueFacCountries).length > 0; });
        validations.geolocation.country_mismatches = mismatches;
      }

      validations.bogon = bogonResult;

      // Calculate overall health score (0-100)
      var checks = [
        { key: "bogon", weight: 15 },
        { key: "irr", weight: 10 },
        { key: "rpki_completeness", weight: 15 },
        { key: "abuse_contact", weight: 5 },
        { key: "blocklist", weight: 15 },
        { key: "manrs", weight: 5 },
        { key: "rdns", weight: 5 },
        { key: "visibility", weight: 10 },
        { key: "rpsl", weight: 5 },
        { key: "ix_route_server", weight: 5 },
        { key: "resource_cert", weight: 10 },
      ];

      var totalWeight = 0;
      var earnedScore = 0;
      var checkResults = [];

      checks.forEach(function(c) {
        var v = validations[c.key];
        var points = 0;
        if (v && v.status === "pass") points = c.weight;
        else if (v && v.status === "warning") points = Math.round(c.weight * 0.5);
        totalWeight += c.weight;
        earnedScore += points;
        checkResults.push({ check: c.key, weight: c.weight, earned: points, status: v ? v.status : "error" });
      });

      var healthScore = totalWeight > 0 ? Math.round((earnedScore / totalWeight) * 100) : 0;
      var duration = Date.now() - start;

      return res.end(
        JSON.stringify(
          {
            meta: { query: "AS" + rawAsn, duration_ms: duration, timestamp: new Date().toISOString(), total_prefixes: allPrefixes.length, prefixes_sampled: samplePrefixes.length },
            asn: targetAsn,
            name: net.name || (overviewData && overviewData.data ? overviewData.data.holder : "") || "Unknown",
            health_score: healthScore,
            score_breakdown: checkResults,
            validations: validations,
          },
          null,
          2
        )
      );
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: "Validation failed", message: err.message }));
    }
  }

  // ============================================================
  // Main lookup endpoint: /api/lookup?asn=X
  // ============================================================
  if (reqPath === "/api/lookup") {
    const rawAsn = (url.searchParams.get("asn") || "").replace(/[^0-9]/g, "");
    if (!rawAsn) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing or invalid ASN parameter" }));
    }
    const asn = rawAsn;
    const cacheKey = "lookup:" + asn;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.writeHead(200, { "Content-Type": "application/json", "X-Cache": "HIT" });
      return res.end(JSON.stringify(cached));
    }
    const start = Date.now();

    try {
      // Phase 0: Get PDB net first (fast, <1s) to get net_id for IX/Fac queries
      const pdbNet = await fetchPeeringDB("/net?asn=" + asn);
      const net = pdbNet?.data?.[0] || {};
      const netId = net.id;

      // Phase 1: ALL calls in parallel — RIPE Stat + PDB IX/Fac + Atlas + bgp.he.net
      const promises = [
        fetchJSON("https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS" + asn, { timeout: 30000 }),
        fetchJSON("https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS" + asn, { timeout: 30000 }),
        fetchJSON("https://stat.ripe.net/data/as-overview/data.json?resource=AS" + asn),
        fetchJSON("https://stat.ripe.net/data/rir-stats-country/data.json?resource=AS" + asn),
        fetchJSON("https://atlas.ripe.net/api/v2/probes/?asn_v4=" + asn + "&page_size=500"),
        fetchBgpHeNet(asn),
        fetchJSON("https://stat.ripe.net/data/visibility/data.json?resource=AS" + asn, { timeout: 30000 }),
        fetchJSON("https://stat.ripe.net/data/prefix-size-distribution/data.json?resource=AS" + asn),
        netId ? fetchPeeringDB("/netixlan?net_id=" + netId) : Promise.resolve(null),
        netId ? fetchPeeringDB("/netfac?net_id=" + netId) : Promise.resolve(null),
      ];
      const [prefixData, neighbourData, overviewData, rirData, atlasProbeData, bgpHeData, visibilityData, prefixSizeData, ixlanData, facData] = await Promise.all(promises);

      const prefixes = prefixData?.data?.prefixes || [];
      const neighbours = neighbourData?.data?.neighbours || [];
      const overview = overviewData?.data || {};
      const rirEntries = rirData?.data?.located_resources || rirData?.data?.rir_stats || [];

      // Bug 6 fix: Atlas probe status uses status.name (object), not status_name (flat)
      const atlasProbes = atlasProbeData?.results || [];
      const atlasConnected = atlasProbes.filter(p => {
        const sName = (p.status_name || (p.status && p.status.name) || "").toLowerCase();
        return sName === "connected";
      });
      const atlasAnchors = atlasProbes.filter(p => p.is_anchor === true);

      // RPKI: sample max 5+5 prefixes (v4+v6) in parallel
      const allPrefixes = prefixes.map((p) => p.prefix);
      const v4Pfx = allPrefixes.filter(p => !p.includes(":")).slice(0, 5);
      const v6Pfx = allPrefixes.filter(p => p.includes(":")).slice(0, 5);
      const samplePfx = [...v4Pfx, ...v6Pfx];
      const rpkiAllResults = await Promise.all(samplePfx.map((pfx) => fetchRPKIPerPrefix(asn, pfx)));

      const ixConnections = (ixlanData?.data || [])
        .map((ix) => ({
          ix_name: ix.name || "",
          ix_id: ix.ix_id,
          speed_mbps: ix.speed || 0,
          ipv4: ix.ipaddr4 || null,
          ipv6: ix.ipaddr6 || null,
          city: ix.city || "",
        }))
        .sort((a, b) => b.speed_mbps - a.speed_mbps);

      const facilities = (facData?.data || []).map((f) => ({
        fac_id: f.fac_id,
        name: f.name || "",
        city: f.city || "",
        country: f.country || "",
      }));

      const rpkiStatuses = rpkiAllResults;
      const rpkiValid = rpkiStatuses.filter((r) => r.status === "valid").length;
      const rpkiInvalid = rpkiStatuses.filter((r) => r.status === "invalid").length;
      const rpkiNotFound = rpkiStatuses.filter((r) => r.status !== "valid" && r.status !== "invalid").length;
      const rpkiTotal = rpkiStatuses.length;
      const rpkiCoverage = rpkiTotal > 0 ? Math.round((rpkiValid / rpkiTotal) * 100) : 0;

      const upstreams = neighbours
        .filter((n) => n.type === "left")
        .map((n) => ({ asn: n.asn, name: n.as_name || "", power: n.power || 0 }))
        .sort((a, b) => b.power - a.power);
      const downstreams = neighbours
        .filter((n) => n.type === "right")
        .map((n) => ({ asn: n.asn, name: n.as_name || "", power: n.power || 0 }))
        .sort((a, b) => b.power - a.power);
      const peers = neighbours
        .filter((n) => n.type === "uncertain" || n.type === "peer")
        .map((n) => ({ asn: n.asn, name: n.as_name || "", power: n.power || 0 }))
        .sort((a, b) => b.power - a.power);

      // Resolve empty AS names — all in parallel, with 3s timeout
      const emptyNameNeighbours = [...upstreams, ...downstreams, ...peers].filter(n => !n.name);
      if (emptyNameNeighbours.length > 0) {
        const resolvePromise = Promise.all(
          emptyNameNeighbours.map(n =>
            fetchJSON("https://stat.ripe.net/data/as-overview/data.json?resource=AS" + n.asn, { timeout: 3000 })
              .then(r => { if (r?.data?.holder) n.name = r.data.holder; })
              .catch(() => {})
          )
        );
        await Promise.race([resolvePromise, new Promise(r => setTimeout(r, 3000))]);
      }

      let rir = "";
      let country = "";
      if (Array.isArray(rirEntries) && rirEntries.length > 0) {
        rir = rirEntries[0]?.rir || "";
        country = rirEntries[0]?.country || "";
      }
      if (!rir && rirData?.data) {
        const rirField = rirData.data.rirs || [];
        if (rirField.length > 0) rir = rirField[0]?.rir || "";
      }

      const duration = Date.now() - start;

      // Compute routing visibility and prefix size distribution
      const routingInfo = await (async function() {
        const ipv4Prefixes = prefixes.filter(function(p) { return !p.prefix.includes(":"); });
        const ipv6Prefixes = prefixes.filter(function(p) { return p.prefix.includes(":"); });
        var ipv4VisAvg = 0, ipv6VisAvg = 0, totalRisPeersV4 = 0, totalRisPeersV6 = 0;

        // Visibility API returns per-RIS-collector data
        // Each collector has ipv4_full_table_peer_count and ipv4_full_table_peers_not_seeing[]
        // Bug 3 fix: visibility API may timeout for large ASNs — handle gracefully
        var visibilities = (visibilityData && visibilityData.data && visibilityData.data.visibilities) || [];
        var v4Seeing = 0, v4Total = 0, v6Seeing = 0, v6Total = 0;
        var visTimedOut = !visibilityData || !visibilityData.data;
        visibilities.forEach(function(v) {
          if (!v || !v.probe) return;
          var v4PeerCount = v.ipv4_full_table_peer_count || 0;
          var v4NotSeeing = (v.ipv4_full_table_peers_not_seeing || []).length;
          var v6PeerCount = v.ipv6_full_table_peer_count || 0;
          var v6NotSeeing = (v.ipv6_full_table_peers_not_seeing || []).length;
          v4Total += v4PeerCount;
          v4Seeing += (v4PeerCount - v4NotSeeing);
          v6Total += v6PeerCount;
          v6Seeing += (v6PeerCount - v6NotSeeing);
        });
        if (v4Total > 0) ipv4VisAvg = Math.round((v4Seeing / v4Total) * 1000) / 10;
        if (v6Total > 0) ipv6VisAvg = Math.round((v6Seeing / v6Total) * 1000) / 10;
        // If visibility API timed out but we have prefixes, try bgproutes.io fallback
        if (visTimedOut && prefixes.length > 0) {
          var fallbackPrefix = prefixes.find(function(p) { return !p.prefix.includes(":"); });
          if (!fallbackPrefix) fallbackPrefix = prefixes[0];
          if (fallbackPrefix) {
            var bgprFallback = await fetchBgproutesVisibility(fallbackPrefix.prefix);
            if (bgprFallback && bgprFallback.vps_seeing > 0) {
              // Estimate visibility: % of VPs seeing the prefix (assume ~300 total RIS-equivalent VPs)
              var estimatedTotal = Math.max(bgprFallback.vps_seeing, 300);
              ipv4VisAvg = Math.round((bgprFallback.vps_seeing / estimatedTotal) * 1000) / 10;
              ipv6VisAvg = -1; // bgproutes fallback is per-prefix, not per-AF aggregate
              totalRisPeersV4 = bgprFallback.vps_seeing;
              console.log("[Visibility] RIPE Stat timed out, used bgproutes.io fallback for " + fallbackPrefix.prefix + ": " + bgprFallback.vps_seeing + " VPs seeing it");
            } else {
              ipv4VisAvg = -1;
              ipv6VisAvg = -1;
              console.log("[Visibility] RIPE Stat timed out and bgproutes.io fallback returned no data");
            }
          } else {
            ipv4VisAvg = -1;
            ipv6VisAvg = -1;
          }
        }
        totalRisPeersV4 = v4Total;
        totalRisPeersV6 = v6Total;

        // Prefix size distribution: data.ipv4[] and data.ipv6[] arrays with {size, count}
        var psdData = (prefixSizeData && prefixSizeData.data) || {};
        var psV4 = (psdData.ipv4 || []).map(function(e) { return { size: e.size, count: e.count }; }).sort(function(a,b){ return a.size - b.size; });
        var psV6 = (psdData.ipv6 || []).map(function(e) { return { size: e.size, count: e.count }; }).sort(function(a,b){ return a.size - b.size; });

        return {
          ipv4_prefixes: ipv4Prefixes.length,
          ipv6_prefixes: ipv6Prefixes.length,
          ipv4_visibility_avg: ipv4VisAvg,
          ipv6_visibility_avg: ipv6VisAvg,
          total_ris_peers_v4: totalRisPeersV4,
          total_ris_peers_v6: totalRisPeersV6,
          prefix_sizes_v4: psV4,
          prefix_sizes_v6: psV6,
        };
      })();

      const result = {
        meta: {
          service: "PeerCortex",
          version: "0.5.0",
          query: "AS" + asn,
          duration_ms: duration,
          sources: ["PeeringDB", "RIPE Stat", "bgp.he.net", "Cloudflare RPKI", "Route Views"],
          timestamp: new Date().toISOString(),
          rpki_prefixes_checked: rpkiTotal,
          total_prefixes: prefixes.length,
        },
        network: {
          asn: parseInt(asn),
          name: net.name || overview?.holder || "Unknown",
          aka: net.aka || "",
          org_name: (net.org && net.org.name) ? net.org.name : "",
          website: net.website || "",
          type: net.info_type || "",
          policy: net.policy_general || "",
          traffic: net.info_traffic || "",
          ratio: net.info_ratio || "",
          scope: net.info_scope || "",
          notes: net.notes ? net.notes.substring(0, 500) : "",
          peeringdb_id: netId || null,
          rir: rir,
          country: country,
          looking_glass: net.looking_glass || "",
          route_server: net.route_server || "",
        },
        prefixes: {
          total: prefixes.length,
          ipv4: prefixes.filter((p) => !p.prefix.includes(":")).length,
          ipv6: prefixes.filter((p) => p.prefix.includes(":")).length,
          list: prefixes.map((p) => p.prefix),
        },
        rpki: {
          coverage_percent: rpkiCoverage,
          valid: rpkiValid,
          invalid: rpkiInvalid,
          not_found: rpkiNotFound,
          checked: rpkiTotal,
          details: rpkiStatuses,
        },
        neighbours: {
          total: neighbours.length,
          upstream_count: upstreams.length,
          downstream_count: downstreams.length,
          peer_count: peers.length,
          upstreams: upstreams.slice(0, 20),
          downstreams: downstreams.slice(0, 20),
          peers: peers.slice(0, 20),
        },
        ix_presence: {
          total_connections: ixConnections.length,
          unique_ixps: [...new Set(ixConnections.map((ix) => ix.ix_id))].length,
          connections: ixConnections,
        },
        facilities: {
          total: facilities.length,
          list: facilities,
        },
        routing: routingInfo,
        bgp_he_net: bgpHeData || null,
        atlas: {
          total_probes: atlasProbes.length,
          connected: atlasConnected.length,
          disconnected: atlasProbes.length - atlasConnected.length,
          anchors: atlasAnchors.length,
          probes: atlasProbes.slice(0, 100).map(p => ({
            id: p.id,
            status: p.status_name || p.status || "Unknown",
            is_anchor: p.is_anchor || false,
            country: p.country_code || "",
            prefix_v4: p.prefix_v4 || "",
            prefix_v6: p.prefix_v6 || "",
            description: p.description || "",
          })),
        },
      };

      cacheSet(cacheKey, result, CACHE_TTL_LOOKUP);
      res.end(JSON.stringify(result, null, 2));
    } catch (err) {
      const duration = Date.now() - start;
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Lookup failed", message: err.message, duration_ms: duration }));
    }
    return;
  }

  // ============================================================
  // Compare endpoint: /api/compare?asn1=X&asn2=Y
  // ============================================================
  if (reqPath === "/api/compare") {
    const asn1 = (url.searchParams.get("asn1") || "").replace(/[^0-9]/g, "");
    const asn2 = (url.searchParams.get("asn2") || "").replace(/[^0-9]/g, "");
    if (!asn1 || !asn2) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Need asn1 and asn2 parameters" }));
    }

    const compareCacheKey = "compare:" + asn1 + ":" + asn2;
    const compareCached = cacheGet(compareCacheKey);
    if (compareCached) {
      res.writeHead(200, { "Content-Type": "application/json", "X-Cache": "HIT" });
      return res.end(JSON.stringify(compareCached));
    }
    const start = Date.now();
    try {
      // ALL calls in parallel — single batch
      // Phase 1: Get PDB net objects + RIPE data
      const [pdb1, pdb2, nb1Data, nb2Data, pfx1Data, pfx2Data] = await Promise.all([
        fetchPeeringDB("/net?asn=" + asn1),
        fetchPeeringDB("/net?asn=" + asn2),
        fetchJSON("https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS" + asn1, { timeout: 30000 }),
        fetchJSON("https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS" + asn2, { timeout: 30000 }),
        fetchJSON("https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS" + asn1, { timeout: 30000 }),
        fetchJSON("https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS" + asn2, { timeout: 30000 }),
      ]);

      const net1 = pdb1?.data?.[0] || {};
      const net2 = pdb2?.data?.[0] || {};
      const netId1 = net1.id;
      const netId2 = net2.id;

      // Phase 2: IX + Facility using net_id (Bug 1 fix: netfac requires net_id, not asn)
      const ixFacPromises = [];
      ixFacPromises.push(netId1 ? fetchPeeringDB("/netixlan?net_id=" + netId1) : Promise.resolve(null));
      ixFacPromises.push(netId2 ? fetchPeeringDB("/netixlan?net_id=" + netId2) : Promise.resolve(null));
      ixFacPromises.push(netId1 ? fetchPeeringDB("/netfac?net_id=" + netId1) : Promise.resolve(null));
      ixFacPromises.push(netId2 ? fetchPeeringDB("/netfac?net_id=" + netId2) : Promise.resolve(null));
      const [ix1Data, ix2Data, fac1Data, fac2Data] = await Promise.all(ixFacPromises);

      const ix1Set = new Set((ix1Data?.data || []).map((ix) => ix.ix_id));
      const ix2Set = new Set((ix2Data?.data || []).map((ix) => ix.ix_id));
      const ix1Names = {};
      (ix1Data?.data || []).forEach((ix) => (ix1Names[ix.ix_id] = ix.name));
      const ix2Names = {};
      (ix2Data?.data || []).forEach((ix) => (ix2Names[ix.ix_id] = ix.name));

      const commonIX = [...ix1Set].filter((id) => ix2Set.has(id)).map((id) => ({ ix_id: id, name: ix1Names[id] || ix2Names[id] || "" }));
      const only1IX = [...ix1Set].filter((id) => !ix2Set.has(id)).map((id) => ({ ix_id: id, name: ix1Names[id] || "" }));
      const only2IX = [...ix2Set].filter((id) => !ix1Set.has(id)).map((id) => ({ ix_id: id, name: ix2Names[id] || "" }));

      const fac1Set = new Set((fac1Data?.data || []).map((f) => f.fac_id));
      const fac2Set = new Set((fac2Data?.data || []).map((f) => f.fac_id));
      const fac1Names = {};
      (fac1Data?.data || []).forEach((f) => (fac1Names[f.fac_id] = f.name));
      const fac2Names = {};
      (fac2Data?.data || []).forEach((f) => (fac2Names[f.fac_id] = f.name));

      const commonFac = [...fac1Set].filter((id) => fac2Set.has(id)).map((id) => ({ fac_id: id, name: fac1Names[id] || fac2Names[id] || "" }));

      const nb1 = (nb1Data?.data?.neighbours || []).filter((n) => n.type === "left");
      const nb2 = (nb2Data?.data?.neighbours || []).filter((n) => n.type === "left");
      const up1Set = new Set(nb1.map((n) => n.asn));
      const up2Set = new Set(nb2.map((n) => n.asn));
      const nb1Map = {};
      nb1.forEach((n) => (nb1Map[n.asn] = n.as_name || ""));
      const nb2Map = {};
      nb2.forEach((n) => (nb2Map[n.asn] = n.as_name || ""));

      const commonUpstreams = [...up1Set]
        .filter((a) => up2Set.has(a))
        .map((a) => ({ asn: a, name: nb1Map[a] || nb2Map[a] || "" }));

      // Resolve names + RPKI sample (max 3+3 prefixes) all in parallel with 5s timeout
      const pfx1 = (pfx1Data?.data?.prefixes || []).slice(0, 3).map((p) => p.prefix);
      const pfx2 = (pfx2Data?.data?.prefixes || []).slice(0, 3).map((p) => p.prefix);
      const [, rpki1Results, rpki2Results] = await Promise.race([
        Promise.all([
          commonUpstreams.length > 0 ? Promise.all(commonUpstreams.map(n =>
            fetchJSON("https://stat.ripe.net/data/as-overview/data.json?resource=AS" + n.asn, { timeout: 3000 })
              .then(r => { if (r?.data?.holder) n.name = r.data.holder; })
              .catch(() => {})
          )) : Promise.resolve([]),
          Promise.all(pfx1.map((p) => fetchRPKIPerPrefix(asn1, p))),
          Promise.all(pfx2.map((p) => fetchRPKIPerPrefix(asn2, p))),
        ]),
        new Promise(r => setTimeout(() => r([[], [], []]), 5000)),
      ]);

      const rpki1Valid = rpki1Results.filter((r) => r.status === "valid").length;
      const rpki2Valid = rpki2Results.filter((r) => r.status === "valid").length;
      const rpki1Pct = rpki1Results.length > 0 ? Math.round((rpki1Valid / rpki1Results.length) * 100) : 0;
      const rpki2Pct = rpki2Results.length > 0 ? Math.round((rpki2Valid / rpki2Results.length) * 100) : 0;

      const duration = Date.now() - start;
      const compareResult = {
            meta: { duration_ms: duration, timestamp: new Date().toISOString() },
            asn1: {
              asn: parseInt(asn1),
              name: net1.name || "Unknown",
              ix_count: ix1Set.size,
              fac_count: fac1Set.size,
              upstream_count: up1Set.size,
              rpki_coverage: rpki1Pct,
            },
            asn2: {
              asn: parseInt(asn2),
              name: net2.name || "Unknown",
              ix_count: ix2Set.size,
              fac_count: fac2Set.size,
              upstream_count: up2Set.size,
              rpki_coverage: rpki2Pct,
            },
            common_ixps: commonIX,
            only_asn1_ixps: only1IX,
            only_asn2_ixps: only2IX,
            common_facilities: commonFac,
            common_upstreams: commonUpstreams,
            rpki_comparison: {
              asn1_coverage: rpki1Pct,
              asn2_coverage: rpki2Pct,
              asn1_checked: rpki1Results.length,
              asn2_checked: rpki2Results.length,
              better: rpki1Pct > rpki2Pct ? "AS" + asn1 : rpki2Pct > rpki1Pct ? "AS" + asn2 : "equal",
            },
          };
      cacheSet(compareCacheKey, compareResult, CACHE_TTL_DEFAULT);
      res.end(JSON.stringify(compareResult, null, 2));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Compare failed", message: err.message }));
    }
    return;
  }


  // ============================================================
  // Peer Matching endpoint: /api/peers/find?ix=NAME&policy=open&min_speed=10000
  // ============================================================
  if (reqPath === "/api/peers/find") {
    const ixName = url.searchParams.get("ix") || "";
    const policy = url.searchParams.get("policy") || "";
    const minSpeed = parseInt(url.searchParams.get("min_speed") || "0");
    const netType = url.searchParams.get("type") || "";

    if (!ixName) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing ix parameter (IX name)" }));
    }

    const start = Date.now();
    try {
      // Search for IX by name
      const ixSearch = await fetchPeeringDB("/ix?name__contains=" + encodeURIComponent(ixName));
      const ixResults = ixSearch?.data || [];
      if (ixResults.length === 0) {
        return res.end(JSON.stringify({ error: "No IX found matching: " + ixName, matches: [] }));
      }

      // Use first matching IX
      const ix = ixResults[0];
      const ixId = ix.id;

      // Get ixlan for this IX
      const ixlanData = await fetchPeeringDB("/ixlan?ix_id=" + ixId);
      const ixlans = ixlanData?.data || [];
      if (ixlans.length === 0) {
        return res.end(JSON.stringify({ ix: { id: ixId, name: ix.name }, matches: [] }));
      }

      const ixlanId = ixlans[0].id;

      // Get all networks at this IX
      const netixlanData = await fetchPeeringDB("/netixlan?ixlan_id=" + ixlanId);
      const netixlans = netixlanData?.data || [];

      // Get unique net_ids
      const netIds = [...new Set(netixlans.map(n => n.net_id))];

      // Fetch network details in batches
      const networks = [];
      const batchSize = 20;
      for (let i = 0; i < Math.min(netIds.length, 200); i += batchSize) {
        const batch = netIds.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(nid => fetchPeeringDB("/net/" + nid))
        );
        batchResults.forEach(r => {
          if (r?.data?.[0]) networks.push(r.data[0]);
        });
      }

      // Filter and rank
      let filtered = networks.map(net => {
        const nix = netixlans.filter(n => n.net_id === net.id);
        const maxSpeed = Math.max(...nix.map(n => n.speed || 0));
        return {
          asn: net.asn,
          name: net.name || "",
          policy: net.policy_general || "",
          type: net.info_type || "",
          speed_mbps: maxSpeed,
          speed_gbps: maxSpeed >= 1000 ? (maxSpeed / 1000) + " Gbps" : maxSpeed + " Mbps",
          traffic: net.info_traffic || "",
          website: net.website || "",
          peeringdb_id: net.id,
          ipv4: nix[0]?.ipaddr4 || null,
          ipv6: nix[0]?.ipaddr6 || null,
        };
      });

      // Apply filters
      if (policy) {
        filtered = filtered.filter(n => n.policy.toLowerCase().includes(policy.toLowerCase()));
      }
      if (minSpeed > 0) {
        filtered = filtered.filter(n => n.speed_mbps >= minSpeed);
      }
      if (netType) {
        filtered = filtered.filter(n => n.type.toLowerCase().includes(netType.toLowerCase()));
      }

      // Sort by speed desc
      filtered.sort((a, b) => b.speed_mbps - a.speed_mbps);

      // Also find common IXPs for each match (check if they share other IXPs)
      const duration = Date.now() - start;
      return res.end(JSON.stringify({
        meta: { duration_ms: duration, timestamp: new Date().toISOString() },
        ix: { id: ixId, name: ix.name, ixlan_id: ixlanId },
        total_members: netixlans.length,
        filtered_count: filtered.length,
        matches: filtered.slice(0, 50),
      }, null, 2));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: "Peer matching failed", message: err.message }));
    }
  }

  // ============================================================
  // Prefix Detail endpoint: /api/prefix/detail?prefix=X
  // ============================================================
  if (reqPath === "/api/prefix/detail") {
    const prefix = url.searchParams.get("prefix") || "";
    if (!prefix) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing prefix parameter" }));
    }
    const start = Date.now();
    try {
      const [routingStatus, rpkiValid, visibility] = await Promise.all([
        fetchJSON("https://stat.ripe.net/data/routing-status/data.json?resource=" + encodeURIComponent(prefix)),
        fetchJSON("https://stat.ripe.net/data/rpki-validation/data.json?resource=" + encodeURIComponent(prefix)),
        fetchJSON("https://stat.ripe.net/data/visibility/data.json?resource=" + encodeURIComponent(prefix)),
      ]);

      const origins = routingStatus?.data?.origins || [];
      const firstSeen = routingStatus?.data?.first_seen?.time || null;
      const rpkiStatus = rpkiValid?.data?.status || "unknown";
      const rpkiRoas = rpkiValid?.data?.validating_roas || [];
      var visData = visibility?.data?.visibilities || [];
      var risPeersSeeingIt = visData.length > 0 ? visData.filter(v => v.ris_peers_seeing > 0).length : 0;
      var visibilitySource = "ripe_stat";
      // bgproutes.io fallback if RIPE Stat visibility returned no data
      if (visData.length === 0 && BGPROUTES_API_KEY) {
        var bgprVis = await fetchBgproutesVisibility(prefix);
        if (bgprVis && bgprVis.vps_seeing > 0) {
          risPeersSeeingIt = bgprVis.vps_seeing;
          visData = []; // keep empty, use risPeersSeeingIt
          visibilitySource = "bgproutes.io";
        }
      }

      // Try to get IRR data
      let irrStatus = "unknown";
      try {
        const whoisData = await fetchJSON("https://stat.ripe.net/data/whois/data.json?resource=" + encodeURIComponent(prefix));
        const records = whoisData?.data?.records || [];
        if (records.length > 0) irrStatus = "found";
      } catch(_e) {}

      const duration = Date.now() - start;
      return res.end(JSON.stringify({
        meta: { duration_ms: duration, timestamp: new Date().toISOString() },
        prefix: prefix,
        origins: origins.map(o => ({ asn: o.asn, prefix: o.prefix })),
        rpki: { status: rpkiStatus, validating_roas: rpkiRoas.length },
        irr_status: irrStatus,
        visibility: { ris_peers_seeing: risPeersSeeingIt, total_probes: visData.length || risPeersSeeingIt, source: visibilitySource },
        first_seen: firstSeen,
      }, null, 2));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: "Prefix detail failed", message: err.message }));
    }
  }

  // ============================================================
  // IX Detail endpoint: /api/ix/detail?ix_id=X
  // ============================================================
  if (reqPath === "/api/ix/detail") {
    const ixId = (url.searchParams.get("ix_id") || "").replace(/[^0-9]/g, "");
    if (!ixId) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing ix_id parameter" }));
    }
    const start = Date.now();
    try {
      const [ixData, ixlanData] = await Promise.all([
        fetchPeeringDB("/ix/" + ixId),
        fetchPeeringDB("/ixlan?ix_id=" + ixId),
      ]);

      const ix = ixData?.data?.[0] || {};
      const ixlans = ixlanData?.data || [];
      const ixlanId = ixlans.length > 0 ? ixlans[0].id : null;

      let members = [];
      if (ixlanId) {
        const netixlanData = await fetchPeeringDB("/netixlan?ixlan_id=" + ixlanId);
        members = (netixlanData?.data || []).map(m => ({
          asn: m.asn,
          name: m.name || "",
          speed_mbps: m.speed || 0,
          speed_display: (m.speed || 0) >= 1000 ? ((m.speed || 0) / 1000) + " Gbps" : (m.speed || 0) + " Mbps",
          ipv4: m.ipaddr4 || null,
          ipv6: m.ipaddr6 || null,
        }));
      }

      // Sort by speed desc for top members
      const sorted = members.slice().sort((a, b) => b.speed_mbps - a.speed_mbps);

      const duration = Date.now() - start;
      return res.end(JSON.stringify({
        meta: { duration_ms: duration, timestamp: new Date().toISOString() },
        ix: {
          id: parseInt(ixId),
          name: ix.name || "",
          city: ix.city || "",
          country: ix.country || "",
          website: ix.website || "",
          peeringdb_url: "https://www.peeringdb.com/ix/" + ixId,
        },
        total_members: members.length,
        top_members_by_speed: sorted.slice(0, 20),
        all_members: sorted,
      }, null, 2));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: "IX detail failed", message: err.message }));
    }
  }


  // ============================================================
  // Feature 25: Topology endpoint
  // ============================================================
  if (reqPath === "/api/topology") {
    const rawAsn = (url.searchParams.get("asn") || "").replace(/[^0-9]/g, "");
    const depth = parseInt(url.searchParams.get("depth") || "2") || 2;
    if (!rawAsn) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing or invalid ASN parameter" }));
    }
    const start = Date.now();
    try {
      const topology = await fetchTopology(parseInt(rawAsn), depth);
      topology.meta = {
        query: "AS" + rawAsn, depth: depth, duration_ms: Date.now() - start,
        timestamp: new Date().toISOString(), node_count: topology.nodes.length, edge_count: topology.edges.length,
      };
      return res.end(JSON.stringify(topology, null, 2));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: "Topology query failed", message: err.message }));
    }
  }

  // ============================================================
  // Feature 27: WHOIS endpoint
  // ============================================================
  if (reqPath === "/api/whois") {
    const resource = url.searchParams.get("resource") || "";
    if (!resource) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing resource parameter (ASN, prefix, or domain)" }));
    }
    const start = Date.now();
    try {
      const whoisResult = await fetchWhois(resource);
      whoisResult.meta = { duration_ms: Date.now() - start, timestamp: new Date().toISOString() };
      return res.end(JSON.stringify(whoisResult, null, 2));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: "WHOIS lookup failed", message: err.message }));
    }
  }

  // 404
  res.writeHead(404);
  res.end(
    JSON.stringify({
      error: "Not found. Endpoints: /api/health, /api/validate?asn=X, /api/lookup?asn=X, /api/aspa?asn=X, /api/aspa/verify?asn=X, /api/bgproutes?asn=X, /api/compare?asn1=X&asn2=Y, /api/peers/find?ix=NAME, /api/prefix/detail?prefix=X, /api/ix/detail?ix_id=X",
    })
  );
});


// ============================================================
// Atlas Probe Cache (for Lia's Atlas Paradise)
// ============================================================
let atlasProbeCache = null;
let atlasProbeFetching = false;

function fetchAllAtlasProbes() {
  if (atlasProbeFetching) return Promise.resolve();
  atlasProbeFetching = true;
  console.log("[ATLAS] Fetching all Atlas probes...");

  return new Promise(function(resolve) {
    var allAsns = new Set();
    var byCountry = {};
    var pageCount = 0;
    var maxPages = 40;

    function fetchPage(pageUrl) {
      if (pageCount >= maxPages) return finish();
      pageCount++;

      fetchJSON(pageUrl).then(function(data) {
        if (!data || !data.results) return finish();

        data.results.forEach(function(probe) {
          var asn4 = probe.asn_v4;
          var asn6 = probe.asn_v6;
          var cc = probe.country_code || "XX";

          if (!byCountry[cc]) byCountry[cc] = { total: 0, connected: 0, asnSet: new Set() };
          byCountry[cc].total++;
          if (probe.status && probe.status.id === 1) byCountry[cc].connected++;
          if (asn4) { allAsns.add(asn4); byCountry[cc].asnSet.add(asn4); }
          if (asn6) { allAsns.add(asn6); byCountry[cc].asnSet.add(asn6); }
        });

        if (data.next) {
          fetchPage(data.next);
        } else {
          finish();
        }
      }).catch(function() { finish(); });
    }

    function finish() {
      var byCountryOut = {};
      Object.keys(byCountry).forEach(function(cc) {
        var info = byCountry[cc];
        byCountryOut[cc] = { total: info.total, connected: info.connected, asn_count: info.asnSet.size };
      });

      atlasProbeCache = {
        total_probes: Object.keys(byCountry).reduce(function(s, cc) { return s + byCountry[cc].total; }, 0),
        total_connected: Object.keys(byCountry).reduce(function(s, cc) { return s + byCountry[cc].connected; }, 0),
        unique_asns_with_probes: allAsns.size,
        asns_with_probes: Array.from(allAsns).sort(function(a, b) { return a - b; }),
        by_country: byCountryOut,
        fetched_at: new Date().toISOString(),
        pages_fetched: pageCount,
      };

      console.log("[ATLAS] Loaded " + allAsns.size + " unique ASNs with probes (" + pageCount + " pages)");
      atlasProbeFetching = false;
      resolve();
    }

    fetchPage("https://atlas.ripe.net/api/v2/probes/?page_size=500&status=1&page=1&format=json");
  });
}

const PORT = process.env.PORT || 3101;

// Fetch RPKI ASPA feed at startup and refresh every 10 minutes
Promise.all([fetchRpkiAspaFeed(), fetchAllAtlasProbes()]).then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log("PeerCortex v0.4.0 running on http://0.0.0.0:" + PORT);
    console.log("bgproutes.io API key: " + (BGPROUTES_API_KEY ? "configured" : "NOT configured"));
    console.log("RPKI ASPA objects loaded: " + rpkiAspaMap.size);
  });
});

// Refresh RPKI ASPA cache every 10 minutes
setInterval(() => {
  fetchRpkiAspaFeed();
}, 10 * 60 * 1000);

// Refresh Atlas probe cache every hour
setInterval(function() {
  fetchAllAtlasProbes();
}, 60 * 60 * 1000);
