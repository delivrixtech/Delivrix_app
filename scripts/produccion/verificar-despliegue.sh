#!/usr/bin/env bash
# ¿EL DESPLIEGUE SALIÓ BIEN? — y si no, ¿qué se hace?
#
# Hermano de verificar-arranque-en-frio.sh y con la misma forma, pero otra pregunta y otro corte.
# Aquél mide contra el BOOT ("¿volvió todo solo tras reiniciar la Mac?"). Éste mide contra el
# DESPLIEGUE: "¿el código nuevo está corriendo de verdad, y la fábrica sigue fabricando?".
#
# ── POR QUÉ NO ALCANZA CON LO QUE YA IMPRIME desplegar.sh ─────────────────────────────────────────
#
# desplegar.sh termina comprobando que /health devuelva `build.commit` igual al que acaba de dejar.
# Eso prueba UNA cosa —que el gateway reinició con el código nuevo— y ninguna de las otras cuatro
# que importan. Los otros seis servicios no reportan commit; el daemon puede reiniciar y no mandar
# un solo correo; el agente puede quedarse sin manos; y el pool —lo único que decide desde qué
# dominios sale correo— NO se arregla desplegando.
#
# ── EL ORDEN NO ES UN CAPRICHO: DESPLEGAR NO BAJA EL POOL ─────────────────────────────────────────
#
# `elegirPool` no juzga la flota: LEE sender-measurement.json. Ese archivo lo escribe flota-salud, y
# el que está en producción ahora mismo fue escrito por el sensor VIEJO, con los veredictos que se
# absolvieron solos por el calendario. Reiniciar servicios no lo reescribe.
#
# Medido con el código NUEVO del árbol contra el inventario REAL de producción (foto del
# 2026-08-08T14:40Z, 58 bandejas): el pool sale 32, y adentro están corpfilinginfra.com,
# corpregistry-control.com y docfiling-ops.com — los tres `estado: "healthy"`, `cerradoEn: []`,
# `cruzados: []`. Los tres son los que anoche mandaron las vueltas #21/#22/#23 sin una sola línea
# COMPLETA mientras el pool bueno iba 6 de 6 en INBOX.
#
# La secuencia es DESPLEGAR → VOLVER A MEDIR → recién ahí baja. Un barrido tarda ~15 MINUTOS, así
# que el chequeo 3 se corre un buen rato después del deploy, no en el mismo segundo. Este script lo
# dice en vez de dar rojo por eso.
#
# EL NÚMERO CAMBIÓ CON ESTE MISMO DESPLIEGUE, y decir el viejo es peor que no decir ninguno: las
# cuatro corridas de 198/206/232/253 s son del comando VIEJO. La sección `## CULPA` pasó a leer
# también `status=deferred` y salió 3,4× más cara (medido contra el mismo nodo: 17,1/20,1 s la vieja
# contra 64,8/69,0 s la nueva), tanto que el presupuesto de lectura subió de 60 a 180 s. Con
# concurrencia 4 y 58 bandejas: ~15 tandas × ~65 s ≈ 15 min.
#
# Y EL RELOJ DE VERDAD NO ES EL NÚMERO, ES `medidoEn`: el chequeo 3 lo compara contra el corte del
# deploy, así que la instrucción correcta es "volvé a correr esto cuando `medidoEn` sea posterior al
# deploy" y mientras tanto `tail -f runtime/logs/flota-salud.log`. El número sólo sirve para saber si
# esperar es normal o si algo se rompió — y con "~4 min" en la pantalla, a los cinco minutos parece
# roto y el atajo obvio es soltar el freno, que es el incidente que el freno viene a evitar.
#
# ── TRES RESULTADOS, NUNCA DOS ────────────────────────────────────────────────────────────────────
#
# ok / FALLA / NO SÉ. "No pude comprobarlo" no es "está bien" — es la firma de todos los incidentes
# de este repo: el probe que se colgaba y devolvió 10 de 10 bloqueados falsos (2026-07-29), el
# "0 blacklist" sobre 38 nodos cerrados en Gmail (2026-07-25), y el `healthy` de anoche, que era
# "no medí" con otro nombre.
#
# SOLO LECTURA. No reinicia, no despliega, no manda correo ni Slack, no toca el kill switch. Cuando
# algo hay que hacer, lo IMPRIME con el comando exacto y espera a que lo decida una persona.
#
# Uso, EN la Studio y sin sudo:
#   bash scripts/produccion/verificar-despliegue.sh
#   bash scripts/produccion/verificar-despliegue.sh --desde=2026-08-08T15:10:00Z   # corte a mano
#   bash scripts/produccion/verificar-despliegue.sh --commit=eb6b373               # commit esperado
#   bash scripts/produccion/verificar-despliegue.sh --rapido                       # sin la 2ª muestra
#
# Salidas: 0 = todo verificado y bien · 1 = algo falló o no se pudo verificar · 2 = otra máquina.
set -uo pipefail

ROOT_DIR="${DELIVRIX_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=scripts/produccion/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

LOG_DIR="${ROOT_DIR}/runtime/logs"
INV="${ROOT_DIR}/runtime/openclaw-workspace/inventory"
SALIDA="${LOG_DIR}/verificar-despliegue.log"

# LOS QUE ANOCHE MANDARON SIN LOGRAR UNA ENTREGA. Salen del log, no de la memoria de nadie:
# `grep MISSING runtime/logs/warmup-daemon.log` da SIETE vueltas seguidas, la #21 a la #27, contra
# 6 de 6 en INBOX de los del pool bueno. Eran TRES en la primera versión de esta lista y las otras
# cuatro quedaron afuera sin razón — el log las nombra igual de fuerte.
#
# `MISSING` es «el proveedor lo aceptó y no apareció en ninguna carpeta» (live-warmup-daemon.ts):
# ni bandeja, ni spam, ni promociones. Es el peor resultado posible que no es un rebote.
QUEMADOS=(
  corpfilinginfra.com corpregistry-control.com docfiling-ops.com
  infranationalcorp.com nationalcorp-control.com nationalcorp-infra.com nationalfilingcontrol.com
)

# Techo de pool que se considera "bajó". No es un número mágico: el pool bueno de ayer era 6, el
# roto era 29-32. Cualquier cosa arriba de esto pide mirar antes de dejarlo correr.
POOL_MAX="${POOL_MAX:-12}"

# Cuánto se espera entre las dos muestras de PID para detectar un servicio en bucle. launchd
# reintenta con ThrottleInterval 10 s, así que 15 s alcanzan para ver cambiar el PID una vez.
PAUSA_BUCLE=15

fallas=0; noses=0; avisos=0
# `frenado` no es una falla del despliegue: es un PASO SIN TERMINAR. Por eso no suma a `fallas` y
# tiene su propio veredicto (ver delivrix_veredicto_despliegue en lib.sh).
EMISOR_FRENADO=0
ROLLBACK=(); FRENO=(); ESPERAR=()

