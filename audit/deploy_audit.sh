#!/usr/bin/env bash
# deploy_audit.sh — Run ONCE on the Erik server to set up the full audit system
# Usage: bash /opt/peercortex-app/audit/deploy_audit.sh
set -e

APP="/opt/peercortex-app"
AUDIT="$APP/audit"
ENV="$APP/.env"

echo "=== PeerCortex Audit Setup ==="
echo ""

# ── 1) Check PeeringDB key ────────────────────────────────────────────────────
if grep -q "PEERINGDB_API_KEY=" "$ENV" 2>/dev/null; then
    PDB_KEY=$(grep "PEERINGDB_API_KEY=" "$ENV" | cut -d= -f2- | tr -d '"'"'")
    echo "[1/5] PeeringDB API key found: ${PDB_KEY:0:8}..."
else
    echo "[1/5] WARNING: PEERINGDB_API_KEY not in $ENV — rate limits will occur!"
fi

# ── 2) Write ecosystem.config.js (loads .env at PM2 start) ───────────────────
cat > "$APP/ecosystem.config.js" << 'ECOSYS'
const fs = require('fs');
function loadEnv(p) {
  const env = {};
  try {
    fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const idx = line.indexOf('=');
      if (idx < 1) return;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      env[k] = v;
    });
  } catch (e) {}
  return env;
}
const env = loadEnv('/opt/peercortex-app/.env');
module.exports = {
  apps: [{
    name:   'peercortex',
    script: '/opt/peercortex-app/server.js',
    cwd:    '/opt/peercortex-app',
    env
  }]
};
ECOSYS
echo "[2/5] ecosystem.config.js written"

# ── 3) Reload PM2 with env vars ───────────────────────────────────────────────
pm2 reload "$APP/ecosystem.config.js" --update-env 2>&1 | grep -E "✓|error|online" || true
sleep 2
# Verify key is now in PM2 env
if pm2 env 8 2>/dev/null | grep -q "PEERINGDB_API_KEY"; then
    echo "[3/5] PM2 env: PEERINGDB_API_KEY confirmed active"
else
    # fallback: check via node
    KEY_CHECK=$(cd "$APP" && node -e "
      const fs=require('fs');
      const lines=fs.readFileSync('.env','utf8').split('\n');
      for (const l of lines) {
        if (l.startsWith('PEERINGDB_API_KEY=')) {
          console.log('KEY_PRESENT');
          break;
        }
      }
    " 2>/dev/null)
    echo "[3/5] PM2 reload done (key verification: $KEY_CHECK)"
fi

# ── 4) Create audit directories ───────────────────────────────────────────────
mkdir -p "$AUDIT/reports"
echo "[4/5] Audit directories ready: $AUDIT"

# ── 5) Install cron job (midnight daily) ──────────────────────────────────────
CRON_CMD="0 0 * * * cd $APP && source $ENV && /usr/bin/python3 $AUDIT/audit.py >> $AUDIT/audit.log 2>&1"
# Remove any old peercortex audit cron entries
EXISTING=$(crontab -l 2>/dev/null | grep -v "peercortex.*audit\|audit.py")
(echo "$EXISTING"; echo "$CRON_CMD") | crontab -
echo "[5/5] Cron installed:"
crontab -l | grep "audit.py"

echo ""
echo "=== Setup complete! ==="
echo "  Audit script : $AUDIT/audit.py"
echo "  Registry     : $AUDIT/asn_registry.json"
echo "  Reports      : $AUDIT/reports/YYYY-MM-DD.json"
echo "  Latest report: $AUDIT/latest_report.txt"
echo "  Cron         : daily at 00:00 server time"
echo ""
echo "Run a test now:"
echo "  cd $APP && source $ENV && python3 $AUDIT/audit.py"
