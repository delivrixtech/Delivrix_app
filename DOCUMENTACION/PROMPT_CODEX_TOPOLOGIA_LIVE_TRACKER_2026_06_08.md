# Codex — FEATURE: animar la Topología del Canvas EN VIVO durante `configure_complete_smtp`

> **Estado:** diseño auditado a fondo (5 subagentes read-only, 2026-06-08) contra el código real. Requisito firme de Juanes: **tiempo real, en vivo (sub-segundo), NO poll de 5s**. Esto es un FEATURE (no un diff pre-verificado): implementá el diseño exacto de abajo, con **subagentes OBLIGATORIO** (worker + auditor independiente antes del commit). El render en vivo NO se cubre 100% por unit tests → queda **QA-visual de Juanes** en un run SMTP real. Stop-and-report si algo no aplica limpio.

## Objetivo
Mostrar **en tiempo real** el avance de `configure_complete_smtp` en **DOS vistas SINCRONIZADAS** (misma fuente `liveRunProgress` → sincronización gratis, sin lógica extra):
1. **Topología animada** (`canvas-v4.tsx` `TopologyTab`): cada nodo pasa a **"en curso" (ámbar)** al arrancar su paso y a **"listo" (verde)** al terminar; **rojo** si falla.
2. **Stepper "paso X/14"**: la lista de los **14 pasos** en orden, cada uno **hecho/configurando/pendiente** con su **nombre legible** + ETA + heartbeat en esperas largas.
Sin recargar, instantáneo, y **correcto al reconectar** (el WS reconecta seguido).

## Arquitectura (3 piezas) — verificada
**A) Push en vivo (instantáneo) — YA disponible, casi sin backend.** El WS `/v1/canvas/live/stream` hace broadcast de TODOS los eventos a cualquier cliente que **no** pase `?task=` (el cliente actual no lo pasa). El orquestador ya emite por cada paso, sincrónico (sub-segundo): `oc.action.now` con `kind:"audit"`, `action`=`oc.orchestrator.step_started|step_completed|step_failed`, `targetId`=`` `${runId}:${step}:${skill}` ``, `taskId`=runId (`orchestrator-smtp.ts:1980-1999`; run-level `emitRunAction` `run_started|completed|failed`, targetId=runId, `:1962-1978`). El frontend ya los recibe en `applyEvent` `oc.action.now` (`canvas-live-client.ts:415`) pero solo guarda `lastAction` (lossy) → hay que **acumular**.

**B) Snapshot con progreso (replay/robustez) — único cambio de backend.** Un cliente que reconecta a mitad de run solo recibe eventos FUTUROS; el snapshot hoy NO tiene progreso por paso → quedaría en blanco minutos (los `wait_*` duran minutos). Hay que enriquecer el snapshot con el progreso real de `SmtpRunState`.

**C) Run-scoping (correctitud).** Puede haber 2 runs concurrentes (el lock es per-runId). Hay que seguir el run activo y descartar eventos de otros runs, o se corrompe el grafo.

## Cambios — Backend (chico)
1. **Extender el tipo de snapshot** en `packages/domain/src/canvas-live.ts` (snapshot type ~:173-178): agregar un campo opcional `progress` (o `runs: RunProgress[]`), shape derivado de `SmtpRunState`, SIN secretos ni payloads:
   ```ts
   interface CanvasLiveRunProgress {
     runId: string;
     status: "running" | "completed" | "failed" | string;
     lastCompletedStep: number;
     steps: Array<{ step: number; skill: string; status: "pending" | "in_flight" | "done" }>;
   }
   ```
   Incluir el/los run(s) activo(s)/recientes (al menos el activo). NO inventar un tipo de EVENTO nuevo (el normalizer `canvas-live-events.ts:600-667` rechaza tipos desconocidos).
2. **Poblar el snapshot** en `apps/gateway-api/src/services/canvas-live-events.ts` `snapshot()` (`:95-115`): leer el progreso vía un reader **autoritativo** que reuse `readSmtpRunState` (`orchestrator-smtp.ts:1012`) / `inventory/smtp-runs/`. Inyectar ese reader desde `main.ts` (donde se construye el servicio) — NO duplicar la lógica de derivación; `lastCompletedStep` ya lo recomputa `updateRunStateProgress :1252`. Mapear task↔run es trivial: `taskId === runId`.
3. NO tocar `emitStep`/`emitRunAction` ni el normalizer ni el ciclo de WS.

