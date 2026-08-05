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
if pgrep -f "live-warmup-daemon" >/dev/null 2>&1; then
  echo "FATAL: esta laptop tiene el daemon de warmup CORRIENDO." >&2
  echo "  Dos daemons contra bases distintas duplican el volumen hacia Gmail, y ese daño es" >&2
  echo "  permanente. Apagalo primero:  ./scripts/warmup-servicios.sh stop" >&2
  exit 1
fi

echo "== desplegando ${RAMA} → ${SSH_DEST} =="

remoto() { ssh -o BatchMode=yes -o ConnectTimeout=15 "${SSH_DEST}" "cd \"${STUDIO_DIR}\" && $1"; }

antes="$(remoto 'git rev-parse HEAD')"
echo "· producción está en ${antes:0:8}"

salida="$(remoto "git fetch origin ${RAMA} --quiet && git merge --ff-only origin/${RAMA} 2>&1")" || {
  echo "FALLÓ el merge --ff-only en la Studio:" >&2
  echo "${salida}" >&2
  echo "  (¿hay cambios locales en producción? entrá por ssh y resolvelo a mano)" >&2
  exit 1
}
despues="$(remoto 'git rev-parse HEAD')"

if [[ "${antes}" == "${despues}" ]]; then
  echo "· ya estaba al día — nada que reiniciar"
  exit 0
fi
echo "· ${antes:0:8} → ${despues:0:8}"

cambios="$(remoto "git diff --name-only ${antes} ${despues}")"
echo "${cambios}" | sed 's/^/    /' | head -20
total="$(echo "${cambios}" | wc -l | tr -d ' ')"
(( total > 20 )) && echo "    … y $((total - 20)) más"

# --- qué servicio depende de qué (lógica probada en produccion.test.sh) -----------------------
declare -a reiniciar=()
while IFS= read -r s; do [[ -n "${s}" ]] && reiniciar+=("${s}"); done < <(
  printf '%s\n' "${cambios}" | delivrix_servicios_afectados
)

if [[ ${#reiniciar[@]} -eq 0 ]]; then
  echo "· ningún servicio depende de lo que cambió — no reinicio nada"
  exit 0
fi

# Si cambió package.json hay que reinstalar antes de reiniciar, o el servicio arranca sin la
# dependencia nueva y muere en bucle (con KeepAlive, en bucle infinito).
if echo "${cambios}" | grep -qE '^package(-lock)?\.json$|^apps/[^/]+/package(-lock)?\.json$'; then
  echo "· cambió package.json → npm ci en producción"
  remoto 'npm ci --silent' || { echo "FALLÓ npm ci — NO reinicio nada (los servicios siguen con la versión vieja, que funciona)" >&2; exit 1; }
fi

echo "· reiniciando: ${reiniciar[*]}"
# UN solo ssh -t con UN solo sudo: reiniciar servicios de sistema exige root, y por SSH no hay
# dónde teclear la contraseña. Con -t hay terminal, y metiendo todos los kickstart dentro de un
# único `sudo bash -c` se pide la clave UNA vez por deploy en vez de una por servicio.
# (Para deploys 100% desatendidos hace falta una regla en sudoers — decisión del dueño, ver
#  DOCUMENTACION/DISCIPLINA_DE_VERSIONES_Y_DEPLOY.md §3.)
kicks=""
for s in "${reiniciar[@]}"; do
  kicks+="launchctl kickstart -k system/com.delivrix.${s} && echo '    ${s}: reiniciado' || echo '    ${s}: NO se pudo (¿está cargado?)'; "
done
ssh -t "${SSH_DEST}" "sudo bash -c \"${kicks}\"" || {
  echo "FALLÓ: no se pudieron reiniciar los servicios en producción." >&2
  echo "  Producción quedó con el código NUEVO en disco y el VIEJO en memoria." >&2
  exit 1
}

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
  echo "· producción responde ok · versión ${version:-sin declarar} · commit ${reportado:0:8}"
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
