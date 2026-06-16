#!/usr/bin/env bash
# Restart limpio del gateway con verificacion real.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${GATEWAY_HOST:-127.0.0.1}"
PORT="${GATEWAY_PORT:-3000}"

cd "${ROOT_DIR}"

is_alive() {
  local pid="$1"
  ps -p "${pid}" >/dev/null 2>&1
}

stop_pid() {
  local pid="$1"

  if ! is_alive "${pid}"; then
    return 0
  fi

  if ! kill "${pid}" 2>/dev/null; then
    echo "No se pudo enviar SIGTERM a PID ${pid}." >&2
    return 1
  fi
  for _ in {1..20}; do
    if ! is_alive "${pid}"; then
      return 0
    fi
    sleep 0.2
  done

  if ! kill -9 "${pid}" 2>/dev/null; then
    echo "No se pudo enviar SIGKILL a PID ${pid}." >&2
    return 1
  fi
  for _ in {1..20}; do
    if ! is_alive "${pid}"; then
      return 0
    fi
    sleep 0.2
  done

  echo "PID ${pid} no se detuvo despues de SIGKILL." >&2
  return 1
}

echo "=== 1. Matar instancias previas ==="
screen -X -S delivrix-gateway quit 2>/dev/null || true
sleep 1
EXISTING=$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | sort -u || true)
if [ -n "$EXISTING" ]; then
  echo "Matando listener(s) en :${PORT}: $EXISTING"
  for raw_pid in ${EXISTING}; do
    pid="${raw_pid//[!0-9]/}"
    [ -n "$pid" ] && stop_pid "$pid"
  done
fi
screen -wipe 2>/dev/null || true

echo ""
echo "=== 2. Levantar gateway ==="
mkdir -p runtime
rm -f runtime/gateway-smoke.log
# Env canonico: config/gateway.env (blindado -- Vercel CLI solo pisa .env.local).
ENV_FILE="config/gateway.env"
[[ -f config/gateway.env ]] || ENV_FILE=".env.local"
echo "Usando env: ${ENV_FILE}"
printf -v START_CMD 'cd %q && OPENCLAW_SIGN_ALLOW_UNSIGNED_LOCAL_PANEL=true exec node --env-file=%q apps/gateway-api/src/main.ts > runtime/gateway-smoke.log 2>&1' "${ROOT_DIR}" "${ENV_FILE}"
screen -dmS delivrix-gateway bash -lc "${START_CMD}"

echo "Esperando a que levante..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -m 1 -s "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
    echo "OK levantado en ~${i}s"
    break
  fi
  echo "  intento $i: no responde aun"
done

echo ""
echo "=== 3. Status final ==="
echo "Screen:"
SCREEN_STATUS="$(screen -ls 2>/dev/null || true)"
if grep -q "delivrix-gateway" <<< "${SCREEN_STATUS}"; then
  grep "delivrix-gateway" <<< "${SCREEN_STATUS}"
else
  echo "  NO SCREEN"
fi
echo "Port 3000:"
lsof -tiTCP:"${PORT}" -sTCP:LISTEN || echo "  NADA ESCUCHANDO"
echo ""
echo "Log (ultimas 20 lineas):"
tail -20 runtime/gateway-smoke.log 2>/dev/null || echo "  no log"
echo ""
echo "Health:"
curl -m 3 -s "http://${HOST}:${PORT}/health" | jq -r '"status: " + .status, "killSwitch: " + (.killSwitch.enabled | tostring)' 2>/dev/null || echo "  NO RESPONDE"