## Cambios — Frontend
4. **`apps/admin-panel/src/features/canvas/canvas-live-client.ts` (`useLiveCanvasStream`):**
   - Agregar al `InternalState` (`:51-58`, init en `emptyState :65-72`) un acumulador **aparte** (no en los Maps que evicta `evictLiveState`):
     ```ts
     liveRunProgress: Map<string /*runId*/, {
       runStatus: "running" | "completed" | "failed";
       currentStep: number | null;
       steps: Map<number, { skill: string; status: "in_progress" | "ready" | "error" }>;
     }>;
     ```
   - **Sembrar** `liveRunProgress` desde el `progress` del snapshot en `applySnapshot` (mapear `pending`→(omitir), `in_flight`→`in_progress`, `done`→`ready`; run `status`). Esto es el replay al (re)conectar.
   - **Acumular en vivo** en el branch `oc.action.now` (`:415`), ADITIVO (dejar intacto el write de `lastAction` para no romper el tab Live): si `event.kind==="audit"` y `event.action` empieza con `oc.orchestrator.`:
     - split `event.targetId` por `:` → `[runId, stepStr, ...skillParts]`; `skill = skillParts.join(":")` (defensivo por si el skill trae `:`); `step = Number(stepStr)`.
     - `…step_started` → `steps.set(step,{skill,status:"in_progress"})`, `currentStep=step`.
     - `…step_completed` → `steps.set(step,{skill,status:"ready"})`; si `currentStep===step` → `currentStep=null`.
     - `…step_failed` → `steps.set(step,{skill,status:"error"})`.
     - `…run_started|run_completed|run_failed` (targetId sin `:step:`) → setear `runStatus`.
   - El `scheduleForceRender()` al final de `applyEvent` (`:472`) ya re-renderiza en cada evento (rAF, sub-segundo) — no agregar timers.
   - **Exponer** `liveRunProgress` en `UseLiveCanvasStreamResult` (`:38-49`) y en el return (`:582-593`). Opcional: exponer un helper "progreso del run activo" usando `activeTaskId` (que ya es el runId).
5. **`apps/admin-panel/src/features/canvas/canvas-v4.tsx` (`TopologyTab` ~:3484-3539):**
   - **Reusar el `liveStream` YA montado** (`:2089`, `useLiveCanvasStream(!demoMode)`) pasándole `liveStream.liveRunProgress` (y `activeTaskId`) como **prop** a `TopologyTab`. **NO** montar un 2º `useLiveCanvasStream` (abriría un 2º WS).
   - Mantener el poll del baseline (estructura/labels/nodos no-run).
   - **Run-scope:** elegir el run activo = `activeTaskId` (===runId) si está `running`; **descartar** el progreso de runs cuyo runId ≠ activo.
   - Computar un overlay `Record<nodeId, OpenClawCanvasNodeStatus>` desde los `steps` del run activo + el mapeo skill→nodo + la **agregación** (abajo), dentro de un `useMemo` keyed en `liveRunProgress`/`activeTaskId`.
   - **Suprimir** el overlay "en curso" si el run `status !== "running"` (que un run terminado no muestre un paso vivo).
   - Merge: `nodes.map(n => ({...n, status: overlay[n.id] ?? n.status}))` → pasar a `<CanvasFlow>`. **CanvasFlow NO se toca** (ya pulsa/anima desde `node.status`).

## Mapeo skill→nodo + estados (node ids verificados en `packages/domain/src/openclaw-canvas.ts`)
| skill(s) | node.id |
|---|---|
| `suggest_safe_domain` | `proxmox_host` |
| `register_domain_route53`, `wait_for_dns_propagation`(NS/A/DKIM), `upsert_dns_route53`, `configure_email_auth` | `dns_identity` |
| `create_webdock_server`, `wait_server_running`, `bind_webdock_main_domain` | `vps_lxc_plan` |
| `provision_smtp_postfix` | `sender_nodes` |
| `seed_warmup_pool` | `warming_plan` |
| `wait_warmup_initial` | `warming_ramp` |
| `send_real_email` | `sender_nodes` (done) → `reputation_gates` (begins) |

**Nota `wait_for_dns_propagation` aparece 3 veces** (pasos 3/8/11) — todas mapean a `dns_identity`; desambiguar por número de paso si hace falta, pero todas encienden el mismo nodo.

**Estados de nodo (CORRECTO, verificado en `statusToVisual` `canvas-flow.tsx:114-125`):**
- en curso → **`in_progress`** (ámbar, label "en curso"). **NO usar `collecting`** (ese renderiza "midiendo"/info).
- hecho → **`ready`** (verde, "listo").
- falla → **`error`** (rojo + AlertTriangle).
**Agregación por nodo** (varios skills → 1 nodo): cualquier mapeado `error` → `error`; si no, cualquier `in_progress` → `in_progress`; si no, si TODOS los mapeados existentes están `ready`/`done` → `ready`; si no → dejar el `status` baseline del snapshot.
(Opcional, lindo: encender el edge de la transición actual a `in_progress` — el edge ámbar animado ya existe `canvas-flow.tsx:407-434`. No obligatorio.)

## PROHIBIDO
- NO inventar un tipo de evento WS nuevo (`oc.orchestrator.*` como `type`) — el normalizer lo rechaza; gran blast-radius.
- NO abrir un 2º WebSocket (reusar el `liveStream` montado vía prop).
- NO romper el tab Live (el write de `lastAction` queda intacto; el acumulador es aditivo).
- NO tocar `CanvasFlow` (ya anima desde `node.status`), ni el ciclo de WS, ni `evictLiveState`, ni `emitStep`.
- NO pasar `?task=` en la suscripción (el broadcast filtraría los eventos de otros runs… al revés: sin `?task=` recibe todo y vos run-scopeás en el cliente).
- NO meter valores de secretos/tokens en el `progress` del snapshot.

