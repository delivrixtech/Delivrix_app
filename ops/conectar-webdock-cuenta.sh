#!/bin/bash
# =============================================================================
# CONECTAR / VERIFICAR cuenta Webdock + resolver SSH del operador
# -----------------------------------------------------------------------------
# Corre en TU Mac. Hace, en orden:
#   1. Reinicia el gateway para que tome el token Webdock de .env.local
#   2. Verifica /health y consulta /v1/webdock/inventory -> debe decir kind "live"
#   3. SSH: deriva la PUBLICA (no secreta) desde la PRIVADA en SMTP_PROVISION_SSH_KEY_PATH
#      y la deja en WEBDOCK_OPERATOR_SSH_PUBLIC_KEY. NO genera llaves nuevas.
#   4. Reporta fingerprint para confirmar cual de las llaves registradas en Webdock es.
# Lee .env.local con grep (NO con `source`) para no romperse con placeholders
# tipo VAR=<from ...>. NUNCA imprime el token ni la llave privada.
# Uso:  bash "ops/conectar-webdock-cuenta.sh"
# =============================================================================
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
ENV_FILE="$ROOT/.env.local"
say() { printf '\n== %s ==\n' "$1"; }
mask() { local v="$1"; local n=${#v}; if [ "$n" -le 8 ]; then printf '****'; else printf '%s...%s' "${v:0:4}" "${v: -4}"; fi; }
# Lee una var del .env.local SIN ejecutar el archivo (robusto ante placeholders).
getvar() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }

# --- 1. Restart gateway -------------------------------------------------------
say "1. Reiniciando gateway (toma el token Webdock)"
bash scripts/delivrix-gateway-start.sh
sleep 4

# --- 2. Health + inventario live ---------------------------------------------
say "2. Verificando gateway e inventario Webdock"
H="$(curl -s -m 6 http://127.0.0.1:3000/health || true)"
case "$H" in *ok*) echo "   /health: OK";; *) echo "   /health: SIN RESPUESTA -> revisar runtime/logs/gateway.log"; esac

TOK="$(getvar DELIVRIX_READ_BOUNDARY_TOKEN)"; [ -z "$TOK" ] && TOK="$(getvar OPENCLAW_GATEWAY_TOKEN)"
INV="$(curl -s -m 20 -H "Authorization: Bearer ${TOK}" http://127.0.0.1:3000/v1/webdock/inventory || true)"
KIND="$(printf '%s' "$INV" | grep -oE '"kind"[ ]*:[ ]*"[a-z]+"' | head -1 | grep -oE '(live|mock)')"
COUNT="$(printf '%s' "$INV" | grep -oE '"slug"' | wc -l | tr -d ' ')"
RESPOK="$(printf '%s' "$INV" | grep -oE '"responseOk"[ ]*:[ ]*(true|false)' | head -1 | grep -oE '(true|false)')"
if [ "$KIND" = "live" ] && [ "$RESPOK" = "true" ]; then
  echo "   Inventario Webdock: LIVE  (servers vistos: ${COUNT})  -> token OK, cuenta conectada"
elif [ -n "$KIND" ]; then
  echo "   Inventario Webdock: kind=${KIND} responseOk=${RESPOK}  -> revisar scope del token"
else
  echo "   No pude leer inventario. Respuesta cruda: ${INV:0:160}"
fi

# --- 3. SSH: derivar publica desde la privada existente -----------------------
say "3. Resolviendo SSH del operador (sin generar llaves nuevas)"
KEYPATH_RAW="$(getvar SMTP_PROVISION_SSH_KEY_PATH)"
KEYPATH="${KEYPATH_RAW/#\~/$HOME}"
if [ -z "$KEYPATH_RAW" ]; then
  echo "   SMTP_PROVISION_SSH_KEY_PATH no esta en .env.local. Llaves en ~/.ssh:"
  ls -1 "$HOME/.ssh/" 2>/dev/null | grep -viE '\.pub$|known_hosts|config|authorized|^agent$' | sed 's/^/     - ~\/.ssh\//'
elif [ ! -f "$KEYPATH" ]; then
  echo "   La privada NO existe en: $KEYPATH"
  echo "   Llaves privadas disponibles en ~/.ssh:"
  ls -1 "$HOME/.ssh/" 2>/dev/null | grep -viE '\.pub$|known_hosts|config|authorized|^agent$' | sed 's/^/     - ~\/.ssh\//'
  echo "   -> Decime cual es la del operador y ajusto SMTP_PROVISION_SSH_KEY_PATH."
else
  PUB="$(ssh-keygen -y -f "$KEYPATH" 2>/dev/null)"
  if [ -z "$PUB" ]; then
    echo "   La privada existe pero no pude derivar la publica (passphrase?). Corre manual:"
    echo "     ssh-keygen -y -f $KEYPATH"
  else
    FP="$(ssh-keygen -lf "$KEYPATH" 2>/dev/null | awk '{print $2}')"
    if grep -qE '^WEBDOCK_OPERATOR_SSH_PUBLIC_KEY=' "$ENV_FILE"; then
      grep -vE '^WEBDOCK_OPERATOR_SSH_PUBLIC_KEY=' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
    fi
    printf 'WEBDOCK_OPERATOR_SSH_PUBLIC_KEY=%s\n' "$PUB" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "   Privada: $KEYPATH  (existe)"
    echo "   Fingerprint: $FP"
    echo "   Comentario publica: $(printf '%s' "$PUB" | awk '{print $3}')"
    echo "   Publica conectada en WEBDOCK_OPERATOR_SSH_PUBLIC_KEY (mismo par, garantizado)."
    echo "   En Webdock > Public Keys debe figurar una con este fingerprint (la 'delivrix-ops')."
  fi
fi

say "RESUMEN (leido directo del archivo)"
echo "Token Webdock OPS:  $(mask "$(getvar WEBDOCK_API_KEY_OPS)")"
echo "ENABLE_CREATE:      $(getvar WEBDOCK_SERVERS_ENABLE_CREATE)"
echo "ENABLE_SSH:         $(getvar SMTP_PROVISIONING_ENABLE_SSH)   (si el flujo 14-pasos hace SSH real al VPS, debe ser true)"
echo "SSH key path:       $(getvar SMTP_PROVISION_SSH_KEY_PATH)"
echo ""
echo "Pegame este output."
