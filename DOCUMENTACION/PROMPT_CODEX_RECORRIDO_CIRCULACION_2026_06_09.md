# Codex — FEATURE: recorrido del grafo de Topología EN CIRCULACIÓN (colores fluyendo step-by-step)

> **Estado:** investigado a fondo (4 subagentes read-only, 2026-06-09) contra el código real (HEAD/produ `9ccc7cb`). El tracker live YA funciona (los NODOS cambian de color en vivo, confirmado). Falta que el grafo muestre el recorrido **en circulación** (un frente que avanza), que hoy NO se ve por 2 causas precisas (abajo). **Frontend-only.** Toca `canvas-flow.tsx` (esta vez necesario) pero **bajo riesgo: solo clases CSS + props derivados, CERO estado JS nuevo (no reabrir el memleak), y con overlay vacío el baseline queda byte-idéntico.** **Subagentes OBLIGATORIO** (worker + auditor). La animación real se valida con **QA-visual de Juanes** (no se cubre por unit test). Stop-and-report si algo no aplica limpio.

## Causa raíz (verificada, anclada)
1. **Los EDGES nunca se overlayean según el build.** `buildTopologyStatusOverlay` (`smtp-live-progress.ts:210-230`) emite SOLO estados de NODO. `TopologyTab` (`canvas-v4.tsx:3524-3534`) hace `data.nodes.map(...)` pero **NO** `data.edges.map(...)` → los edges quedan en su estado ESTÁTICO. Y ese estático (`edgeStatusFromSource`, `openclaw-canvas.ts:683-687`) pone en `in_progress` (ámbar + animado) a casi todos los edges del path incluso idle → el grafo entero parece "fluyendo ámbar" siempre, sin un frente que avance. **Causa #1 de "no se ve el recorrido".**
2. **El nodo activo no resalta.** `in_progress` (`canvas-flow.tsx:120`) solo cambia el dot 10px + caption 9px; cuerpo/borde/ícono no cambian. El halo `v2-tick-halo` (`globals.css:372-383`) es **one-shot 600ms verde** al cambiar de estado (no continuo, color equivocado) → un nodo "en curso" por minutos queda estático. Baseline ya tiene ~4-5 nodos ámbar → el build se camufla.
3. **Dato clave:** la animación de flujo de ReactFlow YA existe (`animated:true` en `layoutEdges:423` → `@xyflow/react` `dashdraw`). Pero `.v2-edge-flow` (`globals.css:386-407`) está **MUERTA** para esto (anima `background-position` de un div; los edges son `<path>` SVG). Para un flujo fuerte/direccional hace falta un keyframe real de `stroke-dashoffset`.

## El fix (frontend-only)
### 1) `smtp-live-progress.ts` — overlay de EDGES + flags (nuevo, función pura)
Agregar el spine fijo del recorrido (edge IDs reales, verificados en `openclaw-canvas.ts:650-672`) y `buildRecorridoOverlay(run)`:
```ts
export const RECORRIDO_EDGES = [
  { id: "proxmox_to_cluster",    from: "proxmox_host",  to: "cluster_plan" },
  { id: "cluster_to_vps",        from: "cluster_plan",  to: "vps_lxc_plan" },
  { id: "vps_to_dns",            from: "vps_lxc_plan",  to: "dns_identity" },
  { id: "dns_to_sender",         from: "dns_identity",  to: "sender_nodes" },
  { id: "sender_to_warming",     from: "sender_nodes",  to: "warming_plan" },
  { id: "warming_plan_to_ramp",  from: "warming_plan",  to: "warming_ramp" },
  { id: "warming_to_reputation", from: "warming_ramp",  to: "reputation_gates" }
] as const;
export type RecorridoEdgeStatus = "ready" | "in_progress" | "pending";
// buildRecorridoOverlay(run): { nodes, edges: Record<edgeId,RecorridoEdgeStatus>, activeNodeId, buildNodeIds }
```
- `nodes` = reusar `buildTopologyStatusOverlay` verbatim.
- `activeNodeId` = `nodeIdForSmtpStep(currentStep)`; `frontierIdx` = índice del edge cuyo `to` === activeNodeId.
- Edges: `i < frontier` → `ready`; `i === frontier` (entrante) y `i === frontier+1` (saliente) → `in_progress`; resto → `pending`. → exactamente **2 edges ámbar** alrededor del nodo activo, verde detrás, dim adelante.
- Run no-running (completed/failed/null) → edges colapsan a `ready` (si ambos extremos ready) o `pending`; `activeNodeId=null`. (Overlay vacío cuando no hay run → baseline intacto.)
- `buildNodeIds` = nodos del spine (para atenuar el resto).
Tests nuevos en `smtp-live-progress.test.ts` (sibling del test de overlay existente): asserta done/active/pending por edge en un step intermedio + vacío cuando no corre.

