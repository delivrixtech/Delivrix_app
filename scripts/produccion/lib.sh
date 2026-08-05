#!/usr/bin/env bash
# Piezas compartidas de producción. Viven acá porque tienen que ser PROBABLES: si el test se
# escribe contra una copia de la lógica en vez de contra la lógica misma, el test y el código
# comparten el error y el verde no significa nada (ya nos pasó con un fixture de Bedrock).
#
# Se usa con `source`. No ejecuta nada por sí sola.

# Lee UNA clave de un archivo de entorno estilo KEY=valor, quitando comillas envolventes.
# Mismo criterio que load_admin_proxy_env de delivrix-admin-start.sh.
delivrix_leer_env() {
  local archivo="$1" clave="$2" linea valor
  [[ -f "${archivo}" ]] || return 0
  linea="$(grep -m1 -E "^[[:space:]]*${clave}=" "${archivo}" 2>/dev/null || true)"
  [[ -n "${linea}" ]] || return 0
  valor="${linea#*=}"
  valor="${valor%$'\r'}"
  if [[ "${valor}" == \"*\" && ${#valor} -ge 2 ]]; then valor="${valor:1:${#valor}-2}"; fi
  printf '%s' "${valor}"
}

# Segundos desde el arranque, a partir de la salida cruda de `sysctl -n kern.boottime`, que es:
#   { sec = 1785948516, usec = 610720 } Wed Aug  5 11:48:36 2026
# OJO con la trampa: `sed 's/.*sec = ([0-9]+).*/\1/'` es CODICIOSO y captura el usec, no el sec.
# Devolvía 610720 y el uptime salía gigante ⇒ la gracia de arranque nunca se activaba, sin decir
# nada. Por eso vive acá y tiene test: es un parseo que falla en silencio.
delivrix_uptime_s() {
  local crudo="$1" sec
  sec="$(printf '%s' "${crudo}" | sed -E 's/^\{[[:space:]]*sec[[:space:]]*=[[:space:]]*([0-9]+).*/\1/')"
  [[ "${sec}" =~ ^[0-9]+$ ]] || return 1
  echo $(( $(date +%s) - sec ))
}

# Umbral de silencio del daemon, DERIVADO del intervalo real de vuelta (no un número a mano: uno
# menor que el intervalo reinicia el daemon en bucle para siempre). 2,5 vueltas + 10 min de gracia.
delivrix_umbral_silencio_min() {
  local archivo="$1" v intervalo
  v="$(delivrix_leer_env "${archivo}" WARMUP_LIVE_INTERVAL_MS | tr -dc '0-9')"
  intervalo=$(( ${v:-0} / 60000 ))
  (( intervalo > 0 )) || intervalo=240   # sin dato: el default del código son 4h
  echo $(( intervalo * 5 / 2 + 10 ))
}

# Dada una lista de archivos cambiados (uno por línea en stdin), imprime qué servicios hay que
# reiniciar, uno por línea. Ante la duda reinicia de MÁS: un servicio corriendo código viejo es
# una falla silenciosa, y reiniciar de sobra cuesta segundos.
delivrix_servicios_afectados() {
  local f
  local -a acc=()
  _sumar() { local s; for s in "$@"; do [[ " ${acc[*]:-} " == *" ${s} "* ]] || acc+=("${s}"); done; }
  while IFS= read -r f; do
    [[ -n "${f}" ]] || continue
    case "${f}" in
      packages/*|config/*|package.json|package-lock.json|scripts/produccion/servicio.sh|scripts/produccion/lib.sh)
        _sumar gateway panel warmup-daemon warmup-monitor warmup-cupo ;;
      apps/gateway-api/*)            _sumar gateway ;;
      apps/admin-panel/*)            _sumar panel ;;
      apps/warmup-engine/*)          _sumar warmup-daemon gateway ;;
      scripts/ops/warmup-monitor.ts) _sumar warmup-monitor ;;
      scripts/ops/limite-fisico.ts)  _sumar warmup-cupo ;;
    esac
  done
  local s
  for s in "${acc[@]:-}"; do [[ -n "${s}" ]] && printf '%s\n' "${s}"; done
}
