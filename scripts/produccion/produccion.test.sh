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
# EL CUPO VIVE EN gateway-api Y CORRE EN warmup-cupo. `scripts/ops/limite-fisico.ts` (el
# entrypoint del servicio warmup-cupo) importa `resolverTecho` de sender-quota.ts y el parser de
# node-daily-cap.ts; `scripts/ops/warmup-monitor.ts` importa `porEncimaDelTecho` de node-daily-cap.
# Con el caso genérico `apps/gateway-api/*` los dos devolvían sólo "gateway": el módulo que gobierna
# el TOPE DIARIO DE VOLUMEN seguía vivo en memoria con el código viejo. Hoy queda tapado de
# casualidad porque limite-fisico.ts y warmup-monitor.ts también están en el diff; el día que se
# toque sólo uno de estos dos archivos, no.
chequear "cupo por dominio"        "gateway warmup-cupo"                                  "$(mapa 'apps/gateway-api/src/sender-quota.ts')"
chequear "tope diario del nodo"    "gateway warmup-cupo warmup-monitor"                   "$(mapa 'apps/gateway-api/src/node-daily-cap.ts')"
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

echo "entorno para la foto: se publica el nombre, casi nunca el valor"
# Esto sale de producción hacia una carpeta que van a leer agentes: si el filtro se afloja, la foto
# publica una credencial. Se prueba la FUGA (que un secreto salga entero), no la comodidad.
seguro() { printf '%s\n' "$1" | delivrix_env_seguro; }
chequear "booleano visible"      "WARMUP_LIVE_ENABLE=true"          "$(seguro 'WARMUP_LIVE_ENABLE=true')"
chequear "booleano en false"     "WARMUP_AGENT_PUEDE_SOLTAR=false"  "$(seguro 'WARMUP_AGENT_PUEDE_SOLTAR=false')"
chequear "entero corto visible"  "WARMUP_TOPE_DIARIO=14"            "$(seguro 'WARMUP_TOPE_DIARIO=14')"
chequear "token oculto"          "OPENCLAW_GATEWAY_TOKEN=(oculto)"  "$(seguro 'OPENCLAW_GATEWAY_TOKEN=sk-live-9f3a2b')"
chequear "url con clave oculta"  "POSTGRES_URL=(oculto)"            "$(seguro 'POSTGRES_URL=postgres://u:p@h:5432/db')"
chequear "clave sin nombre delator" "SLACK_WEBHOOK=(oculto)"        "$(seguro 'SLACK_WEBHOOK=https://hooks.slack.com/services/T00/B00/xyz')"
# El caso que rompe una lista negra de nombres: un secreto numérico largo. Por FORMA se oculta.
chequear "número largo oculto"   "PIN=(oculto)"                     "$(seguro 'PIN=1234567890123')"
chequear "con comillas oculto"   "CLAVE=(oculto)"                   "$(seguro 'CLAVE="abc 123"')"
chequear "export y espacios"     "WARMUP_LIVE_ENABLE=true"          "$(seguro 'export WARMUP_LIVE_ENABLE=true ')"
chequear "comentario no sale"    ""                                 "$(seguro '# WARMUP_LIVE_ENABLE=true')"
chequear "vacía sale oculta"     "VACIA=(oculto)"                   "$(seguro 'VACIA=')"
chequear "línea sin = se ignora" ""                                 "$(seguro 'esto no es una asignación')"

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

echo "launchd: el parseo que comparten los dos verificadores"
# Toma el TEXTO y no el nombre del servicio justamente para poder probarse sin launchd. Lo leen
# verificar-arranque-en-frio.sh y verificar-despliegue.sh: mientras había dos copias del mismo sed,
# tocar una dejaba a los dos scripts dando veredictos distintos del mismo servicio.
salida_real='	state = running
	program = /bin/bash
	pid = 331
	last exit code = 0
	runs = 2'
chequear "servicio vivo"        "running|331|0|2" "$(delivrix_launchd_campos "${salida_real}")"
# El job periódico: `not running` es su estado NORMAL (StartInterval). Leerlo como muerto es el
# error clásico, y el parser tiene que devolverlo tal cual para que quien decida pueda distinguir.
chequear "periódico sin pid"    "not running||0|17" \
  "$(delivrix_launchd_campos '	state = not running
	last exit code = 0
	runs = 17')"
