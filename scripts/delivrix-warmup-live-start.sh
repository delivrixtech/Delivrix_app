#!/usr/bin/env bash
set -euo pipefail

# Lanzador del DAEMON LIVE del warmup-engine (opción B — calentamiento AUTÓNOMO real).
# Espeja delivrix-warmup-start.sh (screen + pid + log), pero corre el entrypoint LIVE.
#
# GO-LIVE EXPLÍCITO: correr ESTE script ES la decisión de prender el emisor autónomo. Por eso el
# script exporta WARMUP_LIVE_ENABLE=true. Sin ese flag el daemon es INERTE (cero correo).
# Barreras (verificadas en cada vuelta por el daemon): tope diario (WARMUP_LIVE_MAX_PER_DAY, def 3),
# gate de placement (auto-pausa si inbox% < piso), intervalo (WARMUP_LIVE_INTERVAL_MS, def 4h),
# y KILL-FILE: `touch runtime/warmup-live.kill` pausa el envío al instante; borralo para reanudar.
# Env canónico: config/gateway.env (POSTGRES_URL, CREDENTIAL_ENCRYPTION_KEY, WARMUP_GMAIL_*).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
PID_FILE="${RUNTIME_DIR}/warmup-live.pid"
SCREEN_FILE="${RUNTIME_DIR}/warmup-live.screen"
SCREEN_NAME="${WARMUP_LIVE_SCREEN:-delivrix-warmup-live}"
TODAY="$(date +%Y-%m-%d)"
LOG_FILE="${LOG_DIR}/warmup-live-${TODAY}.log"
CURRENT_LOG="${LOG_DIR}/warmup-live.log"
ENTRYPOINT="apps/warmup-engine/src/service/live-warmup-daemon.ts"

mkdir -p "${LOG_DIR}"

is_alive() { ps -p "$1" >/dev/null 2>&1; }

stop_pid() {
  local pid="$1"
  is_alive "${pid}" || return 0
  kill "${pid}" 2>/dev/null || { echo "Could not SIGTERM ${pid}." >&2; return 1; }
  for _ in {1..20}; do is_alive "${pid}" || return 0; sleep 0.2; done
  kill -9 "${pid}" 2>/dev/null || { echo "Could not SIGKILL ${pid}." >&2; return 1; }
  for _ in {1..20}; do is_alive "${pid}" || return 0; sleep 0.2; done
  echo "PID ${pid} did not stop." >&2; return 1
}

# Detener una corrida previa (screen + pid).
if screen -ls 2>/dev/null | grep -q "[.]${SCREEN_NAME}"; then
  echo "Stopping previous ${SCREEN_NAME} screen..."
  screen -X -S "${SCREEN_NAME}" quit 2>/dev/null || true
  sleep 1
fi
if [[ -f "${PID_FILE}" ]]; then
  existing_pid="$(tr -d '[:space:]' < "${PID_FILE}")"
  if [[ "${existing_pid}" =~ ^[0-9]+$ ]] && is_alive "${existing_pid}"; then
    echo "Stopping previous warmup-live PID ${existing_pid}..."
    stop_pid "${existing_pid}"
  fi
  rm -f "${PID_FILE}"
fi
rm -f "${SCREEN_FILE}"

ln -sfn "$(basename "${LOG_FILE}")" "${CURRENT_LOG}"

ENV_FILE="config/gateway.env"
[[ -f "${ROOT_DIR}/config/gateway.env" ]] || ENV_FILE=".env.local"

{
  echo ""
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting warmup-engine LIVE daemon (autónomo, correo REAL)"
  echo "root=${ROOT_DIR}"
  echo "entrypoint=${ENTRYPOINT}"
  echo "env_file=${ENV_FILE}"
  echo "flag: WARMUP_LIVE_ENABLE=true (barreras: tope diario + gate placement + intervalo + kill-file)"
  echo "log=${LOG_FILE}"
} >> "${LOG_FILE}"

cd "${ROOT_DIR}"
# WARMUP_LIVE_ENABLE se exporta acá tras --env-file para que PISE cualquier valor del archivo:
# correr este script es la decisión explícita de prender el emisor autónomo.
printf -v start_cmd 'cd %q && WARMUP_LIVE_ENABLE=true exec node --env-file=%q %q >> %q 2>&1' \
  "${ROOT_DIR}" "${ENV_FILE}" "${ENTRYPOINT}" "${LOG_FILE}"
screen -dmS "${SCREEN_NAME}" bash -lc "${start_cmd}"
echo "${SCREEN_NAME}" > "${SCREEN_FILE}"

live_pid=""
for _ in {1..30}; do
  live_pid="$(pgrep -f "node .*${ENTRYPOINT}" 2>/dev/null | head -n 1 || true)"
  if [[ -n "${live_pid}" ]]; then echo "${live_pid}" > "${PID_FILE}"; break; fi
  sleep 0.2
done

echo "Warmup-LIVE screen: ${SCREEN_NAME}"
echo "Warmup-LIVE PID: ${live_pid:-pending}"
echo "Mode: LIVE — calentamiento AUTÓNOMO real (barreras activas: tope/placement/intervalo/kill-file)"
echo "Log: ${CURRENT_LOG}"
echo "PARAR EL ENVÍO YA: touch ${RUNTIME_DIR}/warmup-live.kill   (reanudar: rm ese archivo)"
echo "PARAR EL DAEMON: screen -X -S ${SCREEN_NAME} quit"
