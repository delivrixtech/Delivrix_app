#!/bin/bash
# Push CONSOLIDADO FINAL del jueves 28-may pre-demo viernes
#
# Mergea los 3 commits frontend que tenía pendientes en un solo push:
#
# 1. push_frontend_audit_complete.sh — 12 fixes auditoría +
#    adaptaciones a contratos backend Codex 6500a15.
# 2. push_impeccable_polish.sh — 7 anti-patterns side-tab
#    eliminados (Impeccable detector).
# 3. Chips postgres/redis en topbar (Codex 50876e5 /health).
#
# Todo en un solo commit limpio. Mañana viernes 11h hacemos el demo
# con el panel cerrado de extremo a extremo.

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# Limpiar locks stale
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# Pull primero (Codex puede haber pusheado el OPS Bloqueantes)
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# Stage TODOS los archivos frontend + docs jueves
git add \
  apps/admin-panel/src/app/App.tsx \
  apps/admin-panel/src/shared/api/client.ts \
  apps/admin-panel/src/shared/ui/card.tsx \
  apps/admin-panel/src/shared/ui/v2/KillSwitchV2.tsx \
  apps/admin-panel/src/shared/ui/v2/BannerOpenClawV2.tsx \
  apps/admin-panel/src/shared/ui/v2/Toast.tsx \
  apps/admin-panel/src/shared/ui/realtime/FallbackBanner.tsx \
  apps/admin-panel/src/features/canvas/index.tsx \
  apps/admin-panel/src/features/canvas/canvas-v4.tsx \
  apps/admin-panel/src/features/canvas/canvas-live-client.ts \
  apps/admin-panel/src/features/canvas/live-tool.tsx \
  apps/admin-panel/src/features/hardware/index.tsx \
  apps/admin-panel/src/features/overview/index.tsx \
  apps/admin-panel/src/features/onboarding/index.tsx \
  apps/admin-panel/src/features/infrastructure/index.tsx \
  apps/admin-panel/src/features/clusters/index.tsx \
  apps/admin-panel/src/features/collector/index.tsx \
  apps/admin-panel/src/features/safety/index.tsx \
  DOCUMENTACION/AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_AUDITORIA_FRONTEND_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_BD_ORBSTACK_2026_05_28.md \
  DOCUMENTACION/OPS_CODEX_BLOQUEANTES_DEMO_VIERNES_2026_05_28.md \
  DOCUMENTACION/PRACTICE_RUN_REPORT_2026_05_28.md \
  DOCUMENTACION/REPORTE_READINESS_DEMO_VIERNES_2026_05_28.md

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "feat(panel): cierre frontend jueves — auditoría + Impeccable + DB chips

Commit consolidado del trabajo Claude del jueves 28-may, integrado con
los 2 commits que pusheó Codex hoy (6500a15 contratos ES + 50876e5
OrbStack BD).

== Contexto ==

Pedido Juanes: 'esto debe funcionar, debe funcionar... sin excusas'.
Demo viernes 11h Colombia (Final.0). El jefe quiere ver el flujo
entero en tiempo real: compra dominio + DNS + DKIM + servidor +
Webdock + bind + warmup.

Auditoría completa de las 11 vistas con Chrome MCP, 33 hallazgos.
Aplicación de Impeccable detector (pbakaus), 11 anti-patterns
encontrados, 7 cerrados (side-tabs). Integración con /health real
de OrbStack postgres + pgvector + redis.

== Bloque 1: Auditoría frontend (33 hallazgos, 12 cerrados) ==

4 CRÍTICOS:
- A-CRIT-04 hardware/index.tsx — guard de gráficas si series=[]
  (antes mostraba 38/66/48 falsos contradiciendo 'sin series').
- A-CRIT-02 canvas-v4.tsx — chips Live + Idle unificados
  (ThinkingChip return null si idle).
- A-CRIT-03 canvas-v4.tsx — errors SSH a lenguaje operativo
  + collapsible de stderr (ChatErrorBanner + translateGatewayError).
- A-CRIT-01-B canvas-live-client.ts + canvas-v4.tsx — filtro frontend
  de tareas fallidas conversacionales (taskIdsWithOutput + heurística
  failed root sin output + toggle 'Mostrar N ocultas').

4 ALTOS:
- A-ALT-01 overview/index.tsx — 6 aprobaciones visibles + 'Ver N más'.
- A-ALT-03 infrastructure/index.tsx — cards min-width 320.
- A-ALT-05 clusters/index.tsx — tooltips columnas ACT/CAL/PAU/DEG/
  CUA/REP + leyenda compacta.
- A-ALT-06 onboarding/index.tsx — tag '0 interfaces' en warning.

4 MEDIOS:
- A-MED-01 canvas-v4.tsx — tab 'Files (N)' → 'Lecturas (N)'.
- A-MED-04 live-tool.tsx — tooltip badges xN.
- A-MED-06 onboarding/index.tsx — 'bloqueos' → 'ítems pendientes'.
- A-MED-12 infrastructure/index.tsx — timestamps relativos.

