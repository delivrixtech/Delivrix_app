# COMMIT FASE H.23 — Canvas port literal Pencil + swimlanes + polling 5s

## Resumen

Reescribe el feature `canvas` para que sea el **port literal 1:1 del Pencil**
(`m4v5T → gvu8o → FWp8B`) en vez del grafo dagre genérico que existía. Backend
y frontend trabajan ahora con los mismos 5 swimlanes operacionales, sin
inventar agrupación en el cliente.

## Cambios

### Backend (`packages/domain/src/openclaw-canvas.ts`)

- Nuevo tipo `OpenClawCanvasLane` con los 5 valores canónicos del Pencil:
  `onboarding | hardware | provisioning | warming | reputation`.
- Cada `OpenClawCanvasNode` ahora trae `lane` (campo obligatorio).
- Nuevos tipos en el snapshot del canvas:
  - `OpenClawCanvasClusterState` — selector de clúster del toolbar.
  - `OpenClawCanvasTimeRangeState` — 1h/24h/7d.
  - `OpenClawCanvasScaleState` — zoomPercent del toolbar.
  - `OpenClawCanvasLastActivity` — actor + occurredAt + auditHash del footer.
  - `OpenClawCanvasPromptCard` — propuesta de OpenClaw con `primaryAction` y
    `secondaryAction` cuyo `kind` está acotado a `open_runbook | snooze | ack
    | view_evidence`. Nunca POSTea: el panel sigue GET-only.
- 4 nodos nuevos para alcanzar la cuenta literal de Pencil (15 totales en 5
  lanes):
  - `onboarding_capture` y `onboarding_validate` (lane onboarding).
  - `warming_plan` (sustituye al viejo `warming`, marcado como nodo del prompt).
  - `warming_ramp` (lane warming).
  - `reputation_escalation` (lane reputation).
- `buildEdges` reorganiza el flujo: onboarding → hardware → provisioning →
  warming → reputation con saltos entre lanes explícitos.
- `buildPromptCard` selecciona el primer nodo con `needs_review | requires_approval
  | blocked` y construye la propuesta con `runbookRef` por lane.
- Test `OpenClaw live canvas composes the graph without embedding sensitive
  operations` actualizado para validar lanes, cluster, timeRange, scale,
  lastActivity y prompt. 138/138 tests pass.

### Frontend (`apps/admin-panel/src/`)

- `shared/api/client.ts`: tipos `OpenClawCanvasLane`, `OpenClawCanvasPromptCard`
  y extensiones a `OpenClawCanvasPayload` (lanes, cluster, timeRange, scale,
  lastActivity, selectedNodeId, prompt).
