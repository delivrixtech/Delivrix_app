#!/usr/bin/env sh
set -eu

SKILL_SLUG="delivrix-publish-proposal"
MODEL_VERSION="us.anthropic.claude-sonnet-4-6"
PROMPT_VERSION="v1"
SCHEMA_VERSION="2026-05-18.v1"
SHARED_AUDIT="/data/.openclaw/skills/_shared/audit-buffer.mjs"
LOCAL_AUDIT="/data/.openclaw/kb/audit/openclaw-skills.jsonl"

RUNBOOK_ID=""
TARGET_REF=""
CATEGORY=""
SEVERITY=""
HEADLINE=""
BODY_TEXT=""
RUNBOOK_REF=""
ACTIONS_CSV=""
EVIDENCE_CSV=""
TOKENS_USED="0"

usage() {
  echo "usage: delivrix-publish-proposal.sh --runbook-id <id> --target-ref <ref> [--headline text] [--body text] [--evidence-ref ref] [--action action]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runbook-id)
      RUNBOOK_ID="${2:-}"
      shift 2
      ;;
    --target-ref)
      TARGET_REF="${2:-}"
      shift 2
      ;;
    --category)
      CATEGORY="${2:-}"
      shift 2
      ;;
    --severity)
      SEVERITY="${2:-}"
      shift 2
      ;;
    --headline)
      HEADLINE="${2:-}"
      shift 2
      ;;
    --body)
      BODY_TEXT="${2:-}"
      shift 2
      ;;
    --runbook-ref)
      RUNBOOK_REF="${2:-}"
      shift 2
      ;;
    --action)
      ACTIONS_CSV="${ACTIONS_CSV}${ACTIONS_CSV:+,}${2:-}"
      shift 2
      ;;
    --actions)
      ACTIONS_CSV="${2:-}"
      shift 2
      ;;
    --evidence-ref)
      EVIDENCE_CSV="${EVIDENCE_CSV}${EVIDENCE_CSV:+,}${2:-}"
      shift 2
      ;;
    --evidence-refs)
      EVIDENCE_CSV="${2:-}"
      shift 2
      ;;
    --tokens-used)
      TOKENS_USED="${2:-0}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -f /etc/openclaw/skills.env ]; then
  # shellcheck disable=SC1091
  set -a
  . /etc/openclaw/skills.env
  set +a
fi

GATEWAY_URL="${DELIVRIX_GATEWAY_URL:-${DELIVRIX_BASE_URL:-http://172.16.0.1:3000}}"

if [ -z "$RUNBOOK_ID" ] || [ -z "$TARGET_REF" ]; then
  usage
  exit 2
fi

if [ -z "${OPENCLAW_HMAC_SECRET:-}" ]; then
  echo "status: failed"
  echo "reason: missing OPENCLAW_HMAC_SECRET"
  exit 2
fi

case "$RUNBOOK_ID" in
  register-sender-node-local)
    CATEGORY="${CATEGORY:-node_register_proposed}"
    SEVERITY="${SEVERITY:-low}"
    RUNBOOK_REF="${RUNBOOK_REF:-register-sender-node-runbook.md}"
    ACTIONS_CSV="${ACTIONS_CSV:-propose_register_sender_node,register_sender_node_local}"
    ;;
  warming-step)
    CATEGORY="${CATEGORY:-warming_step_proposed}"
    SEVERITY="${SEVERITY:-low}"
    RUNBOOK_REF="${RUNBOOK_REF:-warming-step-runbook.md}"
    ACTIONS_CSV="${ACTIONS_CSV:-propose_warming_step,record_human_decision}"
    ;;
  pause-ip)
    CATEGORY="${CATEGORY:-node_pause_proposed}"
    SEVERITY="${SEVERITY:-high}"
    RUNBOOK_REF="${RUNBOOK_REF:-pause-ip-runbook.md}"
    ACTIONS_CSV="${ACTIONS_CSV:-propose_pause_ip,update_sender_node_metadata}"
    ;;
  incident-quarantine)
    CATEGORY="${CATEGORY:-node_quarantine_proposed}"
    SEVERITY="${SEVERITY:-critical}"
    RUNBOOK_REF="${RUNBOOK_REF:-incident-quarantine-runbook.md}"
    ACTIONS_CSV="${ACTIONS_CSV:-propose_quarantine,update_sender_node_metadata}"
    ;;
  *)
    CATEGORY="${CATEGORY:-agent_proposal}"
    SEVERITY="${SEVERITY:-medium}"
    RUNBOOK_REF="${RUNBOOK_REF:-${RUNBOOK_ID}-runbook.md}"
    if [ -z "$ACTIONS_CSV" ]; then
      echo "status: failed"
      echo "reason: --action or --actions required for unknown runbook_id"
      exit 2
    fi
    ;;
