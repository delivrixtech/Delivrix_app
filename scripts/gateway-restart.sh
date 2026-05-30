#!/usr/bin/env bash
# Restart limpio del gateway con verificacion real.

set -uo pipefail

cd "$(dirname "$0")/.."

echo "=== 1. Matar instancias previas ==="
screen -X -S delivrix-gateway quit 2>/dev/null || true
sleep 1
EXISTING=$(lsof -ti :3000 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  echo "Matando PID(s): $EXISTING"
  echo "$EXISTING" | xargs kill -9 2>/dev/null || true
  sleep 2
fi
screen -wipe 2>/dev/null || true

echo ""
echo "=== 2. Levantar gateway ==="
mkdir -p runtime
rm -f runtime/gateway-smoke.log
screen -dmS delivrix-gateway bash -lc 'cd "/Users/juanescanar/Documents/delivrix app" && OPENCLAW_SIGN_ALLOW_UNSIGNED_LOCAL_PANEL=true node --env-file=.env.local apps/gateway-api/src/main.ts > runtime/gateway-smoke.log 2>&1'

echo "Esperando a que levante..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -m 1 -s http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "OK levantado en ~${i}s"
    break
  fi
  echo "  intento $i: no responde aun"
done

echo ""
echo "=== 3. Status final ==="
echo "Screen:"
screen -ls | grep delivrix-gateway || echo "  NO SCREEN"
echo "Port 3000:"
lsof -ti :3000 || echo "  NADA ESCUCHANDO"
echo ""
echo "Log (ultimas 20 lineas):"
tail -20 runtime/gateway-smoke.log 2>/dev/null || echo "  no log"
echo ""
echo "Health:"
curl -m 3 -s http://127.0.0.1:3000/health | jq -r '"status: " + .status, "killSwitch: " + (.killSwitch.enabled | tostring)' 2>/dev/null || echo "  NO RESPONDE"
