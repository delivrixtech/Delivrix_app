#!/usr/bin/env bash
# Trae producción (la Mac Studio) a este navegador, por SSH.
#
# El panel y el gateway de la Studio escuchan SOLO en 127.0.0.1: no están expuestos ni siquiera
# al tailnet. Este túnel los trae a los mismos puertos de esta máquina, cifrados por SSH sobre
# Tailscale. Nada se abre a internet.
#
#   ./scripts/produccion/tunel.sh          abre el túnel y el panel en el navegador
#   ./scripts/produccion/tunel.sh cerrar   lo baja
set -uo pipefail

STUDIO="${STUDIO:-studio}"
PANEL_PORT="${PANEL_PORT:-5173}"
GW_PORT="${GW_PORT:-3000}"

vivo() { pgrep -f "ssh -f -N -L ${PANEL_PORT}:127.0.0.1:${PANEL_PORT}" >/dev/null 2>&1; }

if [[ "${1:-}" == "cerrar" ]]; then
  pkill -f "ssh -f -N -L ${PANEL_PORT}:127.0.0.1:${PANEL_PORT}" 2>/dev/null \
    && echo "túnel cerrado" || echo "no había túnel abierto"
  exit 0
fi

if vivo; then
  echo "· el túnel ya estaba abierto"
else
  # Puerto ocupado por OTRA cosa (típico: el stack local de desarrollo todavía corriendo). Si se
  # ignora, el túnel falla y uno termina mirando el panel de la laptop creyendo que ve producción
  # — la confusión más cara posible.
  for p in "${PANEL_PORT}" "${GW_PORT}"; do
    if lsof -tiTCP:"${p}" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "FATAL: el puerto ${p} ya está ocupado en ESTA máquina." >&2
      echo "  Si es tu stack local, apagalo primero: ./scripts/delivrix-gateway-stop.sh" >&2
      echo "  Si no, mirá quién es:  lsof -nP -iTCP:${p} -sTCP:LISTEN" >&2
      exit 1
    fi
  done
  ssh -f -N -L "${PANEL_PORT}:127.0.0.1:${PANEL_PORT}" -L "${GW_PORT}:127.0.0.1:${GW_PORT}" "${STUDIO}" || {
    echo "FATAL: no pude abrir el túnel a ${STUDIO}." >&2; exit 1; }
  sleep 2
  echo "· túnel abierto contra ${STUDIO}"
fi

salud="$(curl -fsS --max-time 8 "http://127.0.0.1:${GW_PORT}/health" 2>/dev/null || true)"
if printf '%s' "${salud}" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  echo "· gateway de producción: ok"
else
  echo "AVISO: el gateway de producción no contesta ok. ¿Está viva la Studio?" >&2
fi

# `delivrixapp.localhost` resuelve a 127.0.0.1 SOLO (todo el TLD .localhost lo hace, por RFC
# 6761), sin tocar /etc/hosts ni pedir sudo. Un nombre en vez de un número deja claro QUÉ estás
# mirando: es producción, no el stack local.
URL="http://delivrixapp.localhost:${PANEL_PORT}/"
echo "· panel de PRODUCCIÓN: ${URL}"
echo "· gateway (health):    http://delivrixapp.localhost:${GW_PORT}/health"
command -v open >/dev/null && open "${URL}"