esac

HEADLINE="${HEADLINE:-OpenClaw proposal: ${RUNBOOK_ID} for ${TARGET_REF}}"
BODY_TEXT="${BODY_TEXT:-OpenClaw generated a supervised proposal for ${TARGET_REF} using runbook ${RUNBOOK_ID}.}"

case "$TOKENS_USED" in
  ''|*[!0-9]*)
    TOKENS_USED="0"
    ;;
esac

sanitize_id_part() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-'
}

new_uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    date +%s | awk '{ printf "00000000-0000-4000-8000-%012d\n", $1 % 1000000000000 }'
  fi
}

now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

csv_to_json_array() {
  printf '%s' "$1" | jq -R 'split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))'
}

append_local_audit() {
  EVENT="$1"
  mkdir -p "$(dirname "$LOCAL_AUDIT")" 2>/dev/null || true
  printf '%s\n' "$EVENT" >> "$LOCAL_AUDIT" 2>/dev/null || true
  if [ -f "$SHARED_AUDIT" ]; then
    printf '%s' "$EVENT" | node "$SHARED_AUDIT" enqueue >/dev/null 2>&1 || true
  fi
}

flush_audit() {
  if [ -f "$SHARED_AUDIT" ]; then
    node "$SHARED_AUDIT" flush >/dev/null 2>&1 || true
  fi
}

emit_audit() {
  ACTION="$1"
  DECISION="$2"
  METADATA_JSON="$3"
  EVIDENCE_JSON="$4"
  EVENT="$(jq -cn \
    --arg id "$(new_uuid)" \
    --arg occurredAt "$(now_iso)" \
    --arg action "$ACTION" \
    --arg targetId "$TARGET_REF" \
    --arg decision "$DECISION" \
    --arg promptVersion "$PROMPT_VERSION" \
    --arg modelVersion "$MODEL_VERSION" \
    --arg schemaVersion "$SCHEMA_VERSION" \
    --argjson metadata "$METADATA_JSON" \
    --argjson evidenceRefs "$EVIDENCE_JSON" \
    '{
      id: $id,
      occurredAt: $occurredAt,
      actorType: "openclaw",
      actorId: "openclaw-hostinger-prod",
      action: $action,
      targetType: "agent_proposal",
      targetId: $targetId,
      decision: $decision,
      humanApproved: false,
      approverIds: [],
      killSwitchState: "unknown",
      rollbackToken: null,
      schemaVersion: $schemaVersion,
      promptVersion: $promptVersion,
      modelVersion: $modelVersion,
      evidenceRefs: $evidenceRefs,
      metadata: $metadata
    }')"
  append_local_audit "$EVENT"
}

EPOCH="$(date +%s)"
SAFE_RUNBOOK="$(sanitize_id_part "$RUNBOOK_ID")"
SAFE_TARGET="$(sanitize_id_part "$TARGET_REF")"
PROPOSAL_ID="oc.proposal.${EPOCH}.${SAFE_RUNBOOK}.${SAFE_TARGET}"
ACTIONS_JSON="$(csv_to_json_array "$ACTIONS_CSV")"
EVIDENCE_JSON="$(csv_to_json_array "$EVIDENCE_CSV")"
TOKEN_PRESENT="false"
if [ -n "${DELIVRIX_OPENCLAW_TOKEN:-}" ]; then
  TOKEN_PRESENT="true"
fi

emit_audit "oc.skill.publish_proposal.invoke" "n/a" "$(jq -cn \
  --arg runbookId "$RUNBOOK_ID" \
  --arg targetRef "$TARGET_REF" \
  --arg category "$CATEGORY" \
  --arg severity "$SEVERITY" \
  --arg gatewayUrl "$GATEWAY_URL" \
  --argjson actions "$ACTIONS_JSON" \
  --argjson readTokenPresent "$TOKEN_PRESENT" \
  '{runbookId:$runbookId,targetRef:$targetRef,category:$category,severity:$severity,gatewayUrl:$gatewayUrl,actions:$actions,readTokenPresent:$readTokenPresent}')" "$EVIDENCE_JSON"