desde_arg=""; commit_arg=""; rapido=0
for a in "$@"; do
  case "${a}" in
    --desde=*)  desde_arg="${a#--desde=}" ;;
    --commit=*) commit_arg="${a#--commit=}" ;;
    --rapido)   rapido=1 ;;
    *) echo "argumento desconocido: ${a}" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- guardas
# Un verde o un rojo sobre la máquina equivocada es peor que no tener verificador: acá se informaría
# sobre nueve servicios que en la laptop no existen.
if [[ ! -f "${ROOT_DIR}/runtime/ESTA-MAQUINA-ES-PRODUCCION" ]]; then
  echo "esta máquina no está marcada como producción (falta ${ROOT_DIR}/runtime/ESTA-MAQUINA-ES-PRODUCCION)." >&2
  echo "Corré esto EN la Mac Studio, o pasá DELIVRIX_ROOT=/Users/Shared/delivrix." >&2
  exit 2
fi
HAY_JQ=1; command -v jq >/dev/null 2>&1 || HAY_JQ=0

# ---------------------------------------------------------------- helpers
mtime() { [[ -f "$1" ]] && stat -f %m "$1" 2>/dev/null || true; }
ppid_de()   { [[ -n "${1:-}" ]] && ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ' || true; }
nacimiento() {
  local lstart; [[ -n "${1:-}" ]] || return 0
  lstart="$(ps -o lstart= -p "$1" 2>/dev/null)"
  [[ -n "${lstart}" ]] && date -j -f '%a %b %e %T %Y' "${lstart}" +%s 2>/dev/null || true
}
# Campo ISO de un JSON → epoch. Vacío si no hay jq, si no está el campo, o si no parsea: los tres
# casos son "no sé" y ninguno puede terminar en un ok.
campo_epoch() {
  local archivo="$1" campo="$2" iso
  (( HAY_JQ )) || return 0
  [[ -f "${archivo}" ]] || return 0
  iso="$(jq -r "${campo} // empty" "${archivo}" 2>/dev/null)"
  [[ -n "${iso}" ]] && delivrix_iso_a_epoch "${iso}" || true
}
hace() { # segundos → "3m" / "2h14m"
  local s="${1:-}"; [[ "${s}" =~ ^-?[0-9]+$ ]] || { printf '?'; return; }
  (( s < 0 )) && { printf '%ss en el futuro' "$(( -s ))"; return; }
  (( s < 3600 )) && { printf '%dm' $(( s / 60 )); return; }
  printf '%dh%02dm' $(( s / 3600 )) $(( (s % 3600) / 60 ))
}
ok()    { printf '  ok     %s\n' "$1"; }
falla() { printf '  FALLA  %s\n' "$1"; fallas=$((fallas + 1)); }
nose()  { printf '  NO SÉ  %s\n' "$1"; noses=$((noses + 1)); }
aviso() { printf '  AVISO  %s\n' "$1"; avisos=$((avisos + 1)); }
detalle() { printf '         %s\n' "$1"; }

AHORA="$(date +%s)"

# ---------------------------------------------------------------- 0. el corte y el commit
# TODO se juzga contra el momento del despliegue. Sin corte, un artefacto del deploy ANTERIOR se
# lee como prueba de éste — es el mismo engaño que verificar-arranque-en-frio.sh destapó con los
# procesos nacidos dieciséis horas después del boot.
#
# El corte por defecto es el nacimiento MÁS NUEVO entre los servicios de node, porque desplegar.sh
# reinicia con `launchctl kickstart -k` y eso mata y relanza el proceso: el PID nuevo ES el deploy.
SERVICIOS_NODE=(gateway panel warmup-daemon warmup-monitor warmup-cupo flota-salud)
CORTE=""
if [[ -n "${desde_arg}" ]]; then
  CORTE="$(delivrix_iso_a_epoch "${desde_arg}")" || CORTE=""
  [[ -n "${CORTE}" ]] || { echo "--desde=${desde_arg} no parsea (se espera 2026-08-08T15:10:00Z)." >&2; exit 2; }
else
  for s in "${SERVICIOS_NODE[@]}"; do
    IFS='|' read -r _st pid _ec _r <<< "$(delivrix_launchd_estado "${s}")"
    n="$(nacimiento "${pid}")"
    [[ "${n}" =~ ^[0-9]+$ ]] && { [[ -z "${CORTE}" ]] || (( n > CORTE )); } && CORTE="${n}"
  done
fi
if [[ -z "${CORTE}" ]]; then
  echo "NO SÉ: no pude fechar ningún servicio, así que no hay contra qué comparar." >&2
  echo "  Pasá el momento del deploy a mano:  --desde=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
  exit 1
fi
CORTE_ISO="$(date -u -r "${CORTE}" +%Y-%m-%dT%H:%M:%S)"
ESPERADO="${commit_arg:-$(git -C "${ROOT_DIR}" rev-parse HEAD 2>/dev/null || true)}"

echo "== verificación post-despliegue =="
echo "   corte:   ${CORTE_ISO}Z (hace $(hace $(( AHORA - CORTE ))))$( [[ -n "${desde_arg}" ]] && echo ' — pasado a mano' || echo ' — el servicio más nuevo')"
echo "   commit:  ${ESPERADO:0:8} (el que hay en disco en ${ROOT_DIR})"
echo

# ---------------------------------------------------------------- 1. ¿están vivos los nueve?
echo "-- 1. los nueve servicios --"
# postgres primero y no por orden alfabético: si Postgres no acepta, los otros ocho fallan en
# cascada y el informe culparía a cada uno de un problema que es uno solo.
TODOS=(postgres gateway panel warmup-daemon warmup-monitor warmup-cupo flota-salud watchdog respaldo)
# watchdog y respaldo son PERIÓDICOS (StartInterval / StartCalendarInterval): `state = not running`
# es su estado normal. Exigirles "running" es el error clásico de leer un job periódico como muerto,
# y un aviso que grita en falso enseña a ignorar todos los demás.
PERIODICOS=" watchdog respaldo "
declare -a pids_1=()
for s in "${TODOS[@]}"; do
  IFS='|' read -r st pid exitc runs <<< "$(delivrix_launchd_estado "${s}")"
  pids_1+=("${s}=${pid}")
  if [[ "${st}" == "NOSE" ]]; then
    falla "${s}: launchctl print falla — el plist NO está cargado (o no existe)"
    detalle "instalá el que falte:  sudo bash scripts/produccion/instalar-produccion.sh"
    ROLLBACK+=("${s} sin plist cargado")
    continue
  fi
  if [[ "${PERIODICOS}" == *" ${s} "* ]]; then
    if [[ "${runs}" =~ ^[0-9]+$ ]] && (( runs > 0 )) && [[ "${exitc}" == "0" || -z "${exitc}" ]]; then
      ok "${s}: periódico, runs=${runs}, último exit=${exitc:-0} ('not running' es lo normal)"
    elif [[ "${exitc}" != "0" && -n "${exitc}" ]]; then
      falla "${s}: periódico y su último exit fue ${exitc}"
    else
      nose "${s}: periódico y runs=${runs:-–} — todavía no le tocó correr"
    fi
    continue
  fi
  ppid="$(ppid_de "${pid}")"
  nac="$(nacimiento "${pid}")"
  if [[ "${st}" != "running" || -z "${pid}" ]]; then
    falla "${s}: state=${st:-?} pid=${pid:-–} — no está corriendo"
    ROLLBACK+=("${s} no levanta")
  elif [[ "${ppid}" != "1" ]]; then
    # Un proceso heredado de una sesión SSH se ve idéntico a uno sano mientras la sesión vive, y
    # desaparece en el reinicio siguiente sin dejar rastro.
    falla "${s}: PPID=${ppid:-?} ≠ 1 — NO lo levantó launchd, muere con la sesión que lo abrió"
  elif [[ "${nac}" =~ ^[0-9]+$ ]] && (( nac < CORTE )); then
    # Legítimo cuando desplegar.sh no tocó su código (reinicia SOLO los servicios afectados). Se
    # rotula y no cuenta como falla: decir rojo sobre un servicio sano enseña a ignorar el rojo.
    ok "${s}: vivo desde antes del corte (hace $(hace $(( AHORA - nac )))) — su código no cambió, no se reinició"
  else
    ok "${s}: running pid=${pid} ppid=1, nació $(hace $(( AHORA - nac ))) atrás (con el deploy)"
  fi
done

# EL BUCLE DE ARRANQUE, que es la única falla que se disfraza de salud. Con KeepAlive, un servicio
# que muere al arrancar (falta una dependencia de package.json, una env var nueva) se relanza cada
# 10 s para siempre: `launchctl print` lo muestra `running` en casi todas las muestras porque
# siempre hay UNO vivo. Lo que lo delata es que el PID CAMBIA. Una sola muestra no lo puede ver.
if (( rapido )); then
  nose "bucle de arranque: no se comprobó (--rapido). Un servicio que muere y se relanza cada 10 s"
  detalle "se ve 'running' en una sola muestra. Corré sin --rapido para descartarlo."
else
  sleep "${PAUSA_BUCLE}"
  reinician=""
  for par in "${pids_1[@]}"; do
    s="${par%%=*}"; antes="${par#*=}"
    [[ -n "${antes}" ]] || continue
    [[ "${PERIODICOS}" == *" ${s} "* ]] && continue
    IFS='|' read -r _st ahora_pid _e _r <<< "$(delivrix_launchd_estado "${s}")"
    [[ -n "${ahora_pid}" && "${ahora_pid}" != "${antes}" ]] && reinician+="${s}(${antes}→${ahora_pid}) "
  done
  if [[ -n "${reinician}" ]]; then
    falla "EN BUCLE: cambiaron de PID en ${PAUSA_BUCLE}s — ${reinician% }"
    detalle "no arrancan: se mueren y launchd los relanza. Mirá su log en ${LOG_DIR}/."
    ROLLBACK+=("servicio(s) en bucle de arranque: ${reinician% }")
  else
    ok "ninguno cambió de PID en ${PAUSA_BUCLE}s: no hay bucle de arranque"
  fi
fi

# El gateway es el ÚNICO que puede decir qué commit corre. Que responda no alcanza: el `kickstart`
# se traga su error, el proceso VIEJO sigue contestando ok, y el deploy se declara hecho sobre
# código que nadie está corriendo.
salud="$(curl -fsS --max-time 10 http://127.0.0.1:3000/health 2>/dev/null)"; rc=$?
if (( rc == 28 )); then
  nose "gateway /health: curl venció los 10 s — no puedo decidir (un chequeo colgado no es un 'caído')"
elif [[ -z "${salud}" ]]; then
  falla "gateway /health: no responde en :3000"
  ROLLBACK+=("el gateway no responde")
else
  corriendo="$(printf '%s' "${salud}" | grep -o '"commit"[[:space:]]*:[[:space:]]*"[0-9a-f]*"' | head -1 | grep -o '[0-9a-f]\{7,\}' || true)"
  if [[ -z "${corriendo}" ]]; then
    nose "gateway responde pero no declara build.commit — versión anterior a este esquema"
  elif [[ -z "${ESPERADO}" ]]; then
    nose "gateway corre ${corriendo:0:8} pero no pude leer el commit de disco para comparar"
  elif [[ "${corriendo}" != "${ESPERADO}" ]]; then
    falla "gateway corre ${corriendo:0:8} y en disco hay ${ESPERADO:0:8}: el código nuevo NO está en memoria"
    detalle "sudo launchctl kickstart -k system/com.delivrix.gateway"
    ROLLBACK+=("el gateway quedó con código viejo en memoria")
  else
    ok "gateway corre ${corriendo:0:8} = el de disco"
  fi
fi
echo

# ---------------------------------------------------------------- 2. ¿el daemon dio una vuelta?
echo "-- 2. la vuelta del warmup --"
DLOG="${LOG_DIR}/warmup-daemon.log"
# EL KILL SWITCH PRIMERO, Y AHORA ES ROJO. Sobrevive al reinicio, y con él puesto los nueve
# servicios pueden estar impecables sin que salga un solo correo.
#
# ERA UN `aviso` Y ESO ESTABA MAL. Desde el 2026-08-08 desplegar.sh deja el kill-file puesto antes
# de reiniciar el daemon (el daemon manda en su primer tick y el pool no baja hasta que flota-salud
# remida). O sea: DESPUÉS DE CADA DEPLOY este archivo existe. Con un aviso, el veredicto podía salir
# "DESPLIEGUE VERIFICADO" con el emisor parado, alguien cerraba la terminal, y el warmup quedaba
# frenado para siempre sin que nada lo dijera — el freno que protege se convierte en el incidente.
# Mientras exista, el despliegue NO está terminado.
if [[ -f "${ROOT_DIR}/runtime/warmup-live.kill" ]]; then
  EMISOR_FRENADO=1
  aviso "runtime/warmup-live.kill PRESENTE: el emisor está FRENADO. No va a haber vueltas."
  detalle "es lo normal recién desplegado. Mirá el pool acá abajo y soltalo cuando esté bien."
fi
# CON EL FRENO PUESTO, LA VUELTA NO SE PUEDE JUZGAR. El daemon frenado loguea `pausa (killed: …)` y
# ninguna línea `vuelta #`, que es exactamente la forma de "arrancó y no gira" — el ROLLBACK de más
# abajo. Acusar al despliegue por el freno que el despliegue puso es el aviso que grita en falso, y
# uno que grita en falso enseña a ignorar todos los demás. Lo que SÍ se puede leer es el pool: se
# calcula y loguea ANTES del gate, así que el daemon frenado igual deja escrito con qué habría
# mandado. Ése es el instrumento para decidir si se suelta.
if (( EMISOR_FRENADO )); then
  linea_pool="$( [[ -f "${DLOG}" ]] && grep -a '\[warmup-live\] pool:' "${DLOG}" | tail -1 || true)"
  if [[ -n "${linea_pool}" ]]; then
    detalle "el daemon dejó escrito con qué pool habría mandado:"
    detalle "  ${linea_pool}"
  else
    detalle "todavía no hay línea 'pool:' en ${DLOG} — dale una vuelta del intervalo y volvé."
  fi
# El daemon NO fecha sus líneas, así que el corte no puede ser una hora: es la ÚLTIMA línea ARRANCA,
# que se escribe una vez por arranque del proceso. Todo lo que viene después es de esta corrida.
elif [[ ! -f "${DLOG}" ]]; then
  nose "no existe ${DLOG}"
elif ! grep -qa '\[warmup-live\] ARRANCA' "${DLOG}"; then
  nose "el log del daemon no tiene ninguna línea ARRANCA"
else
  desde_arranca="$(awk '/\[warmup-live\] ARRANCA/{n=NR} END{print n}' "${DLOG}")"
  post="$(awk -v n="${desde_arranca}" 'NR>n' "${DLOG}")"
  IFS='|' read -r _s dpid _e _r <<< "$(delivrix_launchd_estado warmup-daemon)"
  dnac="$(nacimiento "${dpid}")"
  # ¿El ARRANCA que ancla todo esto es de DESPUÉS del deploy? Sólo si el proceso nació después.
  # Importa para el escaneo de quemados de más abajo: si el daemon NO se reinició, las líneas
  # posteriores al último ARRANCA abarcan de los dos lados del deploy, y culpar al despliegue por un
  # envío que pasó ANTES sería exactamente el aviso que grita en falso.
  # TRES estados y no dos. Si no puedo fechar el proceso (launchctl falló, no hay pid) NO puedo
  # saber de qué lado del deploy cayeron estas líneas — y "no sé" jamás puede convertirse en una
  # acusación al despliegue. Es la misma regla que el resto del script.
  daemon_nuevo=nose
  if [[ "${dnac}" =~ ^[0-9]+$ ]]; then
    if (( dnac < CORTE )); then
      daemon_nuevo=no
      ok "el daemon no se reinició en este deploy (vive hace $(hace $(( AHORA - dnac )))) — su código no cambió"
    else
      daemon_nuevo=si
    fi
  fi
  ultima_vuelta="$(printf '%s\n' "${post}" | grep -aE '\[warmup-live\] vuelta #[0-9]+' | tail -1)"
  if [[ -z "${ultima_vuelta}" ]]; then
    if printf '%s\n' "${post}" | grep -qa 'espero el intervalo\|ya cumplió su cupo de hoy'; then
      # NO es una falla: con el cupo por dominio agotado el daemon duerme el intervalo entero
      # (90 min ±35% de jitter ⇒ hasta ~2 h). Pintarlo de rojo sería un aviso que grita en falso.
      nose "todavía no le tocó: el pool ya cumplió su cupo de hoy y está durmiendo el intervalo"
      detalle "el intervalo es 90 min ±35% ⇒ volvé a correr esto en ~2 h, o mirá:  tail -f ${DLOG}"
      ESPERAR+=("la vuelta del daemon puede tardar hasta ~2 h por el jitter del intervalo")
    else
      falla "el daemon arrancó y no dejó NI UNA línea de vuelta ni de espera: no está girando"
      detalle "tail -50 ${DLOG}"
      ROLLBACK+=("el daemon arrancó y no gira")
    fi
  else
    caida="$(printf '%s' "${ultima_vuelta}" | grep -oE 'cayó en [A-Z]+' | awk '{print $3}')"
    n_vuelta="$(printf '%s' "${ultima_vuelta}" | grep -oE 'vuelta #[0-9]+' | head -1)"
    if printf '%s' "${ultima_vuelta}" | grep -qa 'COMPLETA'; then
      case "${caida}" in
        INBOX) ok "${n_vuelta} COMPLETA y cayó en INBOX" ;;
        SPAM|MISSING|"")
          # Placement malo NO es un fallo del despliegue: el deploy cambia el SENSOR, no la
          # reputación. Se dice y se sigue; el que decide bajar el volumen es el agente.
          aviso "${n_vuelta} COMPLETA pero cayó en ${caida:-?} — placement malo, no es culpa del deploy" ;;
      esac
    else
      etapa="$(printf '%s' "${ultima_vuelta}" | grep -oE 'cortó en [a-z]+' | awk '{print $3}')"
      aviso "${n_vuelta} cortó en ${etapa:-?} (cayó en ${caida:-?}): la vuelta no llegó al final"
      detalle "una vuelta cortada sola no es un rollback; dos seguidas después del deploy sí."
    fi
    # EL DAÑO CONCRETO QUE ESTE DESPLIEGUE VIENE A EVITAR: que vuelva a salir correo desde los tres
    # que anoche no lograron una entrega. Se busca en TODAS las vueltas posteriores al arranque, no
    # solo en la última.
    salio_de_quemado=""
    for q in "${QUEMADOS[@]}"; do
      printf '%s\n' "${post}" | grep -qaE "vuelta #[0-9]+ · ${q} →" && salio_de_quemado+="${q} "
    done
    if [[ "${daemon_nuevo}" != "si" ]]; then
      # Sin reinicio del daemon (o sin poder fecharlo) no hay forma de ubicar estas líneas: el log no
      # las marca y el ARRANCA que las ancla es anterior al deploy. Se dice qué se vio y se manda la
      # pregunta al chequeo 3, que sí puede contestarla sobre el pool de AHORA.
      nose "$( [[ "${daemon_nuevo}" == "no" ]] && echo 'el daemon no reinició' || echo 'no pude fechar el proceso del daemon' ): no puedo separar las vueltas de antes y después del deploy${salio_de_quemado:+ (hay envíos desde ${salio_de_quemado% } en la ventana, sin fechar)}"
      detalle "la pregunta la contesta el chequeo 3: si los quemados no están en el pool, no van a salir."
    elif [[ -n "${salio_de_quemado}" ]]; then
      falla "SALIÓ CORREO DESDE UN QUEMADO después del deploy: ${salio_de_quemado% }"
      FRENO+=("el daemon está enviando desde ${salio_de_quemado% }")
    else
      ok "ninguna vuelta posterior al arranque salió desde un dominio quemado conocido"
    fi
  fi
