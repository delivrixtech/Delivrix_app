#!/usr/bin/env bash
# Prueba de aceptación del acceso SSH ops: recorre el MISMO camino que el operador
# externo (Esau), no la lógica interna.
#
#   scripts/ops/ops-ssh-spot-check.sh                    # todos los nodos con acceso ops
#   scripts/ops/ops-ssh-spot-check.sh dominio1 dominio2  # solo esos
#
# Por cada dominio:
#   1. baja el credential doc por GET /v1/sender-pool/credentials/<dominio>/download
#   2. extrae la clave privada de la sección "Acceso SSH (operaciones)"
#   3. entra por SSH y confirma usuario, sudo NOPASSWD y que el box sea smtp.<dominio>
#
# Existe porque "sshAccess está en el record" no prueba que se pueda entrar: la primera
# corrida del backfill se dio por buena sin este paso y ocultó que 14 nodos vivos habían
# quedado afuera. Nunca imprime claves; borra el material al terminar.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${GATEWAY_ENV_FILE:-$ROOT/config/gateway.env}"
BASE="${DELIVRIX_GATEWAY_BASE_URL:-http://127.0.0.1:3000}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

# El gateway resuelve el read-boundary en este orden.
TOKEN="${DELIVRIX_READ_BOUNDARY_TOKEN:-}"
for var in DELIVRIX_READ_BOUNDARY_TOKEN DELIVRIX_OPENCLAW_TOKEN OPENCLAW_GATEWAY_TOKEN; do
  [ -n "$TOKEN" ] && break
  TOKEN="$(grep -E "^${var}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
done
if [ -z "$TOKEN" ]; then
  echo "sin token de lectura: definí DELIVRIX_READ_BOUNDARY_TOKEN o pasá GATEWAY_ENV_FILE" >&2
  exit 1
fi

domains=()
if [ "$#" -gt 0 ]; then
  domains=("$@")
else
  # Los que el sender pool declara con acceso ops. Sin `mapfile`: el bash de macOS es 3.2.
  while IFS= read -r line; do
    [ -n "$line" ] && domains+=("$line")
  done < <(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/sender-pool/status" \
    | python3 -c 'import sys,json;[print(d["domain"]) for d in json.load(sys.stdin).get("domains",[]) if (d.get("smtpCredential") or {}).get("hasSshAccess")]' 2>/dev/null)
fi
if [ ${#domains[@]} -eq 0 ]; then
  echo "no hay dominios con acceso ops para verificar" >&2
  exit 1
fi

pass=0; fail=0
printf '%-34s %-16s %s\n' "DOMINIO" "HOST" "RESULTADO"

for domain in "${domains[@]}"; do
  [ -z "$domain" ] && continue
  doc="$WORK/$domain.md"; sec="$WORK/$domain.ssh"; key="$WORK/$domain.pem"

  code=$(curl -s -o "$doc" -w "%{http_code}" -H "Authorization: Bearer $TOKEN" \
    -H "x-delivrix-actor-id: operator/spot-check" \
    "$BASE/v1/sender-pool/credentials/$domain/download")
  if [ "$code" != "200" ]; then
    printf '%-34s %-16s %s\n' "$domain" "-" "FALLA: descarga HTTP $code"; fail=$((fail+1)); continue
  fi

  # Recortar la sección SSH: antes del doc hay un "- Usuario:" que es el de SMTP.
  awk '/^## Acceso SSH \(operaciones\)/{f=1} f' "$doc" > "$sec"
  if [ ! -s "$sec" ]; then
    printf '%-34s %-16s %s\n' "$domain" "-" "FALLA: el doc no trae la sección SSH"; fail=$((fail+1)); continue
  fi

  awk '/-----BEGIN .*PRIVATE KEY-----/,/-----END .*PRIVATE KEY-----/' "$sec" > "$key"
  chmod 600 "$key"
  if ! grep -q 'BEGIN' "$key"; then
    printf '%-34s %-16s %s\n' "$domain" "-" "FALLA: sección SSH sin clave privada"; fail=$((fail+1)); continue
  fi

  user=$(grep -m1 '^- Usuario: ' "$sec" | sed 's/^- Usuario: //' | tr -d '\r')
  host=$(grep -m1 '^- Host: ' "$sec" | sed 's/^- Host: //' | tr -d '\r')
  port=$(grep -m1 '^- Puerto: ' "$sec" | sed 's/^- Puerto: //' | tr -d '\r')

  out=$(ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 \
        -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
        -p "${port:-22}" "${user}@${host}" \
        'printf "U=%s;" "$(id -un)"; if sudo -n true 2>/dev/null; then printf "S=OK;"; else printf "S=FAIL;"; fi; printf "H=%s" "$(sudo -n postconf -h myhostname 2>/dev/null || echo NA)"' \
        2>&1 | tr -d '\n')
  rm -f "$key"

  got_user=$(sed -n 's/.*U=\([^;]*\);.*/\1/p' <<<"$out")
  got_sudo=$(sed -n 's/.*S=\([^;]*\);.*/\1/p' <<<"$out")
  got_host=$(sed -n 's/.*H=\(.*\)/\1/p' <<<"$out")

  if [ "$got_user" = "$user" ] && [ "$got_sudo" = "OK" ] && [ "$got_host" = "smtp.$domain" ]; then
    printf '%-34s %-16s %s\n' "$domain" "$host" "OK ($got_user, sudo, $got_host)"
    pass=$((pass+1))
  else
    printf '%-34s %-16s %s\n' "$domain" "$host" "FALLA: $(cut -c1-80 <<<"$out")"
    fail=$((fail+1))
  fi
done

echo
echo "===== $pass OK / $fail con falla ====="
[ "$fail" -eq 0 ]
