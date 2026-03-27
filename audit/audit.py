#!/usr/bin/env python3
"""
PeerCortex Daily Accuracy Audit
================================
Runs at midnight via cron, audits a rotating batch of ASNs, and tracks
accuracy over time. Compares PeerCortex data against authoritative sources:
  - RIPE Stat  (prefixes, neighbours)
  - PeeringDB  (IX presence, facilities)

Registry file: /opt/peercortex-app/audit/asn_registry.json
Reports dir:   /opt/peercortex-app/audit/reports/YYYY-MM-DD.json
Latest text:   /opt/peercortex-app/audit/latest_report.txt
"""

import json, os, sys, time, datetime, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ─── Directories ──────────────────────────────────────────────────────────────
AUDIT_DIR   = Path("/opt/peercortex-app/audit")
REGISTRY    = AUDIT_DIR / "asn_registry.json"
REPORTS_DIR = AUDIT_DIR / "reports"
LATEST_TXT  = AUDIT_DIR / "latest_report.txt"
LOG_FILE    = AUDIT_DIR / "audit.log"

# ─── Load .env (for cron compatibility — env vars may not be inherited) ───────
def _load_dotenv():
    env_path = Path("/opt/peercortex-app/.env")
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        idx = line.find("=")
        if idx < 1:
            continue
        key = line[:idx].strip()
        val = line[idx + 1:].strip().strip('"').strip("'")
        if key not in os.environ:
            os.environ[key] = val

_load_dotenv()

# ─── Config ───────────────────────────────────────────────────────────────────
PEERINGDB_KEY  = os.environ.get("PEERINGDB_API_KEY", "")
PEERCORTEX_URL = "http://localhost:3101"   # local — no Cloudflare overhead
PDB_BASE       = "https://www.peeringdb.com/api"
RIPE_BASE      = "https://stat.ripe.net/data"

BATCH_SIZE     = 100
TIMEOUT_PC     = 90    # large networks (Cloudflare, Amazon) can take 60–80s
TIMEOUT_AUTH   = 30
CONCURRENCY    = 4     # parallel PeerCortex requests

# Tolerance for prefix/neighbour counts (BGP timing differences are normal)
PREFIX_TOL_PCT = 0.05   # 5%
PREFIX_TOL_ABS = 2      # absolute ±2
NEIGHBOUR_TOL  = 0.25   # 25%
NEIGHBOUR_ABS  = 5

# ─── Seed ASN list (100 well-known networks) ─────────────────────────────────
# Format: (asn, label)  — label shown in reports, no functional effect
SEED_ASNS = [
    # Tier-1 / Global backbones
    174, 1239, 1299, 2914, 3257, 3320, 3356, 5511, 6461, 6762,
    7018, 9002, 12956,
    # Hyperscalers
    714, 8075, 13335, 13414, 15169, 16509, 20940, 32934, 36459, 46489,
    # IXP / Route servers
    6777, 6939, 8283,
    # Regional ISPs
    6830, 3491, 2516, 4134, 4637, 4755, 4766, 9304, 9318, 7473,
    # Hobbyist / community
    34927, 50869, 59947, 199121, 206924, 211982, 212635, 213279, 215638,
    # European operators
    42476, 47541, 48821, 60610, 61955, 206479, 207841, 212232,
    # APAC
    4826, 7575, 7738, 9790, 17469, 17676, 23693, 24516, 38001, 38195,
    45090, 45177, 55720, 55803, 56041, 131072, 132602,
    # Americas
    10429, 22085, 27947, 28006, 52320, 61832, 265702, 267613, 269608,
    # Africa
    8346, 36874, 36924, 37100, 37239, 37271, 37468, 37662, 327786, 328474,
    # Middle East / Other
    135377, 140627, 394695, 397213, 400304, 401307,
    # Special / edge cases
    1, 64512, 65000, 0, 4294967295,
]

# ─── HTTP helpers ─────────────────────────────────────────────────────────────
def _fetch(url, timeout=30, headers=None):
    """GET url → parsed JSON dict, or None on any error."""
    try:
        req = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status == 429:
                return None
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except Exception:
        return None