fi
echo

# ---------------------------------------------------------------- 3. ¿bajó el pool?
echo "-- 3. el pool --"
MED="${INV}/sender-measurement.json"
med_epoch="$(campo_epoch "${MED}" '.medidoEn')"
remidio=0
if (( ! HAY_JQ )); then
  nose "sin jq no puedo leer la fecha de la medición"
elif [[ -z "${med_epoch}" ]]; then
  falla "no pude leer .medidoEn de ${MED}"
  # Un archivo de salud ilegible NO es neutro: `leerSalud` devuelve undefined, `elegirPool` se
  # saltea el filtro entero y el daemon se degrada al pool configurado. Peor: el panel y el agente
  # muestran los 44 con cap>0, incluidos los que cruzaron el umbral permanente.
  ROLLBACK+=("sender-measurement.json ilegible: el filtro de salud del pool queda apagado")
elif (( med_epoch < CORTE )); then
  nose "la medición es ANTERIOR al deploy (de hace $(hace $(( AHORA - med_epoch )))): el pool todavía NO puede haber bajado"
  detalle "flota-salud remide al arrancar y el barrido nuevo tarda ~15 min (3,4× el viejo)."
  detalle "no cuentes minutos: volvé cuando .medidoEn sea posterior al deploy."
  detalle "seguilo:  tail -f ${LOG_DIR}/flota-salud.log"
  ESPERAR+=("falta que flota-salud remida (~15 min) para que el pool pueda bajar")
