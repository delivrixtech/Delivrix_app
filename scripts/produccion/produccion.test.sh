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
# El sensor de la flota vive en apps/gateway-api pero lo ejecuta flota-salud. Sin esto se despliega
# el código y la flota se sigue midiendo con el viejo: el 2026-08-06 el diff cambió el criterio de
# salud y el mapeo devolvió solo "gateway warmup-daemon", así que el daemon iba a filtrar el pool con
# la regla nueva sobre un sender-measurement.json escrito por la regla vieja. El mapeo dice en su
# comentario "ante la duda reinicia de MÁS"; acá reiniciaba de menos.
chequear "sensor de la flota"      "flota-salud gateway"                                  "$(mapa 'apps/gateway-api/src/sender-measurement.ts')"
chequear "salud de entrega"        "flota-salud gateway"                                  "$(mapa 'apps/gateway-api/src/smtp-delivery-health.ts')"
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

echo "arranque en frío: marca ISO → epoch"
# BSD `date -j -f` ACEPTA los milisegundos pero se queja por stderr en cada llamada; en un log de
# verificación ese ruido se lee como si el chequeo estuviera roto. Por eso se recortan.
ref=1785968693   # el boot real de la Studio: 2026-08-05T22:24:53Z
iso="$(date -u -r ${ref} +%Y-%m-%dT%H:%M:%SZ)"
chequear "ida y vuelta"            "${ref}" "$(delivrix_iso_a_epoch "${iso}")"
chequear "con milisegundos"        "${ref}" "$(delivrix_iso_a_epoch "${iso%Z}.287Z")"
chequear "sin Z"                   "${ref}" "$(delivrix_iso_a_epoch "${iso%Z}")"
chequear "basura → falla, no miente" "" "$(delivrix_iso_a_epoch "no soy una fecha" 2>/dev/null || true)"
chequear "vacío → falla"           ""       "$(delivrix_iso_a_epoch "" 2>/dev/null || true)"

echo "arranque en frío: primera línea posterior al boot"
# LA REGRESIÓN QUE ESTO EVITA: los logs sobreviven al reinicio. Sin comparar contra el boot, una
# línea del arranque ANTERIOR se toma como prueba del actual y el verificador da verde sobre una
# máquina que no levantó nada — que es exactamente la falla que vino a detectar.
fx="$(mktemp)"
cat > "${fx}" <<'LOG'
2026-08-05T10:00:00.000Z [info] event=gateway.started (arranque VIEJO, de antes del boot)
[2026-08-06T09:00:00Z] watchdog previo al boot
2026-08-06T18:30:11.500Z [info] event=gateway.started (éste sí)
2026-08-06T19:00:00.000Z [info] event=gateway.started (posterior, no es el primero)
LOG
chequear "toma la primera POSTERIOR"  "2026-08-06T18:30:11" "$(delivrix_primera_marca_iso '2026-08-06T18:00:00' < "${fx}")"
chequear "corte anterior a todo"      "2026-08-05T10:00:00" "$(delivrix_primera_marca_iso '2026-01-01T00:00:00' < "${fx}")"
chequear "todas viejas → vacío"       ""                    "$(delivrix_primera_marca_iso '2027-01-01T00:00:00' < "${fx}")"
chequear "formato [ISO] del watchdog" "2026-08-06T09:00:00" "$(delivrix_primera_marca_iso '2026-08-06T00:00:00' < "${fx}")"
chequear "sin marcas → vacío"         ""                    "$(printf 'linea sin fecha\n' | delivrix_primera_marca_iso '2026-08-06T00:00:00')"
rm -f "${fx}"

