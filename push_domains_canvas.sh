#!/bin/bash
# Push de los cambios FE pendientes:
#   1. Fix Canvas Live viewport (filtro smoke_valid + severity heuristic)
#   2. Feature Domains v1 (search + suggestions + prices + propose vía OpenClaw)
#
# Correr desde la Mac (no sandbox).

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# 1. Limpiar locks stale del sandbox
rm -f .git/index.lock .git/HEAD.lock .git/objects/9e/tmp_obj_* 2>/dev/null || true

# 2. Verificar estado
echo "→ Estado actual:"
git status --short

# 3. Stage cambios
git add \
  apps/admin-panel/src/features/canvas/canvas-v4.tsx \
  apps/admin-panel/src/features/domains/index.tsx \
  apps/admin-panel/src/app/App.tsx \
  apps/admin-panel/src/app/sections.ts \
  apps/admin-panel/src/shared/api/client.ts

echo ""
echo "→ Diff stat:"
git diff --cached --stat

# 4. Commit
git commit -m "feat(panel): feature Domains v1 + fix Canvas Live viewport

== Feature Domains (Hito 5.12 · Route53 Fase 1) ==

Nueva pantalla apps/admin-panel/src/features/domains/index.tsx con:
- SearchHero: input grande con debounce 350ms → resultado inline
  (status + price si el TLD está en el snapshot).
- SuggestionsSection: 10 candidatas cuando hay seed válido (3+ alfanum).
- PricesPanel: snapshot top 4 TLDs (.com .net .io .co), cache 5min.
- OwnedDomainsTable: tabla con empty state Fase 1 explicativo.
- ProposalQueueSection: placeholder Fase 2 con flujo de 5 pasos
  (propuesta OpenClaw → review op1 → review op2 → execute → audit).
- AskOpenClawCard: 3 intent prompts (sugerencias para Delivrix,
  comparar 3 candidatos, investigar dominio actual) → chat real.
- PhaseStatusCard: status pills por capability (4 live · 2 locked).
- ProposePurchaseButton: cuando un dominio está disponible, dispara
  intent con prompt detallado para que OpenClaw prepare la propuesta.
  Compra real NO se ejecuta — Fase 2 con doble aprobación.

Diseño:
- 2-column grid en lg+: main (search → suggestions → owned → proposals),
  rail (prices → ask openclaw → phase status).
- Mobile: stack vertical en orden de prioridad.
- Tokens.css only, sin hex hardcoded. Sigue el patrón v2 building blocks.

Cableado:
- sections.ts: nueva SectionId 'domains' con icon Globe, grupo 'operacion'.
- App.tsx: lazy import + case en SectionView + toneForSection neutral.
- client.ts: nueva helper getJsonWithQuery(base, params) que valida la base
  contra el read boundary y serializa querystrings con URLSearchParams.

Endpoints consumidos (Codex 5104fd9):
- GET /v1/domains/availability?name=...
- GET /v1/domains/suggestions?seed=...&count=10
- GET /v1/domains/prices?tlds=com,net,io,co
- GET /v1/domains/owned

== Fix Canvas Live viewport ==

Problema: 25 cards 'alarmadas' con oc.audit.smoke_valid del histórico
(Hito 5.11.B smoke tests) aparecían como warning.

Fix useAgentActions():
- AGENT_RECENT_WINDOW_MS = 10min → filtra histórico por timestamp.
- TEST_PATTERN regex → excluye audit_smoke|smoke_valid|healthcheck|self_test|warmup_check.
- Combinado con filtro actor openclaw/* existente.

Fix auditToAction():
- looksLikeOkEvent (.valid|.ok|.completed|.received|...) → severity=info.
- looksLikeCritical (kill_switch|hallucination|breach|...) → severity=critical.
- Resto default a info (no alarmar sin razón).

Fix DetectCard():
- Icon dinámico: critical→ShieldAlert, warning→TriangleAlert, info→CheckCircle2.

Fix LiveEmptyOrError: rediseño con Sparkles + 'OpenClaw idle · esperando próxima acción'.

Refs: #100 Canvas viewport, #98 AWS Route53 Fase 1."

# 5. Push
git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