else
  remidio=1
  ok "medición NUEVA, posterior al deploy (hace $(hace $(( AHORA - med_epoch ))))"
fi

if (( HAY_JQ )) && [[ -f "${MED}" ]]; then
  estados="$(jq -r '[.bandejas[].estado] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' "${MED}" 2>/dev/null || true)"
  [[ -n "${estados}" ]] && detalle "estados: ${estados}"
  # EL TRINQUETE, A LA VISTA EN CADA CORRIDA. `cerradoEn` se ARRASTRA entre mediciones y `elegirPool`
  # excluye a quien lo tenga, así que este número sólo puede subir y el único camino de vuelta es
  # borrar el campo a mano. Se imprime siempre —no sólo cuando molesta— porque el modo de falla es
  # que crezca EN SILENCIO hasta vaciar el pool; el barrido (medir-flota.ts) marca además cuáles se
  # pegaron en la última corrida.
  pegados="$(jq -r '[.bandejas[] | select((.cerradoEn // []) | length > 0)] | length' "${MED}" 2>/dev/null || echo "")"
  if [[ "${pegados}" =~ ^[0-9]+$ ]] && (( pegados > 0 )); then
    detalle "cerrados por el receptor (pegajoso, no caduca): ${pegados} · $(jq -r '[.bandejas[] | select((.cerradoEn // []) | length > 0) | .domain] | join(", ")' "${MED}" 2>/dev/null)"
    detalle "despegar uno (sólo si se comprobó que se recuperó):"
    detalle "  jq '(.bandejas[]|select(.domain==\"DOMINIO\").cerradoEn)=[]' ${MED} > /tmp/m.json && mv /tmp/m.json ${MED}"
  fi
  insuf="$(jq -r '[.bandejas[] | select(.estado == "insufficient_sample")] | length' "${MED}" 2>/dev/null || echo "")"
  sanos="$(jq -r '[.bandejas[] | select(.estado == "healthy")] | length' "${MED}" 2>/dev/null || echo "")"
  # LA PRUEBA DE QUE EL SENSOR NUEVO MORDIÓ. Anoche 23 de los 29 `healthy` tenían un receptor grande
  # rechazándoles el 100% por debajo del piso de 20 intentos: el estado que faltaba. Si después de
  # remedir siguen 0 los `insufficient_sample` y los `healthy` siguen arriba de 25, el código nuevo
  # está en disco y no en el proceso que escribió este archivo.
  if (( remidio )) && [[ "${insuf}" =~ ^[0-9]+$ && "${sanos}" =~ ^[0-9]+$ ]]; then
    if (( insuf == 0 && sanos > 25 )); then
      falla "remidió con ${sanos} healthy y CERO insufficient_sample: el sensor nuevo no está corriendo"
      detalle "flota-salud ejecuta scripts/ops/medir-flota.ts, que importa el sensor. ¿Se reinició?"
      detalle "sudo launchctl kickstart -k system/com.delivrix.flota-salud"
      ROLLBACK+=("flota-salud sigue midiendo con el sensor viejo")
    else
      ok "el sensor nuevo mordió: ${insuf} insufficient_sample (antes del deploy eran 0)"
    fi
  fi
