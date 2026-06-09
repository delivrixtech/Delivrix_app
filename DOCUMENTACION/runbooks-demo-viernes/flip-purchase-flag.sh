#!/bin/bash
#
# flip-purchase-flag.sh — activa/desactiva la compra REAL de dominios en Route53.
#
# Uso:
#   ./flip-purchase-flag.sh on    # activa AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true
#   ./flip-purchase-flag.sh off   # vuelve a false (default seguro)
#   ./flip-purchase-flag.sh status # muestra estado actual sin modificar
#
# Activarlo cuesta dinero real cada vez que el operador apruebe un artifact:
# $11 USD por dominio .com con privacy. El cap mensual lo limita a $50 USD/mes.
#
# Después de cambiarlo, este script REINICIA el gateway automáticamente para
# que cargue la env nueva (sin reinicio el flag no se aplica).

set -euo pipefail

ENV_FILE="/Users/juanescanar/Documents/delivrix app/.env.local"
FLAG_KEY="AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE"

if [ ! -f "$ENV_FILE" ]; then
  echo "FALLO: .env.local no existe en $ENV_FILE"
  exit 1
fi

current=$(grep -E "^${FLAG_KEY}=" "$ENV_FILE" | head -1 | cut -d= -f2 || echo "MISSING")

case "${1:-status}" in
  on)
    echo "→ Activando ${FLAG_KEY}=true (compra REAL habilitada)"
    if [ "$current" = "MISSING" ]; then
      echo "${FLAG_KEY}=true" >> "$ENV_FILE"
    else
      # macOS sed requiere '' después de -i
      sed -i '' "s/^${FLAG_KEY}=.*/${FLAG_KEY}=true/" "$ENV_FILE"
    fi
    echo "OK: Flag actualizado a true."
    NEEDS_RESTART=1
    ;;
  off)
    echo "→ Desactivando ${FLAG_KEY}=false (compra bloqueada por seguridad)"
    if [ "$current" = "MISSING" ]; then
      echo "${FLAG_KEY}=false" >> "$ENV_FILE"
    else
      sed -i '' "s/^${FLAG_KEY}=.*/${FLAG_KEY}=false/" "$ENV_FILE"
    fi
    echo "OK: Flag actualizado a false."
    NEEDS_RESTART=1
    ;;
  status)
    echo "Estado actual del flag:"
    echo "  ${FLAG_KEY}=${current}"
    if [ "$current" = "true" ]; then
      echo "  AVISO: COMPRA REAL HABILITADA — cada aprobación gasta dinero."
    elif [ "$current" = "false" ]; then
      echo "  OK: Compra bloqueada. Gateway responderá purchase_flag_disabled."
    else
      echo "  AVISO: Flag no presente en .env.local."
    fi
    exit 0
    ;;
  *)
    echo "Uso: $0 {on|off|status}"
    exit 1
    ;;
esac

# Verificar gateway corriendo
GATEWAY_PID=$(lsof -ti:3000 2>/dev/null || true)
if [ -z "${NEEDS_RESTART:-}" ]; then
  exit 0
fi

if [ -z "$GATEWAY_PID" ]; then
  echo "INFO: Gateway no está corriendo en :3000. Arrancalo cuando estés listo:"
  echo "   cd \"/Users/juanescanar/Documents/delivrix app\""
  echo "   node --env-file=.env.local apps/gateway-api/src/main.ts"
  exit 0
fi

echo "→ Matando gateway PID $GATEWAY_PID para que recargue env..."
kill "$GATEWAY_PID" 2>/dev/null || true
sleep 1

echo "→ Levantando gateway nuevo en background..."
cd "/Users/juanescanar/Documents/delivrix app"
nohup node --env-file=.env.local apps/gateway-api/src/main.ts > runtime/gateway.log 2>&1 &
NEW_PID=$!
sleep 2

# Verificar /health
if curl -s -f http://127.0.0.1:3000/health >/dev/null 2>&1; then
  echo "OK: Gateway running PID $NEW_PID. /health OK."
else
  echo "AVISO: Gateway arrancó (PID $NEW_PID) pero /health no responde aún. Revisá runtime/gateway.log."
fi
