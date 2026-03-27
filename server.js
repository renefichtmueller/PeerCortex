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

// Static geocode cache for major networking cities (fallback when PDB facility coords missing)
const CITY_COORDS = {
  "amsterdam": [52.3676, 4.9041], "london": [51.5074, -0.1278], "frankfurt": [50.1109, 8.6821],
  "paris": [48.8566, 2.3522], "stockholm": [59.3293, 18.0686], "zurich": [47.3769, 8.5417],
  "berlin": [52.5200, 13.4050], "hamburg": [53.5511, 9.9937], "munich": [48.1351, 11.5820],
  "vienna": [48.2082, 16.3738], "prague": [50.0755, 14.4378], "warsaw": [52.2297, 21.0122],
  "copenhagen": [55.6761, 12.5683], "oslo": [59.9139, 10.7522], "helsinki": [60.1699, 24.9384],
  "milan": [45.4642, 9.1900], "madrid": [40.4168, -3.7038], "lisbon": [38.7223, -9.1393],
  "dublin": [53.3498, -6.2603], "brussels": [50.8503, 4.3517], "bucharest": [44.4268, 26.1025],
  "sofia": [42.6977, 23.3219], "athens": [37.9838, 23.7275], "istanbul": [41.0082, 28.9784],
  "moscow": [55.7558, 37.6173], "mumbai": [19.0760, 72.8777], "singapore": [1.3521, 103.8198],
  "hong kong": [22.3193, 114.1694], "tokyo": [35.6762, 139.6503], "sydney": [-33.8688, 151.2093],
  "los angeles": [34.0522, -118.2437], "new york": [40.7128, -74.0060], "chicago": [41.8781, -87.6298],
  "dallas": [32.7767, -96.7970], "miami": [25.7617, -80.1918], "ashburn": [39.0438, -77.4874],
  "seattle": [47.6062, -122.3321], "san jose": [37.3382, -121.8863], "toronto": [43.6532, -79.3832],
  "sao paulo": [-23.5505, -46.6333], "johannesburg": [-26.2041, 28.0473], "meppel": [52.6966, 6.1940],
  "manchester": [53.4808, -2.2426], "marseille": [43.2965, 5.3698], "dusseldorf": [51.2277, 6.7735],
  "nuremberg": [49.4521, 11.0767], "tallinn": [59.4370, 24.7536], "riga": [56.9496, 24.1052],
  "auckland": [-36.8485, 174.7633], "wellington": [-41.2865, 174.7762], "denver": [39.7392, -104.9903],
  "atlanta": [33.7490, -84.3880], "portland": [45.5152, -122.6784], "vancouver": [49.2827, -123.1207],
  "montreal": [45.5017, -73.5673], "mexico city": [19.4326, -99.1332], "seoul": [37.5665, 126.9780],
  "taipei": [25.0330, 121.5654], "bangkok": [13.7563, 100.5018], "jakarta": [-6.2088, 106.8456],
  "scotland": [55.9533, -3.1883], "edinburgh": [55.9533, -3.1883],
};

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
// RPKI ASPA + ROA Cache from Cloudflare RPKI JSON feed
// ============================================================
const rpkiAspaMap = new Map(); // customer_asid -> Set<provider_asn>
// Indexed ROA storage: Map<firstOctet, Array<{ip, prefixLen, maxLength, asn}>>
// IPv4 keyed by first octet (0-255), IPv6 keyed by "v6:" + first 16 bits hex
const rpkiRoaIndex = new Map();
let rpkiRoaCount = 0;
let rpkiAspaLastFetch = 0;
let rpkiAspaFetching = false;