# Un exit distinto de 0 tiene que sobrevivir el parseo: es la señal de que el servicio se muere.
chequear "murió con exit 78"    "not running||78|9" \
  "$(delivrix_launchd_campos '	state = not running
	last exit code = 78
	runs = 9')"
# Y lo más importante: campos vacíos, que se leen "no sé" y NUNCA "no está corriendo". Ausencia de
# dato no es evidencia (la lección del probe colgado del 2026-07-29: 10 de 10 negativos falsos).
chequear "salida vacía → todo vacío" "|||" "$(delivrix_launchd_campos '')"
chequear "salida sin los campos"     "|||" "$(delivrix_launchd_campos 'no me parezco a launchctl')"
# `pid = 331` y no la primera línea que contenga "pid": launchctl imprime también `original pid`
# en algunos jobs, y tomar el primer match daría el PID equivocado.
chequear "no confunde otros campos"  "running|331||" \
  "$(delivrix_launchd_campos '	state = running
	pid = 331
	spawn type = daemon')"

echo "sintaxis de los scripts"
for s in servicio.sh instalar-produccion.sh watchdog.sh respaldo-nocturno.sh desplegar.sh lib.sh vigilar-desde-la-mini.sh tunel.sh activar-warmup.sh verificar-arranque-en-frio.sh verificar-despliegue.sh; do
  if bash -n "${ROOT_DIR}/scripts/produccion/${s}" 2>/dev/null; then
    printf '  ok   %s\n' "${s}"
  else
    printf '  FALLA %s (error de sintaxis)\n' "${s}"; fallos=$((fallos + 1))
  fi
done
# La foto vive en scripts/ops pero usa lib.sh y es la puerta por donde los agentes ven producción:
# si no parsea, el operador se entera con la Studio del otro lado.
if bash -n "${ROOT_DIR}/scripts/ops/foto-produccion.sh" 2>/dev/null; then
  printf '  ok   ops/foto-produccion.sh\n'
else
  printf '  FALLA ops/foto-produccion.sh (error de sintaxis)\n'; fallos=$((fallos + 1))
fi

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

echo "el kit de producción no puede agrandar el radio de un despliegue"
# LA PRUEBA DE QUE TOCAR ESTE KIT ES BARATO. servicio.sh sourcea lib.sh, así que cualquier cambio en
# lib.sh ya reinicia LOS SEIS: es el máximo, no se puede agrandar. Es lo que permite meter cambios
# de este kit en el mismo deploy que el código de runtime sin sumarle un solo reinicio.
chequear "lib.sh ya reinicia todo"  "flota-salud gateway panel warmup-cupo warmup-daemon warmup-monitor" \
  "$(mapa 'scripts/produccion/lib.sh')"
chequear "lib.sh + cupo = lo mismo" "flota-salud gateway panel warmup-cupo warmup-daemon warmup-monitor" \
  "$(mapa 'scripts/produccion/lib.sh
apps/gateway-api/src/node-daily-cap.ts')"

echo "el freno va ANTES del reinicio, y nadie lo borra solo"
# EL INCIDENTE QUE ESTO EVITA: desplegar NO baja el pool. `elegirPool` LEE sender-measurement.json y
# ese archivo lo escribe flota-salud, que tarda ~250 s en remedir; el daemon, en cambio, manda en su
# PRIMER tick. Poner el freno DESPUÉS del kickstart no sirve de nada: para cuando se ejecuta, el
# correo ya salió desde el pool viejo (medido sobre la foto del 2026-08-08: 32 dominios, con
# corpfilinginfra.com, corpregistry-control.com y docfiling-ops.com adentro).
DEP="${ROOT_DIR}/scripts/produccion/desplegar.sh"
ln_freno="$(grep -n 'touch runtime/warmup-live\.kill' "${DEP}" | head -1 | cut -d: -f1)"
ln_kick="$(grep -n 'echo "· reiniciando:' "${DEP}" | head -1 | cut -d: -f1)"
chequear "hay freno en desplegar.sh"  "si" "$( [[ -n "${ln_freno}" ]] && echo si || echo NO )"
chequear "hay bucle de kickstart"     "si" "$( [[ -n "${ln_kick}" ]] && echo si || echo NO )"
chequear "el freno va ANTES"          "si" \
  "$( [[ -n "${ln_freno}" && -n "${ln_kick}" ]] && (( ln_freno < ln_kick )) && echo si || echo "NO(freno=${ln_freno:-?} kick=${ln_kick:-?})" )"
