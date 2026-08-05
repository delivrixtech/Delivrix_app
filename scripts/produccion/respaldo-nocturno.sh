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
# Alias `mini` de ~/.ssh/config: trae usuario Y llave. Antes se armaba user@ip con `id -un`, que
# en la Studio da "delivrixstudio" — un usuario que no existe en la mini. La copia externa fallaba
# SIEMPRE, de forma determinista, y solo se veía como un WARN en un log que nadie abre.
MINI_SSH="${MINI_SSH:-mini}"
MINI_DIR="${MINI_DIR:-delivrix-respaldos}"
RETENER="${RETENER:-7}"

mkdir -p "${DEST_DIR}"
decir() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG}"; }

PG_URL="$(grep -m1 -E '^[[:space:]]*POSTGRES_URL=' "${ROOT_DIR}/config/gateway.env" 2>/dev/null | cut -d= -f2-)"
if [[ -z "${PG_URL}" ]]; then decir "FATAL: sin POSTGRES_URL en config/gateway.env"; exit 1; fi

sello="$(date -u +%Y%m%dT%H%M%SZ)"
archivo="${DEST_DIR}/delivrix-${sello}.sql.gz"
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

# EL ESTADO QUE NO VIVE EN POSTGRES. /health declara `local-file` para la cola, el log de
# auditoría, la LISTA DE SUPRESIÓN, los nodos, los límites y el kill switch: son archivos en
# runtime/, fuera de git y fuera del dump. Respaldar solo Postgres dejaba los opt-outs y la
# cadena de auditoría sin ninguna copia — perder el disco era perderlos para siempre, y eso es
# un incidente de cumplimiento, no una molestia.
# NO se incluye config/gateway.env: son secretos en claro y no viajan solos a otra máquina.
estado="${DEST_DIR}/delivrix-estado-${sello}.tar.gz"
if tar czf "${estado}" -C "${ROOT_DIR}" \
      $(cd "${ROOT_DIR}" && ls runtime/*.json runtime/*.jsonl 2>/dev/null) \
      runtime/openclaw-workspace/inventory 2>/dev/null \
   && tar tzf "${estado}" >/dev/null 2>&1; then
  decir "estado ok · $(du -h "${estado}" | cut -f1) · $(basename "${estado}")"
else
  decir "FALLÓ el respaldo del estado local (runtime/) — el dump de Postgres SÍ quedó"
  rm -f "${estado}"
fi

# Copia a la mini (por Tailscale). Que falle no invalida el respaldo local, pero SÍ deja el
# sistema con una sola copia — que es justamente lo que este paso viene a evitar. El fallo se
# marca en un archivo además del log, para que el watchdog lo vea: un WARN en un log que nadie
# abre es indistinguible de que todo esté bien.
MARCA_SIN_COPIA="${ROOT_DIR}/runtime/RESPALDO-SIN-COPIA-EXTERNA"
if scp -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
     "${archivo}" "${estado}" "${MINI_SSH}:${MINI_DIR}/" 2>>"${LOG}"; then
  decir "copiado a la mini (${MINI_SSH}:${MINI_DIR})"
  rm -f "${MARCA_SIN_COPIA}"
else
  decir "WARN no pude copiar a la mini — el respaldo local existe, pero HOY no hay copia fuera de esta máquina"
  date -u +%Y-%m-%dT%H:%M:%SZ > "${MARCA_SIN_COPIA}"
fi

# Rotación: se borran los viejos SOLO después de que el nuevo existe y verificó.
for patron in "delivrix-*.sql.gz" "delivrix-estado-*.tar.gz"; do
  sobran="$(ls -1t "${DEST_DIR}"/${patron} 2>/dev/null | tail -n +$((RETENER + 1)) || true)"
  [[ -n "${sobran}" ]] || continue
  echo "${sobran}" | while read -r viejo; do rm -f "${viejo}"; decir "rotado $(basename "${viejo}")"; done
done
