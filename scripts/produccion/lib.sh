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

# De un archivo de entorno por STDIN, imprime `NOMBRE=valor` sólo cuando el valor NO PUEDE ser un
# secreto por su FORMA (`true`, `false`, o un entero de hasta seis dígitos). Todo lo demás sale
# `NOMBRE=(oculto)`: el nombre se publica siempre, el valor casi nunca.
#
# POR QUÉ POR LA FORMA Y NO POR EL NOMBRE. Una lista negra de nombres ("oculto todo lo que diga
# TOKEN, KEY, PASSWORD") es una lista que alguien se olvida de actualizar el día que agrega
# `SLACK_WEBHOOK_URL`, y entonces la foto publica una credencial. Un booleano o un entero corto no
# es una credencial de ningún proveedor que use este repo, así que una lista blanca de FORMAS no
# tiene casos que olvidar. Es la misma regla que `sanearIds` en smtp-delivery-health.ts: se
# descarta lo que no calza, no se intenta escapar lo que sí.
#
# PARA QUÉ EXISTE. La foto de producción no traía el entorno, y sin él un agente no puede
# distinguir "el flag está apagado" de "el flag no existe" — que es la misma trampa de ausencia
# leída como cero que este repo ya pagó tres veces. Los flags que deciden si sale correo
# (`WARMUP_LIVE_ENABLE`) o si el agente puede soltar dominios (`WARMUP_AGENT_PUEDE_SOLTAR`) son
# booleanos, así que se ven; el `POSTGRES_URL` de al lado no.
delivrix_env_seguro() {
  awk '
    /^[[:space:]]*(#|$)/ { next }
    index($0, "=") == 0 { next }
    {
      nombre = substr($0, 1, index($0, "=") - 1)
      sub(/^[[:space:]]*/, "", nombre); sub(/^export[[:space:]]+/, "", nombre)
      sub(/[[:space:]]+$/, "", nombre)
      if (nombre !~ /^[A-Za-z_][A-Za-z0-9_]*$/) next
      valor = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]\r]+$/, "", valor)
      gsub(/^"|"$/, "", valor)
      if (valor ~ /^(true|false|[0-9][0-9]?[0-9]?[0-9]?[0-9]?[0-9]?)$/) print nombre "=" valor
      else print nombre "=(oculto)"
    }'
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

# De la salida CRUDA de `launchctl print` (primer argumento, como texto), imprime
# "<state>|<pid>|<last exit code>|<runs>".
#
# Toma el texto y no el nombre del servicio a propósito, igual que `delivrix_uptime_s`: así se puede
# probar sin launchd. Un parser que solo se ejerce contra la máquina real es un parser sin test, y
# los dos verificadores (arranque en frío y despliegue) dependen de éste para decidir.
#
# VIVE ACÁ PORQUE HAY DOS LECTORES. Estaba dentro de verificar-arranque-en-frio.sh y el verificador
# de despliegue necesitaba lo mismo: dos copias del mismo `sed` sobre la misma salida se separan en
# cuanto una de las dos se toca, y entonces los dos scripts dan veredictos distintos sobre el mismo
# servicio sin que nadie entienda por qué.
#
# Los campos que faltan salen vacíos, y vacío se lee "no sé" — nunca "no está corriendo".
delivrix_launchd_campos() {
  local salida="${1:-}"
  printf '%s|%s|%s|%s' \
    "$(printf '%s\n' "${salida}" | sed -n 's/^[[:space:]]*state = \(.*\)$/\1/p' | head -1)" \
    "$(printf '%s\n' "${salida}" | sed -n 's/^[[:space:]]*pid = \([0-9]*\)$/\1/p' | head -1)" \
    "$(printf '%s\n' "${salida}" | sed -n 's/^[[:space:]]*last exit code = \(.*\)$/\1/p' | head -1)" \
    "$(printf '%s\n' "${salida}" | sed -n 's/^[[:space:]]*runs = \([0-9]*\)$/\1/p' | head -1)"
}

