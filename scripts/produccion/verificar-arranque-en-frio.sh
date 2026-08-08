#!/usr/bin/env bash
# ¿Volvió TODO solo después de reiniciar la Studio, y funcionando?
#
# EL HECHO MEDIDO QUE LO JUSTIFICA (2026-08-06): el boot de esta máquina es del 5/8 18:24:53, pero
# los siete procesos de servicio arrancaron el 6/8 entre las 10:50:06 y las 11:19:03 — dieciséis
# horas DESPUÉS del boot, o sea a mano. Ocho de los nueve plists se escribieron el 6/8 a las 10:50,
# y el de com.delivrix.flota-salud —el que decide qué dominios entran al pool del calentamiento—
# a las 10:50:11. La prueba de reinicio del 5/8 se pasó sobre otro conjunto de servicios: NINGUNO
# de los nueve de hoy vio jamás un arranque en frío.
#
# La verificación que ya existe (final de instalar-produccion.sh) prueba gateway :3000 y panel :5173
# por HTTP, y para los otros cuatro se conforma con `launchctl list | grep delivrix`, que demuestra
# que están CARGADOS, no que hayan hecho algo. Un proceso de node puede estar vivo, con
# `state = running`, y no haber escrito un solo archivo — es exactamente el modo de falla que ya
# vimos en la flota: el proveedor daba el nodo "running" y solo un chequeo externo lo vio muerto.
#
# Por eso acá cada servicio se juzga por su ARTEFACTO FECHADO y el resultado es un NÚMERO: segundos
# desde el boot hasta su primera prueba de trabajo. "gateway ok" no distingue 11 segundos de 9
# minutos, y esa diferencia es la que decide si el watchdog mata al servicio que vino a proteger:
# GRACIA_ARRANQUE_S vale 90 s y se calibró contra un "~11 s" medido EN CALIENTE. El 2026-08-05 el
# watchdog le mandó SIGTERM al gateway a los 2 s de nacer. El número en frío es otro y nadie lo tiene.
#
# SOLO LECTURA. No reinicia, no carga ni descarga nada, no arregla, no despliega, no manda correo.
# Lo único que escribe es su propio log en runtime/logs/verificar-arranque.log.
#
# Uso, en la Studio y SIN sudo:  bash scripts/produccion/verificar-arranque-en-frio.sh
# Salidas: 0 = todos pasaron Y los levantó el boot · 1 = algo falló, no se pudo comprobar, o los
# procesos nacieron después del boot (o sea: no se midió un arranque en frío) · 2 = otra máquina.
set -uo pipefail

# DELIVRIX_ROOT existe para poder correr el script desde una COPIA (por ejemplo /tmp) apuntando al
# árbol de producción, sin tener que dejar un archivo nuevo dentro de /Users/Shared/delivrix.
ROOT_DIR="${DELIVRIX_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=scripts/produccion/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

LOG_DIR="${ROOT_DIR}/runtime/logs"
INV="${ROOT_DIR}/runtime/openclaw-workspace/inventory"
SALIDA="${LOG_DIR}/verificar-arranque.log"
# El mismo valor que usa el watchdog. Se compara contra él, no se aplica.
GRACIA_ARRANQUE_S="${GRACIA_ARRANQUE_S:-90}"
# El techo que hace tolerable un sender-cap.json anterior al boot (limite-fisico.ts --cada=6).
CUPO_TOLERANCIA_S=$(( 6 * 3600 ))

fallas=0; noses=0; avisos=0
lineas=()

# ---------------------------------------------------------------- guardas
# Correr esto en la laptop de desarrollo no rompe nada, pero devolvería un informe de nueve
# servicios inexistentes: un verde o un rojo sobre la máquina equivocada es peor que nada.
if [[ ! -f "${ROOT_DIR}/runtime/ESTA-MAQUINA-ES-PRODUCCION" ]]; then
  echo "esta máquina no está marcada como producción (falta ${ROOT_DIR}/runtime/ESTA-MAQUINA-ES-PRODUCCION)." >&2
  echo "Corré esto EN la Mac Studio, o pasá DELIVRIX_ROOT=/Users/Shared/delivrix." >&2
  exit 2
