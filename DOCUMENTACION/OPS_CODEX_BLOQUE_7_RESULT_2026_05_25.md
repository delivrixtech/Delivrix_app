# OPS Codex Bloque 7 Result - Canvas Live Events

Fecha: 2026-05-25
Commit: ver SHA final en `git log -1 --oneline` / respuesta de cierre.

## Estado

Cerrado. El gateway expone una proyección live separada del audit chain para tareas, acciones y artifacts del Canvas.

## Implementado

- WSS dedicado:
  - `/v1/canvas/live/stream`
  - Filtro opcional: `/v1/canvas/live/stream?task=<taskId>`
- Snapshot:
  - `GET /v1/canvas/live/state`
  - `GET /v1/canvas/live/state?task=<taskId>`
- Ingest interno OpenClaw:
  - `POST /v1/canvas/live/events`
  - Requiere `Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}` cuando el token existe.
- Mutaciones de artifact:
  - `POST /v1/canvas/artifact/:artifactId/approve`
  - `POST /v1/canvas/artifact/:artifactId/reject`
  - `PATCH /v1/canvas/artifact/:artifactId/block/:blockId`
- Persistencia append-only:
  - `state/canvas-live/tasks.jsonl`
  - `state/canvas-live/artifacts.jsonl`
- Contratos TypeScript:
  - `packages/domain/src/canvas-live.ts`
- Tests:
  - `apps/gateway-api/src/routes/canvas-live.test.ts`

## Eventos Soportados

- `oc.task.declare`
- `oc.task.update`
- `oc.action.now` con `kind=api|file|audit|command`
- `oc.artifact.declare`
- `oc.artifact.block`
- `oc.artifact.streaming`

## Auditoría

Los eventos live no escriben audit chain. Solo las acciones humanas sobre artifacts escriben auditoría crítica:

- `oc.artifact.approved`
- `oc.artifact.rejected`
- `oc.artifact.block_edited`

## Validación

Tests:

```bash
node --test apps/gateway-api/src/routes/canvas-live.test.ts
npm test
```

Resultado:

- Canvas live focalizado: 10 pass.
- Suite completa: 278 pass.

Smoke HTTP:

```bash
POST /v1/canvas/live/events
```

Resultado:

```json
{
  "ok": true,
  "eventCount": 3,
  "types": [
    "oc.task.declare",
    "oc.artifact.declare",
    "oc.artifact.block"
  ]
}
```

Snapshot:

```json
{
  "tasks": 1,
  "artifacts": 1,
  "firstBlock": "Validar stream canvas-live editado"
}
```

PATCH block:

```json
{
  "ok": true,
  "updatedAt": "2026-05-26T01:37:31.538Z"
}
```

Approve:

```json
{
  "ok": true,
  "executionId": "exec-43432915-0679-4c58-9056-f810145cc281"
}
```

WSS capture:

`wscat` no está instalado en esta máquina. Se validó el stream con `node --env-file=.env.local` y `globalThis.WebSocket`:

```json
{"type":"oc.task.declare","taskId":"smoke-wss-001"}
```

Persistencia local generada por smoke:

```text
2 state/canvas-live/tasks.jsonl
5 state/canvas-live/artifacts.jsonl
```

## Notas

- Se agregó `state/canvas-live/*.jsonl` a `.gitignore`.
- Codex no tocó `apps/admin-panel/src/features/canvas/canvas-v4.tsx`.
- Los JSONL runtime quedan fuera del commit.