### 2) `canvas-v4.tsx` `TopologyTab` — merge de edges + flags
```ts
const overlay = useMemo(() => buildRecorridoOverlay(activeRunProgress), [activeRunProgress]);
const runActive = activeRunProgress?.runStatus === "running";
// en renderedCanvas (si overlay vacío → return data tal cual):
nodes: data.nodes.map(n => ({ ...n, status: overlay.nodes[n.id] ?? n.status })),
edges: data.edges.map(e => ({ ...e, status: overlay.edges[e.id] ?? e.status }))   // ← NUEVO
// pasar a <CanvasFlow>: activeNodeId={runActive ? overlay.activeNodeId : null}
//                       buildNodeIds={runActive ? overlay.buildNodeIds : null}
```

### 3) `canvas-flow.tsx` — flow de edges + emphasis/dim de nodos (props derivados, sin estado JS nuevo)
- `layoutEdges` (`:407-434`): agregar branch `pending` → color `rgba(255,255,255,0.22)`, `animated:false`, dashed (frente claro). Para `in_progress` mantener `animated:true` y agregar `className:"v4-edge-flowing"`.
- `CanvasFlowProps` (`:105-109`) + `layoutNodes` (`:348-396`): threadear `activeNodeId`/`buildNodeIds` → en node data `emphasis: node.id===activeNodeId`, `dimmed: !!buildNodeIds && !buildNodeIds.includes(node.id)`.
- `DelivrixCanvasNode` (`:160-336`): si `emphasis` → agregar clase `is-active` al body (pulso continuo) y NO recalcular `pulseKey` para el activo (evita remount que corta el pulso). Si `dimmed` → `style.opacity: 0.4` en el wrapper. **Conservar `v2-tick-halo`** para el flash one-shot de "recién pasó a verde" (transición a `ready`).

### 4) `globals.css` — keyframes reales (scoped a `.delivrix-flow-canvas`)
```css
/* flujo direccional fuerte del edge activo (hacia el target) */
.delivrix-flow-canvas .react-flow__edge.v4-edge-flowing path,
.delivrix-flow-canvas .react-flow__edge.animated path {
  stroke-dasharray: 10 6; stroke-width: 3;
  animation: delivrix-recorrido-flow 0.7s linear infinite;
  filter: drop-shadow(0 0 4px rgba(251,191,36,0.55));
}
@keyframes delivrix-recorrido-flow { to { stroke-dashoffset: -16; } }  /* -16 = avanza hacia el destino */
/* pulso continuo del nodo activo */
@keyframes delivrix-node-pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(251,191,36,0); }
  50%     { box-shadow: 0 0 0 10px rgba(251,191,36,0.20); }
}
.delivrix-flow-canvas .delivrix-node-body.is-active { animation: delivrix-node-pulse 1.4s ease-in-out infinite; }
```
(NO reusar `.v2-edge-flow` — está muerta para SVG. Confirmá el selector exacto del edge-path de ReactFlow.)

### 5) `client.ts` (o el tipo del payload de edges, ~`:402`)
Widen el status del edge para permitir `"pending"` (o un tipo edge-local del front). Cambio de 1 línea.

## PROHIBIDO
- **CERO estado JS nuevo en `canvas-flow.tsx`** (nada de useState/Maps/intervals → preserva el fix del memleak). Solo clases CSS + props derivados.
- Overlay vacío (sin run, flag/none) → `renderedCanvas` devuelve `data` tal cual → **baseline byte-idéntico** (el poll de 5s sigue igual).
- Mantener `id/source/target` de los edges estables (que ReactFlow no destruya edges).
- Conservar `v2-tick-halo` para transiciones genéricas; el pulso continuo es clase SEPARADA gated en el nodo activo.
- NO tocar el backend, `openclaw-canvas.ts`/`buildEdges`/`buildNodes`, ni el pipeline de eventos. Es 100% frontend (overlay client-side desde `liveRunProgress`).

## DoD (Codex)
1. Implementar 1-5 con subagentes (worker + auditor independiente).
2. **Unit tests:** `buildRecorridoOverlay` (edges done/active/pending en step intermedio; vacío cuando no corre; el nodo activo correcto) + que el merge no rompe el baseline (overlay vacío → data igual). Correr `npm --workspace @delivrix/admin-panel run check` (incluir el test nuevo) + `node --test smtp-live-progress.test.ts canvas-live-client.test.ts` + `npm test`. tsc 0. (Artefacto sandbox `/private/tmp` EACCES no es regresión.)
3. **Backward-compat:** sin run activo, el grafo se ve idéntico a hoy (overlay vacío). Probarlo.
4. Commit atómico: "Animate Canvas topology recorrido (flowing edges + active-node pulse + dim)". Deploy: panel local (arrancar con `./scripts/delivrix-admin-start.sh`) + push `origin produ`. (Solo frontend — no toca gateway/Hostinger.)
5. **Marcar PENDIENTE QA-VISUAL de Juanes:** durante un `configure_complete_smtp` real, ver en la Topología (a) un frente ámbar fluyendo que AVANZA paso a paso por el spine; (b) verde sólido detrás (hecho); (c) gris/dim adelante; (d) el nodo activo pulsando fuerte y continuo; (e) los nodos fuera del build atenuados; (f) sincronizado con el stepper.

## Reportá
SHA + EXIT de tests + tsc + confirmación de backward-compat (sin run = idéntico) + que NO agregaste estado JS en canvas-flow + que NO tocaste backend/buildEdges. Dejá marcado pendiente la QA-visual.
