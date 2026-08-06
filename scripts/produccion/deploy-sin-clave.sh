#!/usr/bin/env bash
#
# LA ÚLTIMA DEPENDENCIA HUMANA DEL CICLO.
#
# Todo lo demás de Delivrix corre solo: launchd levanta los servicios al arrancar la Mac Studio, el
# watchdog los repone si se caen, el respaldo corre de noche, y el agente vigila y actúa cada 10
# minutos. Pero desplegar código nuevo pide una contraseña, porque reiniciar un LaunchDaemon exige
# root — así que cada mejora se queda esperando a que alguien esté despierto y conectado.
#
# Esto instala UNA regla en sudoers que permite exactamente eso y NADA más:
#
#   delivrixstudio ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/com.delivrix.*
#
# QUÉ HABILITA DE VERDAD, dicho sin adornos: cualquiera que tenga la llave SSH de esta máquina
# puede reiniciar los servicios de Delivrix sin contraseña. Eso es una molestia (el warmup pierde
# unos segundos y vuelve), no un root arbitrario: no puede instalar, ni leer archivos de otros
# usuarios, ni tocar ningún otro servicio del sistema. El comando está anclado con ruta absoluta y
# el comodín solo alcanza a `com.delivrix.*`.
#
# Se revierte borrando el archivo:  sudo rm /etc/sudoers.d/delivrix-deploy
#
# Uso (UNA sola vez, desde la Mac del operador):   ./scripts/produccion/deploy-sin-clave.sh
set -euo pipefail

SSH_DEST="${DELIVRIX_SSH_DEST:-studio}"
ARCHIVO="/etc/sudoers.d/delivrix-deploy"

# La regla se arma acá y se manda por stdin: escribir sudoers con un echo remoto es la receta para
# dejar el archivo a medias si se corta la red, y un sudoers roto deja la máquina sin sudo.
REGLA='# Delivrix: deploys desatendidos. Solo reiniciar servicios propios de Delivrix, nada más.
# Instalado por scripts/produccion/deploy-sin-clave.sh — borrar este archivo lo revierte.
delivrixstudio ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/com.delivrix.*
'

echo "== regla de deploy desatendido en ${SSH_DEST} =="
echo
echo "Se va a instalar ESTO y nada más:"
echo
sed 's/^/    /' <<<"${REGLA}"
echo "Habilita: reiniciar los servicios com.delivrix.* sin contraseña."
echo "NO habilita: instalar, leer archivos ajenos, ni tocar ningún otro servicio."
echo

# visudo -cf valida ANTES de mover el archivo a su lugar. Sin esta validación, un error de sintaxis
# en sudoers.d deja la máquina entera sin poder usar sudo — incluso para arreglarlo.
ssh -t "${SSH_DEST}" "
  set -e
  tmp=\$(mktemp)
  cat > \"\$tmp\" <<'DELIVRIX_EOF'
${REGLA}
DELIVRIX_EOF
  sudo visudo -cf \"\$tmp\" || { echo 'La regla NO es válida: no se instaló nada.' >&2; rm -f \"\$tmp\"; exit 1; }
  sudo install -m 0440 -o root -g wheel \"\$tmp\" '${ARCHIVO}'
  rm -f \"\$tmp\"
  echo '· instalada en ${ARCHIVO}'
"

echo
echo "· verificando que funcione SIN contraseña…"
# `-n` = nunca pedir contraseña. Si la regla no quedó bien, esto falla en vez de colgarse esperando
# una clave que nadie va a teclear — que es justo el modo de falla que arruinaría un deploy nocturno.
if ssh "${SSH_DEST}" "sudo -n launchctl kickstart -k system/com.delivrix.gateway" 2>/dev/null; then
  echo "· LISTO: el gateway se reinició sin pedir clave."
  echo
  echo "Desde ahora ./scripts/produccion/desplegar.sh corre entero solo."
  echo "Para revertir:  ssh ${SSH_DEST} 'sudo rm ${ARCHIVO}'"
else
  echo "· NO funcionó: sudo sigue pidiendo clave." >&2
  echo "  Revisá que el usuario remoto sea 'delivrixstudio' (ssh ${SSH_DEST} id -un)." >&2
  exit 1
fi
