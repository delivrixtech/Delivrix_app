#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ROOT_DIR}/apps/admin-panel"
RUNTIME_DIR="${ROOT_DIR}/runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
PID_FILE="${RUNTIME_DIR}/admin-panel.pid"
SCREEN_FILE="${RUNTIME_DIR}/admin-panel.screen"
SCREEN_NAME="${ADMIN_PANEL_SCREEN:-delivrix-admin}"
HOST="${ADMIN_PANEL_HOST:-127.0.0.1}"
PORT="${ADMIN_PANEL_PORT:-5173}"
TODAY="$(date +%Y-%m-%d)"
LOG_FILE="${LOG_DIR}/admin-panel-${TODAY}.log"
CURRENT_LOG="${LOG_DIR}/admin-panel.log"

mkdir -p "${LOG_DIR}"

is_alive() {
  local pid="$1"
  kill -0 "${pid}" 2>/dev/null
}

command_for_pid() {
  local pid="$1"
  ps -p "${pid}" -o command= 2>/dev/null || true
}

stop_admin_pid() {
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

  echo "Admin panel PID ${pid} did not stop after SIGTERM." >&2
  return 1
}

if screen -ls 2>/dev/null | grep -q "[.]${SCREEN_NAME}[[:space:]]"; then
  echo "Stopping previous ${SCREEN_NAME} screen..."
  screen -X -S "${SCREEN_NAME}" quit 2>/dev/null || true
  sleep 1
fi

if [[ -f "${PID_FILE}" ]]; then
  existing_pid="$(tr -d '[:space:]' < "${PID_FILE}")"
  if [[ "${existing_pid}" =~ ^[0-9]+$ ]] && is_alive "${existing_pid}"; then
    echo "Stopping previous admin panel PID ${existing_pid}..."
    stop_admin_pid "${existing_pid}"
  fi
  rm -f "${PID_FILE}"
fi
rm -f "${SCREEN_FILE}"

port_pid="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
if [[ -n "${port_pid}" ]]; then
  port_command="$(command_for_pid "${port_pid}")"
  port_process="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 { print $1 }')"
  if [[ "${port_command}" == *"vite"* || "${port_command}" == *"apps/admin-panel"* || "${port_process}" == "node" ]]; then
    echo "Stopping admin panel already bound to :${PORT} (PID ${port_pid})..."
    stop_admin_pid "${port_pid}"
  else
    echo "Port ${PORT} is already in use by PID ${port_pid}: ${port_command}" >&2
    echo "Not killing an unknown process. Stop it manually or change ADMIN_PANEL_PORT." >&2
    exit 1
  fi
fi

ln -sfn "$(basename "${LOG_FILE}")" "${CURRENT_LOG}"

{
  echo ""
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting admin-panel on http://${HOST}:${PORT}"
  echo "root=${ROOT_DIR}"
  echo "log=${LOG_FILE}"
} >> "${LOG_FILE}"

printf -v start_cmd 'cd %q && npm run dev >> %q 2>&1' "${APP_DIR}" "${LOG_FILE}"
screen -dmS "${SCREEN_NAME}" bash -lc "${start_cmd}"
echo "${SCREEN_NAME}" > "${SCREEN_FILE}"

echo "Admin panel screen: ${SCREEN_NAME}"
echo "URL: http://${HOST}:${PORT}/"
echo "Log: ${CURRENT_LOG}"