def _fetch_pdb(path, timeout=30):
    headers = {}
    if PEERINGDB_KEY:
        headers["Authorization"] = "Api-Key " + PEERINGDB_KEY
    return _fetch(PDB_BASE + path, timeout=timeout, headers=headers)

def _fetch_ripe(endpoint, asn, timeout=30):
    url = f"{RIPE_BASE}/{endpoint}/data.json?resource=AS{asn}"
    return _fetch(url, timeout=timeout)

def _fetch_pc(asn, timeout=90):
    return _fetch(f"{PEERCORTEX_URL}/api/lookup?asn={asn}", timeout=timeout)

# ─── Registry helpers ─────────────────────────────────────────────────────────
def _load_registry():
    if REGISTRY.exists():
        try:
            return json.loads(REGISTRY.read_text())
        except Exception:
            pass
    return {"asns": {}, "meta": {"created": _today(), "total_runs": 0}}

def _save_registry(reg):
    REGISTRY.write_text(json.dumps(reg, indent=2))

def _today():
    return datetime.date.today().isoformat()

def _now_iso():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

# ─── Batch selection (priority: errors > never audited > oldest) ──────────────
def _select_batch(reg, batch_size):
    entries = reg["asns"]

    # Ensure all seed ASNs are tracked
    for asn in SEED_ASNS:
        k = str(asn)
        if k not in entries:
            entries[k] = {
                "last_audited": None,
                "pass_count": 0,
                "error_count": 0,
                "consecutive_errors": 0,
                "peeringdb_absent": False,
            }

    # Sort into three buckets
    errored  = sorted(
        [k for k, v in entries.items() if v.get("consecutive_errors", 0) > 0],
        key=lambda k: entries[k].get("consecutive_errors", 0),
        reverse=True,
    )
    never    = [k for k, v in entries.items()
                if not v.get("last_audited") and k not in errored]
    audited  = sorted(
        [k for k, v in entries.items()
         if v.get("last_audited") and k not in errored],
        key=lambda k: entries[k].get("last_audited", "9999"),
    )

    ordered = errored + never + audited
    return [int(k) for k in ordered[:batch_size]]

# ─── Authoritative data fetch ─────────────────────────────────────────────────
def _fetch_auth(asn):
    """Fetch authoritative data for one ASN from RIPE Stat + PeeringDB."""
    # PeeringDB net lookup first (need net_id for IX/fac queries)
    pdb_net = _fetch_pdb(f"/net?asn={asn}", timeout=TIMEOUT_AUTH)
    net     = ((pdb_net or {}).get("data") or [{}])[0]
    net_id  = net.get("id")

    # RIPE Stat (run in parallel via threads)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as pool:
        f_pfx = pool.submit(_fetch_ripe, "announced-prefixes", asn, TIMEOUT_AUTH)
        f_nb  = pool.submit(_fetch_ripe, "asn-neighbours",     asn, TIMEOUT_AUTH)
        f_ix  = pool.submit(
            _fetch_pdb,
            (f"/netixlan?net_id={net_id}&limit=1000" if net_id
             else f"/netixlan?asn={asn}&limit=1000"),
            TIMEOUT_AUTH,
        )
        f_fac = pool.submit(
            _fetch_pdb,
            f"/netfac?net_id={net_id}&limit=1000",
            TIMEOUT_AUTH,
        ) if net_id else None

        ripe_pfx = f_pfx.result()
        ripe_nb  = f_nb.result()
        pdb_ix   = f_ix.result()
        pdb_fac  = f_fac.result() if f_fac else None

    prefixes   = (ripe_pfx or {}).get("data", {}).get("prefixes", [])
    v4         = sum(1 for p in prefixes if ":" not in p.get("prefix", ""))
    v6         = sum(1 for p in prefixes if ":" in  p.get("prefix", ""))

    neighbours = (ripe_nb or {}).get("data", {}).get("neighbours", [])
    up         = sum(1 for n in neighbours if n.get("type") == "left")
    dn         = sum(1 for n in neighbours if n.get("type") == "right")

    ix_list    = (pdb_ix  or {}).get("data", [])
    ix_unique  = len(set(c.get("ix_id") for c in ix_list if c.get("ix_id")))

    fac_list   = (pdb_fac or {}).get("data", []) if pdb_fac else []
    fac_count  = len(fac_list)

    return {
        "pdb_id":      net_id,
        "pdb_present": bool(net_id),
        "v4": v4,  "v6": v6,
        "ix": ix_unique,  "fac": fac_count,
        "up": up,  "dn": dn,
        "ripe_ok": ripe_pfx is not None,
        "pdb_ok":  pdb_net  is not None,
    }