# Lo mismo pero preguntándole a launchd por el servicio `com.delivrix.$1`.
# Si el plist no está cargado, `launchctl print` falla y eso es NOSE: no se puede confundir "no
# pude preguntar" con "está caído" (la lección del probe que se colgaba, 2026-07-29, 10 de 10
# negativos falsos).
delivrix_launchd_estado() {
  local salida
  if ! salida="$(launchctl print "system/com.delivrix.$1" 2>/dev/null)"; then
    printf 'NOSE|||'; return
  fi
  delivrix_launchd_campos "${salida}"
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
      # EL AGENTE VIVE EN gateway-api PERO CORRE EN EL MONITOR. Los prompts (SISTEMA, VOZ), las
      # manos y las memorias están en apps/gateway-api/src/agents/, y quien los ejecuta 24/7 es
      # scripts/ops/warmup-monitor.ts — un proceso aparte. Con la regla genérica de abajo, cambiar
      # un prompt reiniciaba SOLO el gateway y el agente seguía razonando con el texto viejo hasta
      # que le tocara reiniciar por otra cosa: desplegado en disco, inerte en memoria.
      #
      # Se descubrió al devolverle la línea de revisar_reputacion al prompt: el deploy dijo
      # "reiniciando: gateway" y el agente no se enteró de que tenía ojos nuevos.
      apps/gateway-api/src/agents/*)  _sumar gateway warmup-monitor ;;
      # EL CUPO VIVE EN gateway-api PERO LO EJECUTA warmup-cupo. `scripts/ops/limite-fisico.ts`
      # —el entrypoint del servicio warmup-cupo— importa `resolverTecho` de sender-quota.ts y el
      # parser/escritor de node-daily-cap.ts. Con el caso genérico de abajo, tocar sólo uno de esos
      # dos archivos reiniciaba el gateway y dejaba a warmup-cupo midiendo y ESCRIBIENDO el tope
      # diario de volumen con el código viejo en memoria — desplegado en disco, inerte donde manda.
      # Es el mismo modo de falla que ya nos mordió con sender-measurement.ts y flota-salud, y con
      # los prompts del agente y warmup-monitor: el archivo vive en una app y corre en otro proceso.
      #
      # node-daily-cap.ts suma ADEMÁS warmup-monitor porque scripts/ops/warmup-monitor.ts importa
      # `porEncimaDelTecho` de ahí: es la alarma de "este dominio pasó su techo" que le llega al jefe.
      #
      # HOY NO CAMBIA NADA (medido: el diff del 2026-08-08 ya arrastra limite-fisico.ts y
      # warmup-monitor.ts, así que los dos servicios ya estaban en la lista). El día que se toque
      # SÓLO uno de estos dos archivos, sí. Va ANTES del genérico porque el `case` corta en el
      # primer patrón que matchea.
      apps/gateway-api/src/sender-quota.ts)    _sumar gateway warmup-cupo ;;
      apps/gateway-api/src/node-daily-cap.ts)  _sumar gateway warmup-cupo warmup-monitor ;;
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

# El veredicto FINAL de verificar-despliegue.sh: "<codigo>|<texto>".
#   $1 fallas · $2 noses · $3 avisos · $4 frenado (1 si existe runtime/warmup-live.kill)
#
# VIVE ACÁ PORQUE ES LO QUE DECIDE EL EXIT CODE y adentro del script no se puede probar: para
# llegar al final hay que tener launchd, Postgres, el gateway escuchando y jq. Un verificador
# cuyo veredicto nunca se ejerció es un verificador que nadie probó.
#
# EL FRENO VA PRIMERO Y ES ROJO. Desde el 2026-08-08 desplegar.sh deja `runtime/warmup-live.kill`
# puesto antes de reiniciar el daemon, porque el daemon manda en su PRIMER tick y el pool no baja
# hasta que flota-salud vuelva a medir (~15 min con el barrido nuevo): sin freno, el propio deploy
# dispara el incidente que viene a arreglar. El precio de ese freno es que alguien se olvide, y
# ahí el warmup queda parado PARA SIEMPRE en silencio. Mientras el archivo exista, esto no puede
# decir "DESPLIEGUE VERIFICADO": el deploy no terminó.
delivrix_veredicto_despliegue() {
  local fallas="${1:-0}" noses="${2:-0}" avisos="${3:-0}" frenado="${4:-0}"
  local cola="${fallas} falla(s), ${noses} sin verificar, ${avisos} aviso(s)"
  if (( frenado )); then
    printf '1|FRENADO: falta soltar el emisor — %s' "${cola}"
  elif (( fallas > 0 )); then
    printf '1|NO: %s' "${cola}"
  elif (( noses > 0 )); then
    printf '1|INCOMPLETO: 0 fallas, %s sin verificar, %s aviso(s) — volvé a correrlo' "${noses}" "${avisos}"
  else
    printf '0|DESPLIEGUE VERIFICADO: 0 fallas, %s aviso(s)' "${avisos}"
  fi
}

# Qué se dice del TAMAÑO del pool: "<nivel>|<texto>", nivel ∈ ok|aviso|nose|falla.
#   $1 n_pool · $2 remidio (1 si la medición es posterior al deploy) · $3 techo
#
# VIVE ACÁ POR LA MISMA RAZÓN QUE EL VEREDICTO: adentro de verificar-despliegue.sh esta rama no se
# puede ejercer. Para llegar hasta ella hace falta el repo entero, node, config/gateway.env y los dos
# archivos del inventario — el árbol falso de produccion.test.sh no los tiene, así que el `nose` de
# "no pude calcular el pool" se comía todos los casos y la lógica quedaba sin una sola prueba.
#
# EL CASO QUE FALTABA ERA EL CERO, y era el peor de todos. Un pool vacío no cruza el techo, así que
# caía al `ok "el pool bajó a N"`: LA FÁBRICA PARADA SALÍA VERDE en el único instrumento que la
# vigila. Y del otro lado el agente está igual de ciego — `decideDaemonAction` devuelve `send` con el
# pool vacío porque el branch de "nada que calentar" está DESPUÉS del gate. Los dos instrumentos que
# la cuidan se perdían justo el desenlace que este despliegue tiene que evitar.
#
# Es `falla` y no `aviso` a propósito: con el sensor nuevo y el `cerradoEn` pegajoso (no caduca solo)
# el pool sólo puede achicarse día a día, así que cero no es una rareza, es un destino alcanzable.
delivrix_juicio_pool() {
  local n="${1:-}" remidio="${2:-0}" techo="${3:-12}"
  if [[ ! "${n}" =~ ^[0-9]+$ ]]; then
    printf 'nose|no pude calcular el tamaño del pool'
  elif (( n == 0 )); then
    printf 'falla|el pool quedó VACÍO: no hay UN dominio desde el cual calentar — la fábrica no fabrica'
  elif (( n > techo )); then
    if (( remidio )); then
      printf 'aviso|el pool quedó en %s (esperado ~6, techo %s): mirá a quién dejó entrar antes de seguir' "${n}" "${techo}"
    else
      printf 'nose|el pool está en %s con la medición vieja — todavía no bajó porque todavía no remidió' "${n}"
    fi
  elif (( remidio )); then
    printf 'ok|el pool bajó a %s (techo %s)' "${n}" "${techo}"
  else
    # Callarse acá era decir "todo bien" sin haber medido nada: la medición es de antes del deploy,
    # así que este número todavía no habla de lo que se acaba de desplegar.
    printf 'nose|el pool está en %s, pero con la medición vieja ese número no dice nada del deploy' "${n}"
  fi
}
