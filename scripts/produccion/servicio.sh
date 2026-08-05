#!/usr/bin/env bash
# Lanza UN servicio en PRIMER PLANO, para que launchd lo supervise.
#
# Los lanzadores de la raíz (delivrix-gateway-start.sh, etc.) existen para emular a mano lo que
# launchd hace nativo: relanzar si muere, recordar el PID, rotar el log, limpiar el puerto. En
# producción esa gimnasia sobra — launchd es el supervisor. Acá queda SOLO el entorno y el exec.
#
# Uso: servicio.sh gateway|panel|warmup-daemon|warmup-monitor|warmup-cupo
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

ENV_FILE="config/gateway.env"
[[ -f "${ROOT_DIR}/${ENV_FILE}" ]] || ENV_FILE=".env.local"

# launchd NO da PATH ni shell de login: el binario de node va absoluto o no arranca nada.
NODE_BIN="${DELIVRIX_NODE:-}"
if [[ -z "${NODE_BIN}" ]]; then
  for cand in /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "${cand}" ]] && NODE_BIN="${cand}" && break
  done
fi
[[ -n "${NODE_BIN}" ]] || NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "FATAL: no encuentro node. Instalalo con Homebrew o exportá DELIVRIX_NODE." >&2
  exit 1
fi
export PATH="$(dirname "${NODE_BIN}"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Lee UNA clave del archivo de entorno. Se usa solo para el panel: los procesos de node reciben
# el archivo entero por --env-file y no necesitan que bash lo interprete.
# shellcheck source=scripts/produccion/lib.sh
source "${ROOT_DIR}/scripts/produccion/lib.sh"
leer_env() { delivrix_leer_env "${ROOT_DIR}/${ENV_FILE}" "$1"; }

case "${1:-}" in
  gateway)
    exec "${NODE_BIN}" --env-file="${ENV_FILE}" apps/gateway-api/src/main.ts
    ;;

  warmup-daemon)
    # El ÚNICO servicio que manda correo. Por eso es el único con WARMUP_LIVE_ENABLE.
    exec env WARMUP_LIVE_ENABLE=true "${NODE_BIN}" --env-file="${ENV_FILE}" \
      --experimental-strip-types apps/warmup-engine/src/service/live-warmup-daemon.ts
    ;;

  warmup-monitor)
    exec "${NODE_BIN}" --env-file="${ENV_FILE}" --experimental-strip-types \
      scripts/ops/warmup-monitor.ts --loop
    ;;

  warmup-cupo)
    exec "${NODE_BIN}" --env-file="${ENV_FILE}" --experimental-strip-types \
      scripts/ops/limite-fisico.ts --status --cada=6
    ;;

  panel)
    # El proxy de Vite lee los tokens del ENTORNO (no de --env-file). Misma cadena de fallback
    # que vite.config.ts: si el token efectivo falta, el WS queda en "reconnecting" perpetuo.
    # El host y el puerto NO se configuran por entorno: están fijos en el script `dev` del panel
    # y en vite.config.ts (127.0.0.1:5173). Exportar ADMIN_PANEL_PORT acá sería mentirle al lector.
    export DELIVRIX_READ_BOUNDARY_TOKEN="$(leer_env DELIVRIX_READ_BOUNDARY_TOKEN)"
    export DELIVRIX_OPENCLAW_TOKEN="$(leer_env DELIVRIX_OPENCLAW_TOKEN)"
    export OPENCLAW_GATEWAY_TOKEN="$(leer_env OPENCLAW_GATEWAY_TOKEN)"
    export WARMUP_API_KEY="$(leer_env WARMUP_API_KEY)"
    export ADMIN_PANEL_GATEWAY_ORIGIN="$(leer_env ADMIN_PANEL_GATEWAY_ORIGIN)"
    : "${ADMIN_PANEL_GATEWAY_ORIGIN:=http://127.0.0.1:3000}"

    canvas="$(leer_env CANVAS_LIVE_STREAM_TOKEN)"
    : "${canvas:=${DELIVRIX_READ_BOUNDARY_TOKEN:-${OPENCLAW_GATEWAY_TOKEN:-}}}"
    if [[ -z "${canvas}" ]]; then
      echo "FATAL: sin token para el Canvas Live WS (CANVAS_LIVE_STREAM_TOKEN / DELIVRIX_READ_BOUNDARY_TOKEN / OPENCLAW_GATEWAY_TOKEN)." >&2
      exit 1
    fi
    export CANVAS_LIVE_STREAM_TOKEN="${canvas}"

    logtok="$(leer_env GATEWAY_LOG_STREAM_TOKEN)"
    : "${logtok:=${DELIVRIX_OPENCLAW_TOKEN:-${DELIVRIX_READ_BOUNDARY_TOKEN:-${OPENCLAW_GATEWAY_TOKEN:-}}}}"
    export GATEWAY_LOG_STREAM_TOKEN="${logtok}"

    export VITE_CANVAS_LIVE_STREAM_TOKEN="${CANVAS_LIVE_STREAM_TOKEN}"
    export VITE_GATEWAY_LOG_STREAM_TOKEN="${GATEWAY_LOG_STREAM_TOKEN}"
    export VITE_DELIVRIX_READ_BOUNDARY_TOKEN="${DELIVRIX_READ_BOUNDARY_TOKEN}"
    export VITE_DELIVRIX_OPENCLAW_TOKEN="${DELIVRIX_OPENCLAW_TOKEN}"

    cd "${ROOT_DIR}/apps/admin-panel"
    # --strictPort es obligatorio en producción: vite.config.ts trae strictPort:false, así que con
    # el 5173 ocupado Vite se muda a otro puerto EN SILENCIO y reporta éxito. Bajo launchd eso deja
    # un panel "vivo" que nadie puede abrir y un watchdog reiniciándolo para siempre. Que falle
    # fuerte y quede escrito en el log es la única forma honesta.
    exec npm run dev -- --strictPort
    ;;

  *)
    echo "uso: servicio.sh gateway|panel|warmup-daemon|warmup-monitor|warmup-cupo" >&2
    exit 2
    ;;
esac