# Y NUNCA lo borra: soltar el emisor es una decisión de una persona que ya miró el pool. Se filtran
# comentarios y `echo` porque el script IMPRIME el comando para soltarlo — imprimirlo es lo correcto,
# ejecutarlo no.
chequear "desplegar.sh NUNCA borra el freno" "0" \
  "$(grep -vE '^[[:space:]]*(#|echo )' "${DEP}" | grep -cE 'rm .*warmup-live\.kill' || true)"
# El respaldo de datos: sin él, un rollback de código deja el JSON NUEVO con el sensor VIEJO, cuyo
# `motivoDeExclusion` es lista NEGRA y no tiene rama para `insufficient_sample` ⇒ esos nodos vuelven
# al pool con UNA entrega. El rollback de código a secas abre el pool más que no hacer nada.
chequear "deja snapshot para el rollback de DATOS" "si" \
  "$(grep -q 'sender-measurement\.pre-deploy\.json' "${DEP}" && echo si || echo NO)"

echo "el freno olvidado no puede ser silencioso"
# EL OTRO LADO DEL MISMO FRENO. Si el verificador puede decir "DESPLIEGUE VERIFICADO" con el
# kill-file puesto, alguien cierra la terminal y el warmup queda parado PARA SIEMPRE sin que nada lo
# diga. Y como ahora desplegar.sh lo pone en CADA deploy, ese caso pasó de raro a ser el normal.
vd() { delivrix_veredicto_despliegue "$@"; }
chequear "frenado con todo bien → rojo"   "1|FRENADO: falta soltar el emisor — 0 falla(s), 0 sin verificar, 0 aviso(s)" "$(vd 0 0 0 1)"
chequear "frenado gana sobre las fallas"  "1|FRENADO: falta soltar el emisor — 2 falla(s), 1 sin verificar, 3 aviso(s)" "$(vd 2 1 3 1)"
# Y EL OTRO SENTIDO, que es el que impide que esto sea un rojo permanente: sin el archivo y sin
# fallas, verde. Un verificador que nunca puede dar verde se ignora igual que uno que siempre lo da.
chequear "sin freno y sin fallas → verde" "0|DESPLIEGUE VERIFICADO: 0 fallas, 0 aviso(s)"                "$(vd 0 0 0 0)"
chequear "avisos solos no son rojo"       "0|DESPLIEGUE VERIFICADO: 0 fallas, 4 aviso(s)"                "$(vd 0 0 4 0)"
chequear "una falla sí es rojo"           "1|NO: 1 falla(s), 0 sin verificar, 0 aviso(s)"                "$(vd 1 0 0 0)"
chequear "un no-sé no es un ok"           "1|INCOMPLETO: 0 fallas, 2 sin verificar, 1 aviso(s) — volvé a correrlo" "$(vd 0 2 1 0)"
# CABLEADO DE VERDAD, no una función suelta: van SEIS capacidades construidas en este repo que nunca
# tuvieron llamador. El veredicto de arriba sólo vale si verificar-despliegue.sh lo usa, y sólo
# muerde si el kill-file prende la bandera.
VER="${ROOT_DIR}/scripts/produccion/verificar-despliegue.sh"
chequear "el verificador USA el veredicto" "si" \
  "$(grep -q 'delivrix_veredicto_despliegue "\${fallas}"' "${VER}" && echo si || echo NO)"
chequear "el kill-file prende la bandera"  "si" \
  "$(grep -A2 'runtime/warmup-live\.kill" \]\]; then' "${VER}" | grep -q 'EMISOR_FRENADO=1' && echo si || echo NO)"

