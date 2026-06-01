#!/bin/bash
# Push del Sprint Demo Viernes — 4 piezas frontend del Bloque 10.
#
# Contexto: Codex empuja backend (T2-T8 + T7C multi-agent) en paralelo.
# Este push trae el frontend que Juanes va a presentar el viernes 29 may
# (Acto 1 multi-agent + Acto 2 memoria persistente + Acto 3 sender pool).
#
# Correr desde la Mac.

set -e
cd "/Users/juanescanar/Documents/delivrix app"

# 1) Limpiar locks stale del sandbox si quedaron
rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

# 2) Pull primero por si Codex pusheó más cambios
git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short

# 3) Stage de los archivos del sprint demo viernes.
#    No se incluyen: .audit/audit-events.jsonl (ephemeral), "Servidor Fisico /"
#    (junk), push_canvas_v6.sh / push_domains_canvas.sh (scripts efímeros).
git add \
  apps/admin-panel/src/app/App.tsx \
  apps/admin-panel/src/app/sections.ts \
  apps/admin-panel/src/features/canvas/canvas-live-client.ts \
  apps/admin-panel/src/features/canvas/live-tool-types.ts \
  apps/admin-panel/src/features/canvas/live-tool.tsx \
  apps/admin-panel/src/features/canvas/workspace-browser.tsx \
  apps/admin-panel/src/features/sender-pool/index.tsx \
  apps/admin-panel/src/features/domains/index.tsx \
  DOCUMENTACION/AUDITORIA_PANEL_ADMIN_2026_05_26.md \
  DOCUMENTACION/PRESENTACION_ESTADO_PANEL_2026_05_26.md

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "feat(panel): sprint demo viernes — 4 piezas frontend Bloque 10

Demo viernes 29-may: flujo end-to-end real con OpenClaw (comprar dominio →
configurar DNS → SPF/DKIM/DMARC → adquirir VPS Webdock → instalar SMTP →
conectar → arrancar warmup). Backend lo trae Codex (T2-T8 + T7C). Este
commit cierra las 4 piezas frontend que activan los 3 actos de la demo.

== Pieza 1: Sender Pool section (Acto 3 — visión que el agente escala) ==

Nueva feature en sidebar grupo Operación que muestra el estado de los N
dominios sender administrados por OpenClaw:

- 3 KPIs: Activos / Total / Planeados.
- Tabla 6 columnas (Dominio, Estado, Warmup, Hoy, Total, Health) con
  StatusPill cubriendo 6 estados (onboarding/warming/active/paused/burned/
  failed) y HealthIndicators (auth + blacklists dots).
- OnboardNewDomainCard que dispara intent OpenClaw 'sender-pool:onboard'
  con prompt detallado para el flow end-to-end.
- FlowExplainerCard con 7 pasos del onboarding para que jefes entiendan.
- Empty/error states honestos mientras Codex expone GET /v1/sender-pool/status.

Archivos:
- apps/admin-panel/src/features/sender-pool/index.tsx (nuevo, ~480 LOC)
- apps/admin-panel/src/app/sections.ts (entry sender-pool)
- apps/admin-panel/src/app/App.tsx (lazy import + case render)

== Pieza 2: Botón 'Onboard end-to-end' en feature Dominios ==

Equivalente al CTA del Sender Pool pero situado en Domains para que el
operador no tenga que cambiar de feature después de buscar un dominio.
Context-aware: si el input tiene un dominio AVAILABLE confirmado, pre-llena
el prompt con ese dominio; si no, deja que OpenClaw proponga 3 candidatos.

Archivos:
- apps/admin-panel/src/features/domains/index.tsx (nuevo OnboardEndToEndCard)

== Pieza 3: Sub-tasks jerárquicas en LiveTool (Acto 1 — multi-agent) ==

Soporte para visualizar el supervisor multi-agent del Bloque 10 T7C:
un task supervisor padre con N sub-tasks corriendo en paralelo, renderizados
anidados con indent visual + línea vertical conectora.

- live-tool-types.ts: campo opcional parentTaskId?: string | null en LiveTask;
  mirror Wire sincronizado con contract canónico (CanvasLiveTaskDeclareEventWire
  y CanvasLiveTaskSnapshotWire) tras commit Codex 79cd89f.
- canvas-live-client.ts: handler de oc.task.declare y taskFromSnapshot ahora
  propagan parentTaskId desde el wire al shape interno (antes lo dropeaban
  silenciosamente y el sub-task tree quedaba muerto en runtime).
- live-tool.tsx: dedupTasks() reemplazado por buildTaskTree() que agrupa por
  parentTaskId; TaskNodeRow recursivo con indent 14px por nivel; badge 'N sub'
  cuando el padre tiene sub-tareas; sidebar ensanchado 200→240px para acomodar
  la jerarquía.

También se refinó la ArtifactColumn: nuevo ArtifactHeader con kind pill
(plan/proposal/template/report) + botones Copiar/Exportar para reports;
ReadOnlyTitle/ReadOnlyBlock para artifacts informativos; ApprovalBadge
unificado (approved/rejected/informational).

== Pieza 4: WorkspaceBrowser en tab Archivos (Acto 2 — memoria persistente) ==

Nuevo componente que el operador abre en el Acto 2 para mostrar que el agente
RECUERDA. Renderiza /data/.openclaw/workspace/ con:

- Tree pane (40% width al seleccionar archivo, 100% antes) con expand/collapse,
  iconos Folder/FolderOpen/FileText/File-json, indent 14px por nivel.
- File preview con formato JSON pretty + badge 'mock' cuando el endpoint
  backend no está expuesto todavía.
- Dataset demo realista (executions/2026-05-29/, learnings/, skills/, inventory/)
  para que la demo del viernes funcione visualmente. Fallback se descarta apenas
  GET /v1/openclaw/workspace/tree + /file estén live (Codex follow-up).

Integración en ActionColumn: tab Archivos siempre rinde WorkspaceBrowser; si
hay una file action reciente, aparece como strip 'Actividad reciente' arriba
del browser.

Archivos:
- apps/admin-panel/src/features/canvas/workspace-browser.tsx (nuevo, ~280 LOC)
- apps/admin-panel/src/features/canvas/live-tool.tsx (FilesTabView + integración)

== Docs ==

- DOCUMENTACION/AUDITORIA_PANEL_ADMIN_2026_05_26.md: auditoría exhaustiva por
  sección/tab con lenguaje accionable.
- DOCUMENTACION/PRESENTACION_ESTADO_PANEL_2026_05_26.md: doc ejecutivo en
  lenguaje no técnico para presentar a jefes el viernes (10 secciones + Canvas
  5 tabs + cronograma 3 días).

== Verificación ==

- tsc --noEmit -p apps/admin-panel/tsconfig.json → 0 errores.
- vite build → ✓ canvas-v4 chunk 277 kB gz 80 kB; sender-pool 13 kB gz 4 kB.

Backend Bloque 10 cerrado por Codex (commits f844842 T2 → 79cd89f T7C/T8).
Endpoints disponibles para los CTAs: POST /v1/warmup/start, POST
/v1/flows/onboard-sender-domain, POST /v1/flows/onboard-batch (sub-tasks
paralelas con parentTaskId emitido por el supervisor multi-agent).

Bloqueantes externos pendientes para smoke real viernes:
- AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true en gateway.
- Doble aprobación humana real configurada.
- DELIVRIX_ADMIN_CONTACT_JSON (contacto Route53).
- Webdock API key servers:write + ticket port 25 outbound desbloqueado.
- 3 seed inboxes configuradas para warmup."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