fi

# EL POOL SE PREGUNTA CON EL CÓDIGO QUE LO DECIDE, NO CON UN awk QUE LO IMITE.
#
# Reimplementar `elegirPool` en bash sería el error que este repo ya pagó: un fixture escrito desde
# mi suposición de la lógica hace que el chequeo y el código compartan el error, y el verde no
# significa nada. Acá se importan `resolveLiveDaemonConfig` + `elegirPool` + `poolSinSalud` —las
# tres funciones que corre live-warmup-daemon.ts en sus líneas 1338-1339— con el MISMO archivo de
# entorno, así que el número que sale es el pool que el daemon va a usar, no una aproximación.
#
# Se pregunta acá en vez de esperar la línea `pool:` del log porque el daemon solo la escribe cuando
# el pool CAMBIA y puede estar durmiendo hasta 2 h. Un chequeo que hay que esperar dos horas es un
# chequeo que nadie corre.
POOL_JSON=""
if [[ -f "${ROOT_DIR}/config/gateway.env" ]]; then
  POOL_JSON="$(cd "${ROOT_DIR}" && node --env-file=config/gateway.env --input-type=module -e '
    const R = process.cwd();
    const { resolveLiveDaemonConfig, poolSinSalud } = await import(`${R}/apps/warmup-engine/src/service/live-warmup-daemon.ts`);
    const { elegirPool, leerCuposFisicos, leerSalud, leerReputacion } = await import(`${R}/apps/warmup-engine/src/service/plan-diario.ts`);
    const cfg = resolveLiveDaemonConfig(process.env);
    const salud = await leerSalud(cfg.saludFile);
    const crudo = elegirPool(
      await leerCuposFisicos(cfg.capFile), cfg.boxes, salud,
      await leerReputacion(cfg.reputacionFile), cfg.arrancaPrimero
    );
    const pool = poolSinSalud(crudo, cfg.boxes, salud !== undefined, cfg.saludFile);
    console.log(JSON.stringify({ n: pool.boxes.length, boxes: pool.boxes, degradado: salud === undefined }));
  ' 2>/dev/null || true)"
else
  nose "falta ${ROOT_DIR}/config/gateway.env: no puedo calcular el pool con la config real"
fi

if [[ -z "${POOL_JSON}" ]]; then
  [[ -f "${ROOT_DIR}/config/gateway.env" ]] && nose "no pude calcular el pool (¿node? ¿imports?). Mirá la línea 'pool:' en ${DLOG}"
