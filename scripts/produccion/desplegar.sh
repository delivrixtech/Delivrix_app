#!/usr/bin/env bash
# Lleva a producción (la Mac Studio) lo que ya está en la rama produ de GitHub.
#
# CORRE EN LA LAPTOP. El ciclo es: trabajás acá → push a produ → ./scripts/produccion/desplegar.sh
#
# Reinicia SOLO los servicios cuyos archivos cambiaron: reiniciar el daemon de warmup sin
# necesidad cuesta una vuelta, y no hay razón para pagarla.
set -euo pipefail

STUDIO_HOST="${STUDIO_HOST:-100.87.218.46}"
STUDIO_USER="${STUDIO_USER:-}"
STUDIO_DIR="${STUDIO_DIR:-~/Documents/delivrix app}"
RAMA="${RAMA:-produ}"
SSH_DEST=""

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/produccion/lib.sh
source "${ROOT_DIR}/scripts/produccion/lib.sh"

if [[ -z "${STUDIO_USER}" ]]; then
  echo "FATAL: definí STUDIO_USER (el usuario de la Studio)." >&2
  echo "  ej:  STUDIO_USER=juanes ./scripts/produccion/desplegar.sh" >&2
  exit 1
fi
SSH_DEST="${STUDIO_USER}@${STUDIO_HOST}"

# --- guarda anti doble-emisor -----------------------------------------------------------------
# Si esta laptop todavía tiene el daemon de warmup vivo, hay DOS cerebros mandando correo contra
# bases distintas. El lock de la base no cruza máquinas: no hay nada que lo impida salvo esto.
if pgrep -f "live-warmup-daemon" >/dev/null 2>&1; then
  echo "FATAL: esta laptop tiene el daemon de warmup CORRIENDO." >&2
  echo "  Dos daemons contra bases distintas duplican el volumen hacia Gmail, y ese daño es" >&2
  echo "  permanente. Apagalo primero:  ./scripts/warmup-servicios.sh stop" >&2
  exit 1
fi

echo "== desplegando ${RAMA} → ${SSH_DEST} =="

remoto() { ssh -o BatchMode=yes -o ConnectTimeout=15 "${SSH_DEST}" "cd \"${STUDIO_DIR}\" && $1"; }

antes="$(remoto 'git rev-parse HEAD')"
echo "· producción está en ${antes:0:8}"

salida="$(remoto "git fetch origin ${RAMA} --quiet && git merge --ff-only origin/${RAMA} 2>&1")" || {
  echo "FALLÓ el merge --ff-only en la Studio:" >&2
  echo "${salida}" >&2
  echo "  (¿hay cambios locales en producción? entrá por ssh y resolvelo a mano)" >&2
  exit 1
}
despues="$(remoto 'git rev-parse HEAD')"

if [[ "${antes}" == "${despues}" ]]; then
  echo "· ya estaba al día — nada que reiniciar"
  exit 0
fi
echo "· ${antes:0:8} → ${despues:0:8}"

cambios="$(remoto "git diff --name-only ${antes} ${despues}")"
echo "${cambios}" | sed 's/^/    /' | head -20
total="$(echo "${cambios}" | wc -l | tr -d ' ')"
(( total > 20 )) && echo "    … y $((total - 20)) más"

# --- qué servicio depende de qué (lógica probada en produccion.test.sh) -----------------------
declare -a reiniciar=()
while IFS= read -r s; do [[ -n "${s}" ]] && reiniciar+=("${s}"); done < <(
  printf '%s\n' "${cambios}" | delivrix_servicios_afectados
)

if [[ ${#reiniciar[@]} -eq 0 ]]; then
  echo "· ningún servicio depende de lo que cambió — no reinicio nada"
  exit 0
fi

# Si cambió package.json hay que reinstalar antes de reiniciar, o el servicio arranca sin la
# dependencia nueva y muere en bucle (con KeepAlive, en bucle infinito).
if echo "${cambios}" | grep -qE '^package(-lock)?\.json$|^apps/[^/]+/package(-lock)?\.json$'; then
  echo "· cambió package.json → npm ci en producción"
  remoto 'npm ci --silent' || { echo "FALLÓ npm ci — NO reinicio nada (los servicios siguen con la versión vieja, que funciona)" >&2; exit 1; }
fi

echo "· reiniciando: ${reiniciar[*]}"
for s in "${reiniciar[@]}"; do
  # El daemon de warmup solo está cargado si se instaló con --con-warmup.
  ssh -o BatchMode=yes "${SSH_DEST}" "sudo launchctl kickstart -k system/com.delivrix.${s}" 2>/dev/null \
    && echo "    ${s}: reiniciado" \
    || echo "    ${s}: no está cargado en producción (¿se instaló con --con-warmup?)"
done

# --- verificación: sin esto el deploy solo dice que envió comandos ---------------------------
echo "· verificando…"
ok=0
for _ in {1..20}; do
  if ssh -o BatchMode=yes "${SSH_DEST}" \
      "curl -fsS --max-time 4 http://127.0.0.1:3000/health" 2>/dev/null \
      | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then ok=1; break; fi
  sleep 3
done
if [[ ${ok} == 1 ]]; then
  echo "· gateway ok en ${despues:0:8}"
else
  echo "FALLÓ: el gateway no responde tras el reinicio." >&2
  echo "  ssh ${SSH_DEST} 'tail -50 \"${STUDIO_DIR}/runtime/logs/gateway.log\"'" >&2
  exit 1
fi