== Bloque 2: Adaptaciones a contratos Codex 6500a15 ==

shared/api/client.ts agrega types:
+ OperatingNorthGateDetail / OperatingNorthRoleDisplayNames
+ OperatingNorthPayload.gateDetails?, environment?, releasePhase?,
  roleDisplayNames?
+ IamRole.displayName?
+ Provider.statusLabel?
+ OpenClawOnboardingSectionState / OpenClawOnboardingStatePayload
  .environment?, .releasePhase?, .sections?

Features que consumen:
- overview GatesCard → 22 gates en ES via gateDetails[].
- infrastructure ProviderCard → statusLabel ES (ej. 'Aún offline').
- safety RolesCard → displayName ES ('Operador supervisado (sólo
  lectura)').
- collector SourcesRow → blockedReasonOperator + expectedInMvp +
  url null (sin example.invalid).
- onboarding Form → environment 'mvp.local' + sections con
  detectedFieldCount para tag warning correcto.

== Bloque 3: Impeccable polish (7 side-tabs eliminados) ==

Corrí pbakaus/impeccable detector --fast contra apps/admin-panel/src.
11 anti-patterns. Cerrados los 7 'side-tab' (border-left/right > 1px
coloreado), clasificados como 'the most recognizable tell of
AI-generated UIs' y uno de los 3 prohibidos absolutos de Impeccable
(reference/colorize.md).

Fix recomendado: hairline 1px en perímetro + surface tint 4-8%.
Aplicado en:
- shared/ui/card.tsx (toneBorder map).
- shared/ui/v2/KillSwitchV2.tsx (section principal).
- shared/ui/v2/BannerOpenClawV2.tsx.
- shared/ui/v2/Toast.tsx.
- shared/ui/realtime/FallbackBanner.tsx.
- features/canvas/index.tsx (lane header).

Después: 4 anti-patterns residuales (todos layout-transition perf
sutil, queda para S1).

== Bloque 4: Chips postgres/redis (Codex 50876e5 /health) ==

Codex armó OrbStack con postgres pgvector + redis. /health ahora
reporta postgres + redis con SELECT 1 y PING reales.

Frontend:
- client.ts HealthPayload.postgres? / redis? / dependencies?
  con DependencyCheck { status, checkedAt, message? }.
- App.tsx Topbar nuevo componente DependencyChip — dot color
  según status, label compacto 'pg' / 'redis', tooltip con
  checkedAt formateado o message del error.

Resultado visual: topbar tiene 'Solo lectura · GET-only · ● pg ·
● redis · mvp.local · J operador'. Si la BD o el bus se caen,
el operador lo ve inmediatamente sin entrar a /safety.

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores
- Visualmente verificado con Chrome MCP:
  * / Vista General: 22 gates en español, 6 aprobaciones + 'Ver más',
    banner OpenClaw sin side-tab.
  * /onboarding: ENTORNO mvp.local, SECCIÓN 2 warning si sin
    detección, SECCIÓN 3 '0 interfaces · pendiente'.
  * /hardware: empty state honesto.
  * /collector: 'URL pendiente', 'ESPERADO MVP', razones ES.
  * /infrastructure: 3 Webdock separadas, 'Aún offline', timestamps
    'hace 3s'.
  * /clusters: tooltips ACT/CAL/etc + leyenda.
  * /safety: roles ES, KILL SWITCH GLOBAL sin side-tab.
  * /canvas: tab 'Lecturas', sin chip Idle, toggle 'Mostrar 6 ocultas'.
  * Topbar: chips ● pg + ● redis verdes (live).

== Documentos ==

DOCUMENTACION/AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md
DOCUMENTACION/OPS_CODEX_AUDITORIA_FRONTEND_2026_05_28.md
  (cerrado por Codex 6500a15)
DOCUMENTACION/OPS_CODEX_BD_ORBSTACK_2026_05_28.md
  (cerrado por Codex 50876e5)
DOCUMENTACION/OPS_CODEX_BLOQUEANTES_DEMO_VIERNES_2026_05_28.md
  (PENDIENTE — warmup_seed + SMTP retry interno)
DOCUMENTACION/PRACTICE_RUN_REPORT_2026_05_28.md
DOCUMENTACION/REPORTE_READINESS_DEMO_VIERNES_2026_05_28.md
  (auditoría profunda de los 7 gates del flow E2E)

== Pendiente para llegar al viernes 11h ==

Carril Codex:
- OPS_CODEX_BLOQUEANTES_DEMO_VIERNES (warmup_seed + SMTP retry).

Carril Juanes:
- Mailtrap free tier + 3 seed inboxes + 2 env vars.
- Practice run E2E real con dominio descartable.

Carril Claude:
- Guion del demo Actos 1-2-3.
- Pre-flight checklist viernes 10h.
- Plan B narrativo."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
