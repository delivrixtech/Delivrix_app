#!/usr/bin/env bash
# Smoke E2E paso 1 — FIRMA la propuesta + dispara $15 USD de Route53
# Lee proposalId de runtime/last-proposal-id.txt (creado por smoke-paso-1-submit.sh)

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f runtime/last-proposal-id.txt ]; then
  echo "ERROR: runtime/last-proposal-id.txt no existe. Corre smoke-paso-1-submit.sh primero."
  exit 1
fi

PROPOSAL_ID=$(cat runtime/last-proposal-id.txt | tr -d '\n')
echo "Proposal a firmar: $PROPOSAL_ID"
echo ""
echo "ATENCION: este script dispara registro real Route53. ~15 USD."
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
    \"reason\": \"Smoke E2E paso 1 sabado - registrar delivrix-notify.com en Route53. Costo: 15 USD. Sin auto-renew.\"
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
curl -s http://127.0.0.1:3000/v1/audit-chain/anchor | tee runtime/audit-anchor-sabado-post-firma.json | jq

echo ""
echo "=== Lista dominios Route53 (via gateway) ==="
curl -s http://127.0.0.1:3000/v1/domains/route53/owned | jq '.[] | select(.domainName == "delivrix-notify.com" or .DomainName == "delivrix-notify.com")'

echo ""
echo "=== Fin smoke paso 1 ==="
