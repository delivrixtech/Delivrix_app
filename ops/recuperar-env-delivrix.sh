#!/bin/bash
# =============================================================================
# RECUPERACION POST-INCIDENTE: Vercel CLI pisó .env.local (2026-06-09 17:50Z)
# -----------------------------------------------------------------------------
# Qué hace (en orden, todo en TU Mac):
#   1. Preserva el .env.local clobbereado como evidencia (.bak).
#   2. Intenta restaurar el .env.local bueno desde snapshots locales de
#      Time Machine (pide sudo solo para montar el snapshot, read-only).
#   3. Cosecha los 5 tokens locales desde el proceso del admin panel
#      (PID pre-clobber, runtime/admin-panel.pid) como plan B.
#   4. Si no hubo snapshot: arma .env.local desde .env.example + tokens
#      cosechados + credenciales AWS de ~/.aws/credentials (si existen).
#   5. Reinicia el gateway con scripts/delivrix-gateway-start.sh.
#   6. Verifica: /health, bridgeKind=bedrock en el log, canvas /state con token.
#   7. Imprime PASS/FAIL y la lista exacta de lo que falte (si falta algo).
# Seguro de correr varias veces. NUNCA imprime secretos completos.
# Uso:  bash "ops/recuperar-env-delivrix.sh"
# =============================================================================
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
TS="$(date -u +%Y%m%dT%H%M%SZ)"
HARVEST="/tmp/delivrix-harvest-$TS.env"
RESTORED_FROM=""
PASS=()
FAIL=()

