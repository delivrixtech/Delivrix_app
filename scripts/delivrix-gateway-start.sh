#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
PID_FILE="${RUNTIME_DIR}/gateway.pid"
SCREEN_FILE="${RUNTIME_DIR}/gateway.screen"
SCREEN_NAME="${GATEWAY_SCREEN:-delivrix-gateway}"
HOST="${GATEWAY_HOST:-127.0.0.1}"
PORT="${GATEWAY_PORT:-3000}"
TODAY="$(date +%Y-%m-%d)"
LOG_FILE="${LOG_DIR}/gateway-${TODAY}.log"
CURRENT_LOG="${LOG_DIR}/gateway.log"

mkdir -p "${LOG_DIR}"

is_alive() {
  local pid="$1"
  ps -p "${pid}" >/dev/null 2>&1
}

command_for_pid() {
  local pid="$1"
  ps -p "${pid}" -o command= 2>/dev/null || true
}

stop_gateway_pid() {
  local pid="$1"
  if ! is_alive "${pid}"; then
    return 0
  fi

  if ! kill "${pid}" 2>/dev/null; then
    echo "Could not send SIGTERM to gateway PID ${pid}." >&2
    return 1
  fi
  for _ in {1..20}; do
    if ! is_alive "${pid}"; then
      return 0
    fi
    sleep 0.2
  done

  if ! kill -9 "${pid}" 2>/dev/null; then
    echo "Could not send SIGKILL to gateway PID ${pid}." >&2
    return 1
  fi
  for _ in {1..20}; do
    if ! is_alive "${pid}"; then
      return 0
    fi
    sleep 0.2
  done

  echo "Gateway PID ${pid} did not stop after SIGKILL." >&2
  return 1
}

if screen -ls 2>/dev/null | grep -q "[.]${SCREEN_NAME}"; then
  echo "Stopping previous ${SCREEN_NAME} screen..."
  screen -X -S "${SCREEN_NAME}" quit 2>/dev/null || true
  sleep 1
fi

if [[ -f "${PID_FILE}" ]]; then
  existing_pid="$(tr -d '[:space:]' < "${PID_FILE}")"
  if [[ "${existing_pid}" =~ ^[0-9]+$ ]] && is_alive "${existing_pid}"; then
    echo "Stopping previous gateway PID ${existing_pid}..."
    stop_gateway_pid "${existing_pid}"
  fi
  rm -f "${PID_FILE}"
fi
rm -f "${SCREEN_FILE}"

port_pid="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
if [[ -n "${port_pid}" ]]; then
  port_command="$(command_for_pid "${port_pid}")"
  port_process="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 { print $1 }')"
  if [[ "${port_command}" == *"apps/gateway-api/src/main.ts"* || "${port_process}" == "node" ]]; then
    echo "Stopping gateway already bound to :${PORT} (PID ${port_pid})..."
    stop_gateway_pid "${port_pid}"
  else
    echo "Port ${PORT} is already in use by PID ${port_pid}: ${port_command}" >&2
    echo "Not killing an unknown process. Stop it manually or change GATEWAY_PORT." >&2
    exit 1
  fi
fi

ln -sfn "$(basename "${LOG_FILE}")" "${CURRENT_LOG}"

{
  echo ""
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting gateway-api on http://${HOST}:${PORT}"
  echo "root=${ROOT_DIR}"
  echo "log=${LOG_FILE}"
} >> "${LOG_FILE}"

cd "${ROOT_DIR}"
# Env canonico: config/gateway.env (blindado -- Vercel CLI solo pisa .env.local).
# Fallback a .env.local si el blindado no existe. main.ts resuelve igual para el reloader.
ENV_FILE="config/gateway.env"
[[ -f "${ROOT_DIR}/config/gateway.env" ]] || ENV_FILE=".env.local"
echo "env_file=${ENV_FILE}" >> "${LOG_FILE}"
printf -v start_cmd 'cd %q && exec node --env-file=%q apps/gateway-api/src/main.ts >> %q 2>&1' "${ROOT_DIR}" "${ENV_FILE}" "${LOG_FILE}"
screen -dmS "${SCREEN_NAME}" bash -lc "${start_cmd}"
echo "${SCREEN_NAME}" > "${SCREEN_FILE}"

gateway_pid=""
for _ in {1..30}; do
  gateway_pid="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [[ -n "${gateway_pid}" ]]; then
    echo "${gateway_pid}" > "${PID_FILE}"
    break
  fi
  sleep 0.2
done

echo "Gateway screen: ${SCREEN_NAME}"
echo "Gateway PID: ${gateway_pid:-pending}"
echo "Health: http://${HOST}:${PORT}/health"
echo "Log: ${CURRENT_LOG}"