echo "un pool VACÍO no puede pasar como verde"
# EL AGUJERO: el pool sólo se juzgaba contra el TECHO. Con `n_pool = 0` la condición `n > POOL_MAX`
# es falsa, caía al `elif remidio` y el verificador imprimía `ok "el pool bajó a 0"` — la fábrica
# PARADA saliendo verde en el único instrumento que la vigila. El agente está igual de ciego del
# otro lado (`decideDaemonAction` devuelve `send` con el pool vacío porque el branch de "nada que
# calentar" está DESPUÉS del gate), así que el desenlace que este despliegue tiene que evitar no lo
# veía NINGUNO de los dos.
#
# Se prueba acá y no adentro del verificador porque para llegar a esa rama hacen falta node,
# config/gateway.env y el inventario entero: en el árbol falso todo eso muere en el `nose` de "no
# pude calcular el pool". Por eso el juicio vive en lib.sh, igual que el veredicto.
jp() { delivrix_juicio_pool "$@"; }
chequear "pool 0 remedido → FALLA"        "falla|el pool quedó VACÍO: no hay UN dominio desde el cual calentar — la fábrica no fabrica" "$(jp 0 1 12)"
chequear "pool 0 sin remedir → FALLA"     "falla|el pool quedó VACÍO: no hay UN dominio desde el cual calentar — la fábrica no fabrica" "$(jp 0 0 12)"
# Y las tres direcciones que no se pueden romper: un pool sano remedido SÍ es verde (un verificador
# que nunca da verde se ignora igual que uno que siempre lo da), uno gordo es aviso, y con la
# medición vieja ningún número dice nada todavía.
chequear "pool 6 remedido → ok"           "ok|el pool bajó a 6 (techo 12)"                                    "$(jp 6 1 12)"
chequear "pool 32 remedido → aviso"       "aviso|el pool quedó en 32 (esperado ~6, techo 12): mirá a quién dejó entrar antes de seguir" "$(jp 32 1 12)"
chequear "pool 32 sin remedir → no sé"    "nose|el pool está en 32 con la medición vieja — todavía no bajó porque todavía no remidió"  "$(jp 32 0 12)"
chequear "pool 6 sin remedir NO es un ok" "nose|el pool está en 6, pero con la medición vieja ese número no dice nada del deploy"      "$(jp 6 0 12)"
chequear "pool ilegible → no sé"          "nose|no pude calcular el tamaño del pool"                          "$(jp '' 1 12)"
# CABLEADO DE VERDAD: van SIETE capacidades construidas en este repo que nunca tuvieron llamador.
chequear "el verificador USA el juicio del pool" "si" \
  "$(grep -q 'delivrix_juicio_pool "\${n_pool}"' "${VER}" && echo si || echo NO)"

# LA LISTA DE QUEMADOS TIENE QUE SER LA QUE DICE EL LOG, no la que alguien recordó. Nació con TRES
# y el log del daemon nombra SIETE vueltas seguidas con MISSING (#21 a #27): las otras cuatro
# quedaron afuera sin razón, o sea que el verificador las habría dejado entrar al pool calladas.
# Se afirma acá porque es una lista escrita a mano, que es exactamente la clase de dato que se
# desactualiza sin que nada falle.
for q in corpfilinginfra.com corpregistry-control.com docfiling-ops.com \
         infranationalcorp.com nationalcorp-control.com nationalcorp-infra.com nationalfilingcontrol.com; do
  chequear "quemado en la lista: ${q}" "si" \
    "$(grep -q "${q}" "${VER}" && echo si || echo NO)"
done
# Y la otra dirección: el verificador NO puede prometer que el sensor los saca. Si alguien vuelve a
# escribir «el sensor nuevo no los sacó» como si fuera una sorpresa, el operador espera un verde que
# no llega y el atajo obvio es soltar el freno igual — el incidente que el freno viene a evitar.
chequear "el verificador dice que es ESPERADO y da la salida a mano" "si" \
  "$(grep -q 'ES LO ESPERADO: el sensor no puede sacarlos' "${VER}" && grep -q 'cerradoEn' "${VER}" && echo si || echo NO)"

