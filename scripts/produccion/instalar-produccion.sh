#!/usr/bin/env bash
# Convierte esta Mac en el servidor de producción de Delivrix.
#
# CORRE EN LA MAC STUDIO (por SSH o local), con sudo. Es idempotente: se puede repetir.
#
# Qué hace:
#   1. energía: nunca dormir, encender sola tras corte de luz, reiniciar sola si se cuelga
#   2. actualizaciones de macOS automáticas APAGADAS (la interrupción más peligrosa)
#   3. LaunchDaemons en /Library/LaunchDaemons → arrancan SIN que nadie haga login
#   4. watchdog cada 5 min + respaldo nocturno
#
# El daemon de warmup (el ÚNICO que manda correo) NO se instala por defecto: hay que pasar
# --con-warmup, y solo DESPUÉS de apagar el stack de la laptop. Dos daemons contra bases
# distintas duplican el volumen hacia Gmail, y ese daño es permanente.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CON_WARMUP=0
SOLO_VERIFICAR=0
for arg in "$@"; do
  case "${arg}" in
    --con-warmup) CON_WARMUP=1 ;;
    --verificar)  SOLO_VERIFICAR=1 ;;
    *) echo "uso: instalar-produccion.sh [--con-warmup] [--verificar]" >&2; exit 2 ;;
  esac
done

[[ "$(id -u)" == "0" ]] || { echo "FATAL: corré con sudo." >&2; exit 1; }
OPERADOR="${SUDO_USER:-}"
[[ -n "${OPERADOR}" && "${OPERADOR}" != "root" ]] || { echo "FATAL: usá 'sudo' desde tu usuario normal, no root directo." >&2; exit 1; }
GRUPO="$(id -gn "${OPERADOR}")"

echo "== Delivrix producción =="
echo "   repo:     ${ROOT_DIR}"
echo "   operador: ${OPERADOR}"
echo "   warmup:   $([[ ${CON_WARMUP} == 1 ]] && echo 'SÍ (manda correo)' || echo 'no (se activa con --con-warmup)')"
echo

# ---------------------------------------------------------------- 0. requisitos
# sudo NO hereda el PATH del operador: sin esto, `psql` (y cualquier binario de Homebrew) no
# existe para este script aunque funcione perfecto en la sesión normal. Falló así en la primera
# instalación real y el mensaje culpaba a Postgres, que estaba impecable.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

# macOS (TCC) le prohíbe a los LaunchDaemons leer Documents/Desktop/Downloads, incluso del
# propio usuario y aunque los permisos POSIX estén perfectos. El daemon muere con "Operation not
# permitted" y `ls -l` no muestra nada raro. Pasó en la instalación real con el repo en
# ~/Documents: los 6 servicios cargaron y ninguno pudo arrancar.
# ¿ESTA máquina es producción? Correr esto en la laptop de desarrollo instalaría un SEGUNDO
# emisor de warmup 24/7 contra otra base — el único daño irreversible del sistema (duplicar el
# volumen hacia Gmail cruza un umbral permanente). Ya pasó: el operador pegó el comando en la
# laptop porque el `cd` a la ruta de producción falló en silencio y el script siguió igual.
# El marcador vive en runtime/ (que está en .gitignore), así que NO viaja con el repo: hay que
# crearlo a mano en la máquina de producción, una sola vez, a propósito.
MARCADOR="${ROOT_DIR}/runtime/ESTA-MAQUINA-ES-PRODUCCION"
if [[ ! -f "${MARCADOR}" ]]; then
  echo "FATAL: esta máquina no está marcada como producción." >&2
  echo "  host: $(hostname -s)   repo: ${ROOT_DIR}" >&2
  echo "" >&2
  echo "  Si de verdad ESTA es la máquina de producción (y NO la laptop de desarrollo):" >&2
  echo "     mkdir -p \"${ROOT_DIR}/runtime\" && touch \"${MARCADOR}\"" >&2
  echo "" >&2
  echo "  Instalar esto en la máquina equivocada deja DOS emisores de warmup contra bases" >&2
  echo "  distintas: duplica el volumen hacia Gmail y ese daño no se deshace." >&2
  exit 1
