#!/usr/bin/env bash
# Lleva a producción (la Mac Studio) lo que ya está en la rama produ de GitHub.
#
# CORRE EN LA LAPTOP. El ciclo es: trabajás acá → push a produ → ./scripts/produccion/desplegar.sh
#
# Reinicia SOLO los servicios cuyos archivos cambiaron: reiniciar el daemon de warmup sin
# necesidad cuesta una vuelta, y no hay razón para pagarla.
set -euo pipefail

# Destino SSH: por defecto el alias `studio` de ~/.ssh/config, que ya trae usuario y llave.
# Pasar user@ip a mano no sirve: saltea el alias y con él la IdentityFile, y el deploy muere con
# "Permission denied (publickey)" aunque `ssh studio` funcione perfecto.
STUDIO_SSH="${STUDIO_SSH:-studio}"
STUDIO_DIR="${STUDIO_DIR:-/Users/Shared/delivrix}"
RAMA="${RAMA:-produ}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/produccion/lib.sh
source "${ROOT_DIR}/scripts/produccion/lib.sh"

# Este script EMPUJA hacia producción: corre en la laptop, no dentro de la Studio. Correrlo en la
# máquina de producción no tiene sentido (se conectaría a sí misma) y falla con un error sobre
# llaves SSH que no explica nada. Ya pasó dos veces con scripts de este kit: el prompt de una
# sesión SSH abierta se parece demasiado al de la terminal local.
if [[ -f "${ROOT_DIR}/runtime/ESTA-MAQUINA-ES-PRODUCCION" ]]; then
  echo "FATAL: estás CORRIENDO ESTO DENTRO DE PRODUCCIÓN ($(hostname -s))." >&2
  echo "  desplegar.sh se corre desde la LAPTOP: es el que empuja los cambios hacia acá." >&2
  echo "  Salí de la sesión SSH (exit) y corrélo en el repo de tu laptop." >&2
  exit 1
fi

SSH_DEST="${STUDIO_SSH}"
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "${SSH_DEST}" true 2>/dev/null; then
  echo "FATAL: no puedo entrar a '${SSH_DEST}' sin contraseña." >&2
  echo "  Probá:  ssh ${SSH_DEST} whoami" >&2
  echo "  Si usás otro destino:  STUDIO_SSH=usuario@ip ./scripts/produccion/desplegar.sh" >&2
  exit 1
fi

# --- guarda anti doble-emisor -----------------------------------------------------------------
# Si esta laptop todavía tiene el daemon de warmup vivo, hay DOS cerebros mandando correo contra
# bases distintas. El lock de la base no cruza máquinas: no hay nada que lo impida salvo esto.
#
# EL PATRÓN TIENE QUE SER EL DAEMON, NO LA PALABRA. Con `-f "live-warmup-daemon"` a secas, cualquier
# proceso que MENCIONE esa cadena en su línea de comando cuenta como emisor vivo — y `npm test` la
# menciona, porque su glob incluye apps/warmup-engine/**. Resultado real el 2026-08-06: correr los
# tests bloqueó un deploy legítimo con un FATAL sobre un emisor que no existía.
#
# No es un detalle cosmético: una guarda que grita en falso es una guarda que alguien termina
# comentando, y esta protege de lo único irreversible del proyecto (dos emisores duplicando volumen
# a Gmail cruzan el umbral permanente). Que sea PRECISA es lo que la mantiene creíble.
#
# Se ancla al entrypoint real del daemon, con su extensión, que es lo que ejecuta node de verdad.
if pgrep -f "live-warmup-daemon\.ts" >/dev/null 2>&1; then
  echo "FATAL: esta laptop tiene el daemon de warmup CORRIENDO." >&2
  echo "  Dos daemons contra bases distintas duplican el volumen hacia Gmail, y ese daño es" >&2
  echo "  permanente. Apagalo primero:  ./scripts/warmup-servicios.sh stop" >&2
  exit 1
fi

echo "== desplegando ${RAMA} → ${SSH_DEST} =="

# El PATH va EXPLÍCITO. Un `ssh host 'comando'` abre un shell NO interactivo, que en macOS no lee
# el perfil del usuario: Homebrew no está en el PATH y `npm`, `node` y `psql` simplemente "no
# existen". Se descubrió con un deploy que murió en `npm ci` con "command not found: npm" sobre una
# máquina donde npm está perfectamente instalado — y es la misma trampa que ya había mordido antes
# con `sudo`, que tampoco hereda el PATH.
#
# Falló seguro, eso sí: el script no reinició nada y producción se quedó con la versión vieja, que
# funcionaba. Fallar hacia "no toco nada" es lo que hace que un deploy roto no sea un incidente.
remoto() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 "${SSH_DEST}" \
    "export PATH=/opt/homebrew/bin:/usr/local/bin:\$PATH; cd \"${STUDIO_DIR}\" && $1"
}