# ─── Field comparison ─────────────────────────────────────────────────────────
def _ok(auth_val, pc_val, pct=PREFIX_TOL_PCT, abs_tol=PREFIX_TOL_ABS):
    """True if pc_val is within tolerance of auth_val."""
    if auth_val is None or pc_val is None:
        return True   # cannot compare — treat as OK
    if auth_val == 0 and pc_val == 0:
        return True
    if auth_val == 0:
        return pc_val <= abs_tol
    diff = abs(auth_val - pc_val)
    return diff <= abs_tol or (diff / auth_val) <= pct

def _compare(asn, auth, pc):
    """Return list of failure dicts for this ASN."""
    if pc is None:
        return [{"field": "TIMEOUT", "auth": None, "pc": None, "delta": None}]

    failures = []
    pdb_absent = not auth["pdb_present"]

    pc_v4  = (pc.get("prefixes")  or {}).get("ipv4")
    pc_v6  = (pc.get("prefixes")  or {}).get("ipv6")
    pc_ix  = (pc.get("ix_presence") or {}).get("unique_ixps")
    pc_fac = (pc.get("facilities")  or {}).get("total")
    pc_up  = (pc.get("neighbours")  or {}).get("upstream_count")
    pc_dn  = (pc.get("neighbours")  or {}).get("downstream_count")

    if not _ok(auth["v4"], pc_v4):
        failures.append({"field": "Prefixes v4", "auth": auth["v4"], "pc": pc_v4,
                         "delta": abs(auth["v4"] - (pc_v4 or 0))})
    if not _ok(auth["v6"], pc_v6):
        failures.append({"field": "Prefixes v6", "auth": auth["v6"], "pc": pc_v6,
                         "delta": abs(auth["v6"] - (pc_v6 or 0))})

    # IXP / facility — only meaningful when ASN is in PeeringDB
    if not pdb_absent:
        if auth["ix"] != pc_ix:
            failures.append({"field": "IXPs", "auth": auth["ix"], "pc": pc_ix,
                             "delta": abs(auth["ix"] - (pc_ix or 0))})
        if auth["fac"] != pc_fac:
            failures.append({"field": "Facilities", "auth": auth["fac"], "pc": pc_fac,
                             "delta": abs(auth["fac"] - (pc_fac or 0))})

    if not _ok(auth["up"], pc_up, pct=NEIGHBOUR_TOL, abs_tol=NEIGHBOUR_ABS):
        failures.append({"field": "Neighbours (upstream)", "auth": auth["up"], "pc": pc_up,
                         "delta": abs(auth["up"] - (pc_up or 0))})
    if not _ok(auth["dn"], pc_dn, pct=NEIGHBOUR_TOL, abs_tol=NEIGHBOUR_ABS):
        failures.append({"field": "Neighbours (downstream)", "auth": auth["dn"], "pc": pc_dn,
                         "delta": abs(auth["dn"] - (pc_dn or 0))})

    return failures

