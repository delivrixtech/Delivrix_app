#!/bin/bash
#
# smoke-test-onboarding.sh — corre el smoke del flow onboard-sender-domain
# contra el gateway local y reporta el estado de los blockers.
#
# Uso:
#   ./smoke-test-onboarding.sh                                              # dominio dummy + approval dummy
#   ./smoke-test-onboarding.sh midominio-test.com                           # dominio custom + approval dummy
#   ./smoke-test-onboarding.sh midominio.com <approval-token-real>          # con approval token real
#
# Body schema esperado por el handler (verificado en
# apps/gateway-api/src/routes/onboard-flow.ts:127-180):
#   - domain        (string)   ← required
#   - actorId       (string)   ← required
#   - approvalToken (string)   ← required (dummy si solo querés ver blockers)
#   - profile       (string)   ← opcional, default "bit"
#   - seedInboxes   (string[]) ← opcional si DELIVRIX_DEMO_SEED_INBOXES está en env

set -euo pipefail

GATEWAY="http://127.0.0.1:3000"
DOMAIN="${1:-delivrix-smoke-$(date +%Y%m%d-%H%M%S).com}"
APPROVAL_TOKEN="${2:-dummy-approval-token-for-blocker-check}"

echo "═══════════════════════════════════════════════════════════"
echo " Smoke test onboard-sender-domain"
echo "═══════════════════════════════════════════════════════════"
echo " Gateway:        $GATEWAY"
echo " Dominio:        $DOMAIN"
echo " Approval token: ${APPROVAL_TOKEN:0:20}..."
echo " Timestamp:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "═══════════════════════════════════════════════════════════"

# 1) /health
echo ""
echo "→ /health:"
if curl -s -f "$GATEWAY/health" >/dev/null; then
  curl -s "$GATEWAY/health" | head -c 200
  echo ""
else
  echo "✗ Gateway no responde en $GATEWAY. Arrancalo primero:"
  echo "    node --env-file=.env.local apps/gateway-api/src/main.ts"
  exit 1
fi

# 2) Smoke onboarding — body completo con todos los campos required
echo ""
echo "→ POST /v1/flows/onboard-sender-domain:"
RESPONSE=$(curl -s -X POST "$GATEWAY/v1/flows/onboard-sender-domain" \
  -H "Content-Type: application/json" \
  -d "{
    \"domain\": \"$DOMAIN\",
    \"profile\": \"bit\",
    \"actorId\": \"smoke-test\",
    \"approvalToken\": \"$APPROVAL_TOKEN\",
    \"seedInboxes\": [
      \"seed1+smoke@delivrix.com\",
      \"seed2+smoke@delivrix.com\",
      \"seed3+smoke@delivrix.com\"
    ],
    \"maxRetries\": 0
  }")

echo "$RESPONSE" | head -c 2500
echo ""

# 3) Análisis de blockers
echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Análisis (qué falta cerrar para demo viernes):"
echo "═══════════════════════════════════════════════════════════"

# Detección heurística por substring en el response
declare -a FOUND
for blocker in \
  purchase_flag_disabled \
  monthly_cap_missing \
  admin_contact_missing \
  admin_contact_invalid \
  approval_not_found_or_expired \
  aws_route53_credentials_missing \
  webdock_ops_key_missing \
  registration_price_unavailable \
  monthly_cap_exceeded; do
  if echo "$RESPONSE" | grep -q "\"$blocker\""; then
    FOUND+=("$blocker")
    case "$blocker" in
      purchase_flag_disabled)
        echo "  ⏳ $blocker            ← OK, se flipea el viernes con flip-purchase-flag.sh on"
        ;;
      approval_not_found_or_expired)
        echo "  ⏳ $blocker  ← OK con approval token dummy; con token real válido debería pasar"
        ;;
      monthly_cap_exceeded)
        echo "  ⚠️  $blocker            ← cap mensual gastado"
        ;;
      *)
        echo "  ✗ $blocker         ← INESPERADO, deberíamos haberlo cerrado ya"
        ;;
    esac
  fi
done

if [ "${#FOUND[@]}" -eq 0 ]; then
  echo "  (sin blockers en el response — puede ser que el flow ya pasó T1)"
fi

# Veredicto
EXPECTED=("purchase_flag_disabled" "approval_not_found_or_expired")
if [ "${#FOUND[@]}" -eq 2 ] && \
   [[ " ${FOUND[*]} " == *" purchase_flag_disabled "* ]] && \
   [[ " ${FOUND[*]} " == *" approval_not_found_or_expired "* ]]; then
  echo ""
  echo "✓ ESTADO IDEAL pre-demo: solo quedan los 2 blockers esperados."
  echo "  Cuando flipeés purchase_flag + dispares con approval token real,"
  echo "  el flow va a pasar T1 y arrancar la compra."
fi

# 4) Último workspace escrito por el agente
echo ""
echo "→ Últimos archivos en el workspace del agente:"
WORKSPACE="/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace"
if [ -d "$WORKSPACE/executions" ]; then
  LATEST_DAY=$(ls -t "$WORKSPACE/executions/" 2>/dev/null | head -1)
  if [ -n "$LATEST_DAY" ]; then
    echo "  Carpeta: executions/$LATEST_DAY/"
    ls -t "$WORKSPACE/executions/$LATEST_DAY/" 2>/dev/null | head -3 | sed 's/^/    /'
  fi
fi
