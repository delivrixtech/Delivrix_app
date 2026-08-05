#!/usr/bin/env bash
# Los tres procesos del warmup, corriendo como servicios y no a mano en una terminal.
#
#   scripts/warmup-servicios.sh start     arranca los tres (o el que falte)
#   scripts/warmup-servicios.sh status    dice cuál vive y cuál no, y desde cuándo
#   scripts/warmup-servicios.sh stop      los baja
#   scripts/warmup-servicios.sh restart   stop + start
#   scripts/warmup-servicios.sh start daemon    solo uno
#
# Por qué existe: los tres corrían con `nohup ... &` en la terminal del operador. Se mueren al
# cerrarla, no se sabe si están vivos, y —lo peor— cuando el que mide el cupo se cae, la medición
# vence a las 12h y el motor de decisión pasa a decidir a ciegas SIN QUE NADIE LO VEA. Un proceso
# que se muere en silencio es peor que uno que no arranca.
#
# Sigue el mismo patrón que scripts/delivrix-gateway-start.sh (screen + pidfile + log fechado con
# symlink al actual) a propósito: un segundo mecanismo de arranque en el mismo repo es una segunda
# cosa que mantener y que se olvida.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ESTE SCRIPT ES DE DESARROLLO. En producción los tres servicios los maneja launchd
# (com.delivrix.warmup-*), y acá hay dos formas de hacer daño real:
#   · `start` levantaría un SEGUNDO emisor. Hoy el lock de la base lo corta, pero el lock no
#     cruza máquinas ni bases: si esta copia apunta a otra Postgres, salen DOS emisores y eso
#     duplica el volumen hacia Gmail, que es irreversible.
#   · `stop` mata por `pgrep -f` sobre el comando — y ese patrón COINCIDE con el proceso que
#     lanzó launchd. Alguien que cree estar parando "su" daemon apaga el de producción.
# Por eso: si esta máquina es producción, este script no corre. Ahí se usa launchctl.
if [[ -f "${ROOT_DIR}/runtime/ESTA-MAQUINA-ES-PRODUCCION" ]]; then
  echo "FATAL: esta es la máquina de PRODUCCIÓN ($(hostname -s))." >&2
  echo "  Acá los servicios del warmup los maneja launchd, no este script." >&2
  echo "    ver:      launchctl print system/com.delivrix.warmup-daemon | head -5" >&2
  echo "    reiniciar: sudo launchctl kickstart -k system/com.delivrix.warmup-daemon" >&2
  echo "    apagar:    sudo launchctl bootout system/com.delivrix.warmup-daemon" >&2
  exit 1
fi

RUNTIME_DIR="${ROOT_DIR}/runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
PID_DIR="${RUNTIME_DIR}/pids"
TODAY="$(date +%Y-%m-%d)"

mkdir -p "${LOG_DIR}" "${PID_DIR}"

ENV_FILE="config/gateway.env"
[[ -f "${ROOT_DIR}/config/gateway.env" ]] || ENV_FILE=".env.local"

# nombre | comando (relativo a ROOT_DIR) | env extra
# El daemon es el ÚNICO que manda correo, así que es el único que lleva WARMUP_LIVE_ENABLE. Los
# otros dos son de lectura: si se caen se pierde visibilidad, no correo.
servicios() {
  cat <<'SERVICIOS'
daemon|apps/warmup-engine/src/service/live-warmup-daemon.ts|WARMUP_LIVE_ENABLE=true
monitor|scripts/ops/warmup-monitor.ts --loop|
cupo|scripts/ops/limite-fisico.ts --status --cada=6|
SERVICIOS
}

vive() { ps -p "$1" >/dev/null 2>&1; }

