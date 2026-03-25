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

const UA = "PeerCortex/0.2.0 (https://github.com/renefichtmueller/PeerCortex)";

function fetchJSON(url, options) {
  return new Promise((resolve) => {
    const reqOptions = {
      headers: { "User-Agent": UA, ...(options && options.headers ? options.headers : {}) },
    };
    https
      .get(url, reqOptions, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (_e) {
            resolve(null);
          }
        });
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


async function resolveASNames(asnList) {
  const names = {};
  const batchSize = 10;
  for (let i = 0; i < asnList.length; i += batchSize) {
    const batch = asnList.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((asn) =>
        fetchJSON("https://stat.ripe.net/data/as-overview/data.json?resource=AS" + asn)
          .then((r) => ({ asn, name: r?.data?.holder || "" }))
          .catch(() => ({ asn, name: "" }))
      )
    );
    results.forEach((r) => { names[r.asn] = r.name; });
  }
  return names;
}

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

  res.setHeader("Content-Type", "application/json");

  // Health endpoint
  if (reqPath === "/api/health") {
    return res.end(
      JSON.stringify({
        status: "ok",
        service: "PeerCortex",
        version: "0.2.0",
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.floor(process.uptime()),
        bgproutes_configured: !!BGPROUTES_API_KEY,
      })
    );
  }

  // ============================================================
  // ASPA Check endpoint: /api/aspa?asn=X
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

      // Extract AS paths from looking glass
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

      // Also get upstreams from neighbour data
      const neighbours = neighbourData?.data?.neighbours || [];
      const leftNeighbours = neighbours.filter((n) => n.type === "left");
      leftNeighbours.forEach((n) => upstreamSet.add(n.asn));

      let detectedProviders = [...upstreamSet].map((asn) => {
        const nb = leftNeighbours.find((n) => n.asn === asn);
        return { asn, name: nb && nb.as_name ? nb.as_name : "" };
      });

      // Batch-resolve AS names from RIPE Stat AS overview API
      const providerASNs = detectedProviders.map((p) => p.asn);
      const resolvedNames = await resolveASNames(providerASNs);
      detectedProviders = detectedProviders.map((p) => ({
        ...p,
        name: resolvedNames[p.asn] || p.name || "",
      }));

      // Check RIPE DB for ASPA references
      let aspaObjectExists = false;
      try {
        const ripeDbInfo = await fetchJSON(
          "https://rest.db.ripe.net/search.json?query-string=AS" +
            rawAsn +
            "&type-filter=aut-num&source=ripe"
        );
        const objects = ripeDbInfo?.objects?.object || [];
        objects.forEach((obj) => {
          const attrs = obj.attributes?.attribute || [];
          attrs.forEach((attr) => {
            if (attr.name === "remarks" && attr.value && attr.value.toLowerCase().includes("aspa")) {
              aspaObjectExists = true;
            }
          });
        });
      } catch (_e) {
        // RIPE DB query failed, continue
      }

      // Generate recommended ASPA object template
      const providerList = detectedProviders.map((p) => "AS" + p.asn).join(", ");
      const recommendedAspa =
        "aut-num:        AS" + rawAsn + "\n" +
        "# Recommended ASPA object:\n" +
        "# customer:     AS" + rawAsn + "\n" +
        "# provider-set: " + providerList + "\n" +
        "# AFI:          ipv4, ipv6\n" +
        "#\n" +
        "# Detected providers from BGP path analysis:\n" +
        detectedProviders.map((p) => "#   AS" + p.asn + (p.name ? " (" + p.name + ")" : "")).join("\n");

      // Sample path analysis
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

      // Fetch vantage points
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

      // RIB query via POST - pick a ready VP with good RIB size
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
              // arr format: [as_path, communities, rov_status, aspa_status, ...]
              const asPath = Array.isArray(arr) ? arr[0] || "" : "";
              const rovStatus = Array.isArray(arr) ? arr[2] || "" : "";
              const aspaStatus = Array.isArray(arr) ? arr[3] || "" : "";
              return {
                prefix: pfx,
                as_path: asPath,
                rov_status: rovStatus.split(",").map((s) => s === "V" ? "valid" : s === "I" ? "invalid" : s === "U" ? "unknown" : s).join(","),
                aspa_status: aspaStatus.split(",").map((s) => s === "V" ? "valid" : s === "I" ? "invalid" : s === "U" ? "unknown" : s).join(","),
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
        } catch (_e) { /* RIB POST query failed */ }
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
  // Main lookup endpoint: /api/lookup?asn=X
  // ============================================================
  if (reqPath === "/api/lookup") {
    const rawAsn = (url.searchParams.get("asn") || "").replace(/[^0-9]/g, "");
    if (!rawAsn) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing or invalid ASN parameter" }));
    }
    const asn = rawAsn;
    const start = Date.now();

    try {
      const [pdbNet, prefixData, neighbourData, overviewData, rirData, atlasProbeData] = await Promise.all([
        fetchJSON("https://www.peeringdb.com/api/net?asn=" + asn),
        fetchJSON("https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS" + asn),
        fetchJSON("https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS" + asn),
        fetchJSON("https://stat.ripe.net/data/as-overview/data.json?resource=AS" + asn),
        fetchJSON("https://stat.ripe.net/data/rir-stats-country/data.json?resource=AS" + asn),
        fetchJSON("https://atlas.ripe.net/api/v2/probes/?asn_v4=" + asn + "&page_size=500"),
      ]);

      const net = pdbNet?.data?.[0] || {};
      const netId = net.id;
      const prefixes = prefixData?.data?.prefixes || [];
      const neighbours = neighbourData?.data?.neighbours || [];
      const overview = overviewData?.data || {};
      const rirEntries = rirData?.data?.located_resources || rirData?.data?.rir_stats || [];

      // Atlas probes
      const atlasProbes = atlasProbeData?.results || [];
      const atlasConnected = atlasProbes.filter(p => p.status_name === "Connected");
      const atlasAnchors = atlasProbes.filter(p => p.is_anchor === true);

      // Phase 2: IX + Facilities + RPKI (batched 20 at a time)
      const phase2Promises = [];
      if (netId) {
        phase2Promises.push(fetchJSON("https://www.peeringdb.com/api/netixlan?net_id=" + netId));
        phase2Promises.push(fetchJSON("https://www.peeringdb.com/api/netfac?net_id=" + netId));
      } else {
        phase2Promises.push(Promise.resolve(null));
        phase2Promises.push(Promise.resolve(null));
      }

      // RPKI batched 20 at a time, up to 50 prefixes
      const allPrefixes = prefixes.map((p) => p.prefix);
      const rpkiAllResults = [];
      const batchSize = 20;
      for (let i = 0; i < Math.min(allPrefixes.length, 50); i += batchSize) {
        const batch = allPrefixes.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map((pfx) => fetchRPKIPerPrefix(asn, pfx)));
        rpkiAllResults.push(...batchResults);
      }

      const [ixlanData, facData] = await Promise.all(phase2Promises);

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

      // Resolve AS names for neighbours that have empty as_name
      const neighboursNeedingNames = neighbours.filter((n) => !n.as_name).map((n) => n.asn);
      const neighbourNames = neighboursNeedingNames.length > 0 ? await resolveASNames(neighboursNeedingNames) : {};

      const upstreams = neighbours
        .filter((n) => n.type === "left")
        .map((n) => ({ asn: n.asn, name: n.as_name || neighbourNames[n.asn] || "", power: n.power || 0 }))
        .sort((a, b) => b.power - a.power);
      const downstreams = neighbours
        .filter((n) => n.type === "right")
        .map((n) => ({ asn: n.asn, name: n.as_name || neighbourNames[n.asn] || "", power: n.power || 0 }))
        .sort((a, b) => b.power - a.power);
      const peers = neighbours
        .filter((n) => n.type === "uncertain" || n.type === "peer")
        .map((n) => ({ asn: n.asn, name: n.as_name || neighbourNames[n.asn] || "", power: n.power || 0 }))
        .sort((a, b) => b.power - a.power);

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

      const result = {
        meta: {
          service: "PeerCortex",
          version: "0.2.0",
          query: "AS" + asn,
          duration_ms: duration,
          sources: ["PeeringDB", "RIPE Stat"],
          timestamp: new Date().toISOString(),
          rpki_prefixes_checked: rpkiTotal,
          total_prefixes: prefixes.length,
        },
        network: {
          asn: parseInt(asn),
          name: net.name || overview?.holder || "Unknown",
          aka: net.aka || "",
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

      res.end(JSON.stringify(result, null, 2));
    } catch (err) {
      const duration = Date.now() - start;
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Lookup failed", message: err.message, duration_ms: duration }));
    }
    return;
  }

  // ============================================================
  // Compare endpoint: /api/compare?asn1=X&asn2=Y (enhanced)
  // ============================================================
  if (reqPath === "/api/compare") {
    const asn1 = (url.searchParams.get("asn1") || "").replace(/[^0-9]/g, "");
    const asn2 = (url.searchParams.get("asn2") || "").replace(/[^0-9]/g, "");
    if (!asn1 || !asn2) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Need asn1 and asn2 parameters" }));
    }

    const start = Date.now();
    try {
      const [pdb1, pdb2, nb1Data, nb2Data, pfx1Data, pfx2Data] = await Promise.all([
        fetchJSON("https://www.peeringdb.com/api/net?asn=" + asn1),
        fetchJSON("https://www.peeringdb.com/api/net?asn=" + asn2),
        fetchJSON("https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS" + asn1),
        fetchJSON("https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS" + asn2),
        fetchJSON("https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS" + asn1),
        fetchJSON("https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS" + asn2),
      ]);

      const net1 = pdb1?.data?.[0] || {};
      const net2 = pdb2?.data?.[0] || {};

      const ixFacPromises = [];
      if (net1.id) {
        ixFacPromises.push(fetchJSON("https://www.peeringdb.com/api/netixlan?net_id=" + net1.id));
        ixFacPromises.push(fetchJSON("https://www.peeringdb.com/api/netfac?net_id=" + net1.id));
      } else {
        ixFacPromises.push(Promise.resolve(null));
        ixFacPromises.push(Promise.resolve(null));
      }
      if (net2.id) {
        ixFacPromises.push(fetchJSON("https://www.peeringdb.com/api/netixlan?net_id=" + net2.id));
        ixFacPromises.push(fetchJSON("https://www.peeringdb.com/api/netfac?net_id=" + net2.id));
      } else {
        ixFacPromises.push(Promise.resolve(null));
        ixFacPromises.push(Promise.resolve(null));
      }

      const [ix1Data, fac1Data, ix2Data, fac2Data] = await Promise.all(ixFacPromises);

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

      // Common upstreams
      const nb1 = (nb1Data?.data?.neighbours || []).filter((n) => n.type === "left");
      const nb2 = (nb2Data?.data?.neighbours || []).filter((n) => n.type === "left");
      const up1Set = new Set(nb1.map((n) => n.asn));
      const up2Set = new Set(nb2.map((n) => n.asn));
      const nb1Map = {};
      nb1.forEach((n) => (nb1Map[n.asn] = n.as_name || "AS" + n.asn));
      const nb2Map = {};
      nb2.forEach((n) => (nb2Map[n.asn] = n.as_name || "AS" + n.asn));

      const commonUpstreams = [...up1Set]
        .filter((a) => up2Set.has(a))
        .map((a) => ({ asn: a, name: nb1Map[a] || nb2Map[a] || "AS" + a }));

      // RPKI comparison (sample 10 prefixes each)
      const pfx1 = (pfx1Data?.data?.prefixes || []).slice(0, 10).map((p) => p.prefix);
      const pfx2 = (pfx2Data?.data?.prefixes || []).slice(0, 10).map((p) => p.prefix);

      const [rpki1Results, rpki2Results] = await Promise.all([
        Promise.all(pfx1.map((p) => fetchRPKIPerPrefix(asn1, p))),
        Promise.all(pfx2.map((p) => fetchRPKIPerPrefix(asn2, p))),
      ]);

      const rpki1Valid = rpki1Results.filter((r) => r.status === "valid").length;
      const rpki2Valid = rpki2Results.filter((r) => r.status === "valid").length;
      const rpki1Pct = rpki1Results.length > 0 ? Math.round((rpki1Valid / rpki1Results.length) * 100) : 0;
      const rpki2Pct = rpki2Results.length > 0 ? Math.round((rpki2Valid / rpki2Results.length) * 100) : 0;

      const duration = Date.now() - start;
      res.end(
        JSON.stringify(
          {
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
          },
          null,
          2
        )
      );
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Compare failed", message: err.message }));
    }
    return;
  }

  // 404
  res.writeHead(404);
  res.end(
    JSON.stringify({
      error: "Not found. Endpoints: /api/health, /api/lookup?asn=X, /api/aspa?asn=X, /api/bgproutes?asn=X, /api/compare?asn1=X&asn2=Y",
    })
  );
});

const PORT = process.env.PORT || 3101;
server.listen(PORT, "0.0.0.0", () => {
  console.log("PeerCortex v0.2.0 running on http://0.0.0.0:" + PORT);
  console.log("bgproutes.io API key: " + (BGPROUTES_API_KEY ? "configured" : "NOT configured"));
});