elif (( HAY_JQ )); then
  n_pool="$(printf '%s' "${POOL_JSON}" | jq -r '.n')"
  degradado="$(printf '%s' "${POOL_JSON}" | jq -r '.degradado')"
  [[ "${degradado}" == "true" ]] && aviso "sin medición de salud legible: el daemon está degradado al pool configurado"
  en_pool=""
  for q in "${QUEMADOS[@]}"; do
    printf '%s' "${POOL_JSON}" | jq -e --arg q "${q}" '.boxes | index($q)' >/dev/null 2>&1 && en_pool+="${q} "
  done
  detalle "pool = ${n_pool} → $(printf '%s' "${POOL_JSON}" | jq -r '.boxes | join(", ")')"
  if [[ -n "${en_pool}" ]]; then
    if (( remidio )); then
      # ── ESTO ES LO ESPERADO, Y DECIRLO ES LA MITAD DEL CHEQUEO ──────────────────────────────
      #
      # La versión anterior decía «el sensor nuevo no los sacó» como si fuera una sorpresa, y le
      # prometía al operador un verde que el mecanismo NO PUEDE DAR. Medido corriendo
      # `assessDeliveryHealth` del árbol con los números reales de la foto del 2026-08-08:
      #   · corpfilinginfra.com  41 entregados / 3 rechazados / 38 diferidos (38 de las 41 a sí mismo)
      #   · corpregistry-control.com  11 / 2 / 9   ·  docfiling-ops.com  9 / 2 / 7
      # Con esos rechazos NINGUNA puerta del sensor los alcanza: `blocked_by_provider` pide 20
      # intentos al 90%, `degraded` pide 5 rechazos, y el veto de abajo del piso
      # (`insufficient_sample`) pide `rechazos/intentos >= 0,9` contra UN receptor. Y el 0,9 está
      # cerrado por un dato duro: los tres cayeron en MISSING, que significa que el proveedor
      # ACEPTÓ el mensaje — o sea que gmail.com tiene al menos una entrega y el ratio no llega.
      # Corrido en los dos repartos posibles: con gmail 3/2 sale `healthy`; sólo con gmail 0
      # entregados sale `insufficient_sample`, y el MISSING prueba que no es cero.
      #
      # O sea: un dominio puede no entregar NADA útil y aun así ser irreprochable para el sensor.
      # El sensor mide si el receptor nos cierra la puerta; MISSING es la puerta abierta y el
      # mensaje tirado a la basura. Son dos preguntas distintas y ésta no tiene sensor todavía.
      #
      # SIGUE SIENDO `falla` + FRENO a propósito: que sea esperado no lo hace inofensivo — estos
      # nodos no pueden mandar. Lo que cambia es que ahora el operador sabe QUÉ HACER, y no se
      # queda esperando un verde que no viene. Un chequeo que siempre está rojo enseña a ignorarlo,
      # que es la lección que este repo ya pagó.
      falla "los quemados SIGUEN en el pool después de remedir: ${en_pool% }"
      detalle "ES LO ESPERADO: el sensor no puede sacarlos. Tienen 2-3 rechazos en toda la ventana y"
      detalle "cayeron en MISSING (el proveedor los aceptó y los tiró), así que ninguna puerta los agarra."
      detalle "NO sueltes el freno todavía. Sacalos A MANO —es un acto humano y está bien que lo sea—:"
      # `cerradoEn` es la palanca manual que YA existe (el mismo verificador imprime cómo BORRARLA
      # más abajo). La etiqueta dice de dónde salió: el motivo del pool va a leerse "cerrado por el
      # receptor (arrastrado: …)", y sin la etiqueta nadie sabría después que lo puso una persona.
      # shellcheck disable=SC2086  # división por palabras a propósito: `en_pool` es una lista
      for q in ${en_pool}; do
        detalle "  jq '(.bandejas[]|select(.domain==\"${q}\").cerradoEn)=[\"MISSING x3 — sacado a mano tras el deploy\"]' ${MED} > /tmp/m.json && mv /tmp/m.json ${MED}"
      done
      detalle "volvé a correr esto, confirmá que el pool ya no los tiene, y RECIÉN AHÍ soltá el freno."
      FRENO+=("quemados en el pool con medición nueva: ${en_pool% } — sacalos con \`cerradoEn\` antes de soltar")
    else
      nose "los quemados están en el pool, pero la medición todavía es la vieja: ${en_pool% }"
      detalle "esto es lo ESPERADO antes de remedir. Volvé cuando .medidoEn pase el deploy (~15 min)."
    fi
  else
    ok "ninguno de los quemados conocidos está en el pool"
  fi
  # EL JUICIO SOBRE EL TAMAÑO VIVE EN lib.sh Y ESTÁ PROBADO AHÍ (ver `delivrix_juicio_pool`). Acá
  # adentro no se puede ejercer: llegar a esta línea pide node, config/gateway.env y el inventario
  # entero, y en el árbol falso de produccion.test.sh todo eso se cae en el `nose` de más arriba. El
  # caso que faltaba era `n_pool == 0`: no cruza el techo, caía al `ok "el pool bajó a 0"` y la
  # fábrica PARADA salía verde.
  IFS='|' read -r nivel_pool msg_pool <<< "$(delivrix_juicio_pool "${n_pool}" "${remidio}" "${POOL_MAX}")"
  case "${nivel_pool}" in
    falla) falla "${msg_pool}" ;;
    aviso) aviso "${msg_pool}" ;;
    nose)  nose  "${msg_pool}" ;;
    *)     ok    "${msg_pool}" ;;
  esac
  if [[ "${nivel_pool}" == "falla" ]]; then
    if (( remidio )); then
      detalle "con la medición NUEVA. Mirá por qué los excluyó a todos:"
      detalle "  jq -r '[.bandejas[].estado]|group_by(.)|map(\"\\(.[0])=\\(length)\")|join(\" \")' ${MED}"
      detalle "el sospechoso más probable es \`cerradoEn\`, que NO caduca solo. Para despegar uno:"
      detalle "  jq '(.bandejas[]|select(.domain==\"DOMINIO\").cerradoEn)=[]' ${MED} > /tmp/m.json && mv /tmp/m.json ${MED}"
    else
      detalle "y todavía con la medición VIEJA: esto no lo causó el deploy. Revisá el cupo físico"
      detalle "(sender-cap.json) antes de culpar al sensor."
    fi
  fi
fi
echo

# ---------------------------------------------------------------- 4. ¿el agente sigue con manos?
echo "-- 4. el agente --"
MON="${INV}/warmup-monitor.json"
mon_epoch="$(campo_epoch "${MON}" '.generadoEn')"
if (( ! HAY_JQ )); then
  nose "sin jq no puedo leer el estado del agente"
elif [[ -z "${mon_epoch}" ]]; then
  falla "no pude leer .generadoEn de ${MON}: el agente no dejó lectura"
