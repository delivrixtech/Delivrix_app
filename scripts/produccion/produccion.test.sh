#!/usr/bin/env bash
# Chequeo de la lógica que puede fallar en silencio del kit de producción.
#
# Las dos cosas que rompen sin hacer ruido:
#   - el mapa de archivo→servicio: si erra, un servicio queda corriendo código VIEJO y todo
#     "funciona" hasta que alguien nota que el fix no está aplicado;
#   - la lectura del entorno: si erra, el panel arranca sin token y queda en "reconnecting".
#
# Corre: bash scripts/produccion/produccion.test.sh
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/scripts/produccion/lib.sh"

fallos=0
chequear() {
  local nombre="$1" esperado="$2" obtenido="$3"
  if [[ "${esperado}" == "${obtenido}" ]]; then
    printf '  ok   %s\n' "${nombre}"
  else
    printf '  FALLA %s\n       esperado: [%s]\n       obtenido: [%s]\n' "${nombre}" "${esperado}" "${obtenido}"
    fallos=$((fallos + 1))
  fi
}

mapa() { printf '%s\n' "$1" | delivrix_servicios_afectados | sort | tr '\n' ' ' | sed 's/ $//'; }

echo "mapa de archivo → servicio"
chequear "gateway solo"            "gateway"                                              "$(mapa 'apps/gateway-api/src/main.ts')"
chequear "panel solo"              "panel"                                                "$(mapa 'apps/admin-panel/src/App.tsx')"
chequear "warmup toca daemon+gw"   "gateway warmup-daemon"                                "$(mapa 'apps/warmup-engine/src/service/live-warmup-daemon.ts')"
chequear "monitor"                 "warmup-monitor"                                       "$(mapa 'scripts/ops/warmup-monitor.ts')"
chequear "cupo"                    "warmup-cupo"                                          "$(mapa 'scripts/ops/limite-fisico.ts')"
# La salud de la flota decide QUÉ DOMINIOS entran al pool del warmup. Salía de una corrida manual,
# así que nadie la corría: el 2026-08-06 el archivo tenía 35h y el agente elegía el pool con una
# foto de anteayer. Ahora es un servicio, y como tal tiene que reiniciarse cuando cambia su código.
chequear "salud de la flota"       "flota-salud"                                          "$(mapa 'scripts/ops/medir-flota.ts')"
chequear "packages toca todo"      "flota-salud gateway panel warmup-cupo warmup-daemon warmup-monitor" "$(mapa 'packages/queue/src/index.ts')"
chequear "config toca todo"        "flota-salud gateway panel warmup-cupo warmup-daemon warmup-monitor" "$(mapa 'config/gateway.env')"
chequear "doc no toca nada"        ""                                                     "$(mapa 'DOCUMENTACION/algo.md')"
chequear "sin duplicados"          "gateway warmup-daemon"                                "$(mapa 'apps/warmup-engine/a.ts
apps/warmup-engine/b.ts
apps/gateway-api/c.ts')"
chequear "entrada vacía"           ""                                                     "$(mapa '')"

echo "lectura del entorno"
fixture="$(mktemp)"
cat > "${fixture}" <<'ENV'
# un comentario
VACIA=
TOKEN=abc123
CON_COMILLAS="def 456"
CON_IGUAL=postgres://u:p@h:5432/db?x=1
PARECIDA_TOKEN=no-es-esta
ENV
chequear "clave simple"       "abc123"                          "$(delivrix_leer_env "${fixture}" TOKEN)"
chequear "quita comillas"     "def 456"                         "$(delivrix_leer_env "${fixture}" CON_COMILLAS)"
chequear "respeta los ="      "postgres://u:p@h:5432/db?x=1"    "$(delivrix_leer_env "${fixture}" CON_IGUAL)"
chequear "vacía es vacía"     ""                                "$(delivrix_leer_env "${fixture}" VACIA)"
chequear "clave ausente"      ""                                "$(delivrix_leer_env "${fixture}" NO_EXISTE)"
chequear "no agarra sufijos"  "abc123"                          "$(delivrix_leer_env "${fixture}" TOKEN)"
rm -f "${fixture}"

echo "umbral de silencio del daemon"
umb="$(mktemp)"
printf 'WARMUP_LIVE_INTERVAL_MS=5400000\n' > "${umb}"   # 90 min, el valor real de hoy
chequear "90min → 235"        "235" "$(delivrix_umbral_silencio_min "${umb}")"
printf 'WARMUP_LIVE_INTERVAL_MS=540000\n' > "${umb}"    # 9 min
chequear "9min → 32"          "32"  "$(delivrix_umbral_silencio_min "${umb}")"
printf 'OTRA=1\n' > "${umb}"                            # sin el dato: default del código, 4h
chequear "sin dato → 610"     "610" "$(delivrix_umbral_silencio_min "${umb}")"
# La invariante que importa: el umbral SIEMPRE mayor que el intervalo, o el watchdog reinicia
# el daemon en bucle para siempre.
for ms in 540000 5400000 14400000 60000; do
  printf 'WARMUP_LIVE_INTERVAL_MS=%s\n' "${ms}" > "${umb}"
  u="$(delivrix_umbral_silencio_min "${umb}")"; i=$(( ms / 60000 ))
  chequear "umbral(${i}min) > intervalo" "si" "$( (( u > i )) && echo si || echo NO )"
done
rm -f "${umb}"

echo "uptime desde kern.boottime (el parseo que falló en silencio)"
ahora="$(date +%s)"
crudo="{ sec = $((ahora - 42)), usec = 610720 } Wed Aug  5 11:48:36 2026"
u="$(delivrix_uptime_s "${crudo}")"
chequear "toma el sec, NO el usec" "si" "$( (( u >= 40 && u <= 45 )) && echo si || echo "NO(${u})" )"
# La regresión concreta: con un sed codicioso esto daba 610720 y la gracia nunca se activaba.
chequear "no confunde usec con sec"  "si" "$( [[ "${u}" != "610720" ]] && echo si || echo NO )"
crudo2="{ sec = $((ahora - 5)), usec = 1 } x"
u2="$(delivrix_uptime_s "${crudo2}")"
chequear "recién arrancada → uptime chico" "si" "$( (( u2 < 10 )) && echo si || echo "NO(${u2})" )"
chequear "entrada basura → falla, no miente" "" "$(delivrix_uptime_s "no soy boottime" 2>/dev/null || true)"

echo "sintaxis de los scripts"
for s in servicio.sh instalar-produccion.sh watchdog.sh respaldo-nocturno.sh desplegar.sh lib.sh vigilar-desde-la-mini.sh tunel.sh activar-warmup.sh; do
  if bash -n "${ROOT_DIR}/scripts/produccion/${s}" 2>/dev/null; then
    printf '  ok   %s\n' "${s}"
  else
    printf '  FALLA %s (error de sintaxis)\n' "${s}"; fallos=$((fallos + 1))
  fi
done

echo
if (( fallos == 0 )); then echo "TODO OK"; else echo "${fallos} FALLA(S)"; exit 1; fi
