#!/usr/bin/env bash
# Enciende el EMISOR de warmup en producción. Se corre UNA vez, desde la laptop.
#
# Existe por una razón muy concreta: el comando equivalente a mano es largo, y al pegarlo el
# cliente lo corta en dos líneas — `sudo` se queda sin comando y tira su ayuda de uso. Pasó tres
# veces. Un script corto no se puede partir.
#
# Antes de encenderlo verifica lo único que no se puede deshacer: que la laptop NO tenga su propio
# daemon vivo. Dos emisores contra bases distintas duplican el volumen hacia Gmail, y cruzar ese
# umbral es permanente.
set -euo pipefail

STUDIO_SSH="${STUDIO_SSH:-studio}"
STUDIO_DIR="${STUDIO_DIR:-/Users/Shared/delivrix}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ -f "${ROOT_DIR}/runtime/ESTA-MAQUINA-ES-PRODUCCION" ]]; then
  echo "FATAL: esto se corre desde la LAPTOP, no dentro de producción ($(hostname -s))." >&2
  echo "  Salí de la sesión SSH (exit) y corrélo en el repo de tu laptop." >&2
  exit 1
fi

if pgrep -f "live-warmup-daemon" >/dev/null 2>&1; then
  echo "FATAL: esta laptop TODAVÍA tiene el daemon de warmup corriendo." >&2
  echo "  Apagalo primero:  ./scripts/warmup-servicios.sh stop" >&2
  echo "  Dos emisores duplican el volumen hacia Gmail y ese daño no se deshace." >&2
  exit 1
fi

echo "== encendiendo el emisor de warmup en ${STUDIO_SSH} =="
echo "   (te va a pedir la contraseña de la Studio)"
ssh -t "${STUDIO_SSH}" "cd '${STUDIO_DIR}' && sudo ./scripts/produccion/instalar-produccion.sh --con-warmup"

echo
echo "== verificando que el emisor esté vivo =="
for _ in {1..15}; do
  linea="$(ssh -o BatchMode=yes "${STUDIO_SSH}" "tail -3 '${STUDIO_DIR}/runtime/logs/warmup-daemon.log' 2>/dev/null" || true)"
  if printf '%s' "${linea}" | grep -q "ARRANCA"; then
    echo "${linea}" | sed 's/^/    /'
    echo "· el daemon arrancó y tomó el lock de instancia"
    exit 0
  fi
  sleep 4
done
echo "AVISO: no vi el 'ARRANCA' del daemon en ~60s. Mirá:" >&2
echo "  ssh ${STUDIO_SSH} 'tail -20 ${STUDIO_DIR}/runtime/logs/warmup-daemon.log'" >&2
exit 1
