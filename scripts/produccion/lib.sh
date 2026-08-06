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

# --- verificación de arranque en frío ---------------------------------------------------------
# Las tres piezas que decide verificar-arranque-en-frio.sh viven acá por el mismo motivo que
# delivrix_uptime_s: son lógica que falla en silencio y hay que poder probarla SIN reiniciar la
# máquina de producción. Un fixture escrito desde mi suposición de la lógica no sirve — el test y
# el código compartirían el error (ya nos pasó con el wire de Bedrock).

# Marca ISO (2026-08-06T17:25:26.287Z) → epoch.
# Los milisegundos se recortan a propósito: el `date -j -f` de BSD los acepta pero escupe
# "Warning: Ignoring 5 extraneous characters" por stderr en cada llamada, y ese ruido en un log de
# verificación se lee como si el chequeo estuviera roto.
delivrix_iso_a_epoch() {
  local iso="${1:-}" seco
  seco="${iso%%.*}"; seco="${seco%Z}"
  [[ "${seco}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] || return 1
  date -j -u -f '%Y-%m-%dT%H:%M:%S' "${seco}" +%s 2>/dev/null
}

# De un flujo de líneas con marca ISO (stdin), imprime la PRIMERA posterior al corte. Vacío si
# ninguna lo es.
#
# La primera y no la última, porque la pregunta del arranque en frío es "cuánto tardó en hacer su
# primer trabajo"; la última línea solo dice "sigue vivo", que es justo lo que ya sabíamos.
# Y el corte importa: los logs sobreviven al reinicio, así que sin comparar contra el boot se toma
# una línea del arranque ANTERIOR como prueba del actual — el verificador daría verde sobre una
# máquina que no levantó nada.
#
# Compara como TEXTO: el formato ISO ordena igual que el tiempo, y así no se llama a `date` una vez
# por línea sobre un log de miles (el del gateway ya pesa 118 KB). Clases [0-9] explícitas y no
# {4}: el awk de BSD no garantiza intervalos en las expresiones regulares.
delivrix_primera_marca_iso() {
  awk -v corte="${1:-}" '
    match($0, /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) {
      m = substr($0, RSTART, RLENGTH)
      if (m "" >= corte "") { print m; exit }
    }'
}

# El veredicto de UN servicio a partir de la fecha de su artefacto. Imprime "<veredicto> <segundos
# desde el boot hasta el artefacto>".
#
# TRES resultados, nunca dos: ok / FALLA / NOSE. "No pude comprobarlo" NO es "está bien": el
# 2026-07-29 una sonda que se colgaba devolvió "bloqueado" falso en 10 de 10 nodos y se diagnosticó
# medio día un problema inexistente. Acá el equivalente sería peor — dar por buena una máquina que
# no arrancó.
#
# tolerancia_s + arranco existen por warmup-cupo y por nada más: limite-fisico.ts solo remide si la
# medición previa tiene ≥6h (el `--cada=6` compara contra la EDAD DEL ARCHIVO, no contra un timer),
# así que tras un reinicio un servicio perfecto puede pasar hasta 6h sin escribir. Exigirle un
# artefacto posterior al boot lo pinta de rojo durante esas 6h, y un operador que aprende a ignorar
# el rojo es peor que no tener verificador.
delivrix_veredicto_artefacto() {
  local boot="${1:-}" art="${2:-}" tolerancia="${3:-0}" arranco="${4:-no}" delta edad
  [[ "${boot}" =~ ^[0-9]+$ && "${art}" =~ ^[0-9]+$ ]] || { echo "NOSE -"; return; }
  delta=$(( art - boot ))
  if (( delta >= 0 )); then echo "ok ${delta}"; return; fi
  edad=$(( $(date +%s) - art ))
  if (( tolerancia > 0 )) && (( edad < tolerancia )) && [[ "${arranco}" == "si" ]]; then
    echo "ok-tolerado ${delta}"; return
  fi
  echo "FALLA ${delta}"
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
        _sumar gateway panel warmup-daemon warmup-monitor warmup-cupo flota-salud ;;
      # El sensor de la flota VIVE en apps/gateway-api pero lo EJECUTA flota-salud: medir-flota.ts
      # importa `medirFlota` de sender-measurement.ts, que importa smtp-delivery-health.ts. Sin esta
      # línea el deploy reiniciaba solo el gateway, y flota-salud —un loop `--cada=6` que lee su
      # código al arrancar y que nadie vuelve a arrancar— seguía escribiendo sender-measurement.json
      # con el código viejo por tiempo indefinido: el warmup elegía el pool con el criterio NUEVO
      # sobre datos del criterio VIEJO. Va ANTES del caso genérico porque el `case` corta en el
      # primer patrón que matchea.
      apps/gateway-api/src/sender-measurement.ts|apps/gateway-api/src/smtp-delivery-health.ts)
        _sumar gateway flota-salud ;;
      apps/gateway-api/*)            _sumar gateway ;;
      apps/admin-panel/*)            _sumar panel ;;
      apps/warmup-engine/*)          _sumar warmup-daemon gateway ;;
      scripts/ops/warmup-monitor.ts) _sumar warmup-monitor ;;
      scripts/ops/limite-fisico.ts)  _sumar warmup-cupo ;;
      scripts/ops/medir-flota.ts)    _sumar flota-salud ;;
    esac
  done
  local s
  for s in "${acc[@]:-}"; do [[ -n "${s}" ]] && printf '%s\n' "${s}"; done
}
