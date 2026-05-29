#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log_dir="${CODEX_PERMISSION_NOTIFY_LOG_DIR:-$HOME/.codex/permission-notifier}"
timestamp="$(date +%Y%m%d-%H%M%S)"
log_file="${log_dir}/session-${timestamp}.log"

mkdir -p "$log_dir"

"${script_dir}/watch-permission-log.sh" "$log_file" &
watcher_pid=$!

cleanup() {
  if kill -0 "$watcher_pid" 2>/dev/null; then
    kill "$watcher_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

printf 'Codex permission notifier is watching: %s\n' "$log_file" >&2

if [ "$#" -eq 0 ]; then
  script -q -F -t 0 "$log_file" "${SHELL:-/bin/zsh}" -l
else
  script -q -F -t 0 "$log_file" "$@"
fi