RAW_BODY="$(jq -cn \
  --arg id "$PROPOSAL_ID" \
  --arg category "$CATEGORY" \
  --arg severity "$SEVERITY" \
  --arg headline "$HEADLINE" \
  --arg body "$BODY_TEXT" \
  --arg runbookRef "$RUNBOOK_REF" \
  --arg targetRef "$TARGET_REF" \
  --arg skillSlug "$SKILL_SLUG" \
  --arg modelVersion "$MODEL_VERSION" \
  --arg promptVersion "$PROMPT_VERSION" \
  --arg schemaVersion "$SCHEMA_VERSION" \
  --argjson actions "$ACTIONS_JSON" \
  --argjson evidenceRefs "$EVIDENCE_JSON" \
  --argjson tokensUsed "$TOKENS_USED" \
  '{
    proposal: {
      id: $id,
      category: $category,
      severity: $severity,
      headline: $headline,
      body: $body,
      evidenceRefs: $evidenceRefs,
      runbookRef: $runbookRef,
      targetRef: $targetRef,
      delivrix_actions_required: $actions
    },
    audit: {
      skillSlug: $skillSlug,
      modelVersion: $modelVersion,
      promptVersion: $promptVersion,
      tokensUsed: $tokensUsed
    },
    schemaVersion: $schemaVersion
  }')"

CANONICAL="${EPOCH}.${RAW_BODY}"
SIGNATURE="$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$OPENCLAW_HMAC_SECRET" -binary | od -An -tx1 | tr -d ' \n')"
RESPONSE_FILE="$(mktemp)"
HTTP_STATUS="$(curl -sS -o "$RESPONSE_FILE" -w "%{http_code}" \
  -X POST "${GATEWAY_URL%/}/v1/agent/proposals" \
  -H "Content-Type: application/json" \
  -H "X-OpenClaw-Signature: $SIGNATURE" \
  -H "X-OpenClaw-Timestamp: $EPOCH" \
  --data-binary "$RAW_BODY" || true)"

RESPONSE_BODY="$(cat "$RESPONSE_FILE" 2>/dev/null || true)"
rm -f "$RESPONSE_FILE" 2>/dev/null || true

RESPONSE_PROPOSAL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.proposalId // empty' 2>/dev/null || true)"
REQUIRED_APPROVALS="$(printf '%s' "$RESPONSE_BODY" | jq -r '.requiredApprovals // empty' 2>/dev/null || true)"
INJECTED_INTO_CANVAS="$(printf '%s' "$RESPONSE_BODY" | jq -r '.injectedIntoCanvas // empty' 2>/dev/null || true)"
REJECT_REASON="$(printf '%s' "$RESPONSE_BODY" | jq -r '.rejectReason // .reason // empty' 2>/dev/null || true)"

if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "202" ]; then
  emit_audit "oc.skill.publish_proposal.completed" "allow" "$(jq -cn \
    --arg httpStatus "$HTTP_STATUS" \
    --arg proposalId "${RESPONSE_PROPOSAL_ID:-$PROPOSAL_ID}" \
    --arg requiredApprovals "${REQUIRED_APPROVALS:-}" \
    --arg injectedIntoCanvas "${INJECTED_INTO_CANVAS:-}" \
    --arg runbookId "$RUNBOOK_ID" \
    --arg targetRef "$TARGET_REF" \
    '{httpStatus:($httpStatus|tonumber),proposalId:$proposalId,requiredApprovals:($requiredApprovals|tonumber? // null),injectedIntoCanvas:($injectedIntoCanvas == "true"),runbookId:$runbookId,targetRef:$targetRef}')" "$EVIDENCE_JSON"
  flush_audit
  echo "status: submitted"
  echo "httpStatus: $HTTP_STATUS"
  echo "proposalId: ${RESPONSE_PROPOSAL_ID:-$PROPOSAL_ID}"
  echo "requiredApprovals: ${REQUIRED_APPROVALS:-unknown}"
  echo "injectedIntoCanvas: ${INJECTED_INTO_CANVAS:-unknown}"
  exit 0
fi

emit_audit "oc.skill.publish_proposal.failed" "reject" "$(jq -cn \
  --arg httpStatus "$HTTP_STATUS" \
  --arg rejectReason "$REJECT_REASON" \
  --arg proposalId "$PROPOSAL_ID" \
  --arg runbookId "$RUNBOOK_ID" \
  --arg targetRef "$TARGET_REF" \
  --arg responseBody "$RESPONSE_BODY" \
  '{httpStatus:($httpStatus|tonumber? // 0),rejectReason:$rejectReason,proposalId:$proposalId,runbookId:$runbookId,targetRef:$targetRef,responseBody:$responseBody}')" "$EVIDENCE_JSON"
flush_audit
echo "status: failed"
echo "httpStatus: $HTTP_STATUS"
echo "proposalId: $PROPOSAL_ID"
if [ -n "$REJECT_REASON" ]; then
  echo "rejectReason: $REJECT_REASON"
fi
exit 1
