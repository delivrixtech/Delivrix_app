# Alineamiento estratégico — Canvas vivo + Chat live + visión OpenClaw
Fecha: 2026-05-24 · Autor: Claude · Disparador: operador pidió reset porque "el Canvas no tiene nada que ver" y "ni siquiera tenemos algo inteligente para visualizar"

## TL;DR

Hay **drift importante entre la visión original (HITO 5.7) y lo implementado hoy**. El Canvas era ReactFlow real con nodos/edges/timeline; hoy es swimlanes con scroll horizontal manual. ReactFlow está instalado pero el código del Canvas no lo usa. El ChatWidget existe (235 LOC, WSS) pero falta verificar end-to-end. Pencil v2 que hicimos hoy reflejaba el código actual (swimlanes), no la visión real — por eso "sigue igual" aún con el rediseño.

**Decisión clave a tomar**: ¿reescribimos Canvas con ReactFlow (la visión original) o seguimos con swimlanes mejoradas? La infraestructura para ReactFlow ya existe — no es un cambio de paquete, es usar lo que ya hay.

---

## 1. Dónde íbamos (la visión original)

### 1.1 HITO 5.7 — Canvas operacional con React Flow
Doc: `DOCUMENTACION/HITO_5_7_ADMIN_PANEL_REACT_CANVAS.md`

> Renderiza `GET /v1/openclaw/live-canvas` con **React Flow**:
> - nodos
> - edges
> - timeline
> - bloqueos
> - aprobaciones humanas
> - drill-down por endpoint

El Canvas era el corazón visual: una pizarra donde el operador ve **lo que OpenClaw está haciendo en vivo**. Nodos que cambian de color, edges que muestran dependencia, timeline que avanza, aprobaciones que aparecen como pop-out.

### 1.2 HITO 5.5A — Canvas + telemetría hardware
Doc: `DOCUMENTACION/HITO_5_5A_CANVAS_OPENCLAW_TELEMETRIA_HARDWARE.md`

Definió el contrato `live-canvas` con shape `{ canvas: { lanes, nodes, edges, timeRange, scale, currentStepId, blockedBy, prompt } }`. Notar **`edges`** — el contrato siempre tuvo edges, el frontend nunca los usó.

### 1.3 OPS Chat live (Hito 5.11.C)
Doc: `DOCUMENTACION/OPS_OPENCLAW_CHAT_LIVE.md`

Operador habla a OpenClaw desde el panel. WSS `/v1/openclaw/chat/stream` + POST `/v1/openclaw/chat/send`. Drawer 380px lateral derecho. Sesión compartida `agent:main:operator`. Audit `oc.chat.operator_message` + `oc.chat.agent_response`.

### 1.4 Norte del proyecto
- Delivrix es **agente de infraestructura supervisado** (Hito 5.11.B cerró el agente OpenClaw en Hostinger Bedrock Sonnet 4.6).
- El panel es la **ventana operativa**: operador ve qué hace el agente, aprueba con regla de 2 personas, kill switch armado.
- Demo MVP día 30/30 (estamos día 21+ hoy).

---

## 2. Dónde estamos (estado real verificado)

### 2.1 Canvas — REGRESIÓN ⚠️
`apps/admin-panel/src/features/canvas/index.tsx` (1770 LOC)

- **@xyflow/react v12.10.2 está instalado** en `package.json`.
- **CSS importado** en `main.tsx` l14: `import "@xyflow/react/dist/style.css"`.
- **Clase `.delivrix-node`** ya estilizada en `globals.css` l128-153 (success/warning/critical borders).
- **PERO** el código del Canvas tiene **0 referencias** a ReactFlow (`grep` confirmado).
- Implementa swimlanes manuales con flex + `overflow-x-auto`. Sin edges, sin pan, sin grid, sin minimap. El "zoom" es CSS transform que distorsiona texto (auditado en `AUDIT_CANVAS_DEEP_2026_05_24.md`).

