#!/usr/bin/env bash
# Delivrix env doctor: corre el pre-flight de entorno del gateway en frio y reporta
# TODAS las variables criticas faltantes/placeholder de una sola vez.
#
# Uso:
#   bash scripts/delivrix-env-doctor.sh
#
# Exit code: 0 si no hay faltantes fatales; 1 si falta algo del nucleo de auth.
# No imprime valores de secretos, solo nombres.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# Precedencia: config/gateway.env (blindado, fuera del alcance de Vercel) -> .env.local
ENV_FILE=".env.local"
if [[ -f "config/gateway.env" ]]; then
  ENV_FILE="config/gateway.env"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[env-doctor] No encontre ${ENV_FILE} en ${ROOT_DIR}." >&2
  echo "[env-doctor] Definí el env del gateway antes de correr el doctor." >&2
  exit 1
fi

echo "[env-doctor] Evaluando ${ENV_FILE} contra el catalogo de variables criticas..."
echo ""

node --env-file="${ENV_FILE}" --input-type=module -e '
import { checkEnvPreflight } from "./apps/gateway-api/src/env-preflight.ts";
const result = checkEnvPreflight(process.env);
console.log(result.report);
process.exit(result.ok ? 0 : 1);
'
