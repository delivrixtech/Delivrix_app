# OPS Codex Bloque 7 — Canvas Live events (tasks + actions + artifacts)

**Fecha:** 2026-05-25
**Worktree:** `/Users/juanescanar/Documents/delivrix app`
**Branch base:** `main` (HEAD post-Bloque 6 Porkbun)
**Filosofía:** El backend emite eventos estructurados sobre el trabajo del agente en tiempo real. Frontend (Claude) los renderiza como herramienta funcional (Postman view + plan editable). Tras 13 iteraciones de diseño, este es el contrato definitivo.

## Contexto

El Canvas Live del panel admin va a mostrar 3 zonas en paralelo:
- **Sidebar de tareas** — todas las tareas/agentes activos.
- **Postman view central** — la API call REAL que OpenClaw está haciendo ahora, con request/response.
- **Plan editable derecho** — el artifact (plan/propuesta/template) que el agente construye, con bloques click-to-edit.

El backend debe emitir los eventos correctos para poblar esas 3 zonas via WSS. El audit chain sigue capturando todo, pero estos eventos son una proyección estructurada y específica para el panel — no contaminan el audit chain.

Coordinación con Claude: Claude trabaja **paralelo** en `apps/admin-panel/src/features/canvas/canvas-v4.tsx` reemplazando el contenido de LiveTab con el componente `LiveTool`. Codex NO toca ese archivo.

## Tareas

### T1 — Nuevo topic WSS `canvas-live`

Agregar al gateway-api WSS un topic adicional `canvas-live` (`/v1/openclaw/chat/stream` ya existe para chat; ahora paralelo abrir `/v1/canvas/live/stream` o reusar el mismo conn con tipo discriminado).

Recomendado: nuevo endpoint dedicado para mantener separation of concerns:
- `GET /v1/canvas/live/stream` → WSS upgrade, server-sent events de los 4 tipos abajo.

Suscripción opcional con query `?task=auditoria-ionos-2026-05-25` si querés solo una tarea. Sin filtro = todos los eventos de todas las tareas.

### T2 — Evento `oc.task.declare` / `oc.task.update`

Cuando OpenClaw arranca una nueva tarea (recibe un prompt del operador y decide planear), emite:

```json
{
  "type": "oc.task.declare",
  "taskId": "auditoria-ionos-2026-05-25-1701",
  "title": "Auditoría dominios IONOS",
  "status": "running",
  "createdAt": "2026-05-25T17:01:18Z",
  "actorId": "openclaw/openclaw-hostinger-prod"
}
```

Updates de estado:

```json
{
  "type": "oc.task.update",
  "taskId": "auditoria-ionos-2026-05-25-1701",
  "status": "awaiting_approval" | "idle" | "completed" | "failed",
  "updatedAt": "2026-05-25T17:01:39Z"
}
```

Status posibles: `running`, `idle`, `awaiting_approval`, `completed`, `failed`.

### T3 — Evento `oc.action.now`

Por cada API call externa o lectura significativa que OpenClaw haga DURANTE una tarea, emite:

```json
{
  "type": "oc.action.now",
  "taskId": "auditoria-ionos-2026-05-25-1701",
  "kind": "api",
  "method": "GET",
  "url": "https://blacklist.spamhaus.org/lookup/74.208.236.98",
  "status": 200,
  "durationMs": 1240,
  "responseBytes": 142,
  "responseBody": {
    "ip": "74.208.236.98",
    "domain": "corpyearlyreport.com",
    "listed": false,
    "lists": [],
    "queriedAt": "2026-05-25T17:01:23Z"
  },
  "next": {
    "kind": "api",
    "method": "GET",
    "url": "https://blacklist.spamhaus.org/lookup/74.208.236.214",
    "context": "nfcfilings.com"
  },
  "occurredAt": "2026-05-25T17:01:23Z"
}
```

`kind` posibles: `api` (HTTP request), `file` (escribir/leer archivo del agente), `audit` (event interno al audit chain), `command` (ejecutar SSH/shell).

Para `kind: "file"`:
```json
{
  "type": "oc.action.now",
  "taskId": "...",
  "kind": "file",
  "operation": "write",
  "path": "/var/openclaw/state/auditoria-1701.json",
  "diffSummary": "+ 23 lines · - 0 lines",
  "preview": "{\n  \"completedDomains\": 14,\n  \"...\": \"...\"\n}",
  "occurredAt": "..."
}
```

Para `kind: "command"`:
```json
{
  "type": "oc.action.now",
  "taskId": "...",
  "kind": "command",
  "cmd": "dig +short TXT _dmarc.corpyearlyreport.com",
  "exitCode": 0,
  "stdout": "",
  "stderr": "",
  "durationMs": 312,
  "occurredAt": "..."
}
```

**Frecuencia:** un evento por cada API call / file op / command. Si son muchos en paralelo (ej. 16 dominios), emitir uno por uno conforme se completan, NO en batch al final. El frontend reemplaza el "now" con cada evento nuevo.

**No contamina audit chain:** estos eventos son SOLO para el WSS canvas-live. El audit chain canónico sigue con su contrato propio (oc.audit.*, riskLevel, hash, etc.).

### T4 — Evento `oc.artifact.declare` + bloques