# El PID del proceso NODE, no el de los envoltorios.
#
# `pgrep -f <comando>` matchea TRES cosas: el `SCREEN -dmS ...`, el `login/bash -lc ...` y el node
# real — los tres tienen el comando en su línea. Con `head -1` salía casi siempre un envoltorio, y
# entonces `stop` mataba la cáscara y dejaba el node huérfano corriendo. Se vio en vivo: quedaron
# dos monitores y dos mediciones a la vez.
#
# El filtro `^node ` sobre el comando exacto deja solo el proceso de verdad.
pid_de() {
  local nombre="$1" comando
  comando="$(servicios | awk -F'|' -v n="${nombre}" '$1 == n { print $2 }')"
  [[ -n "${comando}" ]] || return 1
  local pid
  for pid in $(pgrep -f "${comando}" 2>/dev/null || true); do
    if ps -p "${pid}" -o command= 2>/dev/null | grep -q "^node "; then
      echo "${pid}"
      return 0
    fi
  done
  return 1
}

parar_uno() {
  local nombre="$1" comando
  comando="$(servicios | awk -F'|' -v n="${nombre}" '$1 == n { print $2 }')"

  # La sesión de screen primero: es la unidad que contiene todo el árbol.
  screen -X -S "warmup-${nombre}" quit 2>/dev/null || true

  # Y después TODO lo que quede con ese comando. Matar solo el pidfile dejaba huérfanos, y un
  # huérfano del daemon sigue MANDANDO CORREO sin que el operador crea que hay algo corriendo.
  local quedaron=0
  for _ in {1..20}; do
    local pids
    pids="$(pgrep -f "${comando}" 2>/dev/null || true)"
    [[ -z "${pids}" ]] && break
    quedaron=1
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
    sleep 0.3
  done
  local restantes
  restantes="$(pgrep -f "${comando}" 2>/dev/null || true)"
  if [[ -n "${restantes}" ]]; then
    # shellcheck disable=SC2086
    kill -9 ${restantes} 2>/dev/null || true
    sleep 0.5
  fi

  if [[ -n "$(pgrep -f "${comando}" 2>/dev/null || true)" ]]; then
    echo "  ${nombre}: NO SE PUDO DETENER — quedan procesos vivos" >&2
    return 1
  fi
  echo "  ${nombre}: $([[ "${quedaron}" == 1 ]] && echo detenido || echo 'no estaba corriendo')"
  rm -f "${PID_DIR}/warmup-${nombre}.pid"
}

arrancar_uno() {
  local nombre="$1" comando="$2" extra="$3"
  if pid_de "${nombre}" >/dev/null; then
    echo "  ${nombre}: ya corriendo (PID $(pid_de "${nombre}"))"
    return 0
  fi

  local log="${LOG_DIR}/warmup-${nombre}-${TODAY}.log"
  # Symlink al log del día: el operador siempre mira el mismo path, y los archivos rotan solos por
  # fecha. Sin esto un solo log crece para siempre — el daemon escribe cada vuelta, 24/7.
  ln -sfn "$(basename "${log}")" "${LOG_DIR}/warmup-${nombre}.log"

  {
    echo ""
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] arrancando ${nombre}"
  } >> "${log}"

  # `env` y no `VAR=x exec`: `exec WARMUP_LIVE_ENABLE=true node ...` da
  # "exec: WARMUP_LIVE_ENABLE=true: not found" — exec no acepta asignaciones adelante. El proceso
  # moría al instante y el arranque igual cantaba éxito.
  local cmd
  printf -v cmd 'cd %q && exec env %s node --env-file=%q --experimental-strip-types %s >> %q 2>&1' \
    "${ROOT_DIR}" "${extra}" "${ENV_FILE}" "${comando}" "${log}"
  screen -dmS "warmup-${nombre}" bash -lc "${cmd}"

  # Se espera al PID real Y SE VUELVE A MIRAR después de un momento. Con un solo pgrep se capturaba
  # un proceso transitorio del arranque y se reportaba "arrancado" sobre algo que ya estaba muerto —
  # que es la mentira más cara que puede decir un script de servicios.
  # Se usa `pid_de`, el MISMO que usa `status`: si el arranque reportara el PID del envoltorio y el
  # status el del node, los dos números no coincidirían y el operador no sabría a cuál creerle.
  local pid=""
  for _ in {1..25}; do
    pid="$(pid_de "${nombre}" || true)"
    [[ -n "${pid}" ]] && break
    sleep 0.2
  done
  sleep 1.5
  if [[ -n "${pid}" ]] && vive "${pid}"; then
    echo "${pid}" > "${PID_DIR}/warmup-${nombre}.pid"
    echo "  ${nombre}: arrancado (PID ${pid}) · log ${LOG_DIR}/warmup-${nombre}.log"
  else
    echo "  ${nombre}: NO ARRANCÓ o murió al instante — mirá ${log}" >&2
    tail -n 3 "${log}" | sed 's/^/      /' >&2
    return 1
  fi
}

