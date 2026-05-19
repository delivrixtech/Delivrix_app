#!/usr/bin/env bash
# Delivrix OpenClaw KB nightly reindex.
# macOS cron runs local time; install helper schedules 22:00 America/Bogota,
# equivalent to 03:00 UTC while timezone remains UTC-5.

set -euo pipefail

WORKTREE="${WORKTREE:-/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de}"
SSH_KEY="${SSH_KEY:-${WORKTREE}/../../../clonado/.ssh/openclaw_delivrix}"
SSH_HOST="${SSH_HOST:-root@2.24.223.240}"
CONTAINER="${CONTAINER:-openclaw-dtsf-openclaw-1}"
REMOTE_TMP="${REMOTE_TMP:-/tmp/delivrix-openclaw-kb}"
AUDIT_DIR="${WORKTREE}/.audit"
LAST_INDEXED_FILE="${AUDIT_DIR}/kb-last-indexed-commit"

mkdir -p "${AUDIT_DIR}"

CURRENT_COMMIT="$(cd "${WORKTREE}" && git rev-parse HEAD)"
LAST_COMMIT="$(cat "${LAST_INDEXED_FILE}" 2>/dev/null || true)"

if [ "${FORCE_REINDEX:-0}" != "1" ] && [ "${CURRENT_COMMIT}" = "${LAST_COMMIT}" ]; then
  echo "ok: no changes since last KB reindex (${CURRENT_COMMIT})"
  exit 0
fi

ARCHIVE="/tmp/delivrix-openclaw-kb-source-${CURRENT_COMMIT}.tgz"
tar -C "${WORKTREE}" -czf "${ARCHIVE}" DOCUMENTACION scripts/openclaw

ssh -i "${SSH_KEY}" "${SSH_HOST}" "mkdir -p '${REMOTE_TMP}'"
scp -i "${SSH_KEY}" "${ARCHIVE}" "${SSH_HOST}:${REMOTE_TMP}/kb-source.tgz" >/dev/null
ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker exec '${CONTAINER}' sh -lc 'rm -rf /data/.openclaw/kb/source /openclaw/scripts; mkdir -p /data/.openclaw/kb/source /openclaw/scripts /data/.openclaw/kb/audit'"
ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker cp '${REMOTE_TMP}/kb-source.tgz' '${CONTAINER}:/tmp/kb-source.tgz'"
ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker exec '${CONTAINER}' sh -lc 'tar -xzf /tmp/kb-source.tgz -C /data/.openclaw/kb/source; cp /data/.openclaw/kb/source/scripts/openclaw/*.py /openclaw/scripts/; chmod +x /openclaw/scripts/*.py'"
ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker exec '${CONTAINER}' python3 /openclaw/scripts/index-kb-capa2.py"
ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker exec '${CONTAINER}' python3 /openclaw/scripts/eval-recall.py --json-out /data/.openclaw/kb/audit/recall-latest.json"

echo "${CURRENT_COMMIT}" > "${LAST_INDEXED_FILE}"

python3 - "$CURRENT_COMMIT" "$LAST_COMMIT" <<'PY' >> "${AUDIT_DIR}/openclaw-kb.jsonl"
import json, sys, uuid
from datetime import datetime, timezone
current, previous = sys.argv[1:3]
print(json.dumps({
    "id": str(uuid.uuid4()),
    "occurredAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "actorType": "system",
    "actorId": "codex@cron",
    "action": "oc.kb.reindex_completed",
    "targetType": "openclaw_kb_capa2",
    "targetId": "delivrix-docs",
    "decision": "n/a",
    "schemaVersion": "2026-05-18.v1",
    "metadata": {"sourceCommit": current, "previousCommit": previous},
    "prevHash": "PENDING_CHAIN_BOOTSTRAP",
    "hash": "PENDING_CHAIN_BOOTSTRAP"
}, ensure_ascii=False))
PY

echo "ok: KB reindex completed for ${CURRENT_COMMIT}"
