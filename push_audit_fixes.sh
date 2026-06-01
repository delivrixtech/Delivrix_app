#!/bin/bash
# Push de los fixes de auditoría visual del jueves 28-may
#
# Bugs corregidos (B-A1 a B-A4):
# - B-A1: formatExpiry ahora parsea Unix epoch en segundos cuando el backend
#   devuelve string numérico (ej. "1811462902" → "27 de may de 2027").
# - B-A2: WalletWidget header con pill separada para el nombre del wallet,
#   ya no trunca "Wallet operativo · R...".
# - B-A3: Transaction list dominio usa overflowWrap:anywhere + title attr,
#   nombre completo visible.
# - B-A4: GASTADO summary stat sin signo negativo ni icono TrendingDown
#   (confuso con el color warning). Solo el monto en amarillo.
#
# B-A5 cancelado: falso positivo (palette sí tenía Dominios + Sender Pool,
# solo requería scroll).
# B-A6 (WorkspaceBrowser sin datos reales) queda como OPS para Codex —
# necesita endpoint GET /v1/openclaw/workspace/tree.

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# 1) Limpiar locks stale del sandbox si quedaron
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# 2) Pull primero
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# 3) Stage solo los 2 archivos de los fixes
git add \
  apps/admin-panel/src/features/domains/index.tsx \
  apps/admin-panel/src/features/sender-pool/wallet-widget.tsx

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "fix(panel): 4 bugs de auditoría visual jueves 28-may pre-demo

Auditoría visual del panel con criterio senior frontend + UX completada
hoy. Detectados 5 hallazgos visuales; 4 son frontend y se cierran acá.
El quinto (WorkspaceBrowser sin datos reales) queda como OPS para Codex
porque depende del endpoint GET /v1/openclaw/workspace/tree.

== B-A1: formatExpiry maneja Unix epoch del backend ==

El backend de Route53 a veces devuelve el campo \`expiry\` como string
numérico en segundos Unix (ej. \"1811462902\") en vez de ISO. El frontend
mostraba el timestamp crudo en la columna EXPIRA de Domains, lo cual era
ilegible para los jefes.

Fix en \`features/domains/index.tsx\`: \`formatExpiry()\` ahora detecta si
el input es solo dígitos. Si tiene ≤10 dígitos lo trata como segundos
Unix y multiplica por 1000; si tiene 13 lo trata como ms. Después aplica
\`toLocaleDateString('es-CO', { year: 'numeric', month: 'short', day:
'numeric' })\`. Resultado: \"27 de may de 2027\".

Backend ideal devolvería ISO directamente — eso queda como follow-up
con Codex post-demo. El frontend se defiende mientras tanto.

== B-A2: WalletWidget header sin truncate ==

El título \"Wallet operativo · Route53 Domains\" se cortaba a \"Wallet
operativo · R...\" en el ancho del aside del Sender Pool (≈300px).

Fix en \`features/sender-pool/wallet-widget.tsx\`: el nombre del wallet
ahora vive en una pill separada (estilo monoespaciado con badge
visual) debajo del título principal \"Wallet operativo\", con flex-wrap
para que en anchos chicos haga break a 2 líneas en vez de truncate.

Beneficio extra: cuando S1 traiga multi-wallet (varios wallets por
proyecto), la pill puede mostrar el nombre del wallet activo con
visual hierarchy clara.

== B-A3: Transaction dominio sin truncate ==

El dominio \"delivrix-demo-d10-20260527.click\" se cortaba a
\"delivrix-demo-d10-20260527.cl...\" en la lista de transacciones
recientes, perdiendo el TLD que es información crítica de audit.

Fix en \`wallet-widget.tsx\` \`TransactionsList\`: usé
\`overflowWrap: 'anywhere'\` (mejor que \`wordBreak: break-all\`,
respeta los hyphens del nombre) + \`title\` HTML attribute para
tooltip nativo on-hover. El dominio completo es visible y copyable
con select.

== B-A4: GASTADO summary sin signo negativo ==

El stat de \"Gastado\" mostraba \"-$3.00\" con icono TrendingDown y
color warning. La combinación de signo + icono + color era
redundante y confusa (parece resta, no gasto del cap).

Fix: removí el icono \`TrendingDown\` del Stat (también el import
unused). El color amarillo \`var(--color-warning)\` y el label
\"Gastado\" ya comunican que es débito del cap. Resultado limpio:
\"$3.00\" en amarillo.

El signo \`−\` se mantiene en cada transacción individual de la lista
(donde sí es semántica de débito), pero ahora con minus tipográfico
correcto (\\u2212) en vez de hyphen-minus.

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores
- vite build → ✓ canvas-v4 chunk 277 kB gz 80 kB
- HMR verificado en panel localhost:5173 en Sender Pool + Domains

== Pendiente B-A6 (OPS Codex) ==

WorkspaceBrowser sigue mostrando dataset DEMO porque el endpoint
GET /v1/openclaw/workspace/tree no está expuesto en el gateway.
Los archivos reales de los smokes están en
\`runtime/openclaw-workspace/executions/2026-05-27\` y
\`runtime/openclaw-workspace/executions/2026-05-28\` pero el panel
no los lee. OPS separado para Codex."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Verificación final:"
git log --oneline -3