**Por qué pasó**: en algún momento entre 5.7 y 5.10 (Fase H del rebrand Pencil) se reescribió Canvas para "port literal" del frame Pencil que en ese momento dibujaba swimlanes. El motor ReactFlow quedó instalado como zombie. Es deuda técnica importante.

### 2.2 ChatWidget — EXISTE pero falta verificar funcionalidad ⚠️
`apps/admin-panel/src/features/chat/ChatWidget.tsx` (235 LOC)

- Montado en `app/App.tsx` l129 como lazy load con prop `open={chatOpen}` + `onClose`.
- Tiene WebSocket, useEffect para conectar, ConnectionPill (online/offline/reconnecting), MessageBubble.
- **Falta verificar**:
  - ¿El gateway tiene los endpoints `POST /v1/openclaw/chat/send` + `WSS /v1/openclaw/chat/stream`? (OPS lo manda pero no confirmé implementación)
  - ¿OpenClaw container Hostinger expone `/api/chat.send` + `/api/chat.stream`?
  - ¿`OPENCLAW_GATEWAY_TOKEN` está en `.env.local`?
  - ¿Funciona end-to-end con la última versión del agente Bedrock?

### 2.3 Rest del panel (9 pantallas) — estado mixto
- **Overview, Canvas, Safety** ya importan building blocks v2 (LiveIndicator, BannerOpenClawV2, SectionDivider, ApprovalRow). Sprint 1 P0 cerró shadows + focus + cluster timestamp.
- **Onboarding, Hardware, Collector, Clusters, Learning** todavía tienen el OpenClawPrompt manual (gradient bulky) + sin LiveIndicator + cosas hardcoded del audit.
- Audit completo: 80 findings (27 P0 + 35 P1 + 18 P2) en `AUDIT_PANEL_FE_SENIOR_2026_05_20.md`.

### 2.4 Building blocks v2 — implementados pero subutilizados
9 bloques en `apps/admin-panel/src/shared/ui/v2/`:
- ✅ Usados: LiveIndicator (3 features), BannerOpenClawV2 (2), SectionDivider (3), ApprovalRow (1)
- ❌ Sin usar todavía: KpiCardV2, ComplianceCardV2, IamRoleRow, IamSessionRow, KillSwitchV2

### 2.5 Pencil v2 — diseños quedaron desactualizados ⚠️
- Frames v2 recreados hoy (Dbpmn Overview, swxPF Canvas, XbGul Safety) reflejan el código actual.
- **Pero**: yo dibujé swimlanes para Canvas v2 (swxPF) porque eso es lo que tiene el código — no la visión real de ReactFlow con edges. El Pencil v2 está alineado con el bug, no con la visión.

---

## 3. Hacia dónde vamos — propuesta de 3 frentes

### Frente A — Canvas Real con ReactFlow (P0 estratégico, 2-3 días)

**Por qué primero**: es el corazón de la demo MVP. El usuario lo dijo claro: "el Canvas no tiene nada que ver", "ni siquiera tenemos algo inteligente para visualizar". Sin Canvas vivo, OpenClaw no se demuestra como agente de infra; demuestra como "lista de checks".

**Scope mínimo**:
- Migrar `Swimlanes` + `NodeCard` a `<ReactFlow>` con custom node `<DelivrixNode>` (clase `.delivrix-node` ya estilizada).
- Layout: dagre o ELK para auto-position. O posición manual via `node.x/node.y` del contrato.
- Edges: usar `canvas.edges` del contrato (siempre estuvo en el shape, nunca se rendereizó).
- Animaciones:
  - Pulse halo cuando cambia `node.status` (clase `v2-tick-halo` ya está en globals.css).
  - Edge `var(--color-critical)` con animación cuando hay bloqueo de dependencia.
  - Edge `var(--color-success)` cuando termina un step.
