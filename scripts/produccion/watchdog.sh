#!/usr/bin/env bash
# Cubre el modo de falla que launchd NO ve: el proceso VIVO pero colgado.
#
# KeepAlive relanza lo que muere. Un proceso que sigue en memoria pero dejó de responder
# (conexión IMAP colgada, event loop bloqueado) para launchd está perfecto. Eso ya nos pasó con
# un nodo de la flota: el proveedor lo daba "running" y solo un chequeo externo lo vio muerto.
#
# Corre cada 5 min por launchd (com.delivrix.watchdog).
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/runtime/logs"
STAMP_DIR="${ROOT_DIR}/runtime/watchdog"
LOG="${LOG_DIR}/watchdog.log"
mkdir -p "${LOG_DIR}" "${STAMP_DIR}"
# shellcheck source=scripts/produccion/lib.sh
source "${ROOT_DIR}/scripts/produccion/lib.sh"

GATEWAY_URL="${GATEWAY_HEALTH_URL:-http://127.0.0.1:3000/health}"
PANEL_URL="${PANEL_URL:-http://127.0.0.1:5173/}"
# El daemon escribe una vez por vuelta; el umbral se DERIVA del intervalo real (ver lib.sh).
DAEMON_MAX_SILENCIO_MIN="${DAEMON_MAX_SILENCIO_MIN:-$(delivrix_umbral_silencio_min "${ROOT_DIR}/config/gateway.env")}"
# Nunca dos kickstarts al mismo servicio en menos de esto: si algo está roto de verdad,
# reiniciarlo cada 5 min no lo arregla y sí llena el disco de logs.
REINTENTO_MIN="${REINTENTO_MIN:-15}"
LOG_MAX_MB="${LOG_MAX_MB:-64}"

decir() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${LOG}"; }

# Devuelve 0 si al servicio le toca reinicio (no lo reiniciamos hace más de REINTENTO_MIN).
puede_reiniciar() {
  local svc="$1" stamp="${STAMP_DIR}/$1.last"
  [[ -f "${stamp}" ]] || return 0
  local edad_min=$(( ( $(date +%s) - $(stat -f %m "${stamp}" 2>/dev/null || echo 0) ) / 60 ))
  (( edad_min >= REINTENTO_MIN ))
}

reiniciar() {
  local svc="$1" motivo="$2"
  if ! puede_reiniciar "${svc}"; then
    decir "${svc}: ${motivo} — PERO se reinició hace menos de ${REINTENTO_MIN}min; no insisto (revisar a mano)"
    return
  fi
  touch "${STAMP_DIR}/${svc}.last"
  decir "${svc}: ${motivo} → kickstart"
  launchctl kickstart -k "system/com.delivrix.${svc}" >> "${LOG}" 2>&1 \
    || decir "${svc}: kickstart FALLÓ (¿está cargado el plist?)"
}

estado=()

# --- gateway: tiene que responder /health con status ok --------------------------------------
salud="$(curl -fsS --max-time 10 "${GATEWAY_URL}" 2>/dev/null || true)"
if [[ -z "${salud}" ]]; then
  reiniciar gateway "no responde ${GATEWAY_URL}"
  estado+=("gateway=CAIDO")
elif ! printf '%s' "${salud}" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  # Postgres caído se ve acá: reiniciar el gateway no lo arregla, así que solo se registra.
  decir "gateway: responde pero status != ok — $(printf '%s' "${salud}" | head -c 200)"
  estado+=("gateway=degradado")
else
  estado+=("gateway=ok")
fi

# --- panel: basta con que el puerto sirva algo -----------------------------------------------
if curl -fsS --max-time 10 -o /dev/null "${PANEL_URL}" 2>/dev/null; then
  estado+=("panel=ok")
else
  reiniciar panel "no responde ${PANEL_URL}"
  estado+=("panel=CAIDO")
fi

# --- warmup daemon: vivo se demuestra ESCRIBIENDO, no existiendo -----------------------------
daemon_log="${LOG_DIR}/warmup-daemon.log"
if [[ -f "${daemon_log}" ]]; then
  silencio_min=$(( ( $(date +%s) - $(stat -f %m "${daemon_log}") ) / 60 ))
  if (( silencio_min >= DAEMON_MAX_SILENCIO_MIN )); then
    reiniciar warmup-daemon "sin escribir hace ${silencio_min}min (tope ${DAEMON_MAX_SILENCIO_MIN})"
    estado+=("warmup=MUDO:${silencio_min}min")
  else
    estado+=("warmup=ok:${silencio_min}min")
  fi
else
  estado+=("warmup=sin-log")
fi

# --- rotación: el log del daemon crece 24/7 y launchd no rota -------------------------------
for f in "${LOG_DIR}"/*.log; do
  [[ -f "${f}" ]] || continue
  mb=$(( $(stat -f %z "${f}") / 1048576 ))
  if (( mb >= LOG_MAX_MB )); then
    mv -f "${f}" "${f}.1"
    decir "rotado $(basename "${f}") (${mb}MB)"
  fi
done

# Una línea por corrida SIEMPRE, incluso cuando todo está bien: un watchdog que solo habla cuando
# hay problemas es indistinguible de un watchdog que dejó de correr.
decir "${estado[*]}"

# El último `((...))` de la rotación devuelve 1 cuando no hay nada que rotar, y ése sería el
# código de salida del script: launchd lo registraría como fallo en cada corrida normal.
exit 0
