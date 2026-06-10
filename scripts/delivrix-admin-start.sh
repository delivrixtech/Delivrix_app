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
NODE_BIN_DIR="${NODE_BIN_DIR:-}"
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

screen_session_exists() {
  local name="$1"
  local listing
  listing="$(screen -ls 2>/dev/null || true)"
  [[ "${listing}" == *".${name}"* ]]
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

load_admin_proxy_env() {
  local env_file="$1"
  [[ -f "${env_file}" ]] || return 0

  local line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "${line}" =~ ^[[:space:]]*# ]] && continue
    [[ "${line}" == *"="* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    case "${key}" in
      ADMIN_PANEL_GATEWAY_ORIGIN|CANVAS_LIVE_STREAM_TOKEN|GATEWAY_LOG_STREAM_TOKEN|DELIVRIX_READ_BOUNDARY_TOKEN|DELIVRIX_OPENCLAW_TOKEN|OPENCLAW_GATEWAY_TOKEN|VITE_CANVAS_LIVE_STREAM_TOKEN|VITE_GATEWAY_LOG_STREAM_TOKEN|VITE_DELIVRIX_READ_BOUNDARY_TOKEN|VITE_DELIVRIX_OPENCLAW_TOKEN)
        if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
          value="${value:1:${#value}-2}"
        fi
        export "${key}=${value}"
        ;;
    esac
  done < "${env_file}"
}

load_admin_proxy_env "${ROOT_DIR}/.env.local"

if [[ -z "${NODE_BIN_DIR}" ]]; then
  if [[ -x "${HOME}/.nvm/versions/node/v24.15.0/bin/node" ]]; then
    NODE_BIN_DIR="${HOME}/.nvm/versions/node/v24.15.0/bin"
  else
    NODE_BIN_DIR="$(dirname "$(command -v node)")"
  fi
fi

# --- Token efectivo del Canvas Live WS (espejo del fallback de vite.config.ts) ---
# El proxy resuelve canvasLiveProxyToken = CANVAS_LIVE_STREAM_TOKEN ?? DELIVRIX_READ_BOUNDARY_TOKEN ?? OPENCLAW_GATEWAY_TOKEN
# Fail-fast: nunca lanzar un panel cuyo WS no pueda autenticar (= "reconnecting" perpetuo).
CANVAS_LIVE_EFFECTIVE_TOKEN="${CANVAS_LIVE_STREAM_TOKEN:-${DELIVRIX_READ_BOUNDARY_TOKEN:-${OPENCLAW_GATEWAY_TOKEN:-}}}"
if [[ -z "${CANVAS_LIVE_EFFECTIVE_TOKEN}" ]]; then
  echo "FATAL: no hay token para el Canvas Live WS." >&2
  echo "  Definí CANVAS_LIVE_STREAM_TOKEN (o DELIVRIX_READ_BOUNDARY_TOKEN u OPENCLAW_GATEWAY_TOKEN) en ${ROOT_DIR}/.env.local antes de arrancar el panel." >&2
  exit 1
fi
GATEWAY_LOG_EFFECTIVE_TOKEN="${GATEWAY_LOG_STREAM_TOKEN:-${DELIVRIX_OPENCLAW_TOKEN:-${DELIVRIX_READ_BOUNDARY_TOKEN:-${OPENCLAW_GATEWAY_TOKEN:-}}}}"
ADMIN_PANEL_GATEWAY_ORIGIN_EFFECTIVE="${ADMIN_PANEL_GATEWAY_ORIGIN:-http://127.0.0.1:3000}"

if screen_session_exists "${SCREEN_NAME}"; then
  echo "Stopping previous ${SCREEN_NAME} screen..."
  screen -X -S "${SCREEN_NAME}" quit 2>/dev/null || true
  for _ in {1..50}; do
    ! screen_session_exists "${SCREEN_NAME}" && break
    sleep 0.2
  done
  if screen_session_exists "${SCREEN_NAME}"; then
    echo "Screen '${SCREEN_NAME}' sigue vivo tras ~10s. Abortando." >&2
    exit 1
  fi
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
  port_process="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 { print $1 }' || true)"
  if [[ "${port_command}" == *"vite"* || "${port_command}" == *"apps/admin-panel"* || "${port_process}" == "node" ]]; then
    echo "Stopping admin panel already bound to :${PORT} (PID ${port_pid})..."
    stop_admin_pid "${port_pid}"
  else
    echo "Port ${PORT} is already in use by PID ${port_pid}: ${port_command}" >&2
    echo "Not killing an unknown process. Stop it manually or change ADMIN_PANEL_PORT." >&2
    exit 1
  fi

  # Esperar a que :PORT quede realmente libre antes de que Vite haga bind
  # (evita EADDRINUSE y que Vite con strictPort:false agarre :PORT+1 en silencio).
  for _ in {1..50}; do
    [[ -z "$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)" ]] && break
    sleep 0.2
  done
  if [[ -n "$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)" ]]; then
    echo "Puerto ${PORT} sigue ocupado tras ~10s. Abortando." >&2
    exit 1
  fi
fi

ln -sfn "$(basename "${LOG_FILE}")" "${CURRENT_LOG}"

{
  echo ""
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting admin-panel on http://${HOST}:${PORT}"
  echo "root=${ROOT_DIR}"
  echo "log=${LOG_FILE}"
  echo "node_bin=${NODE_BIN_DIR}"
} >> "${LOG_FILE}"

printf -v start_cmd 'export PATH=%q:"$PATH"; export ADMIN_PANEL_HOST=%q; export ADMIN_PANEL_PORT=%q; export ADMIN_PANEL_GATEWAY_ORIGIN=%q; export CANVAS_LIVE_STREAM_TOKEN=%q; export GATEWAY_LOG_STREAM_TOKEN=%q; export DELIVRIX_READ_BOUNDARY_TOKEN=%q; export DELIVRIX_OPENCLAW_TOKEN=%q; export OPENCLAW_GATEWAY_TOKEN=%q; export VITE_CANVAS_LIVE_STREAM_TOKEN=%q; export VITE_GATEWAY_LOG_STREAM_TOKEN=%q; export VITE_DELIVRIX_READ_BOUNDARY_TOKEN=%q; export VITE_DELIVRIX_OPENCLAW_TOKEN=%q; cd %q && while true; do npm run dev; echo "[auto-restart] panel Vite cayo; relanzando en 3s..."; sleep 3; done >> %q 2>&1' \
  "${NODE_BIN_DIR}" "${HOST}" "${PORT}" \
  "${ADMIN_PANEL_GATEWAY_ORIGIN_EFFECTIVE}" \
  "${CANVAS_LIVE_EFFECTIVE_TOKEN}" "${GATEWAY_LOG_EFFECTIVE_TOKEN}" \
  "${DELIVRIX_READ_BOUNDARY_TOKEN:-}" "${DELIVRIX_OPENCLAW_TOKEN:-}" "${OPENCLAW_GATEWAY_TOKEN:-}" \
  "${VITE_CANVAS_LIVE_STREAM_TOKEN:-}" "${VITE_GATEWAY_LOG_STREAM_TOKEN:-}" \
  "${VITE_DELIVRIX_READ_BOUNDARY_TOKEN:-}" "${VITE_DELIVRIX_OPENCLAW_TOKEN:-}" \
  "${APP_DIR}" "${LOG_FILE}"
screen -dmS "${SCREEN_NAME}" bash -lc "${start_cmd}"
echo "${SCREEN_NAME}" > "${SCREEN_FILE}"

admin_pid=""
# Hasta ~60s: (a) verifica que el screen siga vivo, (b) que el puerto escuche.
# screen -ls / lsof / grep / curl devuelven !=0 en casos normales -> TODOS guardados bajo set -euo pipefail.
for _ in {1..60}; do
  if ! screen_session_exists "${SCREEN_NAME}"; then
    echo "El screen '${SCREEN_NAME}' murió durante el arranque." >&2
    echo "--- últimas 40 líneas de ${LOG_FILE} ---" >&2
    tail -n 40 "${LOG_FILE}" >&2 2>/dev/null || true
    exit 1
  fi
  admin_pid="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [[ -n "${admin_pid}" ]]; then
    if command -v curl >/dev/null 2>&1; then
      if ! curl -fsS -o /dev/null --max-time 2 "http://${HOST}:${PORT}/" 2>/dev/null; then
        sleep 1
        continue
      fi
    fi
    echo "${admin_pid}" > "${PID_FILE}"
    break
  fi
  sleep 1
done

if [[ -z "${admin_pid}" ]]; then
  echo "El panel no quedó listo en :${PORT} tras ~60s." >&2
  echo "--- últimas 40 líneas de ${LOG_FILE} ---" >&2
  tail -n 40 "${LOG_FILE}" >&2 2>/dev/null || true
  exit 1
fi

echo "Admin panel screen: ${SCREEN_NAME}"
echo "Admin panel PID: ${admin_pid:-pending}"
echo "URL: http://${HOST}:${PORT}/"
echo "Log: ${CURRENT_LOG}"