fi

case "${ROOT_DIR}" in
  */Documents/*|*/Desktop/*|*/Downloads/*|*/Documents|*/Desktop|*/Downloads)
    echo "FATAL: el repo está en una carpeta protegida por macOS (${ROOT_DIR})." >&2
    echo "  Un LaunchDaemon NO puede leer Documents, Desktop ni Downloads: arranca y muere con" >&2
    echo "  'Operation not permitted' sin que los permisos del archivo digan nada." >&2
    echo "  Movelo fuera de ahí, por ejemplo:" >&2
    echo "     mv \"${ROOT_DIR}\" /Users/Shared/delivrix" >&2
    echo "  y volvé a correr este script desde la ruta nueva." >&2
    exit 1
    ;;
esac

NODE_BIN=""
for cand in /opt/homebrew/bin/node /usr/local/bin/node; do
  [[ -x "${cand}" ]] && NODE_BIN="${cand}" && break
done
if [[ -z "${NODE_BIN}" ]]; then
  echo "FATAL: no hay node en /opt/homebrew/bin ni /usr/local/bin." >&2
  echo "  launchd no tiene PATH ni shell de login: un node de nvm NO sirve acá." >&2
  echo "  Instalalo con:  brew install node" >&2
  exit 1
fi
echo "· node: ${NODE_BIN} ($(${NODE_BIN} --version))"

[[ -f "${ROOT_DIR}/config/gateway.env" ]] || { echo "FATAL: falta config/gateway.env (copialo desde la laptop, permisos 600)." >&2; exit 1; }
perm="$(stat -f %Lp "${ROOT_DIR}/config/gateway.env")"
[[ "${perm}" == "600" ]] || { echo "· ajustando permisos de gateway.env (${perm} → 600)"; chmod 600 "${ROOT_DIR}/config/gateway.env"; }

if grep -qE '^[[:space:]]*POSTGRES_CONTAINER=[^[:space:]]' "${ROOT_DIR}/config/gateway.env"; then
  echo "AVISO: POSTGRES_CONTAINER tiene valor. En producción NO hay Docker/OrbStack:" >&2
  echo "       dejalo vacío (POSTGRES_CONTAINER=) o los scripts de migración buscarán un contenedor." >&2
fi

PSQL_BIN="$(command -v psql || true)"
if [[ -z "${PSQL_BIN}" ]]; then
  echo "FATAL: no encuentro psql." >&2
  echo "  En producción Postgres va por Homebrew, NO contenedor (Docker/OrbStack necesitan sesión" >&2
  echo "  gráfica iniciada, justo la dependencia que este script elimina):" >&2
  echo "     brew install postgresql@17 pgvector && brew services start postgresql@17" >&2
  echo "  Ojo: pgvector solo tiene binarios para 17 y 18 — con el 16 la extensión no existe." >&2
  exit 1
fi
PG_URL="$(grep -m1 -E '^[[:space:]]*POSTGRES_URL=' "${ROOT_DIR}/config/gateway.env" | cut -d= -f2-)"
[[ -n "${PG_URL}" ]] || { echo "FATAL: config/gateway.env no define POSTGRES_URL." >&2; exit 1; }
echo "· psql: ${PSQL_BIN} ($("${PSQL_BIN}" --version))"
# NO se exige acá que Postgres esté ARRIBA: levantarlo es trabajo de este script (§2.5). Exigirlo
# antes creaba un círculo — si una corrida fallida dejaba a Postgres abajo, la siguiente se negaba
# a arrancar por la misma razón que venía a arreglar. Pasó en la instalación real.

if [[ ${SOLO_VERIFICAR} == 1 ]]; then
  echo; echo "solo verificación — no toco nada."; exit 0
fi

