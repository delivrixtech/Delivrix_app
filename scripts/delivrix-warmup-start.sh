#!/usr/bin/env bash
set -euo pipefail

# Lanzador del DAEMON DRY-RUN del warmup-engine. Espeja delivrix-gateway-start.sh (screen + pid + log).
# SEGURIDAD: fuerza WARMUP_TRANSPORT=mock (cero correo real) y sólo habilita el engine con
# WARMUP_ENGINE_ENABLE=true. El entrypoint (dryrun-daemon.ts) además ASERTA mock y rehúsa arrancar si
# alguien pasara postfix. Env canónico: config/gateway.env (fallback .env.local) — de ahí sale POSTGRES_URL.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
PID_FILE="${RUNTIME_DIR}/warmup.pid"
SCREEN_FILE="${RUNTIME_DIR}/warmup.screen"
SCREEN_NAME="${WARMUP_SCREEN:-delivrix-warmup}"
TODAY="$(date +%Y-%m-%d)"
LOG_FILE="${LOG_DIR}/warmup-${TODAY}.log"
CURRENT_LOG="${LOG_DIR}/warmup.log"
ENTRYPOINT="apps/warmup-engine/src/service/dryrun-daemon.ts"

mkdir -p "${LOG_DIR}"

is_alive() {
  local pid="$1"
  ps -p "${pid}" >/dev/null 2>&1
}

stop_warmup_pid() {
  local pid="$1"
  if ! is_alive "${pid}"; then
    return 0
  fi
  if ! kill "${pid}" 2>/dev/null; then
    echo "Could not send SIGTERM to warmup PID ${pid}." >&2
    return 1
  fi
  for _ in {1..20}; do
    if ! is_alive "${pid}"; then
      return 0
    fi
    sleep 0.2
  done
  if ! kill -9 "${pid}" 2>/dev/null; then
    echo "Could not send SIGKILL to warmup PID ${pid}." >&2
    return 1
  fi
  for _ in {1..20}; do
    if ! is_alive "${pid}"; then
      return 0
    fi
    sleep 0.2
  done
  echo "Warmup PID ${pid} did not stop after SIGKILL." >&2
  return 1
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
    echo "Stopping previous warmup PID ${existing_pid}..."
    stop_warmup_pid "${existing_pid}"
  fi
  rm -f "${PID_FILE}"
fi
rm -f "${SCREEN_FILE}"

ln -sfn "$(basename "${LOG_FILE}")" "${CURRENT_LOG}"

# Env canonico: config/gateway.env (blindado). Fallback a .env.local.
ENV_FILE="config/gateway.env"
[[ -f "${ROOT_DIR}/config/gateway.env" ]] || ENV_FILE=".env.local"

{
  echo ""
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting warmup-engine DRY-RUN daemon"
  echo "root=${ROOT_DIR}"
  echo "entrypoint=${ENTRYPOINT}"
  echo "env_file=${ENV_FILE}"
  echo "flags: WARMUP_ENGINE_ENABLE=true WARMUP_TRANSPORT=mock (cero correo real)"
  echo "log=${LOG_FILE}"
} >> "${LOG_FILE}"

cd "${ROOT_DIR}"
# WARMUP_ENGINE_ENABLE/WARMUP_TRANSPORT se exportan aquí para GARANTIZAR dry-run aunque el env_file no los fije.
# Se pasan tras --env-file para que PISEN cualquier valor del archivo (safety: nunca postfix desde este script).
printf -v start_cmd 'cd %q && WARMUP_ENGINE_ENABLE=true WARMUP_TRANSPORT=mock exec node --env-file=%q %q >> %q 2>&1' \
  "${ROOT_DIR}" "${ENV_FILE}" "${ENTRYPOINT}" "${LOG_FILE}"
screen -dmS "${SCREEN_NAME}" bash -lc "${start_cmd}"
echo "${SCREEN_NAME}" > "${SCREEN_FILE}"

# Capturar el PID del proceso node del screen (no hay puerto que sondear como en el gateway).
warmup_pid=""
for _ in {1..30}; do
  warmup_pid="$(pgrep -f "node .*${ENTRYPOINT}" 2>/dev/null | head -n 1 || true)"
  if [[ -n "${warmup_pid}" ]]; then
    echo "${warmup_pid}" > "${PID_FILE}"
    break
  fi
  sleep 0.2
done

echo "Warmup screen: ${SCREEN_NAME}"
echo "Warmup PID: ${warmup_pid:-pending}"
echo "Mode: DRY-RUN (WARMUP_TRANSPORT=mock, sends zero real mail)"
echo "Log: ${CURRENT_LOG}"
echo "Tip: para un tick único de verificacion: WARMUP_ENGINE_ENABLE=true node --env-file=${ENV_FILE} ${ENTRYPOINT} --once"
