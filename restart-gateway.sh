#!/bin/bash
# Reinicia el gateway desde el worktree (con los handlers H.20 cargados)
# y verifica los 5 endpoints nuevos.
#
# Uso (desde la raíz del worktree o cualquier ruta):
#   bash restart-gateway.sh
#
# Si todo está bien, deja el gateway corriendo en background y termina con
# "OK — gateway listo en http://127.0.0.1:3000".

set -u

# Auto-localiza la raíz del repo (carpeta donde vive este script); override con WORKTREE=...
WORKTREE="${WORKTREE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PORT="${GATEWAY_PORT:-3000}"
GATEWAY_FILE="${WORKTREE}/apps/gateway-api/src/main.ts"
LOG="${WORKTREE}/.gateway.log"

cd "${WORKTREE}" || { echo "FATAL: no se encontró el worktree en ${WORKTREE}"; exit 1; }

# Hito 5.11.A — cargar .env.local automáticamente para que WEBDOCK_API_KEY
# y demás env vars del operador estén disponibles para el gateway.
if [ -f "${WORKTREE}/.env.local" ]; then
  echo "=== 0. Cargando .env.local ==="
  set -a
  # shellcheck source=/dev/null
  source "${WORKTREE}/.env.local"
  set +a
  WEBDOCK_KEY_EFFECTIVE="${WEBDOCK_API_KEY:-${WEBDOCK_API_KEY_PRIMARY:-${WEBDOCK_API_KEY_OPS:-}}}"
  if [ -n "${WEBDOCK_KEY_EFFECTIVE}" ]; then
    echo "  Credencial Webdock presente (****${WEBDOCK_KEY_EFFECTIVE: -4})."
  else
    echo "  Sin credencial Webdock (WEBDOCK_API_KEY[_PRIMARY|_OPS]) — gateway usará fallback mock."
  fi
else
  echo "=== 0. .env.local no existe — gateway usará fallback mock para Webdock ==="
fi

echo "=== 1. Matar gateway viejo en el puerto ${PORT} ==="
PIDS=$(lsof -ti:${PORT} 2>/dev/null || true)
if [ -n "${PIDS}" ]; then
  echo "  PIDs encontrados: ${PIDS}"
  kill -9 ${PIDS} 2>/dev/null || true
  sleep 1
  echo "  procesos terminados."
else
  echo "  no había gateway corriendo en ${PORT}."
fi

echo ""
echo "=== 2. Verificar que el código del worktree tiene H.20 ==="
HANDLERS=$(grep -c "/v1/iam/roles\|/v1/iam/sessions\|/v1/compliance/status\|/v1/openclaw/skills/audit\|/v1/openclaw/evidence" "${GATEWAY_FILE}")
if [ "${HANDLERS}" -lt 5 ]; then
  echo "  FATAL: el gateway en ${GATEWAY_FILE} no tiene los 5 handlers H.20."
  echo "         encontrados: ${HANDLERS}/5"
  exit 1
fi
echo "  los 5 handlers H.20 están presentes."

echo ""
echo "=== 3. Levantar gateway en background (puerto ${PORT}) ==="
GATEWAY_PORT=${PORT} nohup node "${GATEWAY_FILE}" > "${LOG}" 2>&1 &
NEW_PID=$!
echo "  PID: ${NEW_PID}"
echo "  log: ${LOG}"
sleep 2

echo ""
echo "=== 4. Smoke test endpoints H.20 + 5.11.A ==="
ALL_OK=1
for path in /health /v1/iam/roles /v1/iam/sessions /v1/compliance/status /v1/openclaw/skills/audit /v1/openclaw/evidence /v1/webdock/inventory; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:${PORT}${path}")
  if [ "${code}" = "200" ]; then
    echo "  ok    ${code}  ${path}"
  else
    echo "  FAIL  ${code}  ${path}"
    ALL_OK=0
  fi
done

# Verificar si Webdock collector está en modo live o mock.
WEBDOCK_SOURCE=$(curl -s -m 5 "http://127.0.0.1:${PORT}/v1/webdock/inventory" 2>/dev/null \
  | python3 -c "import sys, json; print(json.load(sys.stdin).get('inventory', {}).get('source', {}).get('kind', 'unknown'))" 2>/dev/null || echo "unknown")
echo ""
echo "  Webdock collector mode: ${WEBDOCK_SOURCE}"
if [ "${WEBDOCK_SOURCE}" = "live" ]; then
  WEBDOCK_COUNT=$(curl -s -m 5 "http://127.0.0.1:${PORT}/v1/webdock/inventory" \
    | python3 -c "import sys, json; print(json.load(sys.stdin)['inventory']['summary']['total'])" 2>/dev/null || echo "?")
  DRIFT_COUNT=$(curl -s -m 5 "http://127.0.0.1:${PORT}/v1/webdock/inventory" \
    | python3 -c "import sys, json; print(len(json.load(sys.stdin)['drift']['proposals']))" 2>/dev/null || echo "?")
  echo "  ${WEBDOCK_COUNT} servidores reales · ${DRIFT_COUNT} drifts detectados por OpenClaw"
fi

echo ""
if [ "${ALL_OK}" = "1" ]; then
  echo "OK — gateway listo en http://127.0.0.1:${PORT}"
  echo "      PID ${NEW_PID} corriendo en background, log en ${LOG}"
  echo "      ahora recarga el admin panel (Cmd+R) y debería conectar."
  exit 0
else
  echo "FALLO — algunos endpoints no respondieron. Revisa el log:"
  echo "  tail -50 ${LOG}"
  exit 1
fi
