#!/usr/bin/env bash
# Smoke E2E paso 3 — FIRMA la propuesta + crea VPS real en Webdock
# Lee proposalId de runtime/last-proposal-id-paso3.txt
# Costo: ~$4.30/mes recurrente (Essential bit profile)

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f runtime/last-proposal-id-paso3.txt ]; then
  echo "ERROR: runtime/last-proposal-id-paso3.txt no existe. Corre smoke-paso-3-submit.sh primero."
  exit 1
fi

PROPOSAL_ID=$(cat runtime/last-proposal-id-paso3.txt | tr -d '\n')
echo "Proposal a firmar: $PROPOSAL_ID"
echo ""
echo "ATENCION: este script crea VPS REAL en Webdock. ~4.30 USD/mes recurrente."
echo "Hostname: mail.delivrix-notify.com"
echo "Profile: bit (Essential, vps-xeon-essential-2025)"
echo "Image: ubuntu-2404"
echo "Location: dk"
echo "Presiona ENTER para continuar, Ctrl+C para abortar."
read -r

echo ""
echo "=== Firmando ==="
SIGN_RESPONSE=$(curl -s -w "\n__HTTP_STATUS__%{http_code}" -X POST \
  "http://127.0.0.1:3000/v1/openclaw/proposals/$PROPOSAL_ID/sign" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:5173" \
  -d "{
    \"actorId\": \"operator-juanes\",
    \"reason\": \"Smoke E2E paso 3 sabado - crear VPS Webdock Essential para hostear Postfix de delivrix-notify.com. Costo: 4.30 USD/mes.\"
  }")

echo "$SIGN_RESPONSE"

echo ""
echo "=== Status post-firma ==="
curl -s http://127.0.0.1:3000/v1/openclaw/proposals/$PROPOSAL_ID/status | jq

echo ""
echo "=== Verify chain ==="
curl -s http://127.0.0.1:3000/v1/audit-chain/verify | jq

echo ""
echo "=== Anchor post-firma ==="
curl -s http://127.0.0.1:3000/v1/audit-chain/anchor | tee runtime/audit-anchor-paso-3-post-firma.json | jq

echo ""
echo "=== Fin smoke paso 3 ==="
echo "Verifica el VPS en https://app.webdock.io/en/dash/servers"