## Cambios — Frontend (2ª vista): Stepper "Progreso del build SMTP · paso X/14"
**Segunda vista, MISMA fuente `liveRunProgress`** (sincronizada con la Topología sin lógica extra — ambas leen el mismo estado). Componente nuevo que lista los **14 pasos en orden** desde el `progress` del run activo (`SmtpRunState.steps` trae los 14 con step/skill/status, incluso `pending`), cada uno con:
- **Estado:** `done`→hecho ✓ (verde); `in_flight`/in_progress→configurando… (ámbar + spinner); `pending`→pendiente (gris); failed→falla (rojo). Reusar los colores/tokens del design system (mismos que `statusToVisual`).
- **Nombre legible** (mapa skill→label abajo) en vez del slug.
- **ETA/heartbeat:** en pasos de espera, duración esperada + heartbeat ("esperando… ~Xmin, normal"); en los demás, la duración real al terminar.
- **Cabecera "paso X/14"** desde `lastCompletedStep`/`currentStep`.
- **Placement:** en la **vista Topología**, como panel lateral/overlay junto al grafo (macro + detalle juntos en pantalla). Reusar el design system. Run-scope idéntico (run activo; si `status!=="running"` mostrar "completado"/"falló"; si no hay run activo, estado vacío "sin build activo").

### Mapa skill → label (es) + ETA típica (para heartbeat, NO timeout duro)
| skill | label | ETA |
|---|---|---|
| suggest_safe_domain | Eligiendo dominio seguro | ~2s |
| register_domain_route53 | Registrando dominio | ~30s |
| wait_for_dns_propagation (NS) | Esperando propagación NS | ~1-10min |
| create_webdock_server | Creando VPS | ~3min |
| wait_server_running | Esperando VPS listo | ~1-3min |
| bind_webdock_main_domain | Vinculando dominio + PTR | ~10s |
| upsert_dns_route53 (A+MX) | Configurando DNS (A/MX) | ~30-60s |
| wait_for_dns_propagation (A) | Esperando propagación A | ~30-90s |
| provision_smtp_postfix | Instalando Postfix + DKIM + TLS | ~90s |
| configure_email_auth | Configurando SPF/DKIM/DMARC | ~5s |
| wait_for_dns_propagation (DKIM) | Esperando propagación DKIM | ~30-60s |
| seed_warmup_pool | Iniciando warmup | ~10s |
| wait_warmup_initial | Calentamiento inicial | minutos |
| send_real_email | Enviando correo de prueba | ~10s |
(Las 3 `wait_for_dns_propagation` se distinguen por número de paso: 3=NS, 8=A, 11=DKIM.)

## DoD (Codex)
1. Implementar A/B/C (Topología) + D (Stepper) exactamente, con subagentes (worker + auditor independiente). Ambas vistas leen el MISMO `liveRunProgress` (sincronizadas por construcción).
2. **Unit tests** (lo testeable): parse de `action`+`targetId`→{runId,step,skill,status} (incl. skill con `:`); el acumulador `liveRunProgress` (started→in_progress, completed→ready, failed→error, run_* status); el seed desde el `progress` del snapshot; la agregación por nodo (varios skills→1 nodo, prioridad error>in_progress>ready); el run-scoping (descarta runId≠activo); el shape del `progress` del snapshot del backend. Correr: `npm --workspace @delivrix/admin-panel run check` (incluir los tests nuevos en el `check`), `node --test` de las suites backend tocadas (`canvas-live*.test.ts`, `orchestrator-smtp.test.ts`), y `npm test`. Reportar counts (nota: `approval-token.test.ts` `/private/tmp` EACCES es artefacto de sandbox, no regresión).
3. `tsc --noEmit` 0 en el panel.
4. Commit atómico: "Animate Canvas topology live from configure_complete_smtp run progress".
5. **Deploy:** gateway restart (por el cambio del snapshot) + panel (arrancar SIEMPRE con `./scripts/delivrix-admin-start.sh` para que el WS tenga token) + `push origin produ` (FF). Si el gateway corre también en Hostinger, sincronizar.
6. **Marcar PENDIENTE DE QA-VISUAL de Juanes:** abrir la Topología durante un `configure_complete_smtp` real y verificar (a) cada nodo pasa a "en curso" (ámbar) al arrancar su paso y a "listo" (verde) al terminar, **en vivo** (no cada 5s); (b) al recargar/reconectar a mitad de run, AMBAS vistas pintan el estado actual al instante (no en blanco); (c) si hay 2 runs, no se mezclan; (d) un run terminado no muestra pasos "en curso"; (e) **el stepper muestra los 14 pasos ticando hecho/configurando/pendiente en vivo, SINCRONIZADO con el grafo** (p.ej. paso "configurando" ↔ su nodo en ámbar al mismo tiempo).

## Reportá
SHA + EXIT/counts de tests + tsc + confirmación de deploy/push, y que NO inventaste tipo de evento, NO abriste 2º WS, NO tocaste CanvasFlow/emitStep/evictLiveState/normalizer, NO metiste secretos en el snapshot. Dejá marcado pendiente de QA-visual.
