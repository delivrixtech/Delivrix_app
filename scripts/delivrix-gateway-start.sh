#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
PID_FILE="${RUNTIME_DIR}/gateway.pid"
HOST="${GATEWAY_HOST:-127.0.0.1}"
PORT="${GATEWAY_PORT:-3000}"
TODAY="$(date +%Y-%m-%d)"
LOG_FILE="${LOG_DIR}/gateway-${TODAY}.log"
CURRENT_LOG="${LOG_DIR}/gateway.log"

mkdir -p "${LOG_DIR}"

is_alive() {
  local pid="$1"
  kill -0 "${pid}" 2>/dev/null
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

  kill "${pid}" 2>/dev/null || true
  for _ in {1..20}; do
    if ! is_alive "${pid}"; then
      return 0
    fi
    sleep 0.2
  done

  echo "Gateway PID ${pid} did not stop after SIGTERM." >&2
  return 1
}

if [[ -f "${PID_FILE}" ]]; then
  existing_pid="$(tr -d '[:space:]' < "${PID_FILE}")"
  if [[ "${existing_pid}" =~ ^[0-9]+$ ]] && is_alive "${existing_pid}"; then
    echo "Stopping previous gateway PID ${existing_pid}..."
    stop_gateway_pid "${existing_pid}"
  fi
  rm -f "${PID_FILE}"
fi

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
nohup node --env-file=.env.local apps/gateway-api/src/main.ts >> "${LOG_FILE}" 2>&1 < /dev/null &
gateway_pid="$!"
disown "${gateway_pid}" 2>/dev/null || true
echo "${gateway_pid}" > "${PID_FILE}"

echo "Gateway PID: ${gateway_pid}"
echo "Health: http://${HOST}:${PORT}/health"
echo "Log: ${CURRENT_LOG}"