- `features/canvas/index.tsx`: **rewrite completo**. Ya no usa
  `@xyflow/react` ni `@dagrejs/dagre` (las deps quedan en package.json por si
  H.24+ las necesita pero el código no las importa). En su lugar:
  - `CanvasSection` hace `useQuery` propio con `queryKey: ["canvas-live"]`,
    `refetchInterval: 5_000`, `staleTime: 4_000` e `initialData` desde el
    dashboard. Polling vivo cada 5s contra `/v1/openclaw/live-canvas`.
  - `Hero` (padding 20/28/16/28).
  - `Toolbar` literal: `csel` (selector cluster con icon `box` + chevron),
    `trange` (1h/24h/7d con activo en `#1A1410`), `zoom` (-/100%/+), `fit`
    (Ajustar), legend "Etapas" con 5 dots de color literal del .pen.
  - `Swimlanes` (5 carriles, fill `#F7F2EA` cornerRadius 10 border `#EAE0CE`):
    cada carril con label sidebar 120w + row horizontal con cards 172w. El
    nodo del prompt usa 184w + gradient border 2px + shadow grande. El nodo
    seleccionado usa overlay gradient `#FACC15→#EA580C` 14% + border en
    color de lane.
  - `PromptStrip` debajo del canvas (no a la derecha): outer cornerRadius 10
    padding 2 con gradient border 135° `#FACC15 #F59E0B #EA580C`, shadow
    `#92400e22` blur 18 offset (0,6); inner blanco con avatar gradient +
    sparkles, mensaje, 2 botones (secundario border `#D4C5A8`, primario fill
    `#1A1410`).
  - `Footer` con 4 quick facts: dot verde + "Actualizado hace Ns" (calculado
    desde `lastActivity.occurredAt`), maximize-2 + "escala N%", user +
    "última: operador@delivrix", (spacer) hash + "audit · sha256:…".
  - `DetailPanel` 360w right con `dpHead` blanco (eyebrow + "Revisión
    OpenClaw" Funnel Sans 18/700 + meta + pill por status) + 5 secciones
    verticales: Resumen + Métricas observadas + Bloqueos y dependencias +
    Aprobaciones humanas + Bitácora reciente.
  - `RunbookModal` se abre cuando el operador clickea el primary action del
    prompt. Muestra los 5 pasos del runbook, los hashes de evidencia y deja
    claro que el panel no ejecuta nada (el botón "Abrir runbook" abre el .md
    en GitHub, no POSTea).

## Validación local (sandbox)

```
cd packages/domain && (corre via npm test del root)
npm test                                  # 138/138 ok
cd apps/admin-panel
npx tsc --noEmit                          # 0 errores
node --test src/shared/api/client.test.ts \
            src/shared/lib/formatters.test.ts \
            src/shared/lib/domain-state-copy.test.ts   # 15/15 ok

# Smoke contra el contrato H.23
GATEWAY_PORT=3397 node apps/gateway-api/src/main.ts &
curl -s http://127.0.0.1:3397/v1/openclaw/live-canvas | jq .canvas.lanes
# → ["onboarding", "hardware", "provisioning", "warming", "reputation"]
curl -s http://127.0.0.1:3397/v1/openclaw/live-canvas | jq '.canvas.nodes | length'
# → 15
curl -s http://127.0.0.1:3397/v1/openclaw/live-canvas | jq .canvas.prompt
# → { nodeId: "onboarding_validate", primaryAction.kind: "open_runbook", ... }
```

## Comando para el operador (recargar el panel)

Después de aplicar este commit, hay que reiniciar gateway (porque tiene el
contrato actualizado) y el dev server del admin panel:

```bash
# 1. Reiniciar gateway desde el worktree
bash "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/restart-gateway.sh"

# 2. (en otra terminal) reiniciar admin panel
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
npm --workspace @delivrix/admin-panel run dev

# 3. abrir http://127.0.0.1:5173 y navegar a Canvas
```

## Comando de commit (Codex en host)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"

rm -rf apps/admin-panel/dist
npm test
npm --workspace @delivrix/admin-panel run check

git add \
  packages/domain/src/openclaw-canvas.ts \
  packages/domain/src/hito-5-6-control-plane-contracts.test.ts \
  apps/admin-panel/src/shared/api/client.ts \
  apps/admin-panel/src/features/canvas/index.tsx \
  COMMIT_FASE_H_23.md

git commit -m "feat(canvas): port literal Pencil swimlanes + polling 5s

Reescribe la sección Canvas (frame Pencil m4v5T) reemplazando el grafo
dagre genérico por:

- 5 swimlanes operacionales (onboarding/hardware/provisioning/warming/
  reputation) con colores literales del .pen.
- Toolbar Pencil completa: cluster selector + 1h/24h/7d + zoom +/-/100%
  + Ajustar + legend de 5 dots.
- 15 nodos distribuidos por lane (era 10 lineales), incluyendo 4 nodos
  nuevos: onboarding_capture, onboarding_validate, warming_plan (con
  prompt OpenClaw embebido), warming_ramp, reputation_escalation.
- Prompt strip debajo del canvas con gradient border 2px + 2 botones.
  El primario abre un RunbookModal con los pasos del runbook .md y los
  hashes de evidencia. El bundle frontend sigue GET-only: nada de POST.
- Footer literal Pencil con 4 quick facts (último timestamp calculado
  desde lastActivity.occurredAt).
- Detail panel 360w con 5 secciones: Resumen, Métricas observadas,
  Bloqueos, Aprobaciones humanas, Bitácora reciente.
- useQuery propio con refetchInterval 5_000 para que el canvas refresque
  en vivo sin tocar el dashboard general (sigue 30s).

Backend: OpenClawCanvasNode gana 'lane'; snapshot gana cluster,
timeRange, scale, lastActivity, selectedNodeId, prompt. Test domain
138/138 ok, admin-panel 15/15 ok, tsc clean.

Refs: Hito 5.10 H.23 · canvas operacional vivo y supervisado.
"
```