antes="$(remoto 'git rev-parse HEAD')"
echo "· producción está en ${antes:0:8}"

salida="$(remoto "git fetch origin ${RAMA} --quiet && git merge --ff-only origin/${RAMA} 2>&1")" || {
  echo "FALLÓ el merge --ff-only en la Studio:" >&2
  echo "${salida}" >&2
  echo "  (¿hay cambios locales en producción? entrá por ssh y resolvelo a mano)" >&2
  exit 1
}
despues="$(remoto 'git rev-parse HEAD')"

# OJO: "al día en disco" NO es "al día en memoria". El chequeo de deriva de abajo corre SIEMPRE,
# incluso cuando no hubo nada nuevo que traer — porque el caso que buscamos es justamente ese: un
# deploy anterior movió los archivos y no llegó a reiniciar.
if [[ "${antes}" == "${despues}" ]]; then
  echo "· el repo de producción ya estaba al día (${despues:0:8})"
  cambios=""
else
  echo "· ${antes:0:8} → ${despues:0:8}"
  cambios="$(remoto "git diff --name-only ${antes} ${despues}")"
  echo "${cambios}" | sed 's/^/    /' | head -20
  total="$(echo "${cambios}" | wc -l | tr -d ' ')"
  (( total > 20 )) && echo "    … y $((total - 20)) más"
fi

# --- deriva: ¿qué corre HOY producción, de verdad? --------------------------------------------
# Comparar solo el delta de ESTE deploy no alcanza. Si un deploy anterior movió los archivos pero
# no llegó a reiniciar (falló el sudo, se cortó la red), el gateway sigue en memoria con código
# viejo y el deploy siguiente dice "nada que reiniciar" — que es verdad para su propio delta, y
# mentira sobre el sistema. Pasó exactamente así. Se le pregunta a producción qué commit corre y
# se agrega lo que haya quedado pendiente desde ahí.
corriendo="$(remoto "curl -fsS --max-time 5 http://127.0.0.1:3000/health" 2>/dev/null \
  | grep -o '"commit"[[:space:]]*:[[:space:]]*"[0-9a-f]*"' | head -1 | grep -o '[0-9a-f]\{7,\}' || true)"
if [[ -n "${corriendo}" && "${corriendo}" != "${despues}" ]]; then
  pendiente="$(remoto "git diff --name-only ${corriendo} ${despues} 2>/dev/null" || true)"
  if [[ -n "${pendiente}" ]]; then
    echo "· deriva: producción corre ${corriendo:0:8}, hay cambios sin reiniciar desde ahí"
    cambios="${cambios}"$'\n'"${pendiente}"
  fi
elif [[ -z "${corriendo}" ]]; then
  # Gateway anterior a este esquema (no reporta build) o caído: no se puede saber qué corre.
  echo "· deriva: producción no reporta su commit — reinicio el gateway por las dudas"
  cambios="${cambios}"$'\n'"apps/gateway-api/src/main.ts"
fi

# --- qué servicio depende de qué (lógica probada en produccion.test.sh) -----------------------
declare -a reiniciar=()
while IFS= read -r s; do [[ -n "${s}" ]] && reiniciar+=("${s}"); done < <(
  printf '%s\n' "${cambios}" | delivrix_servicios_afectados
)