# Y AHORA EL SCRIPT DE VERDAD, sobre un árbol de mentira. Los dos chequeos de arriba son grep: si
# alguien mueve el bloque o corta la cadena de `elif`, siguen en verde. Esto lo corre.
#
# El árbol es MÍNIMO a propósito. No se mockean launchd, Postgres ni el gateway: un fixture escrito
# desde mi suposición de cómo responden no prueba nada, porque el test y el código comparten el
# error (la lección del wire de Bedrock). Acá se afirman sólo las dos cosas que NO dependen de nada
# de eso: que el freno manda sobre el veredicto, y que el freno no se acusa a sí mismo.
# El «sin freno → exit 0» no se puede afirmar en la laptop (no hay nueve servicios que verificar);
# esa dirección la cubre `delivrix_veredicto_despliegue` acá arriba, que es quien decide el código.
falso="$(mktemp -d)"
mkdir -p "${falso}/runtime/logs" "${falso}/runtime/openclaw-workspace/inventory"
touch "${falso}/runtime/ESTA-MAQUINA-ES-PRODUCCION"
# El daemon frenado escribe exactamente esto: la línea `pool:` (que se loguea ANTES del gate) y una
# `pausa (killed: …)`. Ninguna `vuelta #` — que es, letra por letra, la forma de "arrancó y no gira".
printf '[warmup-live] ARRANCA\n[warmup-live] pool: salud+cupo → corpfiling-infra.com\n[warmup-live] pausa (killed: kill-file presente)\n' \
  > "${falso}/runtime/logs/warmup-daemon.log"
correr_falso() { DELIVRIX_ROOT="${falso}" bash "${VER}" --rapido --desde=2026-08-08T10:00:00Z 2>&1; }

touch "${falso}/runtime/warmup-live.kill"
salida_frenado="$(correr_falso)"; DELIVRIX_ROOT="${falso}" bash "${VER}" --rapido --desde=2026-08-08T10:00:00Z >/dev/null 2>&1; rc_frenado=$?
chequear "con el freno: veredicto FRENADO" "si" \
  "$(printf '%s' "${salida_frenado}" | grep -q '^FRENADO: falta soltar el emisor' && echo si || echo NO)"
chequear "con el freno: exit distinto de 0" "si" "$( (( rc_frenado != 0 )) && echo si || echo "NO(${rc_frenado})" )"
# LA REGRESIÓN QUE MÁS DUELE: el freno que puso el propio deploy generando un ROLLBACK contra el
# deploy. Un aviso que grita en falso enseña a ignorar todos los demás.
chequear "el freno no se acusa a sí mismo" "si" \
  "$(printf '%s' "${salida_frenado}" | grep -q 'no está girando' && echo NO || echo si)"
chequear "con el freno: muestra el pool que habría usado" "si" \
  "$(printf '%s' "${salida_frenado}" | grep -q 'pool: salud+cupo' && echo si || echo NO)"

rm -f "${falso}/runtime/warmup-live.kill"
salida_suelto="$(correr_falso)"
chequear "sin el freno: NO dice FRENADO" "si" \
  "$(printf '%s' "${salida_suelto}" | grep -q 'FRENADO: falta soltar' && echo NO || echo si)"
# Sin freno el análisis de vueltas vuelve a correr: el `elif` sigue encadenado y no quedó muerto.
chequear "sin el freno: vuelve a juzgar la vuelta" "si" \
  "$(printf '%s' "${salida_suelto}" | grep -q 'no está girando' && echo si || echo NO)"
rm -rf "${falso}"

echo "el commit no puede filtrar credenciales"
# VERIFICADO EL 2026-08-08 con `git check-ignore`: `config/gateway.env` estaba ignorado, pero los 14
# `config/gateway.env.bak*` y `config/warmup-oauth.local.json` NO. Un `git add -A` publicaba
# credenciales OAuth y secretos rotados en GitHub.
for f in config/gateway.env config/gateway.env.bak config/gateway.env.bak-20260725-185229 \
         config/gateway.env.backup-pre-limpieza-2026-07-02 config/warmup-oauth.local.json; do
  chequear "ignorado: ${f}" "si" "$(git -C "${ROOT_DIR}" check-ignore -q "${f}" && echo si || echo NO)"