- Pan + zoom nativos de ReactFlow (no CSS transform).
- Minimap built-in (`<MiniMap />`).
- Background grid (`<Background variant="dots" />`).
- DetailPanel se mantiene a la derecha, escucha `onNodeClick` de ReactFlow.
- PromptStrip sticky top o bottom (decidible).

**Riesgo**: 1770 LOC del Canvas se reducen a ~600 LOC (ReactFlow hace el heavy lifting). Tests visuales obligatorios después.

### Frente B — Verificar + completar Chat Live (P0 funcional, 4-6h)

**Por qué**: el operador dijo "ni un chat en tiempo real". Si ya existe el ChatWidget montado, hay que **confirmar que funciona** end-to-end y si no, completar lo que falte.

**Pasos**:
1. `grep` en `services/gateway/src` por `/v1/openclaw/chat/send` y `/v1/openclaw/chat/stream`. Si no existen, escribir OPS para Codex.
2. SSH a OpenClaw container `2.24.223.240:61175`, verificar `/api/chat.send` + `/api/chat.stream`.
3. `.env.local` tiene `OPENCLAW_GATEWAY_TOKEN`? Si no, generar + rotar.
4. Probar end-to-end: abrir panel → drawer chat → enviar mensaje → ver respuesta streaming.
5. Si falla algo, fixearlo o documentar bloqueante (puede ser que Bedrock + container Hostinger no tengan implementado chat aún).

### Frente C — Completar v2 building blocks en las 6 pantallas restantes (P1, 1-2 días)

Aplicar a Onboarding/Hardware/Collector/Clusters/Learning:
- Sustituir OpenClawPrompt manual con BannerOpenClawV2.
- LiveIndicator en cada hero.
- KpiCardV2 donde aplique.
- ComplianceCardV2 en Safety (todavía custom).
- Eliminar shadows hardcoded restantes (Sprint 1 ya barrió 50; auditar si quedan).

### Frente D — Actualizar Pencil para reflejar visión real (parte del Frente A)

Cuando Canvas con ReactFlow esté implementado, rediseñar el frame `swxPF` (o crear `Canvas v3`) en Pencil con: nodos circulares/cuadrados conectados por edges con flechas, minimap esquina, grid de fondo, DetailPanel lateral. Esto es **para alinear Pencil con la visión real**, no con el bug actual.

---

## 4. Recomendación senior

**Arrancar simultáneamente Frente A + Frente B**:

- **Sesión actual (hoy)**: yo arranco **Frente A** — migrar Canvas a ReactFlow real. Es el cambio más visible y desbloquea el "wow factor" que falta. Estimación: 4-6h hasta tener un Canvas funcional básico con nodos+edges+pan/zoom; refinamiento de animaciones después.

- **Codex (en paralelo)**: verificar **Frente B** ChatLive end-to-end. Si gateway no tiene los endpoints, escribir OPS para Codex implementarlos. Si Bedrock container no tiene chat.send, escribir OPS para configurarlo.

- **Después**: Frente C en sprint dedicado (1-2 días).

- **Decisión 5.13**: si Frente A + B no caben en el MVP día 30, mover Canvas-ReactFlow a 5.13 post-MVP y atacar solo polish del actual + ChatLive en MVP. **Pero recomendación**: hacer Canvas-ReactFlow YA. Lo demás (multi-provider 5.12) sigue siendo válido pero no es lo que el operador está pidiendo a gritos.

---

## 5. Tarea inmediata (next 5 min)

**Decisión del operador**: confirmar plan de 3 frentes + arranque Frente A.

Si confirmás, empiezo:
1. Crear branch `feature/canvas-reactflow` (worktree si querés mantener paralelo).
2. Leer contrato completo `live-canvas` (shape de edges + posiciones).
3. Stub `<CanvasReactFlow>` con nodos custom + 1 edge animado.
4. Iterar hasta paridad funcional con swimlanes actual.
5. Reemplazar `<Swimlanes>` + `<NodeCard>` por el nuevo.
6. QA visual + commit.

Si preferís otro orden o Frente B primero, decime y reorganizo.