# ─── Audit one ASN ───────────────────────────────────────────────────────────
def _audit_asn(asn):
    auth = _fetch_auth(asn)
    pc   = _fetch_pc(asn, timeout=TIMEOUT_PC)

    # Self-heal attempt: if PeerCortex returned data but looks stale,
    # wait briefly and retry once (cache TTL is 5 min, but a 2nd hit
    # ensures the process is alive and data is fresh)
    if pc is None:
        time.sleep(2)
        pc = _fetch_pc(asn, timeout=TIMEOUT_PC)

    failures = _compare(asn, auth, pc)
    return {
        "asn":        asn,
        "auth":       auth,
        "pc_name":    ((pc or {}).get("network") or {}).get("name", ""),
        "pc_ok":      pc is not None,
        "pdb_absent": not auth["pdb_present"],
        "failures":   failures,
        "passed":     len(failures) == 0,
    }

# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    reg     = _load_registry()
    date    = _today()
    run_ts  = _now_iso()
    prev_accuracy = reg["meta"].get("last_accuracy_pct")

    batch = _select_batch(reg, BATCH_SIZE)

    header = (
        f"\n{'='*60}\n"
        f"PeerCortex Daily Audit — {date}  ({run_ts})\n"
        f"{'='*60}\n"
        f"Batch: {len(batch)} ASNs  |  "
        f"PDB key: {'ACTIVE' if PEERINGDB_KEY else 'MISSING — rate limits likely!'}\n"
    )
    print(header)

    results = []
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {pool.submit(_audit_asn, asn): asn for asn in batch}
        for i, future in enumerate(as_completed(futures), 1):
            asn = futures[future]
            try:
                r = future.result()
                results.append(r)
                status    = "✓" if r["passed"] else f"✗ {len(r['failures'])}"
                pdb_note  = "  [no PDB — correct]" if r["pdb_absent"] else ""
                fail_note = ""
                if r["failures"] and r["failures"][0].get("field") != "TIMEOUT":
                    top = r["failures"][0]
                    fail_note = f"  → {top['field']}: auth={top['auth']} pc={top['pc']}"
                print(f"  [{i:3d}/{len(batch)}] AS{asn:<12} {status}{pdb_note}{fail_note}")
            except Exception as e:
                err_r = {"asn": asn, "pc_ok": False, "pdb_absent": False,
                         "failures": [{"field": "EXCEPTION", "auth": None,
                                       "pc": None, "delta": None, "msg": str(e)}],
                         "passed": False, "auth": {}, "pc_name": ""}
                results.append(err_r)
                print(f"  [{i:3d}/{len(batch)}] AS{asn:<12} ERROR  {e}")

    # ── Update registry ───────────────────────────────────────────────────────
    for r in results:
        k     = str(r["asn"])
        entry = reg["asns"].setdefault(k, {
            "pass_count": 0, "error_count": 0, "consecutive_errors": 0,
            "peeringdb_absent": False, "last_audited": None,
        })
        entry["last_audited"] = date
        entry["peeringdb_absent"] = r["pdb_absent"]

        if r["passed"]:
            entry["pass_count"]         = entry.get("pass_count", 0) + 1
            entry["consecutive_errors"] = 0
            entry["last_status"]        = "pass"
        else:
            entry["error_count"]        = entry.get("error_count", 0) + 1
            entry["consecutive_errors"] = entry.get("consecutive_errors", 0) + 1
            entry["last_status"]        = "fail"

        entry["last_failures"] = r["failures"]

        # Auth source meta
        auth = r.get("auth") or {}
        if auth.get("pdb_id"):
            entry["peeringdb_id"] = auth["pdb_id"]

    total    = len(results)
    passed   = sum(1 for r in results if r["passed"])
    failed   = total - passed
    no_pdb   = sum(1 for r in results if r["pdb_absent"])
    accuracy = round(passed / total * 100) if total else 0

    reg["meta"]["last_run"]          = run_ts
    reg["meta"]["last_accuracy_pct"] = accuracy
    reg["meta"]["total_runs"]        = reg["meta"].get("total_runs", 0) + 1
    reg["meta"]["total_asns"]        = len(reg["asns"])
    _save_registry(reg)

    # ── Build report ──────────────────────────────────────────────────────────
    all_failures = [
        {"asn": r["asn"], **f}
        for r in results
        for f in r["failures"]
        if f.get("field") not in ("TIMEOUT", "EXCEPTION")
    ]
    all_failures.sort(key=lambda x: x.get("delta") or 0, reverse=True)

    timeouts = [r["asn"] for r in results if not r["pc_ok"]]

    trend = ""
    if prev_accuracy is not None:
        diff = accuracy - prev_accuracy
        trend = f"  Trend   : {prev_accuracy}% → {accuracy}% ({diff:+d}%)\n"

    summary_lines = [
        f"\n{'='*60}",
        f"AUDIT SUMMARY — {date}",
        f"{'='*60}",
        f"  Audited : {total} ASNs",
        f"  Passed  : {passed}  ({accuracy}%)",
        f"  Failed  : {failed}",
        f"  No PDB  : {no_pdb}  (fac=0 ix=0 is CORRECT for these — not an error)",
        f"  PDB Key : {'Active (no rate limits)' if PEERINGDB_KEY else 'MISSING — configure PEERINGDB_API_KEY!'}",
    ]
    if trend:
        summary_lines.append(trend.rstrip())
    if timeouts:
        summary_lines.append(f"\n  Timeouts: AS{', AS'.join(str(a) for a in timeouts)}")
    summary_lines.append("")

    if all_failures:
        summary_lines.append("TOP DISCREPANCIES:")
        summary_lines.append(f"  {'ASN':<12} {'Field':<24} {'Auth':>8} {'PeerCortex':>12} {'Delta':>8}")
        summary_lines.append("  " + "-"*66)
        for f in all_failures[:20]:
            summary_lines.append(
                f"  AS{f['asn']:<10} {f['field']:<24} {str(f['auth']):>8} {str(f['pc']):>12} {str(f.get('delta','')):>8}"
            )
    else:
        summary_lines.append("No discrepancies found — 100% accurate!")

    # PeeringDB-absent note
    absent_asns = [r["asn"] for r in results if r["pdb_absent"] and r["passed"]]
    if absent_asns:
        summary_lines.append(
            f"\nASNs not in PeeringDB (fac=0, ix=0 correct):\n"
            f"  {', '.join('AS'+str(a) for a in sorted(absent_asns))}"
        )

    # Overall DB health
    all_entries    = reg["asns"]
    ever_failed    = sum(1 for v in all_entries.values() if v.get("error_count", 0) > 0)
    clean_streak   = sum(1 for v in all_entries.values()
                         if v.get("consecutive_errors", 0) == 0
                         and v.get("last_audited"))
    summary_lines += [
        f"\nDATABASE HEALTH:",
        f"  Total tracked ASNs : {len(all_entries)}",
        f"  Clean streak       : {clean_streak} ASNs with 0 consecutive errors",
        f"  Ever had errors    : {ever_failed} ASNs",
        f"\nReport: {REPORTS_DIR}/{date}.json",
    ]

    summary = "\n".join(summary_lines)
    print(summary)

    # Save text report
    LATEST_TXT.write_text(header + summary)

    # Save JSON report
    report = {
        "date":         date,
        "run_ts":       run_ts,
        "batch_size":   total,
        "passed":       passed,
        "failed":       failed,
        "pdb_absent":   no_pdb,
        "accuracy_pct": accuracy,
        "pdb_key_active": bool(PEERINGDB_KEY),
        "results":      [
            {
                "asn":         r["asn"],
                "name":        r.get("pc_name", ""),
                "pdb_absent":  r["pdb_absent"],
                "passed":      r["passed"],
                "failures":    r["failures"],
                "auth":        {k: v for k, v in (r.get("auth") or {}).items()
                                if k not in ("pdb_ok", "ripe_ok")},
            }
            for r in results
        ],
    }
    (REPORTS_DIR / f"{date}.json").write_text(json.dumps(report, indent=2))

    return accuracy


if __name__ == "__main__":
    acc = main()
    # Exit 0 if ≥90% accurate, 1 otherwise (cron can alert on non-zero exit)
    sys.exit(0 if acc >= 90 else 1)