mask() { local v="$1"; local n=${#v}; if [ "$n" -le 6 ]; then printf '****'; else printf '%s…%s' "${v:0:2}" "${v: -4}"; fi; }
say()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# --- 1. Evidencia -------------------------------------------------------------
say "1. Preservando evidencia"
if [ -f .env.local ] && grep -q "Created by Vercel CLI" .env.local; then
  cp .env.local ".env.local.vercel-clobber-$TS.bak"
  echo "   Clobbereado respaldado en .env.local.vercel-clobber-$TS.bak"
  CLOBBERED=1
elif [ -f .env.local ]; then
  echo "   .env.local actual NO es el clobbereado de Vercel (¿ya restaurado?). No lo piso sin snapshot."
  CLOBBERED=0
else
  echo "   No existe .env.local."
  CLOBBERED=1
fi

# --- 2. Harvest del panel (SIEMPRE, antes de tocar nada) ----------------------
say "2. Cosechando tokens del proceso del admin panel (pre-clobber)"
: > "$HARVEST"; chmod 600 "$HARVEST"
PANEL_PID="$(cat runtime/admin-panel.pid 2>/dev/null || true)"
if [ -n "$PANEL_PID" ] && ps -p "$PANEL_PID" >/dev/null 2>&1; then
  ps eww "$PANEL_PID" 2>/dev/null | tr ' ' '\n' \
    | grep -E '^(CANVAS_LIVE_STREAM_TOKEN|GATEWAY_LOG_STREAM_TOKEN|DELIVRIX_READ_BOUNDARY_TOKEN|DELIVRIX_OPENCLAW_TOKEN|OPENCLAW_GATEWAY_TOKEN)=.+' \
    | sort -u >> "$HARVEST" || true
  N=$(grep -c '=' "$HARVEST" 2>/dev/null || echo 0)
  echo "   PID $PANEL_PID vivo -> $N token(s) cosechado(s) en $HARVEST"
else
  echo "   Panel no está corriendo con PID conocido -> sin harvest (no es fatal si hay snapshot)."
fi

# --- 3. Time Machine local snapshots ------------------------------------------
say "3. Buscando .env.local bueno en snapshots locales de Time Machine"
if [ "$CLOBBERED" -eq 1 ] && command -v tmutil >/dev/null 2>&1; then
  SNAPS="$(tmutil listlocalsnapshots / 2>/dev/null | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}' | sort -r || true)"
  if [ -z "$SNAPS" ]; then
    echo "   No hay snapshots locales (tmutil no listó ninguno)."
  else
    echo "   Snapshots (nuevo->viejo): $(echo "$SNAPS" | tr '\n' ' ')"
    echo "   Se necesita sudo SOLO para montar el snapshot read-only."
    MNT="/tmp/delivrix-snap-$TS"; mkdir -p "$MNT"
    for S in $SNAPS; do
      MOUNTED=0
      for DEV in "/System/Volumes/Data" "/"; do
        if sudo mount_apfs -o ro -s "com.apple.TimeMachine.$S.local" "$DEV" "$MNT" 2>/dev/null; then MOUNTED=1; break; fi
      done
      [ "$MOUNTED" -eq 1 ] || continue
      for CAND in "$MNT$ROOT/.env.local" "$MNT${ROOT#/System/Volumes/Data}/.env.local"; do
        if [ -f "$CAND" ] && ! grep -q "Created by Vercel CLI" "$CAND" && grep -q "OPENCLAW_GATEWAY_TOKEN=" "$CAND"; then
          cp "$CAND" .env.local && chmod 600 .env.local
          RESTORED_FROM="snapshot $S"
          echo "   RESTAURADO completo desde snapshot $S"
          break
        fi
      done
      sudo umount "$MNT" 2>/dev/null || sudo diskutil unmount force "$MNT" >/dev/null 2>&1 || true
      [ -n "$RESTORED_FROM" ] && break
    done
    rmdir "$MNT" 2>/dev/null || true
    [ -z "$RESTORED_FROM" ] && echo "   Ningún snapshot tenía un .env.local válido."
  fi
else
  [ "$CLOBBERED" -eq 0 ] && echo "   Saltado (el .env.local actual no es el clobbereado)."
fi

# --- 4. Reconstrucción si no hubo snapshot ------------------------------------
if [ "$CLOBBERED" -eq 1 ] && [ -z "$RESTORED_FROM" ]; then
  say "4. Reconstruyendo .env.local (skeleton + harvest + ~/.aws)"
  {
    echo "# Reconstruido post-incidente Vercel $TS — completar los CAMBIAR_AQUI"
    grep -vE '^\s*$' .env.example
  } > .env.local
  chmod 600 .env.local
  # 4a. tokens cosechados del panel pisan/agregan
  if [ -s "$HARVEST" ]; then
    while IFS= read -r LINE; do
      K="${LINE%%=*}"
      if grep -qE "^${K}=" .env.local; then
        # reemplazo in-place portable (bash 3.2, sin sed -i con backup raro)
        awk -v kv="$LINE" -v k="$K" 'BEGIN{FS=OFS=""} index($0,k"=")==1{print kv;next}{print}' .env.local > .env.local.tmp && mv .env.local.tmp .env.local
      else
        echo "$LINE" >> .env.local
      fi
      V="${LINE#*=}"; echo "   + $K=$(mask "$V") (del panel vivo)"
    done < "$HARVEST"
    chmod 600 .env.local
  fi
  # 4b. AWS desde ~/.aws/credentials (perfil default) si existe
  AWSC="$HOME/.aws/credentials"
  if [ -f "$AWSC" ]; then
    AKI="$(awk '/^\[default\]/{f=1;next}/^\[/{f=0}f&&/aws_access_key_id/{print $NF;exit}' "$AWSC")"
    SAK="$(awk '/^\[default\]/{f=1;next}/^\[/{f=0}f&&/aws_secret_access_key/{print $NF;exit}' "$AWSC")"
    if [ -n "${AKI:-}" ] && [ -n "${SAK:-}" ]; then
      for PAIR in "AWS_BEDROCK_ACCESS_KEY_ID=$AKI" "AWS_BEDROCK_SECRET_ACCESS_KEY=$SAK" "AWS_ROUTE53_ACCESS_KEY_ID=$AKI" "AWS_ROUTE53_SECRET_ACCESS_KEY=$SAK"; do
        K="${PAIR%%=*}"
        grep -qE "^${K}=" .env.local && awk -v kv="$PAIR" -v k="$K" 'BEGIN{FS=OFS=""} index($0,k"=")==1{print kv;next}{print}' .env.local > .env.local.tmp && mv .env.local.tmp .env.local || echo "$PAIR" >> .env.local
      done
      chmod 600 .env.local
      echo "   + AWS_* desde ~/.aws/credentials [default] ($(mask "$AKI")) — VERIFICÁ que sea la cuenta correcta"
    fi
  fi
  # 4c. defaults seguros que el skeleton no trae
  grep -qE '^OPENCLAW_BRIDGE_KIND=' .env.local || echo "OPENCLAW_BRIDGE_KIND=bedrock" >> .env.local
  grep -qE '^AWS_BEDROCK_REGION=' .env.local   || echo "AWS_BEDROCK_REGION=us-east-1" >> .env.local
  grep -qE '^AWS_BEDROCK_MODEL_ID=' .env.local || echo "AWS_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6" >> .env.local
  RESTORED_FROM="reconstrucción parcial"
fi

# --- 5. Validación de vars críticas -------------------------------------------
say "5. Validando vars críticas en .env.local"
MISSING_CORE=(); MISSING_PROV=()
need() { # $1 tier core|prov ; $2 var
  if grep -qE "^$2=..+" .env.local 2>/dev/null && ! grep -qE "^$2=.*(CAMBIAR_AQUI|<|TODO|xxx|replace_with|replace-me|changeme|your_|your-|placeholder)" .env.local; then
    return 0
  fi
  if [ "$1" = core ]; then MISSING_CORE+=("$2"); else MISSING_PROV+=("$2"); fi
}
for V in OPENCLAW_GATEWAY_TOKEN DELIVRIX_READ_BOUNDARY_TOKEN DELIVRIX_OPENCLAW_TOKEN CANVAS_LIVE_STREAM_TOKEN GATEWAY_LOG_STREAM_TOKEN OPENCLAW_OPERATOR_HMAC_SECRET OPENCLAW_BRIDGE_KIND AWS_BEDROCK_REGION AWS_BEDROCK_MODEL_ID AWS_BEDROCK_ACCESS_KEY_ID AWS_BEDROCK_SECRET_ACCESS_KEY OPENCLAW_AGENT_HTTP_URL OPENCLAW_AGENT_WS_URL; do need core "$V"; done
for V in WEBDOCK_API_KEY WEBDOCK_API_KEY_OPS AWS_ROUTE53_ACCESS_KEY_ID AWS_ROUTE53_SECRET_ACCESS_KEY IONOS_DNS_API_KEY PORKBUN_API_KEY PORKBUN_SECRET_API_KEY SMTP_PROVISION_SSH_KEY_PATH; do need prov "$V"; done
[ ${#MISSING_CORE[@]} -eq 0 ] && echo "   CORE: completo OK" || echo "   CORE faltante: ${MISSING_CORE[*]}"
[ ${#MISSING_PROV[@]} -eq 0 ] && echo "   PROVIDERS: completo OK" || echo "   PROVIDERS faltante: ${MISSING_PROV[*]}"

# --- 6. Restart gateway --------------------------------------------------------
say "6. Reiniciando gateway"
bash scripts/delivrix-gateway-start.sh || { echo "   FALLO: start script falló"; FAIL+=("gateway start"); }
sleep 4

# --- 7. Verificación -----------------------------------------------------------
say "7. Verificación"
H="$(curl -s -m 5 http://127.0.0.1:3000/health || true)"
case "$H" in *'"ok"'*|*status*ok*) PASS+=("/health ok");; *) FAIL+=("/health -> ${H:-sin respuesta}");; esac

GLOG="$(ls -t runtime/logs/gateway-*.log 2>/dev/null | head -1)"
BK="$(grep "gateway.started" "$GLOG" 2>/dev/null | tail -1 | grep -oE '"bridgeKind":"[a-z]+"' || true)"
case "$BK" in *bedrock*) PASS+=("bridgeKind=bedrock");; *) FAIL+=("bridgeKind=${BK:-desconocido} (esperaba bedrock)");; esac

CT="$(grep -E '^CANVAS_LIVE_STREAM_TOKEN=' .env.local | head -1 | cut -d= -f2-)"
[ -z "$CT" ] && CT="$(grep -E '^DELIVRIX_READ_BOUNDARY_TOKEN=' .env.local | head -1 | cut -d= -f2-)"
[ -z "$CT" ] && CT="$(grep -E '^OPENCLAW_GATEWAY_TOKEN=' .env.local | head -1 | cut -d= -f2-)"
if [ -n "$CT" ]; then
  CC="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CT" http://127.0.0.1:3000/v1/canvas/live/state || true)"
  [ "$CC" = "200" ] && PASS+=("canvas /state 200 con token") || FAIL+=("canvas /state -> HTTP $CC")
else
  FAIL+=("sin token canvas para probar")
fi

# --- 8. Panel ------------------------------------------------------------------
say "8. Reiniciando admin panel (para que tome el .env.local restaurado)"
bash scripts/delivrix-admin-start.sh && PASS+=("panel reiniciado") || FAIL+=("panel restart")

# --- Resumen -------------------------------------------------------------------
say "RESUMEN ($RESTORED_FROM)"
for P in "${PASS[@]:-}";  do [ -n "$P" ] && printf '   OK   %s\n' "$P"; done
for F in "${FAIL[@]:-}";  do [ -n "$F" ] && printf '   FALLO %s\n' "$F"; done
if [ ${#MISSING_CORE[@]} -gt 0 ] || [ ${#MISSING_PROV[@]} -gt 0 ]; then
  echo ""
  echo "   PENDIENTE MANUAL (pegar en .env.local y re-correr este script):"
  for V in "${MISSING_CORE[@]:-}"; do [ -n "$V" ] && echo "     [CORE] $V"; done
  for V in "${MISSING_PROV[@]:-}"; do [ -n "$V" ] && echo "     [PROV] $V   (dashboard del provider)"; done
  echo "   Tokens locales (CANVAS/LOG/BOUNDARY) se pueden REGENERAR: openssl rand -hex 32"
  echo "   OJO: OPENCLAW_GATEWAY_TOKEN y DELIVRIX_OPENCLAW_TOKEN deben coincidir con el container Hostinger — NO regenerar, recuperar."
fi
echo ""
echo "Listo. Si todo dio OK: recargá el panel en el browser — el badge debe pasar a connected."
