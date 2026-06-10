#!/bin/bash
# =============================================================================
# AUDITORIA REAL de Webdock: locations + profiles disponibles + que combinacion
# usan los VPS que SI se crearon. Cero suposiciones: consulta la API de Webdock.
# Corre en TU Mac (alcanza api.webdock.io). Lee tokens de .env.local.
# NO crea ni borra nada. Solo GET. NUNCA imprime el token.
# Uso:  bash "ops/auditar-webdock-capacidad.sh"
# =============================================================================
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 1
ENV_FILE="$ROOT/.env.local"
API="https://api.webdock.io/v1"
getvar() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
jqget() { python3 -c "import json,sys;
try:
  d=json.load(sys.stdin)
  $1
except Exception as e:
  print('  (parse error:', e, ')')"; }

# Token cuenta-2 (Dep Infraestructura) y cuenta-1 (InfraVPS, del backup si existe)
TOK2="$(getvar WEBDOCK_API_KEY_SECONDARY)"
BK="$(ls -t "$ROOT"/.env.local.bak-pre-cuenta2-* 2>/dev/null | head -1)"
TOK1="$( [ -n "$BK" ] && grep -E "^WEBDOCK_API_KEY_OPS=" "$BK" | head -1 | cut -d= -f2- )"
[ -z "$TOK1" ] && TOK1="$(getvar WEBDOCK_API_KEY_OPS)"

say(){ printf '\n========== %s ==========\n' "$1"; }

say "1. LOCATIONS reales de Webdock (locationId EXACTO que acepta la API)"
curl -s -m 20 -H "Authorization: Bearer $TOK2" "$API/locations" | jqget "
for l in d:
  print('  id=%-10s city=%-14s country=%s' % (l.get('id'), l.get('city',''), l.get('country','')))"

say "2. PROFILES disponibles por location (si un profile NO aparece, no hay stock ahi)"
for LOC in dk fi-hel-2 nl-ams gb-man de-fra fi us; do
  RES="$(curl -s -m 20 -H "Authorization: Bearer $TOK2" "$API/profiles?locationId=$LOC")"
  CNT="$(printf '%s' "$RES" | python3 -c "import json,sys;
try: print(len(json.load(sys.stdin)))
except: print('ERR')" 2>/dev/null)"
  if [ "$CNT" = "ERR" ] || [ -z "$CNT" ]; then
    echo "  location='$LOC' -> respuesta no-lista (location invalida?): $(printf '%s' "$RES" | head -c 90)"
  else
    echo "  location='$LOC' -> $CNT profiles. slugs:"
    printf '%s' "$RES" | jqget "
for p in d:
  print('      %-26s %s' % (p.get('slug',''), p.get('name','')))"
  fi
done

say "3. Tus VPS EXISTENTES: con que location + profileSlug se crearon (lo que SI funciona)"
echo "--- Cuenta-1 (InfraVPS) ---"
curl -s -m 20 -H "Authorization: Bearer $TOK1" "$API/servers" | jqget "
for s in d:
  print('  %-26s location=%-12s profile=%-26s status=%s' % (s.get('slug',''), s.get('location',''), s.get('profileSlug',''), s.get('status','')))"
echo "--- Cuenta-2 (Dep Infraestructura) ---"
curl -s -m 20 -H "Authorization: Bearer $TOK2" "$API/servers" | jqget "
for s in d:
  print('  %-26s location=%-12s profile=%-26s status=%s' % (s.get('slug',''), s.get('location',''), s.get('profileSlug',''), s.get('status','')))"

say "RESUMEN"
echo "Pegame TODO este output. Con esto sabremos EXACTO:"
echo " - el locationId valido (seccion 1)"
echo " - que profile tiene stock en cada location (seccion 2)"
echo " - con que location+profile se crearon los VPS que ya funcionan (seccion 3)"
echo "Cero adivinanza: son los datos crudos de la API de Webdock."