Cuando OpenClaw empieza a generar un plan, propuesta, template o reporte para una tarea, emite:

```json
{
  "type": "oc.artifact.declare",
  "taskId": "auditoria-ionos-2026-05-25-1701",
  "artifactId": "plan-remediacion-spf-1701",
  "kind": "plan" | "proposal" | "template" | "report",
  "title": "Remediar autenticación de 5 dominios",
  "editable": true,
  "createdAt": "..."
}
```

Después emite bloques uno a uno:

```json
{
  "type": "oc.artifact.block",
  "artifactId": "plan-remediacion-spf-1701",
  "blockId": "step-01",
  "order": 1,
  "kind": "step" | "title" | "paragraph" | "table_row" | "code",
  "content": "Generar par de claves DKIM para cada dominio incompleto",
  "editable": true,
  "status": "complete" | "streaming",
  "occurredAt": "..."
}
```

Para bloques que se construyen con streaming (LLM token-by-token):

```json
{
  "type": "oc.artifact.streaming",
  "artifactId": "plan-remediacion-spf-1701",
  "blockId": "step-04",
  "chunk": "Validar con dig que el TXT ",
  "occurredAt": "..."
}
```

El frontend acumula chunks y muestra cursor parpadeante hasta que llega `oc.artifact.block` con `status: "complete"` para ese blockId.

### T5 — Endpoints approve/reject

Cuando el operador hace click en "Aprobar" o "Rechazar" en el plan editable:

```
POST /v1/canvas/artifact/:artifactId/approve
Body: {
  "actorId": "operator/juanes",
  "blocks": [
    { "blockId": "step-01", "content": "..." },
    { "blockId": "step-02", "content": "..." }
  ]
}
Response: { "ok": true, "executionId": "exec-1234" }
```

```
POST /v1/canvas/artifact/:artifactId/reject
Body: { "actorId": "operator/juanes", "reason": "..." }
Response: { "ok": true }
```

Click-to-edit inline: cuando el operador modifica un bloque en el frontend (contenteditable), el frontend hace:

```
PATCH /v1/canvas/artifact/:artifactId/block/:blockId
Body: { "content": "nuevo contenido", "actorId": "..." }
Response: { "ok": true, "updatedAt": "..." }
```

Estos endpoints SÍ generan audit events críticos (`oc.artifact.approved`, `oc.artifact.block_edited`, `oc.artifact.rejected`).

### T6 — Tests

`apps/gateway-api/src/routes/canvas-live.test.ts`:
- WSS conecta y recibe eventos en orden.
- Filtro por taskId funciona.
- oc.action.now con kind=api/file/command, todos serializan bien.
- Streaming acumula chunks y cierra con block status=complete.
- approve/reject endpoints validan actorId, emiten audit events, persisten en estado.
- Click-to-edit PATCH actualiza el bloque sin disparar approve.

### T7 — Persistencia del estado de tareas

Estado del Canvas Live persiste para sobrevivir reinicio del gateway:
- `state/canvas-live/tasks.jsonl` — append-only de declare/update.
- `state/canvas-live/artifacts.jsonl` — append-only de bloques.
- Endpoint `GET /v1/canvas/live/state` → snapshot actual (todas las tareas activas + artifacts pendientes) para que un cliente nuevo conozca el estado al conectar (antes de subscribirse al stream).

### T8 — Documentación contract

Actualizar `packages/domain/src/canvas-live.ts` con TypeScript interfaces de los 5 tipos de eventos. Claude los importa en el frontend.

## Done criteria

- `npm test` 245+ tests verdes (10 nuevos para canvas-live).
- WSS `/v1/canvas/live/stream` conecta y emite eventos al smoke test.
- OpenClaw emite los 4 eventos durante una auditoría real (no mock).
- Endpoints approve/reject responden 200 + escriben audit events.
- `state/canvas-live/*.jsonl` se rellena correctamente.
- Doc `OPS_CODEX_BLOQUE_7_RESULT_2026_05_25.md` con SHAs + smoke curls + ejemplo de stream WSS capturado con wscat.

## Coordinación con Claude

Claude trabaja **paralelo** en:
- `apps/admin-panel/src/features/canvas/canvas-v4.tsx` (reemplaza contenido de LiveTab)
- `apps/admin-panel/src/features/canvas/live-tool.tsx` (nuevo componente)
- `apps/admin-panel/src/features/canvas/demo-agent-run.ts` (adapta dataset al nuevo shape)
- `apps/admin-panel/src/shared/api/canvas-live-client.ts` (cliente WSS para el nuevo topic)

Codex toca SOLO:
- `apps/gateway-api/src/routes/canvas-live.ts` (nuevo)
- `apps/gateway-api/src/services/canvas-live-events.ts` (nuevo)
- `apps/gateway-api/src/services/openclaw-bridge.ts` (extender para emitir los eventos)
- `packages/domain/src/canvas-live.ts` (nuevo contract)
- `apps/gateway-api/src/main.ts` (registrar router + WSS handler)
- `state/canvas-live/*.jsonl` (storage)
- Tests

Ningún conflicto entre frentes. Claude puede merge cuando Codex pushee.

## Bloqueo previo

Ninguno. T1-T6 pueden empezar inmediatamente. T7 (persistencia) requiere alineación con el patrón del audit chain ya existente.
