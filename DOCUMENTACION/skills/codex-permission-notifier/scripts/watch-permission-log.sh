#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  printf 'usage: %s /path/to/session.log\n' "$0" >&2
  exit 2
fi

log_file="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
notify_script="${script_dir}/notify-macos.sh"
debounce_seconds="${CODEX_PERMISSION_NOTIFY_DEBOUNCE_SECONDS:-90}"
buffer_file="${TMPDIR:-/tmp}/codex-permission-buffer-$$.txt"
last_fingerprint=""
last_epoch=0

cleanup() {
  rm -f "$buffer_file" "$buffer_file.tmp"
}
trap cleanup EXIT INT TERM

mkdir -p "$(dirname "$log_file")"
touch "$log_file"
: > "$buffer_file"

strip_ansi() {
  perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g'
}

detect_prompt_line() {
  case "$1" in
    *"Would you like to run the following command?"*) return 0 ;;
    *"Yes, proceed"*) return 0 ;;
    *"No, and tell Codex what to do differently"*) return 0 ;;
    *"Press enter to confirm or esc to cancel"*) return 0 ;;
    *) return 1 ;;
  esac
}

notify_if_needed() {
  local now reason command_line fingerprint message
  now="$(date +%s)"
  reason="$(grep -E 'Reason:' "$buffer_file" | tail -n 1 | sed -E 's/^.*Reason:[[:space:]]*//' || true)"
  command_line="$(grep -E '^[[:space:]]*\$[[:space:]]+' "$buffer_file" | tail -n 1 | sed -E 's/^[[:space:]]*\$[[:space:]]+//' || true)"

  fingerprint="${command_line}|${reason}"
  if [ -z "$fingerprint" ] || [ "$fingerprint" = "|" ]; then
    fingerprint="$(tail -n 4 "$buffer_file" | tr '\n' ' ')"
  fi

  if [ "$fingerprint" = "$last_fingerprint" ] && [ $((now - last_epoch)) -lt "$debounce_seconds" ]; then
    return 0
  fi

  last_fingerprint="$fingerprint"
  last_epoch="$now"

  if [ -n "$command_line" ] && [ -n "$reason" ]; then
    message="Command: ${command_line} Reason: ${reason}"
  elif [ -n "$command_line" ]; then
    message="Command: ${command_line}"
  else
    message="A Codex terminal is waiting at a permission prompt."
  fi

  "$notify_script" "Codex is waiting for permission" "$message"
}

tail -n 0 -F "$log_file" | while IFS= read -r raw_line; do
  clean_line="$(printf '%s\n' "$raw_line" | strip_ansi)"
  printf '%s\n' "$clean_line" >> "$buffer_file"
  tail -n 18 "$buffer_file" > "$buffer_file.tmp"
  mv "$buffer_file.tmp" "$buffer_file"

  if detect_prompt_line "$clean_line"; then
    if [[ "$clean_line" == *"Would you like to run the following command?"* ]] &&
      ! grep -Eq 'Reason:|^[[:space:]]*\$[[:space:]]+' "$buffer_file"; then
      continue
    fi
    notify_if_needed
  fi
done