done
# LA ASERCIÓN QUE FALTÓ EN 2026-06, y que costó 1010 líneas de código fuente: una regla `runtime/`
# global se tragó archivos que SÍ estaban versionados. Acá se pregunta al revés — qué archivo
# TRACKEADO pasó a estar ignorado — y la respuesta tiene que seguir siendo la de siempre.
chequear "ningún archivo trackeado quedó ignorado" ".env.example" \
  "$(git -C "${ROOT_DIR}" ls-files -i -c --exclude-standard | tr '\n' ' ' | sed 's/ $//')"

echo "el deploy no puede dejar atrás su propia red de seguridad"
# EL TRANSPORTE DEL DEPLOY ES `git fetch && git merge --ff-only` (desplegar.sh:79). No hay rsync, no
# hay scp: UN ARCHIVO SIN TRACKEAR NO LLEGA A LA STUDIO, y esta vez casi se va sin cinco.
#
# Verificado el 2026-08-08 sacándolos del árbol y corriendo los gates de verdad:
#   · sin verificar-despliegue.sh y foto-produccion.sh este mismo archivo da «7 FALLA(S)»;
#   · sin agents/historia.ts, `node --test acciones-agente.test.ts` (TRACKEADO, lo importa en su
#     línea 34) da «# pass 0 / # fail 1» ⇒ `npm test` rojo EN PRODUCCIÓN aunque acá esté verde.
# Y el daño no es sólo el gate: desplegar.sh deja el emisor FRENADO e imprime «corré
# verificar-despliegue.sh», un script que del otro lado no existiría. El operador se queda con la
# fábrica parada y sin el instrumento para decidir cuándo soltarla — la única salida sería un `rm`
# a ciegas del kill-file, que es exactamente lo que el freno vino a impedir.
#
# SE PREGUNTA POR EL DIRECTORIO ENTERO, NO POR UNA LISTA. Una lista hay que acordarse de mantenerla,
# y el archivo que se olvida es siempre el nuevo. `--others --exclude-standard` respeta .gitignore,
# así que lo que aparece acá es código o herramienta que alguien escribió y no puso en git. Lo que
# sea temporal va al scratchpad, no adentro de scripts/ ni de apps/.
chequear "nada sin trackear bajo scripts/ ni apps/" "" \
  "$(git -C "${ROOT_DIR}" ls-files --others --exclude-standard -- scripts apps | tr '\n' ' ' | sed 's/ $//')"
# EL OTRO SENTIDO, Y ES UNA TRAMPA DISTINTA: `.audit/audit-events.jsonl` está TRACKEADO y el gateway
# de producción le escribe encima (LOCAL_AUDIT_LOG_FILE, relativo al cwd, que en la Studio es
# /Users/Shared/delivrix). Si entra en el commit, el `git merge --ff-only` del deploy aborta con
# «your local changes would be overwritten by merge» y manda al operador a depurar un deploy roto
# que no está roto. Falla limpio —antes del freno y del reinicio— pero cuesta la confianza igual.
chequear "el log de auditoría NO entra en el commit" "" \
  "$(git -C "${ROOT_DIR}" diff --cached --name-only -- .audit/audit-events.jsonl | tr '\n' ' ' | sed 's/ $//')"

echo "el agente corre en el monitor, no solo en el gateway"
# Cambiar un prompt y reiniciar solo el gateway deja al agente razonando con el texto viejo: el
# código está en apps/gateway-api/src/agents/ pero lo ejecuta scripts/ops/warmup-monitor.ts.
chequear "un prompt del agente reinicia el monitor" "gateway warmup-monitor" \
  "$(mapa 'apps/gateway-api/src/agents/warmup-monitor.ts')"
chequear "una ruta del gateway NO reinicia el monitor" "gateway" \
  "$(mapa 'apps/gateway-api/src/routes/health.ts')"

if (( fallos == 0 )); then echo "TODO OK"; else echo "${fallos} FALLA(S)"; exit 1; fi