# ---------------------------------------------------------------- 1. energía
echo
echo "== energía: que nada la detenga =="
pmset -a sleep 0            # la Mac JAMÁS duerme (el modo de falla que hoy mata todo en la laptop)
pmset -a disksleep 0
pmset -a displaysleep 10    # la pantalla sí, no consume nada tenerla apagada
pmset -a autorestart 1      # se enciende sola cuando vuelve la luz
pmset -a womp 1             # se despierta por red (Wake on LAN)
systemsetup -setrestartfreeze on >/dev/null 2>&1 || echo "  (aviso: no pude fijar restart-on-freeze)"
echo "· sleep 0 · autorestart 1 · restart-on-freeze on"

# ---------------------------------------------------------------- 2. actualizaciones
echo
echo "== actualizaciones de macOS: manuales =="
softwareupdate --schedule off >/dev/null 2>&1 || true
for k in AutomaticCheckEnabled AutomaticDownload AutomaticallyInstallMacOSUpdates CriticalUpdateInstall; do
  defaults write /Library/Preferences/com.apple.SoftwareUpdate "${k}" -bool false 2>/dev/null || true
done
echo "· automáticas apagadas — se actualiza a mano, en ventana elegida"

if fdesetup status 2>/dev/null | grep -q "FileVault is On"; then
  echo
  echo "!! FileVault está ENCENDIDO."
  echo "   Tras cada reinicio la Mac espera una contraseña que nadie va a teclear, y NADA arranca."
  echo "   Apagalo a mano (Ajustes → Privacidad y seguridad → FileVault) o la promesa de 24/7 es falsa."
fi

# ---------------------------------------------------------------- carga de servicios
# `bootout` es ASÍNCRONO: devuelve enseguida pero el servicio tarda en morir de verdad (postgres
# tiene ExitTimeOut 120). Si el `bootstrap` llega antes de que el anterior termine de irse, falla
# con "Bootstrap failed: 5: Input/output error" — y como este script es idempotente por diseño,
# eso significa que la SEGUNDA corrida chocaba contra sí misma. Pasó en la instalación real.
cargar() {
  local etiqueta="com.delivrix.$1"
  local plist="/Library/LaunchDaemons/${etiqueta}.plist"
  launchctl bootout "system/${etiqueta}" >/dev/null 2>&1 || true
  local i
  for i in {1..40}; do
    launchctl print "system/${etiqueta}" >/dev/null 2>&1 || break
    sleep 1
  done
  if launchctl print "system/${etiqueta}" >/dev/null 2>&1; then
    echo "FATAL: ${etiqueta} sigue cargado tras 40s de bootout. Descargalo a mano:" >&2
    echo "  sudo launchctl bootout system/${etiqueta}" >&2
    exit 1
  fi
  if ! launchctl bootstrap system "${plist}" 2>/dev/null; then
    sleep 5
    launchctl bootstrap system "${plist}"   # si vuelve a fallar, que se vea el error real
  fi
  launchctl enable "system/${etiqueta}"
  echo "· ${etiqueta}: cargado"
}

# ---------------------------------------------------------------- 2.5 Postgres como DAEMON
# `brew services start` corrido como usuario deja un LaunchAgent en ~/Library/LaunchAgents: eso
# arranca DESPUÉS del login. Todo el punto de este kit es no depender de que alguien inicie
# sesión. Se pasa a LaunchDaemon de sistema, y se saca el agente para que no peleen por el 5432.
echo
echo "== postgres como servicio de sistema =="
PG_OPT="$(ls -d /opt/homebrew/opt/postgresql@* 2>/dev/null | sort -V | tail -1 || true)"
if [[ -z "${PG_OPT}" || ! -x "${PG_OPT}/bin/postgres" ]]; then
  echo "FATAL: no encuentro el postgres de Homebrew en /opt/homebrew/opt/postgresql@*" >&2
  exit 1
fi
PG_NAME="$(basename "${PG_OPT}")"
PG_DATA="/opt/homebrew/var/${PG_NAME}"
[[ -d "${PG_DATA}" ]] || { echo "FATAL: no existe el directorio de datos ${PG_DATA}" >&2; exit 1; }

