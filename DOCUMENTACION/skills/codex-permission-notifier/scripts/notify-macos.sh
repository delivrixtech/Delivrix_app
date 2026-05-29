#!/usr/bin/env bash
set -euo pipefail

title="${1:-Codex needs permission}"
message="${2:-A Codex session is waiting for approval.}"
sound="${CODEX_PERMISSION_NOTIFY_SOUND:-Glass}"

escape_osa() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

escaped_title="$(escape_osa "$title")"
escaped_message="$(escape_osa "$message")"
escaped_sound="$(escape_osa "$sound")"

if [ "${CODEX_PERMISSION_NOTIFY_DRY_RUN:-}" = "1" ]; then
  printf 'notification: %s -- %s\n' "$title" "$message"
  exit 0
fi

/usr/bin/osascript \
  -e "display notification \"${escaped_message}\" with title \"${escaped_title}\" sound name \"${escaped_sound}\""
