#!/usr/bin/env bash
# Smoke E2E paso 3 — submit propuesta create_webdock_server
# NO firma. Solo crea la propuesta. La firma queda como paso separado.
# Profile bit = vps-xeon-essential-2025 (Essential ~$4.30/mes)
# Es independiente del estado del dominio Route53 (paso 1 puede estar pending).

set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== 1. Health gateway ==="
curl -s http://127.0.0.1:3000/health | jq -r '"status: " + .status, "killSwitch: " + (.killSwitch.enabled | tostring)'

echo ""
echo "=== 2. Audit chain pre-paso3 ==="
curl -s http://127.0.0.1:3000/v1/audit-chain/verify | jq

echo ""
echo "=== 3. Anchor baseline paso3 ==="
curl -s http://127.0.0.1:3000/v1/audit-chain/anchor | tee runtime/audit-anchor-paso-3-baseline.json | jq

echo ""
echo "=== 4. HMAC + timestamp ==="
SECRET=$(grep '^OPENCLAW_HMAC_SECRET=' .env.local | cut -d= -f2-)
if [ -z "$SECRET" ]; then
  echo "ERROR: OPENCLAW_HMAC_SECRET vacio en .env.local"
  exit 1
fi
TS=$(date +%s)
PROPOSAL_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
HOSTNAME_SLUG="mail.delivrix-notify.com"
echo "Timestamp: $TS"
echo "Proposal UUID: $PROPOSAL_ID"
echo "Hostname target: $HOSTNAME_SLUG"
echo "Profile: bit (Essential, ~\$4.30/mes)"
echo "Image: ubuntu-2404"
echo "Location: dk (Denmark)"
echo "Secret length: ${#SECRET}"

PROPOSAL_BODY='{"schemaVersion":"2026-05-18.v1","proposal":{"id":"'"$PROPOSAL_ID"'","skillSlug":"create_webdock_server","category":"supervised_local_state","severity":"high","headline":"Crear VPS Webdock Essential para delivrix-notify.com","body":"Smoke E2E paso 3 sabado 2026-05-30 - aprovisionar VPS Bit (Essential, vps-xeon-essential-2025) en location dk con Ubuntu 24.04 para hostear Postfix de delivrix-notify.com. Costo aproximado 4.30 USD por mes. Operador firmante: juanescanar-cto.","runbookRef":"create_webdock_server","targetRef":{"type":"server","id":"'"$HOSTNAME_SLUG"'"},"params":{"profile":"bit","imageSlug":"ubuntu-2404","locationId":"dk","hostname":"'"$HOSTNAME_SLUG"'"},"delivrix_actions_required":["create_webdock_server"]},"audit":{"skillSlug":"create_webdock_server","modelVersion":"claude-sonnet-4-6","promptVersion":"smoke-e2e-paso-3-sabado","tokensUsed":0}}'

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
  echo "$NEW_PID" > runtime/last-proposal-id-paso3.txt
  echo "Guardado en runtime/last-proposal-id-paso3.txt"
  echo ""
  echo "STOP aqui. Para firmar y disparar la creacion VPS, corre:"
  echo "  bash scripts/smoke-paso-3-firmar.sh"
else
  echo "FAIL: $RESPONSE"
  exit 1
fi