if [[ ${#reiniciar[@]} -eq 0 ]]; then
  echo "· nada que reiniciar: producción corre ${corriendo:0:8} y no quedó código pendiente"
  exit 0
fi

# Si cambió package.json hay que reinstalar antes de reiniciar, o el servicio arranca sin la
# dependencia nueva y muere en bucle (con KeepAlive, en bucle infinito).
if echo "${cambios}" | grep -qE '^package(-lock)?\.json$|^apps/[^/]+/package(-lock)?\.json$'; then
  echo "· cambió package.json → npm ci en producción"
  remoto 'npm ci --silent' || { echo "FALLÓ npm ci — NO reinicio nada (los servicios siguen con la versión vieja, que funciona)" >&2; exit 1; }
fi

# --- FRENO ANTES DE REINICIAR, Y RED DE DATOS -------------------------------------------------
# DESPLEGAR NO BAJA EL POOL. `elegirPool` no juzga la flota: LEE sender-measurement.json, y ese
# archivo lo escribe flota-salud. Al momento de este deploy el que hay en producción está escrito
# por el sensor VIEJO, el que absolvía a un nodo bloqueado por el calendario (dejaba de mandar
# PORQUE estaba bloqueado, a los 5 días la evidencia se caía de la ventana y salía `healthy`).
# Medido con el código nuevo contra el inventario real del 2026-08-08: el pool sale 32, y adentro
# están los SIETE que anoche mandaron las vueltas #21 a #27 y cayeron en MISSING (corpfilinginfra,
# corpregistry-control, docfiling-ops, infranationalcorp, nationalcorp-control, nationalcorp-infra,
# nationalfilingcontrol), contra 6 de 6 en INBOX de los del pool bueno.
#
# Y NO LOS SACA EL DESPLIEGUE NI LA REMEDICIÓN: tienen 2-3 rechazos en toda la ventana y `MISSING`
# significa que el proveedor los ACEPTÓ, así que ninguna puerta del sensor los alcanza (verificado
# corriendo `assessDeliveryHealth` con sus números). Salen A MANO con `cerradoEn`, y el verificador
# imprime el comando exacto. El paso 5 del runbook depende de eso, no de que el sensor muerda.
#
# El daemon manda en su PRIMER tick y flota-salud tarda ~15 MINUTOS en reescribir el archivo. Ese
# número lo encareció ESTE MISMO cambio y por eso se corrige acá: los 198-253 s que decía esta línea
# se midieron con el comando viejo, y la sección `## CULPA` ahora lee también `status=deferred` — el
# estado con más líneas del log. Medido el 2026-08-08 alternando las dos versiones contra el mismo
# nodo: 17,1 y 20,1 s la vieja contra 64,8 y 69,0 s la nueva (3,4×), y por eso el presupuesto de
# lectura subió de 60 a 180 s (smtp-delivery-health.ts). Con concurrencia 4 y 58 bandejas eso son
# ~15 candidatos por tanda × ~65 s ≈ 15 min, no 4.
#
# NO ES UN DETALLE COSMÉTICO: este número es el que le dice al operador si "la medición todavía es
# la vieja" significa ESPERÁ o SE ROMPIÓ. Con "~4 min" en la pantalla, a los cinco minutos parece
# roto, y el atajo obvio es soltar el freno — que es exactamente el incidente que el freno viene a
# evitar (el pool viejo de 32 con los tres quemados adentro). El reloj de verdad es `medidoEn`.
# O sea:
# sin esto, el propio despliegue dispara el incidente que viene a arreglar. La secuencia obligada
# es FRENAR → DESPLEGAR → VOLVER A MEDIR → VERIFICAR → SOLTAR.
#
# POR QUÉ EL KILL-FILE Y NO `launchctl bootout`: los plist tienen KeepAlive=true, launchd lo levanta
# igual. El kill-file se relee en CADA tick (live-warmup-daemon.ts:1297) y el pool se calcula y
# loguea ANTES del gate (:1338-1348 vs :1354), así que el daemon no manda y IGUAL deja escrito qué
# pool habría usado — que es justo el instrumento para decidir si se puede soltar.
#
# Y EL `cp`: hoy no hay forma de volver el sender-measurement.json de antes. Un rollback de CÓDIGO
# sin rollback de DATOS deja el JSON nuevo con el código viejo, y el `motivoDeExclusion` de eb6b373
# es lista NEGRA sin rama para `insufficient_sample`: esos nodos vuelven al pool con UNA entrega.
# Falla con aviso, nunca aborta: que falte un archivo del inventario no puede cortar un deploy a
# mitad de camino.
if printf '%s\n' "${reiniciar[@]}" | grep -qx warmup-daemon; then
  remoto 'mkdir -p runtime && touch runtime/warmup-live.kill' || {
    echo "FALLÓ: no pude frenar el emisor en producción — NO reinicio nada." >&2
    echo "  Reiniciar el daemon sin freno lo hace mandar desde el pool viejo en su primer tick." >&2
    exit 1
  }
  remoto 'cd runtime/openclaw-workspace/inventory && cp sender-measurement.json sender-measurement.pre-deploy.json && cp warmup-reputacion.json warmup-reputacion.pre-deploy.json' \
    || echo "    aviso: no pude respaldar el inventario — el ROLLBACK DE DATOS no va a existir"
  echo
  echo "  ┌─ EMISOR FRENADO (runtime/warmup-live.kill) ────────────────────────────────────────┐"
  echo "  │ El warmup NO va a mandar un solo correo hasta que lo sueltes A MANO.               │"
  echo "  │ Antes de soltarlo: esperá a que flota-salud remida (~15 min) y verificá el pool.   │"
  echo "  │   ssh ${SSH_DEST} 'cd ${STUDIO_DIR} && bash scripts/produccion/verificar-despliegue.sh'"
  echo "  │ OJO: los 7 quemados NO los saca el sensor (2-3 rechazos y MISSING: ninguna puerta  │"
  echo "  │ los agarra). El verificador te va a dar ROJO por ellos y te imprime el jq que los  │"
  echo "  │ saca a mano. Sacalos, volvé a verificar, y RECIÉN AHÍ:                             │"
  echo "  │   ssh ${SSH_DEST} 'rm ${STUDIO_DIR}/runtime/warmup-live.kill'"
  echo "  └────────────────────────────────────────────────────────────────────────────────────┘"
  echo
fi

echo "· reiniciando: ${reiniciar[*]}"
# Reiniciar servicios de sistema exige root, y hay dos caminos según cómo esté la máquina.
#
# DESATENDIDO (si está la regla de /etc/sudoers.d/delivrix-deploy): un `sudo -n` por servicio.
# Tiene que ser el comando EXACTO que la regla autoriza —`/bin/launchctl kickstart -k …`— y ahí
# estuvo el error que costó el primer deploy sin clave: el script envolvía todo en
# `sudo bash -c "launchctl …"`, que para sudoers es OTRO comando (bash), no launchctl. La regla
# no matcheaba y pedía contraseña igual. Una regla de sudoers autoriza un comando literal, no lo
# que ese comando termine ejecutando.
#
# CON CLAVE (sin la regla): se cae al `ssh -t` con UN solo `sudo bash -c` agrupando todos los
# kickstart, para teclear la contraseña una vez por deploy en vez de una por servicio.
#
# Se prueba primero el desatendido con `sudo -n` (nunca pide clave: falla y listo). Así el mismo
# script sirve en las dos máquinas sin configurar nada.
# `sudo -l <comando>` PREGUNTA si ese comando está autorizado, sin ejecutarlo — y hay que
# preguntarle por el comando EXACTO de la regla. Probar con otro (`launchctl print`, por ejemplo)
# devuelve "no autorizado" aunque la regla esté perfectamente instalada, porque efectivamente ese
# otro comando no lo está.
if ssh "${SSH_DEST}" "sudo -n -l /bin/launchctl kickstart -k system/com.delivrix.gateway >/dev/null 2>&1"; then
  fallo=0
  for s in "${reiniciar[@]}"; do
    if ssh "${SSH_DEST}" "sudo -n /bin/launchctl kickstart -k system/com.delivrix.${s}" 2>/dev/null; then
      echo "    ${s}: reiniciado"
    elif ! ssh "${SSH_DEST}" "test -f /Library/LaunchDaemons/com.delivrix.${s}.plist"; then
      # Servicio NUEVO que todavía no está instalado. Es un caso distinto de "el reinicio falló", y
      # confundirlos manda al operador a depurar un servicio caído que en realidad nunca existió.
      # Instalar un plist escribe en /Library/LaunchDaemons: eso es root de verdad y NO lo cubre la
      # regla de sudoers del deploy, así que pide la clave una vez — a propósito.
      echo "    ${s}: NO ESTÁ INSTALADO todavía." >&2
      echo "      → corré:  ssh -t ${SSH_DEST} 'cd /Users/Shared/delivrix && sudo bash scripts/produccion/instalar-produccion.sh'" >&2
      fallo=1
    else
      echo "    ${s}: NO se pudo reiniciar (está instalado pero el kickstart falló)" >&2
      fallo=1
    fi
  done
  [ "${fallo}" -eq 0 ] || {
    echo "FALLÓ: al menos un servicio no se pudo reiniciar." >&2
    echo "  Producción quedó con el código NUEVO en disco y el VIEJO en memoria." >&2
    exit 1
  }
else
  echo "  (sin regla de sudoers: va a pedir la contraseña una vez — ver deploy-sin-clave.sh)"
  kicks=""
  for s in "${reiniciar[@]}"; do
    kicks+="launchctl kickstart -k system/com.delivrix.${s} && echo '    ${s}: reiniciado' || echo '    ${s}: NO se pudo (¿está cargado?)'; "
  done
  ssh -t "${SSH_DEST}" "sudo bash -c \"${kicks}\"" || {
    echo "FALLÓ: no se pudieron reiniciar los servicios en producción." >&2
    echo "  Producción quedó con el código NUEVO en disco y el VIEJO en memoria." >&2
    exit 1
  }
fi

# --- verificación: que el gateway REPORTE el commit nuevo, no solo que responda ---------------
# Antes bastaba con un "status":"ok" y se imprimía el hash que el propio script había calculado.
# Eso es un falso verde: el `kickstart` de arriba traga su error, el proceso VIEJO sigue vivo
# contestando ok, y el deploy declaraba desplegado un código que nadie estaba corriendo. Ahora la
# prueba la da producción: /health devuelve build.commit, y tiene que ser el que acabamos de dejar.
echo "· verificando…"
verifica_commit=0
for s in "${reiniciar[@]}"; do [[ "${s}" == "gateway" ]] && verifica_commit=1; done

ok=0
reportado=""
for _ in {1..20}; do
  cuerpo="$(ssh -o BatchMode=yes "${SSH_DEST}" "curl -fsS --max-time 4 http://127.0.0.1:3000/health" 2>/dev/null || true)"
  if printf '%s' "${cuerpo}" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    # sin jq: puede no estar instalado en producción, y un deploy no es lugar para descubrirlo
    reportado="$(printf '%s' "${cuerpo}" | grep -o '"commit"[[:space:]]*:[[:space:]]*"[0-9a-f]*"' | head -1 | grep -o '[0-9a-f]\{7,\}' || true)"
    if [[ ${verifica_commit} == 0 || "${reportado}" == "${despues}" ]]; then ok=1; break; fi
  fi
  sleep 3
done

if [[ ${ok} == 1 ]]; then
  version="$(printf '%s' "${cuerpo}" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  if [[ ${verifica_commit} == 1 ]]; then
    echo "· producción responde ok · versión ${version:-sin declarar} · commit ${reportado:0:8}"
  else
    # El gateway NO se reinició porque su código no cambió, así que sigue reportando el commit con
    # el que arrancó. Decir "commit <viejo>" a secas se lee como "producción quedó atrasada" —y no
    # es cierto— así que se dice cuál es cuál. Un mensaje ambiguo en un deploy manda a depurar algo
    # que funciona, que es la forma más cara de tener razón.
    echo "· producción responde ok · versión ${version:-sin declarar}"
    echo "  desplegado: ${despues:0:8} (${#reiniciar[@]} servicio(s) reiniciados)"
    echo "  el gateway sigue en ${reportado:0:8} y está BIEN: no cambió código suyo, no se reinició."
  fi
  # LO QUE ESTE SCRIPT NO PUEDE CONTESTAR, Y HAY QUE CONTESTAR. Acá se probó UNA cosa: que el
  # gateway reinició con el código nuevo. Los otros seis servicios no reportan commit, el daemon
  # puede reiniciar sin mandar un correo, el agente puede quedarse sin manos, y el POOL no baja por
  # desplegar —`elegirPool` lee sender-measurement.json, que todavía es el que escribió el sensor
  # viejo—. Sin este puntero el verificador existe y nadie lo corre, que es como no tenerlo.
  echo
  echo "  FALTA VERIFICAR (esto no lo prueba el deploy). En cuanto flota-salud remida (~15 min:"
  echo "  el barrido nuevo cuesta 3,4× el viejo; seguilo con tail -f runtime/logs/flota-salud.log):"
  echo "    ssh ${SSH_DEST} 'cd ${STUDIO_DIR} && bash scripts/produccion/verificar-despliegue.sh'"
  echo "  Y mientras el emisor siga frenado ese verificador va a dar ROJO a propósito: el deploy"
  echo "  no está terminado hasta que alguien mire el pool y suelte el freno."
elif [[ -n "${cuerpo}" ]]; then
  echo "FALLÓ: el gateway responde, pero NO está corriendo el código que acabamos de desplegar." >&2
  if [[ -n "${reportado}" ]]; then
    echo "  esperado: ${despues:0:8}   reportado: ${reportado:0:8}" >&2
  else
    echo "  no reporta build.commit — es una versión anterior a este esquema, o no reinició." >&2
  fi
  echo "  Mirá:  ssh ${SSH_DEST} 'sudo launchctl print system/com.delivrix.gateway | head -20'" >&2
  exit 1
else
  echo "FALLÓ: el gateway no responde tras el reinicio." >&2
  echo "  ssh ${SSH_DEST} 'tail -50 ${STUDIO_DIR}/runtime/logs/gateway.log'" >&2
  exit 1
fi
