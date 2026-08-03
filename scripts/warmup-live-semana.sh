#!/usr/bin/env bash
# Corrida CONTINUA del warmup live. Autorizada por el operador el 2026-08-03 ("que corra desde hoy
# lunes hasta el próximo lunes"). Barreras activas: tope diario, intervalo, kill-file.
#
#   bash scripts/warmup-live-semana.sh            # arranca en segundo plano
#   touch runtime/warmup-live.kill                # PAUSA (el daemon lo respeta en cada vuelta)
#   rm runtime/warmup-live.kill                   # reanuda
#   tail -f runtime/logs/warmup-live.log          # ver qué está haciendo
set -euo pipefail
cd "$(dirname "$0")/.."

BOXES="${WARMUP_LIVE_BOXES:-corpfiling-infra.com}"   # un dominio SANO; los bloqueados no se calientan
export WARMUP_LIVE_ENABLE=true
export WARMUP_LIVE_BOXES="$BOXES"
export WARMUP_LIVE_MAX_PER_DAY="${WARMUP_LIVE_MAX_PER_DAY:-3}"
export WARMUP_LIVE_INTERVAL_MS="${WARMUP_LIVE_INTERVAL_MS:-14400000}"   # 4h

if pgrep -f "live-warmup-daemon.ts" >/dev/null 2>&1; then
  echo "ya hay un daemon corriendo (pgrep live-warmup-daemon.ts). No arranco otro."
  exit 0
fi

nohup node --env-file=config/gateway.env --experimental-strip-types \
  apps/warmup-engine/src/service/live-warmup-daemon.ts \
  >> runtime/logs/warmup-live.log 2>&1 &

echo "daemon arrancado (pid $!) · boxes=$BOXES · tope=${WARMUP_LIVE_MAX_PER_DAY}/día · log runtime/logs/warmup-live.log"