estado_uno() {
  local nombre="$1"
  local pid
  if pid="$(pid_de "${nombre}")"; then
    local desde
    desde="$(ps -p "${pid}" -o etime= 2>/dev/null | tr -d ' ')"
    echo "  ✓ ${nombre}: vivo (PID ${pid}, hace ${desde})"
  else
    echo "  ✗ ${nombre}: CAÍDO"
  fi
}

# La medición del cupo vence a las 12h. Si el proceso está caído, el motor decide con `cupoFisico:
# null` y eso NO se ve en ningún lado salvo acá. Por eso el status lo dice explícito.
edad_medicion() {
  local archivo="${ROOT_DIR}/runtime/openclaw-workspace/inventory/sender-cap.json"
  [[ -f "${archivo}" ]] || { echo "  ⚠ sin medición del cupo: el motor decide sin saber el cupo de los nodos"; return; }
  local horas
  horas="$(node -e '
    const j = require(process.argv[1]);
    const h = (Date.now() - Date.parse(j.medidoEn)) / 3600000;
    console.log(Number.isFinite(h) ? h.toFixed(1) : "?");
  ' "${archivo}" 2>/dev/null || echo "?")"
  if [[ "${horas}" == "?" ]]; then
    echo "  ⚠ medición del cupo ilegible"
  elif (( $(echo "${horas} > 12" | bc -l) )); then
    echo "  ⚠ medición del cupo VENCIDA (${horas}h): el motor decide sin saber el cupo de los nodos"
  else
    echo "  · medición del cupo: ${horas}h (vigente)"
  fi
}

accion="${1:-status}"
solo="${2:-}"

case "${accion}" in
  start)
    echo "arrancando servicios del warmup:"
    while IFS='|' read -r nombre comando extra; do
      [[ -z "${nombre}" ]] && continue
      [[ -n "${solo}" && "${solo}" != "${nombre}" ]] && continue
      arrancar_uno "${nombre}" "${comando}" "${extra}"
    done < <(servicios)
    ;;
  stop)
    echo "deteniendo servicios del warmup:"
    while IFS='|' read -r nombre _ _; do
      [[ -z "${nombre}" ]] && continue
      [[ -n "${solo}" && "${solo}" != "${nombre}" ]] && continue
      parar_uno "${nombre}"
    done < <(servicios)
    ;;
  restart)
    "${BASH_SOURCE[0]}" stop "${solo}"
    sleep 1
    "${BASH_SOURCE[0]}" start "${solo}"
    ;;
  status)
    echo "servicios del warmup:"
    while IFS='|' read -r nombre _ _; do
      [[ -z "${nombre}" ]] && continue
      estado_uno "${nombre}"
    done < <(servicios)
    edad_medicion
    ;;
  *)
    echo "uso: $(basename "${BASH_SOURCE[0]}") {start|stop|restart|status} [daemon|monitor|cupo]" >&2
    exit 1
    ;;
esac