AGENTE="/Users/${OPERADOR}/Library/LaunchAgents/homebrew.mxcl.${PG_NAME}.plist"
if [[ -f "${AGENTE}" ]]; then
  UID_OP="$(id -u "${OPERADOR}")"
  launchctl bootout "gui/${UID_OP}/homebrew.mxcl.${PG_NAME}" >/dev/null 2>&1 || true
  mv "${AGENTE}" "${AGENTE}.reemplazado-por-daemon"
  echo "· agente de usuario retirado (quedaría arrancando solo tras el login)"
  sleep 2
fi

cat > "/Library/LaunchDaemons/com.delivrix.postgres.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.delivrix.postgres</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PG_OPT}/bin/postgres</string>
    <string>-D</string>
    <string>${PG_DATA}</string>
  </array>
  <key>UserName</key><string>${OPERADOR}</string>
  <key>WorkingDirectory</key><string>/opt/homebrew</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>120</integer>
  <key>StandardOutPath</key><string>/opt/homebrew/var/log/${PG_NAME}.log</string>
  <key>StandardErrorPath</key><string>/opt/homebrew/var/log/${PG_NAME}.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>LC_ALL</key><string>en_US.UTF-8</string></dict>
</dict>
</plist>
PLIST
chown root:wheel /Library/LaunchDaemons/com.delivrix.postgres.plist
chmod 644 /Library/LaunchDaemons/com.delivrix.postgres.plist
cargar postgres
for _ in {1..30}; do
  sudo -u "${OPERADOR}" env PGCONNECT_TIMEOUT=3 "${PSQL_BIN}" "${PG_URL}" -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
if sudo -u "${OPERADOR}" env PGCONNECT_TIMEOUT=3 "${PSQL_BIN}" "${PG_URL}" -tAc 'select 1' >/dev/null 2>&1; then
  echo "· com.delivrix.postgres: arriba y aceptando conexiones (${PG_NAME})"
else
  echo "FATAL: el daemon de postgres no acepta conexiones tras 30s." >&2
  echo "  Log:  tail -30 /opt/homebrew/var/log/${PG_NAME}.log" >&2
  exit 1
fi
if ! sudo -u "${OPERADOR}" "${PSQL_BIN}" "${PG_URL}" -tAc "select 1 from pg_extension where extname='vector'" 2>/dev/null | grep -q 1; then
  echo "  AVISO: la extensión 'vector' NO está en esta base. La memoria semántica de OpenClaw la" >&2
  echo "         declara (embedding vector(1024)); sin ella esas consultas fallan." >&2
fi

# ---------------------------------------------------------------- 3. LaunchDaemons
echo
echo "== servicios =="
mkdir -p "${ROOT_DIR}/runtime/logs" "${ROOT_DIR}/runtime/watchdog"
chown -R "${OPERADOR}:${GRUPO}" "${ROOT_DIR}/runtime"
chmod +x "${ROOT_DIR}/scripts/produccion/"*.sh

# nombre|argumento de servicio.sh|manda correo
SERVICIOS="gateway|gateway|no
panel|panel|no
warmup-monitor|warmup-monitor|no
warmup-cupo|warmup-cupo|no
flota-salud|flota-salud|no
warmup-daemon|warmup-daemon|SI"

