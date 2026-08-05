#!/usr/bin/env bash
# Respaldo nocturno de la base de producción, con copia fuera de esta máquina.
#
# Una máquina nunca es testigo de su propia muerte: el respaldo que solo vive en el disco de la
# Studio no sirve para el caso en que la Studio es lo que se murió. Por eso viaja a la mini.
#
# Lo lanza launchd (com.delivrix.respaldo) a las 03:30. Correr a mano también sirve.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST_DIR="${ROOT_DIR}/runtime/respaldos"
LOG="${ROOT_DIR}/runtime/logs/respaldo.log"
MINI_HOST="${MINI_HOST:-100.104.216.127}"
MINI_USER="${MINI_USER:-$(id -un)}"
MINI_DIR="${MINI_DIR:-~/delivrix-respaldos}"
RETENER="${RETENER:-7}"

mkdir -p "${DEST_DIR}"
decir() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG}"; }

PG_URL="$(grep -m1 -E '^[[:space:]]*POSTGRES_URL=' "${ROOT_DIR}/config/gateway.env" 2>/dev/null | cut -d= -f2-)"
if [[ -z "${PG_URL}" ]]; then decir "FATAL: sin POSTGRES_URL en config/gateway.env"; exit 1; fi

archivo="${DEST_DIR}/delivrix-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
if ! pg_dump "${PG_URL}" | gzip > "${archivo}"; then
  decir "FALLÓ pg_dump — no borro nada ni subo nada"
  rm -f "${archivo}"
  exit 1
fi

# Un dump que no se puede descomprimir es un respaldo imaginario. Se verifica ANTES de rotar.
if ! gzip -t "${archivo}" 2>/dev/null; then
  decir "FALLÓ la verificación del gzip — descarto ${archivo}"
  rm -f "${archivo}"
  exit 1
fi
decir "dump ok · $(du -h "${archivo}" | cut -f1) · $(basename "${archivo}")"

# Copia a la mini (por Tailscale). Que falle no invalida el respaldo local.
if scp -o BatchMode=yes -o ConnectTimeout=15 "${archivo}" "${MINI_USER}@${MINI_HOST}:${MINI_DIR}/" 2>>"${LOG}"; then
  decir "copiado a la mini (${MINI_HOST}:${MINI_DIR})"
else
  decir "WARN no pude copiar a la mini — el respaldo local existe, pero HOY no hay copia fuera de esta máquina"
fi

# Rotación: se borran los viejos SOLO después de que el nuevo existe y verificó.
sobran="$(ls -1t "${DEST_DIR}"/delivrix-*.sql.gz 2>/dev/null | tail -n +$((RETENER + 1)) || true)"
if [[ -n "${sobran}" ]]; then
  echo "${sobran}" | while read -r viejo; do rm -f "${viejo}"; decir "rotado $(basename "${viejo}")"; done
fi
