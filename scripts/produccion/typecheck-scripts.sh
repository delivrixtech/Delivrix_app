#!/usr/bin/env bash
# CAZA REFERENCIAS ROTAS EN scripts/ops — el chequeo que faltaba.
#
# Por qué existe, con nombre y apellido: el 2026-08-06 se cableó `medirUnDominio(pg)` en el carril
# de chat de warmup-monitor.ts con un `pg` que NO estaba en ese alcance. Nadie lo vio porque el
# comando de verificación que se venía corriendo era `tsc -p tsconfig.json`… y en la raíz no hay
# ningún tsconfig.json. tsc respondía "TS5058: the specified path does not exist" y el grep que
# filtraba la salida dejaba eso afuera: verde perfecto sin haber mirado un solo archivo.
#
# El efecto en producción fue mudo y caro. Apenas el modelo decidía ejecutar UNA acción, armar el
# objeto de contexto tiraba ReferenceError, la excepción subía hasta el catch del tick, y la
# respuesta YA GENERADA nunca se publicaba. El cursor de Slack, en cambio, sí había avanzado: el
# mensaje del jefe se perdía para siempre. Él preguntaba, el agente pensaba 40 segundos, y del otro
# lado no aparecía nada.
#
# QUÉ CHEQUEA Y QUÉ NO. Solo falla por errores DENTRO de scripts/. La compilación arrastra medio
# gateway-api por los imports y ahí hay deuda de tipos conocida y anterior a esto; hacer fallar el
# gate por eso lo volvería ruido que todos aprenden a saltear. Lo que se caza acá es lo que ese
# incidente demostró que se escapa: identificadores sin definir y firmas que no cierran.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

salida="$(npx tsc --noEmit -p tsconfig.scripts.json 2>&1 || true)"

# TS7006/TS7016 son "implicit any": estos scripts nunca tuvieron tipado estricto y exigirlo ahora
# sería otro trabajo, no este. Se ignoran a propósito y se dice, para que nadie crea que hay
# cobertura que no hay.
propios="$(printf '%s\n' "${salida}" | grep -E '^scripts/' | grep -vE 'TS7006|TS7016' || true)"

if [[ -n "${propios}" ]]; then
  echo "TYPECHECK DE scripts/ EN ROJO:" >&2
  printf '%s\n' "${propios}" >&2
  exit 1
fi

echo "typecheck scripts/: ok"