echo "arranque en frío: veredicto por servicio"
# Tres resultados, nunca dos. "No pude comprobarlo" NO es "está bien": el 2026-07-29 una sonda que
# se colgaba devolvió "bloqueado" falso en 10 de 10 nodos y se diagnosticó medio día un problema
# que no existía. Acá el falso positivo sería peor: dar por buena una máquina que no arrancó.
boot=1785968693
chequear "artefacto posterior al boot" "ok 120"     "$(delivrix_veredicto_artefacto ${boot} $((boot + 120)))"
chequear "artefacto anterior → FALLA"  "FALLA -60"  "$(delivrix_veredicto_artefacto ${boot} $((boot - 60)))"
chequear "artefacto ausente → NO SÉ"   "NOSE -"     "$(delivrix_veredicto_artefacto ${boot} '')"
chequear "medidoEn ilegible → NO SÉ"   "NOSE -"     "$(delivrix_veredicto_artefacto ${boot} 'no-es-epoch')"
chequear "boot ilegible → NO SÉ"       "NOSE -"     "$(delivrix_veredicto_artefacto '' $((boot + 5)))"
# warmup-cupo: limite-fisico.ts remide solo si la medición previa tiene ≥6h, así que tras un
# reinicio un servicio PERFECTO puede pasar hasta 6h sin escribir. Sin esta tolerancia el operador
# ve rojo en algo sano y aprende a ignorar el rojo — peor que no tener verificador.
ahora="$(date +%s)"
seis_h=21600
chequear "cupo viejo, <6h y arrancó → tolerado" "ok-tolerado -2600" \
  "$(delivrix_veredicto_artefacto $((ahora - 1000)) $((ahora - 3600)) ${seis_h} si)"
chequear "cupo viejo y >6h → FALLA"             "FALLA -24000" \
  "$(delivrix_veredicto_artefacto $((ahora - 1000)) $((ahora - 25000)) ${seis_h} si)"
# La tolerancia NO puede tapar un servicio que ni arrancó: si no hay línea de arranque, un archivo
# fresco es de la corrida ANTERIOR al reinicio y el servicio está muerto.
chequear "cupo viejo sin arranque → FALLA"      "FALLA -2600" \
  "$(delivrix_veredicto_artefacto $((ahora - 1000)) $((ahora - 3600)) ${seis_h} no)"
chequear "la tolerancia no cambia un ok"        "ok 300" \
  "$(delivrix_veredicto_artefacto ${boot} $((boot + 300)) ${seis_h} si)"

echo "sintaxis de los scripts"
for s in servicio.sh instalar-produccion.sh watchdog.sh respaldo-nocturno.sh desplegar.sh lib.sh vigilar-desde-la-mini.sh tunel.sh activar-warmup.sh verificar-arranque-en-frio.sh; do
  if bash -n "${ROOT_DIR}/scripts/produccion/${s}" 2>/dev/null; then
    printf '  ok   %s\n' "${s}"
  else
    printf '  FALLA %s (error de sintaxis)\n' "${s}"; fallos=$((fallos + 1))
  fi
done

echo
# --- la guarda anti doble-emisor tiene que ser PRECISA ------------------------------------------
# El 2026-08-06 el patrón `-f "live-warmup-daemon"` matcheó un `npm test` —su glob incluye
# apps/warmup-engine/**— y bloqueó un deploy legítimo con un FATAL sobre un emisor inexistente.
# Una guarda que grita en falso es una guarda que alguien termina comentando, y esta protege de lo
# único irreversible del proyecto: dos emisores duplicando volumen hacia Gmail.
echo "guarda anti doble-emisor"
patron="$(grep -o 'pgrep -f "[^"]*"' "${ROOT_DIR}/scripts/produccion/desplegar.sh" | head -1 | sed 's/pgrep -f "//; s/"$//')"
chequear "no matchea un npm test" "no" \
  "$(echo 'sh -c npm run typecheck:scripts && node --test apps/warmup-engine/src/**/*.test.ts' | grep -qE "${patron}" && echo si || echo no)"
chequear "sí matchea el daemon real" "si" \
  "$(echo '/opt/homebrew/bin/node --env-file=config/gateway.env --experimental-strip-types apps/warmup-engine/src/service/live-warmup-daemon.ts' | grep -qE "${patron}" && echo si || echo no)"

echo "el agente corre en el monitor, no solo en el gateway"
# Cambiar un prompt y reiniciar solo el gateway deja al agente razonando con el texto viejo: el
# código está en apps/gateway-api/src/agents/ pero lo ejecuta scripts/ops/warmup-monitor.ts.
chequear "un prompt del agente reinicia el monitor" "gateway warmup-monitor" \
  "$(mapa 'apps/gateway-api/src/agents/warmup-monitor.ts')"
chequear "una ruta del gateway NO reinicia el monitor" "gateway" \
  "$(mapa 'apps/gateway-api/src/routes/health.ts')"

if (( fallos == 0 )); then echo "TODO OK"; else echo "${fallos} FALLA(S)"; exit 1; fi