fi

# ---------------------------------------------------------------- el corte: el boot
# El parseo sale de lib.sh, que ya tiene el test de la regresión sec/usec (un sed codicioso tomaba
# el usec y el uptime salía gigante, en silencio). Cero parsers nuevos de kern.boottime en el repo.
if ! uptime_s="$(delivrix_uptime_s "$(sysctl -n kern.boottime 2>/dev/null)")"; then
  echo "NO SÉ: no pude leer kern.boottime. Sin la fecha del boot no hay nada que verificar." >&2
  exit 1
fi
BOOT_EPOCH=$(( $(date +%s) - uptime_s ))
BOOT_ISO="$(date -u -r "${BOOT_EPOCH}" +%Y-%m-%dT%H:%M:%S)"
CABECERA="boot=${BOOT_ISO}Z uptime=$(( uptime_s / 3600 ))h$(( (uptime_s % 3600) / 60 ))m"

echo "== arranque en frío — ${CABECERA} =="
echo

# ---------------------------------------------------------------- helpers
# `mtime` y `medidoEn` son las dos únicas formas que tienen estos servicios de fechar su trabajo.
mtime()    { [[ -f "$1" ]] && stat -f %m "$1" 2>/dev/null || true; }
medido_en() {
  # jq y no grep: en un JSON de 69 KB "medidoEn" puede aparecer anidado y el grep tomaría el
  # primero que encuentre. Si no hay jq el resultado es vacío ⇒ NO SÉ, nunca un ok inventado.
  [[ -f "$1" ]] || return 0
  local iso; iso="$(jq -r '.medidoEn // empty' "$1" 2>/dev/null)"
  [[ -n "${iso}" ]] && delivrix_iso_a_epoch "${iso}" || true
}
# Primera línea del log posterior al boot, en epoch. Vacío si no hay ninguna.
primera_linea_post_boot() {
  local archivo="$1" patron="${2:-.}" iso
  [[ -f "${archivo}" ]] || return 0
  iso="$(grep -a "${patron}" "${archivo}" 2>/dev/null | delivrix_primera_marca_iso "${BOOT_ISO}")"
  [[ -n "${iso}" ]] && delivrix_iso_a_epoch "${iso}" || true
}

# Estado de launchd de un servicio. Imprime "state|pid|last exit code|runs".
# El parseo vive en lib.sh (`delivrix_launchd_campos`) porque verificar-despliegue.sh lee lo mismo:
# dos copias del mismo sed sobre la misma salida se separan en cuanto una se toca, y ahí los dos
# verificadores empiezan a dar veredictos distintos del mismo servicio.
launchd_estado() { delivrix_launchd_estado "$1"; }

# Una línea de resultado. El NÚMERO es el producto principal: sin él "ok" no distingue 11 s de 9 min.
anotar() {
  local servicio="$1" launchd="$2" veredicto="$3" segs="$4" prueba="$5" nota="${6:-}"
  local n
  case "${segs}" in
    ''|'-') n="   --  " ;;
    -*)     n="${segs}s" ;;   # artefacto ANTERIOR al boot: no lo produjo este arranque
    *)      n="+${segs}s" ;;
  esac
  lineas+=("$(printf '%-15s %-34s trabajo:%-26s %-9s %-8s %s' \
    "${servicio}" "${launchd}" "${prueba}" "${veredicto}" "${n}" "${nota}")")
  case "${veredicto}" in
    FALLA) fallas=$((fallas + 1)) ;;
    NOSE)  noses=$((noses + 1)) ;;
  esac
}

