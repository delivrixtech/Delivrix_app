#!/usr/bin/env bash
# CORRE EN LA MINI. Vigila que la Studio (producción) siga viva.
#
# Una máquina nunca es testigo de su propia muerte: el watchdog de la Studio no puede avisar que
# la Studio se murió. Esto lo mira desde afuera, que es el mismo modo de falla que ya vimos en la
# flota (el proveedor daba el nodo "running" y solo un chequeo externo lo vio incomunicado).
#
# NO activa nada. Solo avisa. Activar el relevo es una decisión humana, a propósito: en warmup,
# enviar dos veces es peor que estar pausado — pausar no cuesta reputación, duplicar el volumen
# puede cruzar el umbral de "bulk sender" de Gmail, que es permanente.
#
# Instalación en la mini (LaunchAgent, cada 10 min):
#   cp com.delivrix.vigia.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/...
# o simplemente:  */10 * * * * /ruta/vigilar-desde-la-mini.sh
set -uo pipefail

# Alias `studio` de ~/.ssh/config en la mini: trae usuario Y llave. Con la IP pelada, ssh usa el
# usuario local (delivrixmini), que no existe en la Studio, y el vigía reportaría "caída" una
# máquina perfectamente viva — la peor falla posible en un vigilante.
STUDIO_SSH="${STUDIO_SSH:-studio}"
ESTADO="${ESTADO:-${HOME}/.delivrix-vigia}"
LOG="${LOG:-${HOME}/delivrix-vigia.log}"
# 3 fallos seguidos (~30 min) antes de gritar: un fallo suelto es un hipo de red, no una muerte.
FALLOS_PARA_ALERTA="${FALLOS_PARA_ALERTA:-3}"
RESPALDOS_DIR="${RESPALDOS_DIR:-${HOME}/delivrix-respaldos}"
RESPALDO_MAX_HORAS="${RESPALDO_MAX_HORAS:-48}"

mkdir -p "$(dirname "${ESTADO}")"
decir() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${LOG}"; }

avisar() {
  local msg="$1"
  decir "ALERTA: ${msg}"
  # Notificación en pantalla de la mini. El canal de verdad (Slack/push) se cablea después;
  # dejarlo mudo sería peor que esto.
  osascript -e "display notification \"${msg}\" with title \"Delivrix producción\"" 2>/dev/null || true
  echo "${msg}"
}

fallos=0
[[ -f "${ESTADO}" ]] && fallos="$(cat "${ESTADO}" 2>/dev/null || echo 0)"
[[ "${fallos}" =~ ^[0-9]+$ ]] || fallos=0

# El gateway responde /health solo en loopback de la Studio, así que se pregunta por SSH.
# Se prueban las dos rutas: si Tailscale se cae pero la Studio vive, no es una muerte.
salud="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "${STUDIO_SSH}" \
  'curl -fsS --max-time 5 http://127.0.0.1:3000/health' 2>/dev/null || true)"

if printf '%s' "${salud}" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  if (( fallos >= FALLOS_PARA_ALERTA )); then
    avisar "la Studio VOLVIÓ (estaba caída hace $(( fallos * 10 )) min)"
  fi
  echo 0 > "${ESTADO}"
  decir "studio ok"
else
  fallos=$(( fallos + 1 ))
  echo "${fallos}" > "${ESTADO}"
  decir "studio NO responde (fallo ${fallos}/${FALLOS_PARA_ALERTA})"
  if (( fallos == FALLOS_PARA_ALERTA )); then
    avisar "la Studio no responde hace ~$(( fallos * 10 )) min. El warmup está PAUSADO (la flota sigue enviando sola). Activar el relevo es decisión tuya."
  fi
fi

# Un respaldo que dejó de llegar es una falla silenciosa: nadie la nota hasta que se necesita.
ultimo="$(ls -1t "${RESPALDOS_DIR}"/delivrix-*.sql.gz 2>/dev/null | head -1 || true)"
if [[ -z "${ultimo}" ]]; then
  decir "WARN no hay ningún respaldo en ${RESPALDOS_DIR}"
else
  horas=$(( ( $(date +%s) - $(stat -f %m "${ultimo}") ) / 3600 ))
  if (( horas >= RESPALDO_MAX_HORAS )); then
    avisar "el último respaldo de la Studio tiene ${horas}h (tope ${RESPALDO_MAX_HORAS}h)"
  else
    decir "respaldo más nuevo: ${horas}h"
  fi
fi