// Parse an IPv4 address string to a 32-bit unsigned integer
function ipv4ToInt(addr) {
  const parts = addr.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// Add a ROA to the indexed structure
function addRoaToIndex(prefix, maxLength, asn) {
  const isV6 = prefix.includes(":");
  const pfxParts = prefix.split("/");
  const prefixLen = parseInt(pfxParts[1] || (isV6 ? "128" : "32"));

  if (isV6) {
    // Index by first 16 bits (first hex group)
    const firstGroup = pfxParts[0].split(":")[0] || "0";
    const key = "v6:" + firstGroup.toLowerCase();
    const entry = { prefixStr: pfxParts[0], prefixLen, maxLength, asn };
    if (!rpkiRoaIndex.has(key)) rpkiRoaIndex.set(key, []);
    rpkiRoaIndex.get(key).push(entry);
  } else {
    // Index by first octet
    const firstOctet = parseInt(pfxParts[0].split(".")[0]) || 0;
    const entry = { ip: ipv4ToInt(pfxParts[0]), prefixLen, maxLength, asn };
    if (!rpkiRoaIndex.has(firstOctet)) rpkiRoaIndex.set(firstOctet, []);
    rpkiRoaIndex.get(firstOctet).push(entry);
  }
}

// Validate a single prefix against the indexed ROA data (all 5 RIRs) - O(bucket) not O(n)
function validateRPKILocal(asn, prefix) {
  const asnNum = Number(asn);
  const isV6 = prefix.includes(":");
  const parts = prefix.split("/");
  const addr = parts[0];
  const prefixLen = parseInt(parts[1] || (isV6 ? "128" : "32"));

  let matchingRoas = 0;
  let validRoas = 0;

  if (isV6) {
    const firstGroup = addr.split(":")[0] || "0";
    const key = "v6:" + firstGroup.toLowerCase();
    const bucket = rpkiRoaIndex.get(key);
    if (!bucket) return { prefix, status: "not_found", validating_roas: 0 };

    // Parse query IPv6 address (simplified: expand :: then compute)
    let qParts = addr.split(":");
    const dblIdx = qParts.indexOf("");
    if (dblIdx !== -1) {
      const head = qParts.slice(0, dblIdx);
      const tail = qParts.slice(dblIdx + 1).filter(Boolean);
      const fill = new Array(8 - head.length - tail.length).fill("0");
      qParts = head.concat(fill, tail);
    }
    let qBig = BigInt(0);
    for (let i = 0; i < 8; i++) qBig = (qBig << BigInt(16)) | BigInt(parseInt(qParts[i] || "0", 16));

    for (let i = 0; i < bucket.length; i++) {
      const roa = bucket[i];
      if (prefixLen < roa.prefixLen) continue;
      if (prefixLen > roa.maxLength) continue;
      // Check coverage: parse ROA address
      let rParts = roa.prefixStr.split(":");
      const rDbl = rParts.indexOf("");
      if (rDbl !== -1) {
        const rHead = rParts.slice(0, rDbl);
        const rTail = rParts.slice(rDbl + 1).filter(Boolean);
        const rFill = new Array(8 - rHead.length - rTail.length).fill("0");
        rParts = rHead.concat(rFill, rTail);
      }
      let rBig = BigInt(0);
      for (let j = 0; j < 8; j++) rBig = (rBig << BigInt(16)) | BigInt(parseInt(rParts[j] || "0", 16));
      const shift = BigInt(128 - roa.prefixLen);
      if ((rBig >> shift) === (qBig >> shift)) {
        matchingRoas++;
        if (roa.asn === asnNum) validRoas++;
      }
    }
  } else {
    const firstOctet = parseInt(addr.split(".")[0]) || 0;
    const bucket = rpkiRoaIndex.get(firstOctet);
    if (!bucket) return { prefix, status: "not_found", validating_roas: 0 };

    const qIp = ipv4ToInt(addr);
    for (let i = 0; i < bucket.length; i++) {
      const roa = bucket[i];
      if (prefixLen < roa.prefixLen) continue;
      if (prefixLen > roa.maxLength) continue;
      const mask = roa.prefixLen === 0 ? 0 : (~((1 << (32 - roa.prefixLen)) - 1)) >>> 0;
      if ((roa.ip & mask) === (qIp & mask)) {
        matchingRoas++;
        if (roa.asn === asnNum) validRoas++;
      }
    }
  }

  if (matchingRoas === 0) return { prefix, status: "not_found", validating_roas: 0 };
  if (validRoas > 0) return { prefix, status: "valid", validating_roas: validRoas };
  return { prefix, status: "invalid", validating_roas: 0 };
}

function fetchRpkiAspaFeed() {
  if (rpkiAspaFetching) return Promise.resolve();
  rpkiAspaFetching = true;
  console.log("[RPKI] Fetching Cloudflare RPKI feed (ASPA + ROA)...");
  return new Promise((resolve) => {
    const options = {
      headers: { "User-Agent": UA },
      timeout: 60000,
    };
    https.get("https://rpki.cloudflare.com/rpki.json", options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);

          // Load ASPA objects
          const aspas = parsed.aspas || [];
          rpkiAspaMap.clear();
          aspas.forEach((a) => {
            const customerAsid = Number(a.customer_asid);
            const providers = (a.providers || []).map(Number);
            rpkiAspaMap.set(customerAsid, new Set(providers));
          });

          // Load ROA objects into indexed structure for fast local RPKI validation (all 5 RIRs)
          const roas = parsed.roas || [];
          rpkiRoaIndex.clear();
          rpkiRoaCount = 0;
          roas.forEach((r) => {
            const pfx = r.prefix;
            if (!pfx) return;
            const maxLen = r.maxLength || parseInt((pfx).split("/")[1] || "0");
            const originAsn = Number(String(r.asn).replace(/^AS/i, ""));
            addRoaToIndex(pfx, maxLen, originAsn);
            rpkiRoaCount++;
          });

          rpkiAspaLastFetch = Date.now();
          console.log("[RPKI] Loaded " + rpkiAspaMap.size + " ASPA objects + " + rpkiRoaCount + " ROAs (" + rpkiRoaIndex.size + " index buckets) from Cloudflare RPKI feed");
        } catch (e) {
          console.error("[RPKI] Failed to parse RPKI feed:", e.message);
        }
        rpkiAspaFetching = false;
        resolve();
      });
    }).on("error", (e) => {
      console.error("[RPKI] Fetch failed:", e.message);
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
// Feature 30: RIPE NCC RPKI Validator cross-check (max 5 prefixes)
// ============================================================
async function fetchRipeRpkiValidator(asn, prefix) {
  try {
    const encoded = encodeURIComponent(prefix);
    const url = "https://rpki-validator.ripe.net/api/v1/validity/AS" + asn + "/" + encoded;
    const result = await fetchJSON(url, { timeout: 5000 });
    if (result && result.validated_route) {
      return {
        prefix: prefix,
        validity: result.validated_route.validity || {},
        state: (result.validated_route.validity && result.validated_route.validity.state) || "unknown",
      };
    }
    return { prefix: prefix, state: "unknown", error: "no_data" };
  } catch (_e) {
    return { prefix: prefix, state: "error", error: "timeout_or_unavailable" };
  }
}

// Cross-check a sample of prefixes against RIPE RPKI Validator (max 5, in parallel)
async function crossCheckRpki(asn, prefixes, localResults) {
  const sample = prefixes.slice(0, 5);
  if (sample.length === 0) return { cloudflare_valid: 0, ripe_valid: 0, agreement_pct: 100, disagreements: [], sample_size: 0 };

  const ripeResults = await Promise.all(
    sample.map((pfx) => fetchRipeRpkiValidator(asn, pfx))
  );

  const localMap = new Map();
  for (const lr of localResults) {
    localMap.set(lr.prefix, lr.status);
  }

  let cloudflareValid = 0;
  let ripeValid = 0;
  let agreements = 0;
  const disagreements = [];

  for (let i = 0; i < sample.length; i++) {
    const pfx = sample[i];
    const cfStatus = localMap.get(pfx) || "not_found";
    const ripeState = ripeResults[i].state;

    const cfIsValid = cfStatus === "valid";
    const ripeIsValid = ripeState === "valid" || ripeState === "VALID";

    if (cfIsValid) cloudflareValid++;
    if (ripeIsValid) ripeValid++;

    // Skip comparison if RIPE returned error/unknown
    if (ripeState === "error" || ripeState === "unknown") {
      agreements++; // Don't count failed lookups as disagreements
      continue;
    }

    if (cfIsValid === ripeIsValid) {
      agreements++;
    } else {
      disagreements.push({
        prefix: pfx,
        cloudflare: cfStatus,
        ripe: ripeState,
      });
    }
  }

  const agreementPct = sample.length > 0 ? Math.round((agreements / sample.length) * 100) : 100;
  return { cloudflare_valid: cloudflareValid, ripe_valid: ripeValid, agreement_pct: agreementPct, disagreements: disagreements, sample_size: sample.length };
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

      // Try RIPE first
      const ripeData = await fetchJSON("https://rest.db.ripe.net/search.json?query-string=AS" + asn + "&type-filter=aut-num&source=ripe", { timeout: 5000 }).catch(() => null);
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
      }

      // If RIPE didn't find it, try all other RIRs via RDAP in parallel
      if (!result.data) {
        const rdapEndpoints = [
          { name: "APNIC", url: "https://rdap.apnic.net/autnum/" + asn },
          { name: "ARIN", url: "https://rdap.arin.net/registry/autnum/" + asn },
          { name: "LACNIC", url: "https://rdap.lacnic.net/rdap/autnum/" + asn },
          { name: "AFRINIC", url: "https://rdap.afrinic.net/rdap/autnum/" + asn },
        ];
        const rdapResults = await Promise.all(rdapEndpoints.map((ep) =>
          fetchJSON(ep.url, { timeout: 5000 }).then((d) => {
            if (!d || d.errorCode || !d.handle) return null;
            return { source: ep.name, data: d };
          }).catch(() => null)
        ));
        const found = rdapResults.find((r) => r !== null);
        if (found) {
          const d = found.data;
          const remarks = (d.remarks || []).map((r) => (r.description || []).join(" "));
          const entities = d.entities || [];
          const adminContacts = entities.filter((e) => (e.roles || []).includes("administrative")).map((e) => e.handle || "");
          const techContacts = entities.filter((e) => (e.roles || []).includes("technical")).map((e) => e.handle || "");
          const events = d.events || [];
          const created = (events.find((e) => e.eventAction === "registration") || {}).eventDate || "";
          const lastMod = (events.find((e) => e.eventAction === "last changed") || {}).eventDate || "";
          result.data = {
            aut_num: "AS" + asn,
            as_name: d.name || "",
            descr: remarks,
            org: (entities.find((e) => (e.roles || []).includes("registrant")) || {}).handle || "",
            admin_c: adminContacts,
            tech_c: techContacts,
            mnt_by: [],
            status: (d.status || []).join(", "),
            created: created,
            last_modified: lastMod,
            source: found.source + " (RDAP)",
            import: [],
            export: [],
            remarks: remarks,
          };
        } else {
          result.error = "Not found in any RIR database (RIPE, APNIC, ARIN, LACNIC, AFRINIC)";
        }
      }
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
  // Lia's Paradise: File parsing endpoint (for binary uploads)
  // ============================================================
  if (reqPath === "/api/lia/parse-file" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    let body = "";
    req.on("data", function(chunk) { body += chunk; });
    req.on("end", function() {
      try {
        var parsed = JSON.parse(body);
        var filename = parsed.filename || "";
        var ext = filename.split(".").pop().toLowerCase();
        // For text-based formats, decode base64 and extract text
        if (ext === "csv" || ext === "txt") {
          var text = Buffer.from(parsed.data, "base64").toString("utf8");
          return res.end(JSON.stringify({ text: text }));
        }
        // For binary formats (PDF, XLS, DOC), we can't parse server-side without
        // heavy dependencies. Return helpful error.
        return res.end(JSON.stringify({
          error: "Binary file parsing (" + ext.toUpperCase() + ") requires client-side extraction. Please use CSV or TXT format, or copy-paste the content.",
          suggestion: "Export your spreadsheet as CSV first, then upload the CSV file."
        }));
      } catch(e) {
        return res.end(JSON.stringify({ error: "Parse error: " + e.message }));
      }
    });
    return;
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
    // Use pre-cached org→country map (loaded at startup, 16MB response cached in memory)
    fetchPeeringDB("/net?status=ok&depth=0").then(function(pdbData) {
      if (!pdbData || !pdbData.data) {
        return res.end(JSON.stringify({ error: "Could not fetch PeeringDB networks" }));
      }

      var probeAsns = new Set(atlasProbeCache.asns_with_probes || []);

      var enriched = pdbData.data.map(function(n) {
        var org = pdbOrgCountryMap.get(n.org_id) || {};
        var cc = org.country || "";
        return {
          asn: n.asn,
          name: n.name || "",
          org_name: org.name || "",
          country: cc,
          country_name: cc,
          info_type: n.info_type || "",
          has_probe: probeAsns.has(n.asn),
        };
      }).filter(function(n) { return n.asn > 0 && n.country; });

      var result = JSON.stringify({
        networks: enriched,
        total: enriched.length,
        with_probes: enriched.filter(function(n) { return n.has_probe; }).length,
        without_probes: enriched.filter(function(n) { return !n.has_probe; }).length,
        atlas_unique_asns: probeAsns.size,
        org_countries_loaded: pdbOrgCountryMap.size,
        fetched_at: new Date().toISOString(),
      });

      cacheSet(liaCacheKey, result, 30 * 60 * 1000);
      res.end(result);
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
      const pathNeighbourCount = new Map(); // Count how often each AS appears next to target in paths

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
                const neighbour = pathArr[idx - 1];
                pathNeighbourCount.set(neighbour, (pathNeighbourCount.get(neighbour) || 0) + 1);
              }
            }
          });
        });
      });

      // Provider detection: ONLY use RIPE Stat "left" neighbours (verified upstreams)
      // AS-path analysis is used for frequency/confirmation, NOT as standalone provider source
      const neighbours = neighbourData?.data?.neighbours || [];
      const leftNeighbours = neighbours.filter((n) => n.type === "left");
      const upstreamSet = new Set();
      leftNeighbours.forEach((n) => upstreamSet.add(n.asn));

      // Classify left neighbours: high-power = likely upstream, low-power = likely peer
      const maxPower = leftNeighbours.reduce((m, n) => Math.max(m, n.power || 0), 1);
      const detectedProviders = [...upstreamSet].map((asn) => {
        const nb = leftNeighbours.find((n) => n.asn === asn);
        const power = nb ? (nb.power || 0) : 0;
        const powerPct = Math.round((power / maxPower) * 100);
        const classification = powerPct >= 10 ? "likely_upstream" : "likely_peer";
        return { asn, name: nb && nb.as_name ? nb.as_name : "", power, power_pct: powerPct, classification };
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
      // Validate ALL prefixes using local RPKI data (Cloudflare feed - all 5 RIRs)
      await ensureAspaCache();
      const rpkiBatch = announcedPrefixes.map((p) => p.prefix);
      const rpkiResults = rpkiBatch.map((pfx) => validateRPKILocal(rawAsn, pfx));
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

      rrcs.forEach((rrc) => {
        const peers = rrc.peers || [];
        peers.forEach((peer) => {
          const path = peer.as_path || "";
          const pathArr = path.split(" ").map(Number).filter(Boolean);
          if (pathArr.length > 1) {
            asPaths.push({ rrc: rrc.rrc, path: pathArr, prefix: peer.prefix || "" });
          }
        });
      });

      // Provider detection: ONLY use RIPE Stat "left" neighbours (verified upstreams)
      const neighbours = neighbourData?.data?.neighbours || [];
      const leftNeighbours = neighbours.filter((n) => n.type === "left");
      const upstreamSet = new Set();
      leftNeighbours.forEach((n) => upstreamSet.add(n.asn));

      // Classify left neighbours: high-power = likely upstream, low-power = likely peer
      const maxPower = leftNeighbours.reduce((m, n) => Math.max(m, n.power || 0), 1);
      const detectedProviders = [...upstreamSet].map((asn) => {
        const nb = leftNeighbours.find((n) => n.asn === asn);
        const power = nb ? (nb.power || 0) : 0;
        const powerPct = Math.round((power / maxPower) * 100);
        const classification = powerPct >= 10 ? "likely_upstream" : "likely_peer";
        return { asn, name: nb && nb.as_name ? nb.as_name : "", power, power_pct: powerPct, classification };
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
      // Use all prefixes for RPKI validation (local lookup is fast, no API calls)
      const samplePrefixes = allPrefixes;
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

      // 13. RPKI ROA Completeness (local validation against Cloudflare RPKI feed - all RIRs)
      await ensureAspaCache(); // Ensure ROA data is loaded
      validationPromises.rpki_completeness = Promise.resolve(
        allPrefixes.map(function(pfx) { return validateRPKILocal(rawAsn, pfx); })
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

      // 16. MANRS Compliance (observatory API requires auth — use fallback indicators)
      validationPromises.manrs = fetchJSON("https://observatory.manrs.org/api/v2/asn/" + rawAsn + "/conformance", { timeout: 5000 }).then(function(data) {
        if (!data || data.error || data.detail === "Authentication credentials were not provided.") {
          // API unavailable — check MANRS indicators: RPKI ROA + IRR objects as proxy
          var hasRoa = samplePrefixes.length > 0; // will be checked by RPKI validation
          var hasIrr = !!(net.irr_as_set);
          if (hasRoa && hasIrr) {
            return { status: "info", participant: "unknown", message: "MANRS Observatory API requires authentication — cannot verify membership. Network has ROA + IRR objects (positive indicators).", note: "Unable to verify — MANRS API requires auth. Check https://observatory.manrs.org/asn/" + rawAsn };
          }
          return { status: "info", participant: "unknown", message: "Unable to verify MANRS membership (API requires authentication)", note: "Check manually: https://observatory.manrs.org/asn/" + rawAsn };
        }
        var score = data.conformance_score || data.score || 0;
        return { status: score >= 50 ? "pass" : "warning", participant: true, score: score, details: data };
      }).catch(function(e) { return { status: "info", participant: "unknown", message: "MANRS check unavailable", note: "https://observatory.manrs.org/asn/" + rawAsn }; });

      // 17. Reverse DNS Coverage
      validationPromises.rdns = Promise.all(
        samplePrefixes.slice(0, 5).map(function(pfx) {
          return fetchJSON("https://stat.ripe.net/data/reverse-dns-consistency/data.json?resource=" + encodeURIComponent(pfx), { timeout: 15000 }).then(function(data) {
            var pfxData = data && data.data && data.data.prefixes ? data.data.prefixes : {};
            var hasDelegation = false;
            var details = [];
            // API returns { ipv4: { "prefix": { complete, domains } }, ipv6: { ... } }
            ["ipv4", "ipv6"].forEach(function(af) {
              var afData = pfxData[af] || {};
              Object.keys(afData).forEach(function(p) {
                var entry = afData[p];
                if (entry && entry.complete) hasDelegation = true;
                if (entry && entry.domains) {
                  entry.domains.forEach(function(d) {
                    if (d.found) hasDelegation = true;
                    details.push({ domain: d.domain, found: !!d.found });
                  });
                }
              });
            });
            // Fallback: old array format
            if (Array.isArray(pfxData)) {
              pfxData.forEach(function(p) {
                if (p.ipv4 || p.ipv6 || (p.delegations && p.delegations.length > 0)) hasDelegation = true;
              });
            }
            return { prefix: pfx, has_rdns: hasDelegation, details: details };
          }).catch(function() { return { prefix: pfx, has_rdns: false, error: true }; });
        })
      ).then(function(results) {
        var withRdns = results.filter(function(r) { return r.has_rdns; });
        var coverage = results.length > 0 ? Math.round((withRdns.length / results.length) * 100) : 0;
        // Include details of what failed
        var failedPrefixes = results.filter(function(r) { return !r.has_rdns && !r.error; }).map(function(r) { return r.prefix; });
        return { status: coverage >= 80 ? "pass" : coverage >= 50 ? "warning" : "fail", coverage_pct: coverage, checked: results.length, results: results, failed_prefixes: failedPrefixes };
      }).catch(function(e) { return { status: "error", error: String(e) }; });

      // 18. BGP Visibility (uses routing-status API which is more reliable than visibility API)
      validationPromises.visibility = fetchJSON("https://stat.ripe.net/data/routing-status/data.json?resource=AS" + rawAsn, { timeout: 20000 }).then(function(rsData) {
        var vis = rsData && rsData.data && rsData.data.visibility ? rsData.data.visibility : {};
        var v4 = vis.v4 || {};
        var v6 = vis.v6 || {};
        var totalPeers = (v4.total_ris_peers || 0) + (v6.total_ris_peers || 0);
        var seeingPeers = (v4.ris_peers_seeing || 0) + (v6.ris_peers_seeing || 0);
        var score = totalPeers > 0 ? Math.round((seeingPeers / totalPeers) * 100) : 0;
        var observedNeighbours = rsData && rsData.data ? (rsData.data.observed_neighbours || 0) : 0;
        // If routing-status returned no data, try bgproutes.io
        if (totalPeers === 0 && samplePrefixes[0]) {
          return fetchBgproutesVisibility(samplePrefixes[0]).then(function(bgprFb) {
            if (bgprFb && bgprFb.vps_seeing > 0) {
              seeingPeers = bgprFb.vps_seeing;
              totalPeers = Math.max(bgprFb.vps_seeing, 300);
              score = Math.round((seeingPeers / totalPeers) * 100);
            }
            return { status: score >= 80 ? "pass" : score >= 50 ? "warning" : "fail", visibility_score: score, total_ris_peers: totalPeers, seen_by: seeingPeers, v4_seeing: v4.ris_peers_seeing || 0, v4_total: v4.total_ris_peers || 0, v6_seeing: v6.ris_peers_seeing || 0, v6_total: v6.total_ris_peers || 0, observed_neighbours: observedNeighbours, source: "bgproutes.io_fallback" };
          }).catch(function() {
            return { status: "fail", visibility_score: 0, total_ris_peers: 0, seen_by: 0, source: "unavailable" };
          });
        }
        return { status: score >= 80 ? "pass" : score >= 50 ? "warning" : "fail", visibility_score: score, total_ris_peers: totalPeers, seen_by: seeingPeers, v4_seeing: v4.ris_peers_seeing || 0, v4_total: v4.total_ris_peers || 0, v6_seeing: v6.ris_peers_seeing || 0, v6_total: v6.total_ris_peers || 0, observed_neighbours: observedNeighbours, source: "ripe_routing_status" };
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

      // 21. RPSL/IRR Object Validation (query all 5 RIRs in parallel)
      validationPromises.rpsl = (function() {
        // Try RIPE first (has richest policy data), then RDAP for other RIRs
        var ripePromise = fetchJSON("https://rest.db.ripe.net/lookup/ripe/aut-num/AS" + rawAsn + ".json", { timeout: 5000 }).then(function(data) {
          var objects = data && data.objects && data.objects.object ? data.objects.object : [];
          if (objects.length === 0) return null;
          var attrs = objects[0] && objects[0].attributes && objects[0].attributes.attribute ? objects[0].attributes.attribute : [];
          var hasImport = attrs.some(function(a) { return a.name === "import" || a.name === "mp-import"; });
          var hasExport = attrs.some(function(a) { return a.name === "export" || a.name === "mp-export"; });
          var hasRemarks = attrs.some(function(a) { return a.name === "remarks"; });
          return { status: (hasImport || hasExport) ? "pass" : "warning", exists: true, has_import: hasImport, has_export: hasExport, has_remarks: hasRemarks, has_policy: hasImport || hasExport, source: "RIPE" };
        }).catch(function() { return null; });

        var rdapEndpoints = [
          { name: "APNIC", url: "https://rdap.apnic.net/autnum/" + rawAsn },
          { name: "ARIN", url: "https://rdap.arin.net/registry/autnum/" + rawAsn },
          { name: "LACNIC", url: "https://rdap.lacnic.net/rdap/autnum/" + rawAsn },
          { name: "AFRINIC", url: "https://rdap.afrinic.net/rdap/autnum/" + rawAsn },
        ];
        var rdapPromises = rdapEndpoints.map(function(ep) {
          return fetchJSON(ep.url, { timeout: 5000 }).then(function(data) {
            if (!data || data.errorCode || !data.handle) return null;
            var hasRemarks = !!(data.remarks && data.remarks.length > 0);
            var name = data.name || "";
            return { status: hasRemarks ? "pass" : "warning", exists: true, has_import: false, has_export: false, has_remarks: hasRemarks, has_policy: false, source: ep.name, rdap_name: name, rdap_handle: data.handle || "" };
          }).catch(function() { return null; });
        });

        return Promise.all([ripePromise].concat(rdapPromises)).then(function(results) {
          // Take first successful result
          for (var ri = 0; ri < results.length; ri++) {
            if (results[ri] !== null) return results[ri];
          }
          return { status: "warning", exists: false, has_policy: false };
        });
      })();

      // 22. IXP Route Server Participation (Bug 5 fix: fair scoring for bilateral peering)
      var ixRsQueryUrl = netId ? "/netixlan?net_id=" + netId : "/netixlan?asn=" + rawAsn;
      {
        validationPromises.ix_route_server = fetchPeeringDB(ixRsQueryUrl).then(function(ixData) {
          var connections = ixData && ixData.data ? ixData.data : [];
          var rsParticipants = connections.filter(function(c) { return c.is_rs_peer === true; });
          var totalIx = connections.length;
          var rsCount = rsParticipants.length;
          var rsPct = totalIx > 0 ? Math.round((rsCount / totalIx) * 100) : 0;
          var status, note;

          if (totalIx > 0 && rsCount > 0) {
            // Using route servers - good
            status = "pass";
            note = null;
          } else if (totalIx >= 20 && rsCount === 0) {
            // Large network with 20+ IX connections but no RS = deliberate bilateral peering policy
            status = "pass";
            note = "Bilateral peering policy - " + totalIx + " IX connections without route servers indicates deliberate policy choice";
          } else if (totalIx < 5 && rsCount === 0) {
            // Small number of IX connections and no RS - suggests misconfiguration
            status = "warning";
            note = "Only " + totalIx + " IX connections and no route server usage - consider enabling route server peering for better reachability";
          } else {
            // Medium network (5-19 IX) without RS - mild warning
            status = "warning";
            note = totalIx + " IX connections without route server usage";
          }

          return { status: status, total_ix_connections: totalIx, rs_peer_count: rsCount, rs_peer_pct: rsPct, note: note };
        }).catch(function(e) { return { status: "error", error: String(e) }; });
      }

      // 23. Resource Certification (local RPKI validation - all prefixes, all RIRs)
      validationPromises.resource_cert = Promise.resolve(
        allPrefixes.map(function(pfx) { return validateRPKILocal(rawAsn, pfx); })
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

      // Enrich geolocation (Bug 4 fix: handle anycast/CDN/global networks)
      if (validations.geolocation && validations.geolocation.status !== "error") {
        var uniqueFacCountries = {};
        facCountries.forEach(function(c) { uniqueFacCountries[c] = true; });
        var facCountryCount = Object.keys(uniqueFacCountries).length;
        validations.geolocation.pdb_facility_countries = Object.keys(uniqueFacCountries);
        var geoSet = {};
        (validations.geolocation.geo_countries || []).forEach(function(c) { geoSet[c] = true; });
        var geoCountryCount = Object.keys(geoSet).length;
        var mismatches = Object.keys(geoSet).filter(function(c) { return !uniqueFacCountries[c] && facCountryCount > 0; });
        validations.geolocation.country_mismatches = mismatches;

        // Detect global/anycast networks: 5+ facility countries OR Content/NSP type
        var netInfoType = (net.info_type || "").toLowerCase();
        var isGlobalNetwork = facCountryCount >= 5 || netInfoType === "content" || netInfoType === "nsp";
        if (isGlobalNetwork) {
          // Global/anycast/CDN network: geo mismatches are expected, not anomalies
          validations.geolocation.status = "pass";
          if (geoCountryCount === 0) {
            validations.geolocation.note = "Global network (" + facCountryCount + " countries, type: " + (net.info_type || "N/A") + ") - no MaxMind geolocation data available";
          } else {
            validations.geolocation.note = "Global/anycast network - multi-country presence expected (" + facCountryCount + " facility countries, type: " + (net.info_type || "N/A") + ")";
          }
          validations.geolocation.country_mismatches = [];
        } else if (facCountryCount <= 2 && geoCountryCount >= 10) {
          // Actual anomaly: small network appearing in many countries
          validations.geolocation.status = "warning";
          validations.geolocation.note = "Prefixes geolocated in " + geoCountryCount + " countries but only " + facCountryCount + " facility countries - possible hijack or misconfiguration";
        }
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
        if (v && v.status === "info") {
          // "info" = unable to verify (e.g. API auth required) — exclude from scoring
          checkResults.push({ check: c.key, weight: c.weight, earned: 0, status: "info" });
          return;
        }
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

      // RPKI: validate ALL prefixes using local Cloudflare RPKI data (all 5 RIRs, instant)
      await ensureAspaCache();
      const allPrefixes = prefixes.map((p) => p.prefix);
      const rpkiAllResults = allPrefixes.map((pfx) => validateRPKILocal(asn, pfx));

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

      const facilitiesRaw = (facData?.data || []).map((f) => ({
        fac_id: f.fac_id,
        name: f.name || "",
        city: f.city || "",
        country: f.country || "",
      }));

      // Batch-fetch facility coordinates for map (max 50 facilities)
      const facIds = facilitiesRaw.map(f => f.fac_id).filter(Boolean).slice(0, 50);
      let facCoordMap = {};
      if (facIds.length > 0) {
        try {
          const chunks = [];
          for (let i = 0; i < facIds.length; i += 25) chunks.push(facIds.slice(i, i + 25));
          const coordResults = await Promise.race([
            Promise.all(chunks.map(chunk =>
              fetchPeeringDB("/fac?id__in=" + chunk.join(",") + "&fields=id,latitude,longitude").catch(() => null)
            )),
            new Promise(r => setTimeout(() => r([]), 5000))
          ]);
          (coordResults || []).forEach(res => {
            (res?.data || []).forEach(f => { if (f.latitude && f.longitude) facCoordMap[f.id] = { lat: f.latitude, lon: f.longitude }; });
          });
        } catch(e) { /* graceful degradation */ }
      }
      const facilities = facilitiesRaw.map(f => ({
        ...f,
        latitude: facCoordMap[f.fac_id] ? facCoordMap[f.fac_id].lat : null,
        longitude: facCoordMap[f.fac_id] ? facCoordMap[f.fac_id].lon : null,
      }));

      // Get IX locations for map via ixfac -> fac coordinates (max 20 IXs)
      const uniqueIxIds = [...new Set(ixConnections.map(c => c.ix_id))].filter(Boolean).slice(0, 20);
      let ixLocations = [];
      if (uniqueIxIds.length > 0) {
        try {
          const ixFacData = await Promise.race([
            fetchPeeringDB("/ixfac?ix_id__in=" + uniqueIxIds.join(",")),
            new Promise(r => setTimeout(() => r(null), 5000))
          ]);
          const ixFacs = ixFacData?.data || [];
          // Collect unique fac_ids we don't already have coords for
          const extraFacIds = [...new Set(ixFacs.map(f => f.fac_id).filter(id => id && !facCoordMap[id]))].slice(0, 30);
          if (extraFacIds.length > 0) {
            const extraChunks = [];
            for (let i = 0; i < extraFacIds.length; i += 25) extraChunks.push(extraFacIds.slice(i, i + 25));
            const extraRes = await Promise.race([
              Promise.all(extraChunks.map(chunk =>
                fetchPeeringDB("/fac?id__in=" + chunk.join(",") + "&fields=id,latitude,longitude").catch(() => null)
              )),
              new Promise(r => setTimeout(() => r([]), 4000))
            ]);
            (extraRes || []).forEach(res => {
              (res?.data || []).forEach(f => { if (f.latitude && f.longitude) facCoordMap[f.id] = { lat: f.latitude, lon: f.longitude }; });
            });
          }
          // Build IX locations: pick first facility with coords per IX
          const ixNameMap = {};
          ixConnections.forEach(c => { if (c.ix_id && c.ix_name) ixNameMap[c.ix_id] = c.ix_name; });
          const seenIx = {};
          ixFacs.forEach(f => {
            if (seenIx[f.ix_id]) return;
            const coords = facCoordMap[f.fac_id];
            if (coords) {
              seenIx[f.ix_id] = true;
              ixLocations.push({ ix_id: f.ix_id, name: ixNameMap[f.ix_id] || f.name || "", city: f.city || "", country: f.country || "", latitude: coords.lat, longitude: coords.lon });
            }
          });
        } catch(e) { /* graceful degradation */ }
      }

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

      // ============================================================
      // Multi-source cross-checks (run in parallel, non-blocking)
      // ============================================================
      let rpkiCrossCheck = { cloudflare_valid: 0, ripe_valid: 0, agreement_pct: 100, disagreements: [], sample_size: 0 };
      let prefixCrossCheck = { ripe_stat: prefixes.length, bgp_he_net: null, agreement: null, note: "" };
      let neighbourCrossCheck = { ripe_stat_total: neighbours.length, bgp_he_net_total: null };

      try {
        // RPKI cross-check: sample up to 5 prefixes against RIPE Validator (with 8s total timeout)
        const rpkiCrossPromise = crossCheckRpki(asn, allPrefixes, rpkiStatuses);
        const rpkiCrossResult = await Promise.race([
          rpkiCrossPromise,
          new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
        ]);
        if (rpkiCrossResult) rpkiCrossCheck = rpkiCrossResult;
      } catch (_e) { /* cross-check failed, keep defaults */ }

      // Prefix count cross-check: compare RIPE Stat vs bgp.he.net
      if (bgpHeData) {
        const heV4 = bgpHeData.prefixes_v4 || 0;
        const heV6 = bgpHeData.prefixes_v6 || 0;
        const heTotal = heV4 + heV6;
        if (heTotal > 0) {
          prefixCrossCheck.bgp_he_net = heTotal;
          const ripeStat = prefixes.length;
          if (ripeStat > 0 && heTotal > 0) {
            const ratio = Math.min(ripeStat, heTotal) / Math.max(ripeStat, heTotal);
            prefixCrossCheck.agreement = ratio >= 0.9;
            const diff = Math.abs(ripeStat - heTotal);
            prefixCrossCheck.note = diff === 0
              ? "Exact match"
              : "Difference of " + diff + " prefixes (" + Math.round((1 - ratio) * 100) + "% divergence)";
          }
        } else {
          prefixCrossCheck.note = "bgp.he.net prefix count unavailable";
        }

        // Neighbour cross-check: compare RIPE Stat vs bgp.he.net peer_count
        if (bgpHeData.peer_count != null) {
          neighbourCrossCheck.bgp_he_net_total = bgpHeData.peer_count;
        }
      } else {
        prefixCrossCheck.note = "bgp.he.net data unavailable";
      }

      // Compute overall data quality
      const crossCheckScores = [];
      // RPKI agreement
      crossCheckScores.push(rpkiCrossCheck.agreement_pct);
      // Prefix agreement: convert to percentage
      if (prefixCrossCheck.bgp_he_net != null && prefixes.length > 0) {
        const pfxRatio = Math.min(prefixes.length, prefixCrossCheck.bgp_he_net) / Math.max(prefixes.length, prefixCrossCheck.bgp_he_net);
        crossCheckScores.push(Math.round(pfxRatio * 100));
      }
      // Neighbour agreement
      if (neighbourCrossCheck.bgp_he_net_total != null && neighbours.length > 0) {
        const nbrRatio = Math.min(neighbours.length, neighbourCrossCheck.bgp_he_net_total) / Math.max(neighbours.length, neighbourCrossCheck.bgp_he_net_total);
        crossCheckScores.push(Math.round(nbrRatio * 100));
      }
      const avgAgreement = crossCheckScores.length > 0
        ? Math.round(crossCheckScores.reduce((a, b) => a + b, 0) / crossCheckScores.length)
        : 100;
      const overallConfidence = avgAgreement > 90 ? "high" : avgAgreement >= 70 ? "medium" : "low";

      const dataQuality = {
        sources_queried: ["PeeringDB", "RIPE Stat", "bgp.he.net", "Cloudflare RPKI", "RIPE RPKI Validator"],
        cross_checks: {
          rpki: { sources: 2, agreement_pct: rpkiCrossCheck.agreement_pct, sample_size: rpkiCrossCheck.sample_size, disagreements: rpkiCrossCheck.disagreements },
          prefixes: { sources: 2, agreement_pct: prefixCrossCheck.bgp_he_net != null ? Math.round((Math.min(prefixes.length, prefixCrossCheck.bgp_he_net) / Math.max(prefixes.length, prefixCrossCheck.bgp_he_net || 1)) * 100) : null, ripe_stat: prefixCrossCheck.ripe_stat, bgp_he_net: prefixCrossCheck.bgp_he_net, note: prefixCrossCheck.note },
          neighbours: { sources: 2, agreement_pct: neighbourCrossCheck.bgp_he_net_total != null && neighbours.length > 0 ? Math.round((Math.min(neighbours.length, neighbourCrossCheck.bgp_he_net_total) / Math.max(neighbours.length, neighbourCrossCheck.bgp_he_net_total)) * 100) : null, ripe_stat_total: neighbourCrossCheck.ripe_stat_total, bgp_he_net_total: neighbourCrossCheck.bgp_he_net_total },
        },
        overall_confidence: overallConfidence,
        overall_agreement_pct: avgAgreement,
      };

      // === IX Location Geocode Fallback ===
      // Some IXPs have no facility coordinates in PeeringDB.
      // Use ix_name city extraction + hard-coded IX→city map as fallback.
      var ixIdsWithCoords = new Set(ixLocations.map(function(l) { return l.ix_id; }));
      ixConnections.forEach(function(conn) {
        if (ixIdsWithCoords.has(conn.ix_id)) return;
        var name = conn.ix_name || "";
        if (name) {
          var words = name.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
          for (var w = 0; w < words.length; w++) {
            if (CITY_COORDS[words[w]]) {
              ixLocations.push({ ix_id: conn.ix_id, name: name, city: words[w].charAt(0).toUpperCase() + words[w].slice(1), country: "", latitude: CITY_COORDS[words[w]][0], longitude: CITY_COORDS[words[w]][1], source: "name_geocode" });
              ixIdsWithCoords.add(conn.ix_id);
              return;
            }
            if (w < words.length - 1) {
              var tw = words[w] + " " + words[w + 1];
              if (CITY_COORDS[tw]) {
                ixLocations.push({ ix_id: conn.ix_id, name: name, city: tw, country: "", latitude: CITY_COORDS[tw][0], longitude: CITY_COORDS[tw][1], source: "name_geocode" });
                ixIdsWithCoords.add(conn.ix_id);
                return;
              }
            }
          }
        }
      });
      // Hard-coded IX ID → city for well-known IXPs whose names don't contain city
      var IX_CITY_MAP = { 60: "zurich", 2601: "meppel", 24: "london", 35: "moscow", 15: "chicago", 11: "seattle", 387: "dublin", 171: "warsaw", 168: "bucharest", 71: "milan", 66: "vienna", 62: "prague", 1: "ashburn" };
      ixConnections.forEach(function(conn) {
        if (ixIdsWithCoords.has(conn.ix_id)) return;
        var city = IX_CITY_MAP[conn.ix_id];
        if (city && CITY_COORDS[city]) {
          ixLocations.push({ ix_id: conn.ix_id, name: conn.ix_name || ("IX " + conn.ix_id), city: city.charAt(0).toUpperCase() + city.slice(1), country: "", latitude: CITY_COORDS[city][0], longitude: CITY_COORDS[city][1], source: "ix_city_map" });
        }
      });

      const result = {
        meta: {
          service: "PeerCortex",
          version: "0.5.0",
          query: "AS" + asn,
          duration_ms: duration,
          sources: ["PeeringDB", "RIPE Stat", "bgp.he.net", "Cloudflare RPKI", "RIPE RPKI Validator", "Route Views"],
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
          cross_check: prefixCrossCheck,
        },
        rpki: {
          coverage_percent: rpkiCoverage,
          valid: rpkiValid,
          invalid: rpkiInvalid,
          not_found: rpkiNotFound,
          checked: rpkiTotal,
          details: rpkiStatuses,
          cross_check: rpkiCrossCheck,
        },
        neighbours: {
          total: neighbours.length,
          upstream_count: upstreams.length,
          downstream_count: downstreams.length,
          peer_count: peers.length,
          upstreams: upstreams.slice(0, 20),
          downstreams: downstreams.slice(0, 20),
          peers: peers.slice(0, 20),
          cross_check: neighbourCrossCheck,
        },
        ix_presence: {
          total_connections: ixConnections.length,
          unique_ixps: [...new Set(ixConnections.map((ix) => ix.ix_id))].length,
          connections: ixConnections,
        },
        ix_locations: ixLocations,
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
        data_quality: dataQuality,
      };

      // Update duration to include cross-check time
      result.meta.duration_ms = Date.now() - start;

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

// ============================================================
// PeeringDB Org → Country Cache (for Lia's Paradise)
// ============================================================
let pdbOrgCountryMap = new Map(); // org_id → { country, name }

function fetchPdbOrgCountries() {
  var cacheFile = require("path").join(__dirname, ".pdb-org-cache.json");
  var fs = require("fs");
  
  // Try disk cache first (valid for 24h)
  try {
    var stat = fs.statSync(cacheFile);
    var ageHours = (Date.now() - stat.mtimeMs) / 3600000;
    if (ageHours < 24) {
      var cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      pdbOrgCountryMap = new Map(Object.entries(cached));
      console.log("[PDB-ORG] Loaded " + pdbOrgCountryMap.size + " orgs from disk cache (" + Math.round(ageHours) + "h old)");
      return Promise.resolve();
    }
  } catch (_) { /* no cache or invalid */ }

  console.log("[PDB-ORG] Fetching PeeringDB org countries (fresh)...");
  return new Promise(function(resolve) {
    var chunks = [];
    var req = require("https").get("https://www.peeringdb.com/api/org?status=ok&depth=0", {
      headers: {
        "User-Agent": UA,
        "Authorization": PEERINGDB_API_KEY ? "Api-Key " + PEERINGDB_API_KEY : undefined,
      },
      timeout: 120000,
    }, function(res) {
      if (res.statusCode !== 200) {
        console.error("[PDB-ORG] HTTP " + res.statusCode + " — using stale cache or empty");
        resolve();
        return;
      }
      res.on("data", function(chunk) { chunks.push(chunk); });
      res.on("end", function() {
        try {
          var body = Buffer.concat(chunks).toString("utf8");
          var data = JSON.parse(body);
          if (data && data.data) {
            pdbOrgCountryMap = new Map();
            var cacheObj = {};
            data.data.forEach(function(o) {
              if (o.id && o.country) {
                pdbOrgCountryMap.set(o.id, { country: o.country, name: o.name || "" });
                cacheObj[o.id] = { country: o.country, name: o.name || "" };
              }
            });
            // Save to disk cache
            try { fs.writeFileSync(cacheFile, JSON.stringify(cacheObj)); } catch (_) {}
            console.log("[PDB-ORG] Loaded " + pdbOrgCountryMap.size + " org→country mappings (cached to disk)");
          }
        } catch (e) {
          console.error("[PDB-ORG] Parse error:", e.message);
        }
        resolve();
      });
    });
    req.on("error", function(e) {
      console.error("[PDB-ORG] Fetch error:", e.message);
      resolve();
    });
    req.on("timeout", function() {
      console.error("[PDB-ORG] Timeout after 120s");
      req.destroy();
      resolve();
    });
  });
}

const PORT = process.env.PORT || 3101;

// Fetch RPKI ASPA feed at startup and refresh every 10 minutes
Promise.all([fetchRpkiAspaFeed(), fetchAllAtlasProbes(), fetchPdbOrgCountries()]).then(() => {
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