else
  # El monitor gira cada 10 min (WARMUP_MONITOR_INTERVAL_MS, default 600000). Se le dan 25: dos
  # vueltas más margen, porque una vuelta que consulta al modelo local puede tardar minutos.
  edad=$(( AHORA - mon_epoch ))
  if (( mon_epoch < CORTE )); then
    nose "la última lectura del agente es ANTERIOR al deploy (hace $(hace "${edad}")): todavía no giró"
    detalle "gira cada 10 min. Volvé a correr esto en ~15 minutos."
    ESPERAR+=("el agente todavía no dio su primera vuelta post-deploy (gira cada 10 min)")
  elif (( edad > 1500 )); then
    falla "el agente giró tras el deploy pero su última lectura tiene $(hace "${edad}"): se quedó"
    detalle "tail -50 ${LOG_DIR}/warmup-monitor.log"
  else
    ok "lectura nueva, de hace $(hace "${edad}")"
  fi
  # REPAROS = 0 ES LA CONDICIÓN DE QUE TENGA MANOS. `sentinel-chat.ts` y el monitor sólo ejecutan
  # acciones cuando la verificación no encontró reparos; con reparos el agente sigue hablando pero
  # NO toca nada, y eso desde afuera se ve igual que un agente sano. Es justo el modo de falla que
  # este chequeo existe para separar.
  nrep="$(jq -r '(.verificacion.reparos // []) | length' "${MON}" 2>/dev/null || echo "")"
  nacc="$(jq -r '(.acciones // []) | length' "${MON}" 2>/dev/null || echo "")"
  if [[ ! "${nrep}" =~ ^[0-9]+$ ]]; then
    nose "no pude leer .verificacion.reparos"
  elif (( nrep > 0 )); then
    falla "reparos = ${nrep}: el agente quedó SIN MANOS esta vuelta (habla, pero no ejecuta)"
    detalle "$(jq -r '(.verificacion.reparos // []) | join(" · ")' "${MON}" 2>/dev/null)"
  else
    ok "reparos = 0: sus manos ejecutan"
  fi
  [[ "${nacc}" =~ ^[0-9]+$ ]] && { (( nacc > 0 )) && ok "ejecutó ${nacc} acción(es) en la última vuelta" \
    || aviso "reparos = 0 pero ejecutó 0 acciones: puede ser normal (nada que hacer) o que no tenga a qué llegar"; }
fi
# SLACK SE MIDE POR LA LECTURA, NO POR EL AVISO. `ultimoAviso` sólo se mueve cuando hay novedad:
# un agente perfectamente sano puede pasar horas sin avisar nada, y leer eso como "no contesta"
# sería un rojo falso. Lo que prueba que el canal está vivo es `ultimaLecturaOk`, que se escribe
# cada vuelta que logra leer el hilo.
chat_epoch="$(campo_epoch "${INV}/warmup-chat.json" '.ultimaLecturaOk')"
if (( ! HAY_JQ )); then
  :
elif [[ -z "${chat_epoch}" ]]; then
  nose "no pude leer .ultimaLecturaOk de warmup-chat.json: no sé si Slack está vivo"
elif (( AHORA - chat_epoch > 1500 )); then
  falla "hace $(hace $(( AHORA - chat_epoch ))) que el agente no logra LEER Slack: si el jefe escribe, nadie contesta"
  detalle "revisá el token del bot y el canal:  grep -c SLACK ${ROOT_DIR}/config/gateway.env"
else
  ok "Slack: última lectura buena hace $(hace $(( AHORA - chat_epoch )))"
fi
echo

# ---------------------------------------------------------------- 5. ¿la forma nueva del inventario?
echo "-- 5. la forma de los archivos --"
if (( ! HAY_JQ )) || [[ ! -f "${MED}" ]]; then
  nose "sin jq o sin ${MED} no puedo mirar la forma"
else
  total="$(jq -r '.bandejas | length' "${MED}")"
  con_terceros="$(jq -r '[.bandejas[] | select(has("entregadosATerceros"))] | length' "${MED}")"
  # `entregadosATerceros` es EL campo nuevo del lote: sin él `elegirPool` cae a `entregados`, que
  # cuenta el correo que el nodo se manda a sí mismo por el pipe de rebotes. Con la ventana corrida
  # a 3 días eso metía 19 nodos con CERO entregas reales dentro de un pool de 25.
  if (( remidio )) && [[ "${con_terceros}" == "0" ]]; then
    falla "remidió y NINGUNA de las ${total} bandejas trae entregadosATerceros: escribió el código viejo"
    ROLLBACK+=("el inventario se escribió con la forma vieja después del deploy")
  elif [[ "${con_terceros}" == "${total}" ]]; then
    ok "las ${total} bandejas traen entregadosATerceros (forma nueva)"
  elif (( remidio )); then
    aviso "sólo ${con_terceros} de ${total} bandejas traen entregadosATerceros"
  else
    nose "${con_terceros} de ${total} con entregadosATerceros — el archivo todavía es el de antes del deploy"
  fi

  # ── NFC: LA ATRIBUCIÓN, QUE ES LO QUE EL JEFE CREE QUE YA ESTÁ HECHO ─────────────────────────
  #
  # Se decidió aislar NFC, se construyó el mecanismo entero (`leerLibroPropio`, `atribucion`,
  # `ajeno` en sender-measurement.ts) y el interruptor nunca se accionó: medir-flota.ts sigue
  # llamando con `libro: "todo"` clavado. Medido sobre la foto del 2026-08-08: modo `{"todo": 58}`
  # y 0 queue-ids. Este bloque existe para que ese hecho no se pueda pasar por alto de nuevo: es
  # la sexta capacidad completa sin llamador que encuentra este repo.
  #
  # NO ES UNA FALLA DE ESTE DESPLIEGUE — es honesto y está declarado en el archivo. Es un AVISO,
  # con la frase exacta que hay que decirle al jefe.
  modos="$(jq -r '[.bandejas[].atribucion.modo // "AUSENTE"] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' "${MED}" 2>/dev/null || true)"
  qids="$(jq -r '[.bandejas[].atribucion.queueIds // 0] | add' "${MED}" 2>/dev/null || echo "")"
  detalle "atribución: ${modos:-?} · queue-ids nuestros vistos: ${qids:-?}"
  if [[ "${modos}" == *"AUSENTE"* ]]; then
    aviso "hay bandejas sin declarar atribución: quien lea ese número no sabe de quién es el correo"
  elif [[ "${modos}" == "todo="* && "${modos}" != *"nuestro"* ]]; then
    aviso "NFC NO ESTÁ AISLADO EN LA ATRIBUCIÓN: las ${total} bandejas miden el nodo ENTERO."
    detalle "el veredicto de salud incluye el correo de NFC. medir-flota.ts sigue en \`libro: \"todo\"\`."
    detalle "y ojo: aislar la ATRIBUCIÓN cambia lo que VEMOS, no lo que PASA. Mientras NFC siga"
    detalle "inyectando por estos nodos, sigue quemando los dominios con NUESTRA DKIM."
  elif [[ "${modos}" == *"nuestro"* ]]; then
    ok "atribución encendida (${modos})"
    # EL SENSOR DE VOLUMEN NO SE PUEDE FILTRAR NUNCA. Google cuenta TODO lo que sale del dominio+IP
    # sin mirar quién inyectó, y cruzar 5.000/día a personales es permanente. Si `picos` se vaciara
    # al encender la atribución, nos quedaríamos ciegos justo en la métrica irreversible.
    con_picos="$(jq -r '[.bandejas[] | select((.picos // []) | length > 0)] | length' "${MED}" 2>/dev/null || echo "")"
    if [[ "${con_picos}" =~ ^[0-9]+$ ]] && (( con_picos == 0 )); then
      falla "se encendió la atribución y NINGUNA bandeja tiene picos: el sensor del umbral permanente quedó ciego"
      detalle "picos/cruzados/cerca NO se atribuyen nunca. La salud se puede filtrar; el umbral, jamás."
      ROLLBACK+=("la atribución apagó el sensor de volumen contra el umbral permanente")
    else
      ok "el sensor de volumen sigue sin filtrar: ${con_picos} bandejas con picos"
    fi
  fi
