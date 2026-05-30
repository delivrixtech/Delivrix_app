#!/usr/bin/env bash
# Smoke E2E paso 1 — submit propuesta register_domain_route53
# NO firma. Solo crea la propuesta. La firma queda como paso separado.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== 1. Health gateway ==="
curl -s http://127.0.0.1:3000/health | jq -r '"status: " + .status, "killSwitch: " + (.killSwitch.enabled | tostring)'

echo ""
echo "=== 2. Audit chain pre-smoke ==="
curl -s http://127.0.0.1:3000/v1/audit-chain/verify | jq

echo ""
echo "=== 3. Anchor baseline ==="
curl -s http://127.0.0.1:3000/v1/audit-chain/anchor | tee runtime/audit-anchor-sabado-baseline.json | jq

echo ""
echo "=== 4. HMAC + timestamp ==="
SECRET=$(grep '^OPENCLAW_HMAC_SECRET=' .env.local | cut -d= -f2-)
if [ -z "$SECRET" ]; then
  echo "ERROR: OPENCLAW_HMAC_SECRET vacio en .env.local"
  exit 1
fi
TS=$(date +%s)
PROPOSAL_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
echo "Timestamp: $TS"
echo "Proposal UUID: $PROPOSAL_ID"
echo "Secret length: ${#SECRET}"

PROPOSAL_BODY='{"schemaVersion":"2026-05-18.v1","proposal":{"id":"'"$PROPOSAL_ID"'","skillSlug":"register_domain_route53","category":"supervised_local_state","severity":"high","headline":"Registrar dominio delivrix-notify.com en AWS Route53","body":"Smoke E2E paso 1 sabado 2026-05-30 - registrar dominio descartable delivrix-notify.com con AWS Route53 por 1 anio sin auto-renew. Costo aproximado 15 USD. Operador firmante: juanescanar-cto.","runbookRef":"register_domain","targetRef":{"type":"domain","id":"delivrix-notify.com"},"params":{"domain":"delivrix-notify.com","years":1,"autoRenew":false},"delivrix_actions_required":["register_domain_route53"]},"audit":{"skillSlug":"register_domain_route53","modelVersion":"claude-sonnet-4-6","promptVersion":"smoke-e2e-paso-1-sabado","tokensUsed":0}}'

SIGN_INPUT="${TS}.${PROPOSAL_BODY}"
SIG=$(printf '%s' "$SIGN_INPUT" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
echo "SIG: $SIG"

echo ""
echo "=== 5. Submit propuesta ==="
RESPONSE=$(curl -s -X POST http://127.0.0.1:3000/v1/agent/proposals \
  -H "Content-Type: application/json" \
  -H "X-OpenClaw-Signature: $SIG" \
  -H "X-OpenClaw-Timestamp: $TS" \
  -d "$PROPOSAL_BODY")

echo "$RESPONSE" | jq

NEW_PID=$(echo "$RESPONSE" | jq -r '.proposalId // empty')

echo ""
echo "=== 6. Resultado ==="
if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "null" ]; then
  echo "OK proposalId: $NEW_PID"
  echo "$NEW_PID" > runtime/last-proposal-id.txt
  echo "Guardado en runtime/last-proposal-id.txt"
  echo ""
  echo "STOP aqui. Para firmar y disparar los 15 USD, corre:"
  echo "  bash scripts/smoke-paso-1-firmar.sh"
else
  echo "FAIL: $RESPONSE"
  exit 1
fi