escribir_plist() {
  local etiqueta="$1"; shift
  local plist="/Library/LaunchDaemons/com.delivrix.${etiqueta}.plist"
  local args_xml=""
  for a in "$@"; do args_xml+="    <string>${a}</string>"$'\n'; done
  cat > "${plist}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.delivrix.${etiqueta}</string>
  <key>ProgramArguments</key>
  <array>
${args_xml}  </array>
  <key>UserName</key><string>${OPERADOR}</string>
  <key>WorkingDirectory</key><string>${ROOT_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${ROOT_DIR}/runtime/logs/${etiqueta}.log</string>
  <key>StandardErrorPath</key><string>${ROOT_DIR}/runtime/logs/${etiqueta}.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "${NODE_BIN}"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>/Users/${OPERADOR}</string>
    <key>DELIVRIX_NODE</key><string>${NODE_BIN}</string>
  </dict>
</dict>
</plist>
PLIST
  chown root:wheel "${plist}"; chmod 644 "${plist}"
}

while IFS='|' read -r nombre arg correo; do
  [[ -n "${nombre}" ]] || continue
  if [[ "${correo}" == "SI" && ${CON_WARMUP} == 0 ]]; then
    echo "· com.delivrix.${nombre}: OMITIDO (manda correo — activalo con --con-warmup)"
    continue
  fi
  escribir_plist "${nombre}" "/bin/bash" "${ROOT_DIR}/scripts/produccion/servicio.sh" "${arg}"
  cargar "${nombre}"
done <<< "${SERVICIOS}"

# watchdog: periódico, no KeepAlive (es un script que termina)
cat > /Library/LaunchDaemons/com.delivrix.watchdog.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.delivrix.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT_DIR}/scripts/produccion/watchdog.sh</string>
  </array>
  <key>UserName</key><string>root</string>
  <key>WorkingDirectory</key><string>${ROOT_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${ROOT_DIR}/runtime/logs/watchdog-launchd.log</string>
  <key>StandardErrorPath</key><string>${ROOT_DIR}/runtime/logs/watchdog-launchd.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict>
</plist>
PLIST
chown root:wheel /Library/LaunchDaemons/com.delivrix.watchdog.plist
chmod 644 /Library/LaunchDaemons/com.delivrix.watchdog.plist
cargar watchdog

# respaldo nocturno 03:30
cat > /Library/LaunchDaemons/com.delivrix.respaldo.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.delivrix.respaldo</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT_DIR}/scripts/produccion/respaldo-nocturno.sh</string>
  </array>
  <key>UserName</key><string>${OPERADOR}</string>
  <key>WorkingDirectory</key><string>${ROOT_DIR}</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>${ROOT_DIR}/runtime/logs/respaldo.log</string>
  <key>StandardErrorPath</key><string>${ROOT_DIR}/runtime/logs/respaldo.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>/Users/${OPERADOR}</string>
  </dict>
</dict>
</plist>
PLIST
chown root:wheel /Library/LaunchDaemons/com.delivrix.respaldo.plist
chmod 644 /Library/LaunchDaemons/com.delivrix.respaldo.plist
cargar respaldo

# ---------------------------------------------------------------- 4. verificación
echo
echo "== verificación (hasta 60s) =="
ok_gw=0
for _ in {1..30}; do
  if curl -fsS --max-time 4 http://127.0.0.1:3000/health 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then ok_gw=1; break; fi
  sleep 2
done
[[ ${ok_gw} == 1 ]] && echo "· gateway :3000 → ok" || echo "· gateway :3000 → NO RESPONDE (mirá runtime/logs/gateway.log)"

ok_panel=0
for _ in {1..30}; do
  if curl -fsS --max-time 4 -o /dev/null http://127.0.0.1:5173/ 2>/dev/null; then ok_panel=1; break; fi
  sleep 2
done
[[ ${ok_panel} == 1 ]] && echo "· panel :5173 → ok" || echo "· panel :5173 → NO RESPONDE (mirá runtime/logs/panel.log)"

echo
echo "servicios cargados:"
launchctl list | grep delivrix || echo "  (ninguno — algo falló)"

echo
echo "LO QUE FALTA, Y NO LO HACE NINGÚN SCRIPT:"
echo "  1. Reiniciar esta Mac y comprobar que TODO vuelve solo. Sin esa prueba, 24/7 es una promesa,"
echo "     no un hecho medido."
[[ ${CON_WARMUP} == 0 ]] && echo "  2. Apagar el stack de la laptop ANTES de instalar con --con-warmup (dos daemons = doble correo)."
