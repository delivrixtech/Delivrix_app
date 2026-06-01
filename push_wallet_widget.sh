#!/bin/bash
# Push del WalletWidget MVP a main (sigue al commit Codex 70e261e).
#
# - apps/admin-panel/src/features/sender-pool/wallet-widget.tsx (nuevo)
# - apps/admin-panel/src/features/sender-pool/index.tsx (integración del widget en el aside)
#
# Spec arquitectural: DOCUMENTACION/ARQUITECTURA_MEMORIA_AGENTE_DELIVRIX_2026_05_27.md (§ wallet).
# Decisión CTO bitácora: D8 (wallet feature core, backend + frontend).
# Implementación inteligente del wallet entra en sprint S1 — esto es solo el MVP visual.

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# 1) Limpiar locks stale del sandbox si quedaron
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# 2) Pull primero para asegurar tener el commit 70e261e de Codex
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# 3) Stage SOLO los 2 archivos del widget
git add \
  apps/admin-panel/src/features/sender-pool/wallet-widget.tsx \
  apps/admin-panel/src/features/sender-pool/index.tsx

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "feat(panel): WalletWidget MVP en Sender Pool — gobernanza visual del wallet operativo

Decisión CTO bitácora D8 (2026-05-27): wallet operativo como feature core de
Delivrix (backend + frontend). El cap mensual actual es la versión primitiva.
Este commit entrega el frontend mínimo viable: lectura del audit-events filtrado
por mes actual + acción \`oc.domain.registered\`, suma de \`costUsd\` de metadata,
y comparación contra cap \`AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD\` (hoy hardcoded
en el frontend, en S1 sale via endpoint dedicado).

Spec arquitectural canónico:
\`DOCUMENTACION/ARQUITECTURA_MEMORIA_AGENTE_DELIVRIX_2026_05_27.md\` §wallet.

== Composición del widget ==

- 3 stats: Cap mensual / Gastado / Disponible (formato USD con 2 decimales).
- Barra de progreso con 3 zonas (safe verde / warning amarillo / critical rojo)
  según porcentaje gastado. Thresholds 80% warning, 95% critical.
- ZoneBadge en header con icono + label (Saludable / Atención / Crítico).
- Lista de últimas 5 transacciones del mes con: dominio, fecha+hora, actorId que
  firmó, costo USD. Empty state honesto cuando no hay compras este mes.
- Caption explícito al pie: \"Wallet primitivo · S1 trae control granular,
  optimización del agente, alertas threshold y multi-wallet\".

== Integración ==

WalletWidget se inserta como primer card del aside del Sender Pool (sobre
OnboardNewDomainCard y FlowExplainerCard), donde el operador ve gobernanza de
gasto antes de disparar acciones costosas. Cero cambio de backend.

== Capacidades nuevas habilitadas ==

- Lecto del audit-events vía GET /v1/audit-events (ya en read-boundary).
- Polling 30s + staleTime 15s para mantener fresco sin saturar.
- Tracking de acciones \`oc.domain.registered\` y \`register_domain_route53.success\`.
- Manejo robusto: si endpoint falla retorna array vacío sin romper UI.

== Trade-offs honestos ==

1. CAP_USD = 50 hardcoded en el frontend. S1 traerá endpoint dedicado.
2. Sin multi-wallet todavía. S1 trae \`agent_wallets\` con \`owner_actor_id\`.
3. Sin alertas threshold automáticas (worker S1).
4. Sin optimización LLM del agente (S1 con memoria semántica pgvector + mem0).

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores.
- vite build → ✓ canvas-v4 chunk 277 kB gz 80 kB.
- WalletWidget renderiza correctamente con cap \$50 / gastado \$0 / disponible \$50
  cuando audit-events no tiene compras de dominios este mes.

Sigue al commit Codex 70e261e (Bloque 10 backend con flow E2E real T1-T6 + B3-B9
fixes, 349 tests passing)."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Verificación final:"
git log --oneline -3