fi
echo

# ---------------------------------------------------------------- veredicto
echo "== veredicto =="
if (( ${#ROLLBACK[@]} > 0 )); then
  echo
  echo "ROLLBACK. El despliegue está roto, no la fábrica:"
  for r in "${ROLLBACK[@]}"; do echo "   · ${r}"; done
  # EL ORDEN NO ES COSMÉTICO Y EL PASO 3 ES EL QUE FALTABA. Volver el CÓDIGO sin volver el DATO deja
  # el sender-measurement.json NUEVO (con `insufficient_sample`) leído por el código VIEJO, y el
  # `motivoDeExclusion` de eb6b373 es una lista NEGRA: no tiene rama para ese estado, así que no
  # excluye a nadie por él y esos nodos vuelven al pool con UNA sola entrega en la ventana
  # (MIN_ENTREGAS_EN_VENTANA=1). Un rollback de código a secas deja el pool MÁS ABIERTO que ahora.
  # Por eso el kill-file se saca ÚLTIMO, recién cuando flota-salud reescribió el archivo con el
  # sensor viejo — o cuando se restauró el snapshot que dejó desplegar.sh.
  anterior="$(git -C "${ROOT_DIR}" rev-parse --short 'HEAD@{1}' 2>/dev/null || true)"
  echo "   ssh a la Studio y hacé los CUATRO pasos EN ORDEN:"
  echo "   1) volver el código:"
  echo "        cd ${ROOT_DIR} && git log --oneline -5      # confirmá cuál es el de antes"
  echo "        git reset --hard ${anterior:-<commit-anterior>}"
  echo "   2) reiniciar los servicios afectados (el daemon queda frenado por el kill-file):"
  echo "        sudo launchctl kickstart -k system/com.delivrix.gateway"
  echo "        sudo launchctl kickstart -k system/com.delivrix.flota-salud   # y los demás"
  # EL PASO 3 ES EL SNAPSHOT, NO LA ESPERA, y el orden importa: volver el CÓDIGO deja el JSON NUEVO
  # (con `insufficient_sample`) leído por el código VIEJO, cuyo `motivoDeExclusion` es lista NEGRA y
  # no tiene rama para ese estado — o sea que un rollback de código a secas abre el pool MÁS que no
  # hacer nada. El `cp` es instantáneo y cierra ese hueco ya; esperar a que flota-salud reescriba con
  # el sensor viejo tarda ~15 min (el barrido nuevo cuesta 3,4× el viejo) y es la alternativa, no el
  # camino. Estaban al revés, y "esperá 4 minutos y hacé rm" era la receta para soltar el emisor con
  # el hueco abierto.
  echo "   3) volver el DATO — instantáneo, con el snapshot que dejó desplegar.sh:"
  echo "        cd ${INV} && cp sender-measurement.pre-deploy.json sender-measurement.json"
  echo "        cp warmup-reputacion.pre-deploy.json warmup-reputacion.json"
  echo "      (si el snapshot no existe: esperá a que flota-salud reescriba con el sensor VIEJO,"
  echo "       ~15 min, y confirmá que .medidoEn sea posterior al reinicio del paso 2)"
  echo "   4) recién ahí soltar el emisor:"
  echo "        rm ${ROOT_DIR}/runtime/warmup-live.kill"
fi
if (( ${#FRENO[@]} > 0 )); then
  echo
  echo "FRENO, NO ROLLBACK. El código nuevo está bien; lo que está mal es que sale correo:"
  for f in "${FRENO[@]}"; do echo "   · ${f}"; done
  echo "   parar el emisor NO requiere desplegar nada:"
  echo "     touch ${ROOT_DIR}/runtime/warmup-live.kill"
  echo
  echo "   OJO: revertir el sensor NO arregla esto, lo empeora. El código viejo es el que declaraba"
  echo "   \`healthy\` a los quemados; volver a él los deja entrar al pool otra vez."
fi
if (( ${#ESPERAR[@]} > 0 )); then
  echo
  echo "TODAVÍA NO SE PUEDE SABER — no es un rojo, es que falta tiempo:"
  for e in "${ESPERAR[@]}"; do echo "   · ${e}"; done
fi
if (( EMISOR_FRENADO )); then
  echo
  echo "EL EMISOR ESTÁ FRENADO — el despliegue NO terminó (esto es lo que falta, no un error):"
  echo "   El freno lo puso desplegar.sh a propósito: el daemon manda en su PRIMER tick y el pool"
  echo "   no baja por desplegar (elegirPool LEE sender-measurement.json, que hasta que flota-salud"
  echo "   remida sigue siendo el del sensor viejo). Antes de soltarlo, mirá el chequeo 3 de arriba:"
  echo "   la medición tiene que ser POSTERIOR al deploy y los quemados NO pueden estar en el pool."
  echo "   Cuando eso esté:"
  echo "     rm ${ROOT_DIR}/runtime/warmup-live.kill"
  echo "   Y volvé a correr este script: sin el archivo puede dar verde."
fi
echo
# La decisión del exit code vive en lib.sh porque acá adentro no se puede probar: para llegar a esta
# línea hacen falta launchd, Postgres, el gateway escuchando y jq. Ver produccion.test.sh.
IFS='|' read -r codigo veredicto <<< "$(delivrix_veredicto_despliegue "${fallas}" "${noses}" "${avisos}" "${EMISOR_FRENADO}")"
echo "${veredicto}"

# Queda escrito para poder COMPARAR con el deploy anterior en vez de recordar.
mkdir -p "${LOG_DIR}"
{
  printf '\n===== corte %sZ | commit %s | verificado %s =====\n' \
    "${CORTE_ISO}" "${ESPERADO:0:8}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "${veredicto}"
} >> "${SALIDA}" 2>/dev/null || echo "(aviso: no pude escribir ${SALIDA})"
echo "→ ${SALIDA}"
exit "${codigo}"
