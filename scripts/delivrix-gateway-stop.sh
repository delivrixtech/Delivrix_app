#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${ROOT_DIR}/runtime/gateway.pid"

is_alive() {
  local pid="$1"
  kill -0 "${pid}" 2>/dev/null
}

if [[ ! -f "${PID_FILE}" ]]; then
  echo "No gateway PID file found at ${PID_FILE}."
  exit 0
fi

pid="$(tr -d '[:space:]' < "${PID_FILE}")"
if [[ ! "${pid}" =~ ^[0-9]+$ ]]; then
  echo "Invalid gateway PID file; removing ${PID_FILE}."
  rm -f "${PID_FILE}"
  exit 0
fi

if ! is_alive "${pid}"; then
  echo "Gateway PID ${pid} is not running; removing stale PID file."
  rm -f "${PID_FILE}"
  exit 0
fi

echo "Stopping gateway PID ${pid}..."
kill "${pid}" 2>/dev/null || true
for _ in {1..20}; do
  if ! is_alive "${pid}"; then
    rm -f "${PID_FILE}"
    echo "Gateway stopped."
    exit 0
  fi
  sleep 0.2
done

echo "Gateway PID ${pid} did not stop after SIGTERM." >&2
exit 1