# launchd + PPID en un solo texto para la columna del medio.
# PPID 1 es la pregunta del ticket: lo levantó launchd y no una sesión de terminal. Un proceso
# heredado de un `ssh` muere con la sesión y no vuelve tras el reinicio, pero mientras tanto se ve
# idéntico a uno sano.
launchd_texto() {
  local st="$1" pid="$2" exitc="$3" ppid=""
  [[ -n "${pid}" ]] && ppid="$(ps -o ppid= -p "${pid}" 2>/dev/null | tr -d ' ')"
  printf 'launchd:%s pid=%s ppid=%s exit=%s' "${st:-NOSE}" "${pid:-–}" "${ppid:-–}" "${exitc:-–}"
}
ppid_de() { [[ -n "${1}" ]] && ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ' || true; }
# Vacío si el PPID es 1; si no, el motivo. Un proceso heredado de una sesión SSH se ve idéntico a
# uno sano mientras la sesión vive, y desaparece en el reinicio siguiente sin dejar rastro.
ppid_mal() {
  local p; p="$(ppid_de "${1:-}")"
  [[ "${p}" == "1" ]] && return 0
  printf 'PPID=%s ≠ 1: NO lo levantó launchd' "${p:-?}"
}
# Nacimiento del proceso en epoch (para los servicios cuyo trabajo no deja fecha propia).
nacimiento() {
  local pid="$1" lstart
  [[ -n "${pid}" ]] || return 0
  lstart="$(ps -o lstart= -p "${pid}" 2>/dev/null)"
  [[ -n "${lstart}" ]] && date -j -f '%a %b %e %T %Y' "${lstart}" +%s 2>/dev/null || true
}

# EL SEGUNDO NÚMERO, Y EL QUE DESTAPA EL ENGAÑO PRINCIPAL: cuándo nació el proceso que HOY corre.
# Un artefacto fresco NO prueba un arranque en frío si lo escribió un proceso que nació dieciséis
# horas después del boot — que es exactamente el estado medido el 2026-08-06, con los nueve
# servicios en `state = running` y ninguno levantado por el arranque. Sin este chequeo el script
# imprimiría "TODO VOLVIÓ SOLO" sobre una máquina cuyos servicios encendió una persona a mano: una
# prueba pasada como evidencia de un 24/7 que nadie comprobó.
#
# El corte son 5 minutos: launchd larga los nueve en paralelo con RunAtLoad y ThrottleInterval 10 s,
# y el warmup-daemon es fail-closed y se relanza cada 10 s hasta que Postgres acepta. Cinco minutos
# cubre con holgura cualquier reintento legítimo del arranque; más que eso es un arranque a mano,
# un deploy, o un servicio que estuvo en bucle — y las tres cosas hay que decirlas, no promediarlas.
# Acumulador de texto y no array: /bin/bash de macOS es 3.2 y ahí `${#arr[@]}` vacío revienta con set -u.
nacio_tarde=""
registrar_nacimiento() {
  local nac; nac="$(nacimiento "${2:-}")"
  [[ "${nac}" =~ ^[0-9]+$ ]] || return 0
  (( nac - BOOT_EPOCH > 300 )) && nacio_tarde+="${1}:+$(( nac - BOOT_EPOCH ))s "
  return 0
}

# Preámbulo común de cada servicio: lee launchd, arma la columna del medio y registra cuándo nació
# el proceso. Las variables quedan globales a propósito — cada bloque las usa enseguida.
mirar() {
  IFS='|' read -r st pid exitc runs <<< "$(launchd_estado "$1")"
  lt="$(launchd_texto "${st}" "${pid}" "${exitc}")"
  registrar_nacimiento "$1" "${pid}"
}

# ---------------------------------------------------------------- 1. el entorno que un reinicio rompe en silencio
# Va ANTES que los servicios: si FileVault está encendido, los nueve van a fallar y el informe
# culparía a cada uno por separado de un problema que es uno solo.
echo "-- entorno --"
fv="$(fdesetup status 2>/dev/null || true)"
if [[ "${fv}" == *"FileVault is On"* ]]; then
  echo "  FALLA  FileVault ENCENDIDO — tras el reinicio la Mac espera una contraseña que nadie va a"
  echo "         teclear y NADA arranca. El 24/7 es falso mientras esto siga así."
  fallas=$((fallas + 1))
elif [[ -z "${fv}" ]]; then
  echo "  NO SÉ  no pude leer fdesetup status"; noses=$((noses + 1))
else
  echo "  ok     FileVault apagado"
fi

# Tailscale NO es un LaunchDaemon: es la app de la sesión gráfica, y sube sola porque hay auto-login.
# Si alguien saca el auto-login, tras el reinicio se pierden la copia externa del respaldo y el
# acceso a la mini, en silencio. No es falla de servicio; es un aviso con su consecuencia escrita.
autolog="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)"
if [[ -n "${autolog}" ]]; then
  echo "  ok     auto-login activo (${autolog}) — de esto depende que Tailscale suba solo"
else
  echo "  AVISO  sin auto-login: Tailscale no sube tras el reinicio ⇒ se pierden la copia externa"
  echo "         del respaldo y el acceso a la mini. La flota NO depende de esto (son IPs públicas)."
  avisos=$((avisos + 1))
fi

pmset_out="$(pmset -g 2>/dev/null || true)"
printf '%s\n' "${pmset_out}" | grep -qE '^[[:space:]]*sleep[[:space:]]+0' \
  && echo "  ok     sleep 0 (la Mac no duerme)" \
  || { echo "  AVISO  sleep != 0: dormida, el cupo vence a las 12 h y el warmup se detiene"; avisos=$((avisos + 1)); }
printf '%s\n' "${pmset_out}" | grep -qE '^[[:space:]]*autorestart[[:space:]]+1' \
  && echo "  ok     autorestart 1 (vuelve sola tras un corte de luz)" \
  || { echo "  AVISO  autorestart != 1: tras un corte de luz la Mac queda apagada"; avisos=$((avisos + 1)); }

libre_gb="$(df -g "${ROOT_DIR}" 2>/dev/null | awk 'NR==2 {print $4}')"
if [[ "${libre_gb}" =~ ^[0-9]+$ ]]; then
  (( libre_gb > 5 )) && echo "  ok     ${libre_gb} GB libres" \
    || { echo "  FALLA  solo ${libre_gb} GB libres — Postgres y los logs se caen sin avisar"; fallas=$((fallas + 1)); }
else
  echo "  NO SÉ  no pude leer el espacio libre"; noses=$((noses + 1))
fi

# Dos banderas que sobreviven al reinicio y hacen mentir a los nueve verdes.
if [[ -f "${ROOT_DIR}/runtime/warmup-live.kill" ]]; then
  echo "  FALLA  runtime/warmup-live.kill PRESENTE: los servicios pueden estar todos en verde y no"
  echo "         salir un solo correo. El archivo sobrevive al reinicio."
  fallas=$((fallas + 1))
fi
[[ -f "${ROOT_DIR}/runtime/RESPALDO-SIN-COPIA-EXTERNA" ]] && {
  echo "  AVISO  runtime/RESPALDO-SIN-COPIA-EXTERNA: hay respaldo pero solo en esta máquina"; avisos=$((avisos + 1)); }
echo

# ---------------------------------------------------------------- 2. postgres (primero: todo depende)
# Antes que el gateway a propósito. Al revés, "postgres tardó en aceptar conexiones" se lee como
# "el gateway está roto" y se diagnostica el servicio equivocado.
mirar postgres
PSQL_BIN="$(ls /opt/homebrew/opt/postgresql@*/bin/psql /opt/homebrew/bin/psql 2>/dev/null | head -1 || true)"
PG_URL="$(delivrix_leer_env "${ROOT_DIR}/config/gateway.env" POSTGRES_URL)"
if [[ -z "${PSQL_BIN}" || -z "${PG_URL}" ]]; then
  # Nunca se imprime la URL: trae la contraseña. Solo si está o no.
  anotar postgres "${lt}" NOSE '' "select-1" "sin psql o sin POSTGRES_URL en config/gateway.env"
elif [[ "$(PGCONNECT_TIMEOUT=5 "${PSQL_BIN}" "${PG_URL}" -tAc 'select 1' 2>/dev/null | tr -d ' ')" != "1" ]]; then
  anotar postgres "${lt}" FALLA '' "select-1" "no acepta conexiones"
else
  read -r v s <<< "$(delivrix_veredicto_artefacto "${BOOT_EPOCH}" "$(nacimiento "${pid}")")"
  pm="$(ppid_mal "${pid}")"; [[ -z "${pm}" ]] || v=FALLA
  anotar postgres "${lt}" "${v}" "${s}" "select-1" "${pm:-aprox: nacimiento del proceso, la conexión no deja fecha}"
fi

# ---------------------------------------------------------------- 3. gateway
mirar gateway
salud="$(curl -fsS --max-time 10 http://127.0.0.1:3000/health 2>/dev/null)"; rc_curl=$?
if (( rc_curl == 28 )); then
  # 28 = timeout. Un chequeo que se cuelga es NO SÉ, no un "caído": el 2026-07-29 una sonda que
  # esperaba un banner devolvió "bloqueado" en 10 de 10 nodos que estaban perfectos.
  anotar gateway "${lt}" NOSE '' "/health" "curl venció los 10 s: no puedo decidir"
elif [[ -z "${salud}" ]]; then
  anotar gateway "${lt}" FALLA '' "/health" "no responde en :3000"
elif ! printf '%s' "${salud}" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  anotar gateway "${lt}" FALLA '' "/health" "responde pero status != ok (mirá si Postgres subió)"
else
  # `event=gateway.started` trae marca ISO propia: es el único servicio que puede decir con
  # exactitud cuándo empezó a escuchar. Ese número es el producto principal de este script.
  read -r v s <<< "$(delivrix_veredicto_artefacto "${BOOT_EPOCH}" "$(primera_linea_post_boot "${LOG_DIR}/gateway.log" 'event=gateway.started')")"
  nota="$(ppid_mal "${pid}")"; [[ -z "${nota}" ]] || v=FALLA
  if [[ "${s}" =~ ^[0-9]+$ ]] && (( s >= GRACIA_ARRANQUE_S )); then
    nota="${nota:+${nota} · }TARDÓ MÁS QUE LA GRACIA DEL WATCHDOG (${GRACIA_ARRANQUE_S}s): lo mata mientras arranca"
    avisos=$((avisos + 1))
  fi
  anotar gateway "${lt}" "${v}" "${s}" "/health + gateway.started" "${nota}"
fi

# ---------------------------------------------------------------- 4. panel
mirar panel
# 25 s y no 4: Vite compila en la PRIMERA request, y en frío 4 s reportan un panel caído que no lo
# está. Techo conocido y aceptado: `npm run dev` devuelve 200 en / aunque la app no compile —
# subirlo (pedir un asset construido) es otro ticket.
if curl -fsS --max-time 25 -o /dev/null http://127.0.0.1:5173/ 2>/dev/null; then
  read -r v s <<< "$(delivrix_veredicto_artefacto "${BOOT_EPOCH}" "$(mtime "${LOG_DIR}/panel.log")")"
  pm="$(ppid_mal "${pid}")"; [[ -z "${pm}" ]] || v=FALLA
  anotar panel "${lt}" "${v}" "${s}" "GET :5173" "${pm:-aprox: mtime del log, Vite no fecha sus líneas}"
else
  rc=$?
  (( rc == 28 )) && anotar panel "${lt}" NOSE '' "GET :5173" "curl venció los 25 s: no puedo decidir" \
                 || anotar panel "${lt}" FALLA '' "GET :5173" "no responde en :5173"
fi

# ---------------------------------------------------------------- 5. warmup-daemon
mirar warmup-daemon
dlog="${LOG_DIR}/warmup-daemon.log"
if [[ ! -f "${dlog}" ]] || ! grep -qa '\[warmup-live\] ARRANCA' "${dlog}"; then
  anotar warmup-daemon "${lt}" NOSE '' "ARRANCA + escribe" "sin log o sin línea de arranque"
else
  # ponytail: el daemon NO fecha sus líneas ('[warmup-live] ARRANCA — intervalo 90min…' sale pelado),
  # así que la única fecha disponible es el mtime del archivo. Alcanza para "escribió después del
  # boot", que es la prueba de trabajo; no alcanza para separar el ARRANCA de este arranque del
  # anterior. Se arregla poniéndole marca de tiempo al logger del daemon — otro ticket.
  read -r v s <<< "$(delivrix_veredicto_artefacto "${BOOT_EPOCH}" "$(mtime "${dlog}")")"
  pm="$(ppid_mal "${pid}")"; [[ -z "${pm}" ]] || v=FALLA
  anotar warmup-daemon "${lt}" "${v}" "${s}" "ARRANCA + escribe" "${pm:-aprox: mtime, el daemon no fecha sus líneas}"
fi

# ---------------------------------------------------------------- 6. warmup-monitor (el agente)
mirar warmup-monitor
read -r v s <<< "$(delivrix_veredicto_artefacto "${BOOT_EPOCH}" "$(mtime "${INV}/warmup-monitor.json")")"
pm="$(ppid_mal "${pid}")"; [[ -z "${pm}" ]] || v=FALLA
anotar warmup-monitor "${lt}" "${v}" "${s}" "warmup-monitor.json" "${pm}"

# ---------------------------------------------------------------- 7. warmup-cupo
mirar warmup-cupo
# Su loop compara contra la EDAD DEL ARCHIVO: si la medición previa tiene menos de 6 h, no remide.
# Entonces "sender-cap.json anterior al boot" puede ser un servicio impecable, y por eso se acepta
# —rotulado, nunca como un ok pelado— cuando además hay señal de que arrancó.
arranco=no; cupo_log_m="$(mtime "${LOG_DIR}/warmup-cupo.log")"
(( ${cupo_log_m:-0} > BOOT_EPOCH )) && grep -qa 'midiendo la flota cada' "${LOG_DIR}/warmup-cupo.log" && arranco=si
read -r v s <<< "$(delivrix_veredicto_artefacto "${BOOT_EPOCH}" "$(medido_en "${INV}/sender-cap.json")" "${CUPO_TOLERANCIA_S}" "${arranco}")"
nota="$(ppid_mal "${pid}")"; [[ -z "${nota}" ]] || v=FALLA
[[ "${v}" == "ok-tolerado" ]] && nota="arrancó y no le tocaba remedir (medición de $(( ( $(date +%s) - BOOT_EPOCH - s ) / 3600 ))h, remide a las 6h)"
anotar warmup-cupo "${lt}" "${v}" "${s}" "sender-cap.medidoEn" "${nota}"

# ---------------------------------------------------------------- 8. flota-salud
mirar flota-salud
# El que nunca vio un arranque en frío y el que más importa: decide qué dominios entran al pool.
# Si queda ciego, el warmup elige con una foto vieja — el 2026-08-06 el archivo tenía 35 h y el
# agente decidía el pool con una medición de anteayer.
read -r v s <<< "$(delivrix_veredicto_artefacto "${BOOT_EPOCH}" "$(medido_en "${INV}/sender-measurement.json")")"
pm="$(ppid_mal "${pid}")"; [[ -z "${pm}" ]] || v=FALLA
anotar flota-salud "${lt}" "${v}" "${s}" "sender-measurement.medidoEn" "${pm:-decide el pool del warmup}"

# ---------------------------------------------------------------- 9. watchdog
mirar watchdog
# `state = not running` es lo NORMAL: corre cada 5 min por StartInterval y termina. Exigirle
# "running" sería el error clásico de leer un job periódico como un job muerto. Lo que se le exige
# es haber CORRIDO (runs > 0), haber salido bien y haber dejado una línea después del boot.
if [[ "${st}" == "NOSE" ]]; then
  anotar watchdog "${lt}" NOSE '' "línea en watchdog.log" "launchctl print falló: ¿plist cargado?"
elif [[ ! "${runs}" =~ ^[0-9]+$ ]] || (( runs == 0 )); then
  anotar watchdog "${lt}" FALLA '' "línea en watchdog.log" "runs=${runs:-–}: no corrió ni una vez"
else
  read -r v s <<< "$(delivrix_veredicto_artefacto "${BOOT_EPOCH}" "$(primera_linea_post_boot "${LOG_DIR}/watchdog.log")")"
  nota="runs=${runs} (periódico: 'not running' es lo normal)"
  [[ "${exitc}" == "0" || -z "${exitc}" ]] || { nota="último exit=${exitc}"; v=FALLA; }
  anotar watchdog "${lt}" "${v}" "${s}" "línea en watchdog.log" "${nota}"
fi

# ---------------------------------------------------------------- 10. respaldo
mirar respaldo
# Corre a las 03:30 por StartCalendarInterval. Si el reinicio fue después de esa hora, NO tiene por
# qué haber corrido, y contarlo como falla enseña a ignorar el rojo. Se rotula y no suma.
if [[ "${st}" == "NOSE" ]]; then
  anotar respaldo "${lt}" NOSE '' "corrida de las 03:30" "launchctl print falló: ¿plist cargado?"
else
  ultimo="$(ls -1t "${ROOT_DIR}"/runtime/respaldos/delivrix-*.sql.gz 2>/dev/null | head -1 || true)"
  edad_h="–"; [[ -n "${ultimo}" ]] && edad_h="$(( ( $(date +%s) - $(mtime "${ultimo}") ) / 3600 ))h"
  lineas+=("$(printf '%-15s %-34s trabajo:%-26s %-9s %-8s %s' \
    respaldo "${lt}" "corrida de las 03:30" "n/a" "   --  " \
    "no aplica hasta las 03:30 — NO cuenta como falla (último respaldo: ${edad_h}, runs=${runs:-0})")")
fi

# ---------------------------------------------------------------- informe
printf '%s\n' "${lineas[@]}"
echo
echo "El número es segundos desde el boot hasta la fecha del ARTEFACTO de cada servicio, no hasta"
echo "el momento de este chequeo. Un número negativo = el artefacto es ANTERIOR al boot."
echo
# El orden importa: primero se decide si esto fue siquiera un arranque en frío, y recién después si
# los servicios pasaron. Al revés se imprime "TODO VOLVIÓ SOLO" sobre una máquina cuyos servicios
# encendió una persona — el resultado exacto que este script existe para no volver a dar.
if [[ -n "${nacio_tarde}" ]]; then
  echo "ESTO NO FUE UN ARRANQUE EN FRÍO. Los procesos que corren ahora nacieron DESPUÉS del boot:"
  echo "  ${nacio_tarde}"
  echo "Los servicios pueden estar impecables (mirá las líneas de arriba), pero lo que se midió es"
  echo "un arranque a mano o un deploy, no el reinicio. Reiniciá la Studio y volvé a correr esto."
  echo
fi
if (( fallas > 0 || noses > 0 )); then
  veredicto="NO: ${fallas} falla(s), ${noses} sin verificar, ${avisos} aviso(s)"
  codigo=1
elif [[ -n "${nacio_tarde}" ]]; then
  veredicto="SERVICIOS OK pero ARRANQUE EN FRÍO NO VERIFICADO (procesos nacidos después del boot)"
  codigo=1
else
  veredicto="TODO VOLVIÓ SOLO — ${#lineas[@]} servicios, 0 fallas, ${avisos} aviso(s)"
  codigo=0
fi
echo "${veredicto}"

# Queda escrito para poder COMPARAR la próxima vez en vez de recordar. Encabezado con el boot que
# se verificó: dos corridas del mismo boot son la misma medición, y eso tiene que verse.
mkdir -p "${LOG_DIR}"
{
  printf '\n===== %s | verificado %s =====\n' "${CABECERA}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "${lineas[@]}"
  printf '%s\n' "${veredicto}"
} >> "${SALIDA}" 2>/dev/null || echo "(aviso: no pude escribir ${SALIDA})"
echo "→ ${SALIDA}"
exit "${codigo}"
