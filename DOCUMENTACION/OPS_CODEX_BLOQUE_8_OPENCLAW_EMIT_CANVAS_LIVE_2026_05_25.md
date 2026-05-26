# OPS Codex Bloque 8 — Cablear OpenClaw runtime para emitir canvas-live events

**Fecha:** 2026-05-25
**Worktree:** `/Users/juanescanar/Documents/delivrix app`
**Branch base:** `main` (HEAD post-Bloque 7 canvas-live + commit c76fdb3 del proxy fix)
**Filosofía:** Cerrar el loop. El Bloque 7 dejó la cañería (WSS + endpoints + persistencia + frontend cableado). Falta abrir la llave en el agente para que el panel se llene cuando OpenClaw realmente trabaja.

## Contexto

Diagnóstico observable hoy en `localhost:5173/canvas`:

- Operador escribe en el chat ("Como asi, no puedes enlistarme los 16 dominios?").
- OpenClaw responde por WSS `oc.chat.*` normalmente.
- **Canvas Live queda en "Sin tarea activa" + "Sin propuesta aún"** porque OpenClaw NO emite eventos del shape `oc.task.declare` / `oc.action.now` / `oc.artifact.declare` cuando procesa la interacción.
- Las únicas tareas que aparecen son los smoke tests que Codex emitió manualmente vía `POST /v1/canvas/live/events` durante la validación del Bloque 7.

Frontend (Claude) y backend (Codex) están correctos. Lo que falta es **el agente decidir qué interacciones son "tarea" y emitir los eventos correspondientes**.

## Decisión de diseño antes de implementar

OpenClaw tiene que distinguir 3 tipos de interacción:

1. **Conversación trivial** — saludos, preguntas factuales que el agente puede responder de memoria, aclaraciones. → NO declara tarea. Sigue por el flow normal de `oc.chat.*`.
2. **Tarea operativa** — el operador pide algo accionable (auditar dominios, comparar pricing, generar plan, ejecutar comando). → Declara `oc.task.declare` antes de empezar + emite acciones + artifacts + cierra con `oc.task.update { status: completed }`.
3. **Investigación o reporte** — el operador pide info que requiere lookups, no acción. → Declara tarea, emite reads/api calls, genera artifact tipo `report` editable.

**Heurística MVP:** todo prompt del operador que contiene verbos accionables (`auditar`, `verificar`, `comparar`, `proponer`, `generar`, `ejecutar`, `investigar`, `buscar`, `analizar`) → tarea. Resto → conversación.

Cuando dude, OpenClaw arranca tarea (es menos costoso tener una tarea de más que perder visibilidad).

## Tareas

### T1 — Helper de emisión en el bridge

Crear `bridge/canvas_live_emitter.py` (o equivalente en JS si el bridge es Node) con:

```python
class CanvasLiveEmitter:
    def __init__(self, gateway_base_url: str, actor_id: str):
        self.base = gateway_base_url
        self.actor = actor_id

    def declare_task(self, task_id: str, title: str) -> None:
        """POST /v1/canvas/live/events con oc.task.declare."""

    def update_task(self, task_id: str, status: str) -> None:
        """POST con oc.task.update."""

    def emit_api_call(self, task_id: str, method: str, url: str,
                      status: int, duration_ms: int, response_body: dict | None) -> None:
        """POST con oc.action.now kind=api."""

    def emit_file_op(self, task_id: str, operation: str, path: str,
                     diff_summary: str | None, preview: str | None) -> None:
        """POST con oc.action.now kind=file."""

    def emit_command(self, task_id: str, cmd: str, exit_code: int,
                     stdout: str, stderr: str, duration_ms: int) -> None:
        """POST con oc.action.now kind=command."""

    def declare_artifact(self, task_id: str, artifact_id: str,
                         kind: str, title: str) -> None:
        """POST con oc.artifact.declare."""

    def emit_block(self, artifact_id: str, block_id: str, order: int,
                   kind: str, content: str, status: str) -> None:
        """POST con oc.artifact.block."""

    def stream_chunk(self, artifact_id: str, block_id: str, chunk: str) -> None:
        """POST con oc.artifact.streaming. Throttle a 200ms entre chunks
        para no saturar el WSS si el LLM escupe tokens muy rápido."""
```

Todos los métodos hacen POST a `{gateway_base_url}/v1/canvas/live/events`. Fallar silenciosamente con log a stderr — no romper la conversación si el gateway está offline.

### T2 — Decisor "es tarea o no" en el runtime

En el flow de `openclaw_runtime.process_operator_message(prompt)`:

```python
def process_operator_message(prompt: str, session_id: str) -> AsyncIterator[ChatChunk]:
    is_task = classify_as_task(prompt)

    if is_task:
        task_id = generate_task_id()
        title = summarize_task_title(prompt)  # max 60 chars
        emitter.declare_task(task_id, title)
    else:
        task_id = None

    try:
        # ... flujo normal del agente, pasando task_id a cada skill
        async for chunk in agent.run(prompt, task_id=task_id):
            yield chunk
    finally:
        if task_id:
            emitter.update_task(task_id, "completed")
```

`classify_as_task(prompt)` heurística simple:

```python
TASK_VERBS = [
    "auditar", "verificar", "comparar", "proponer", "generar",
    "ejecutar", "investigar", "buscar", "analizar", "revisar",
    "validar", "consultar", "listar", "monitorear", "diagnosticar"
]

def classify_as_task(prompt: str) -> bool:
    lower = prompt.lower()
    if len(lower.split()) < 4:
        return False  # too short, probablemente saludo o aclaración
    return any(verb in lower for verb in TASK_VERBS)
```

Cuando dude, default a `True` (mejor sobre-emitir que perder visibilidad).

### T3 — Pasar task_id a skills

Cada skill invocada por OpenClaw recibe `task_id` opcional. Cuando hace un API call externo:

```python
async def check_blacklist(domain: str, ip: str, task_id: str | None) -> dict:
    url = f"https://blacklist.spamhaus.org/lookup/{ip}"
    start = time.time()
    response = await http_client.get(url)
    duration_ms = int((time.time() - start) * 1000)
    if task_id:
        emitter.emit_api_call(
            task_id=task_id, method="GET", url=url,
            status=response.status_code,
            duration_ms=duration_ms,
            response_body=response.json() if response.ok else None
        )
    return response.json()
```

Mismo patrón para `read_file`, `write_file`, `exec_ssh_command`, `consult_audit_chain`. Cada uno emite el `oc.action.now` con su `kind` apropiado.

### T4 — Declarar artifact cuando el agente genera plan/reporte

Cuando OpenClaw decide proponer al operador un plan (no respuesta texto), wrapper:

```python
async def propose_artifact(
    task_id: str,
    kind: str,  # "plan" | "proposal" | "template" | "report"
    title: str,
    blocks_iter: AsyncIterator[Block]
):
    artifact_id = generate_artifact_id()
    emitter.declare_artifact(task_id, artifact_id, kind, title)

    order = 0
    async for block in blocks_iter:
        order += 1
        block_id = f"block-{order:02d}"
        if block.is_streaming:
            async for chunk in block.stream():
                emitter.stream_chunk(artifact_id, block_id, chunk)
            emitter.emit_block(artifact_id, block_id, order, block.kind,
                               block.final_content, status="complete")
        else:
            emitter.emit_block(artifact_id, block_id, order, block.kind,
                               block.content, status="complete")
```

El agente decide qué bloques componen el artifact (steps de plan, secciones de reporte, etc.). Los bloques que requieran LLM streaming pasan por `stream_chunk`.

### T5 — Cerrar el loop con approve/reject del operador

Cuando el operador clickea "Aprobar" en el plan, el gateway recibe `POST /v1/canvas/artifact/:id/approve` y debe **notificar al runtime de OpenClaw** que la propuesta fue aprobada para que el agente ejecute los pasos.

Patrón: gateway publica en un topic interno o llama webhook del bridge:

```python
# bridge/runtime_hooks.py
@app.post("/__internal__/artifact-approved")
async def on_artifact_approved(payload: ArtifactApprovedPayload):
    task_id = lookup_task_for_artifact(payload.artifact_id)
    # Re-inyectar al loop de OpenClaw con contexto:
    await openclaw_runtime.resume_with_approval(
        task_id=task_id,
        artifact_id=payload.artifact_id,
        blocks=payload.blocks  # con ediciones del operador si las hubo
    )
```

`resume_with_approval` despierta al agente que estaba esperando y le pasa los blocks finales (que pueden tener ediciones del operador). El agente ejecuta los pasos uno a uno emitiendo `oc.action.now` por cada uno, y termina con `oc.task.update { status: completed }`.

Para reject: análogo con `__internal__/artifact-rejected` + reason. El agente puede proponer otro plan o pedir aclaración al operador.

### T6 — Smoke test end-to-end

Script `scripts/smoke-canvas-live-roundtrip.sh`:

```bash
# 1. Operador manda prompt accionable
curl -X POST http://127.0.0.1:3000/v1/openclaw/chat/send \
  -H "Content-Type: application/json" \
  -d '{"content":"Audita los 16 dominios IONOS contra Spamhaus y proponme un plan de remediación"}'

# 2. Verificar que apareció en /v1/canvas/live/state
sleep 2
curl http://127.0.0.1:3000/v1/canvas/live/state | jq '.tasks[] | select(.title | contains("Audita"))'

# 3. Verificar que llegó al menos 1 oc.action.now de tipo api
wscat -c ws://127.0.0.1:3000/v1/canvas/live/stream &
WSCAT_PID=$!
sleep 10
kill $WSCAT_PID

# 4. Verificar que se declaró artifact tipo "plan"
curl http://127.0.0.1:3000/v1/canvas/live/state | jq '.artifacts[] | select(.kind == "plan")'

# 5. Aprobar el artifact y verificar que ejecuta
ARTIFACT_ID=$(curl -s ... | jq -r '.artifacts[0].artifactId')
curl -X POST http://127.0.0.1:3000/v1/canvas/artifact/$ARTIFACT_ID/approve \
  -d '{"actorId":"operator/smoke","blocks":[]}'

# 6. Verificar que ejecuta y task pasa a completed
sleep 5
curl http://127.0.0.1:3000/v1/canvas/live/state | jq '.tasks[] | select(.taskId == "...") | .status'
```

Done criteria: el script termina con `"completed"` y dejó audit chain crítico con `oc.artifact.approved` + acciones de ejecución.

### T7 — Documentación de skills emisoras

En `docs/openclaw-skills.md` documentar: cada skill nueva debe recibir `task_id` opcional y emitir el evento `oc.action.now` correspondiente. Patrón obligatorio para mantener Canvas Live útil.

## Done criteria

- `npm test` 280+ tests verdes.
- Smoke roundtrip pasa end-to-end.
- En el panel: pides "audita los 16 dominios IONOS" → ves la tarea aparecer en sidebar Canvas Live, las API calls llegando al centro Postman view, el plan construyéndose a la derecha, los botones Aprobar/Rechazar funcionando, y tras aprobar ves la ejecución completándose.
- Doc `OPS_CODEX_BLOQUE_8_RESULT_2026_05_25.md` con SHAs + smoke output + screenshots.

## Coordinación con Claude

Claude trabaja paralelo en otras cosas del MVP (Porkbun frontend, Infrastructure refinements, Domains compare endpoint integration). NO toca:

- `bridge/canvas_live_emitter.py` (nuevo)
- `bridge/runtime_hooks.py` (nuevo)
- `bridge/openclaw_runtime.py` (extender)
- Cada skill que ya existe en `bridge/skills/*.py` (agregar emisión)
- `apps/gateway-api/src/services/canvas-live-bridge.ts` (nuevo, recibe internal hooks)
- Tests del bridge

Una vez Codex pushee, Claude valida visualmente en el panel y refina toasts/empty states si algún edge case sale feo.

## Bloqueo previo

Ninguno. T1-T7 pueden empezar inmediatamente. T5 (resume con approve) requiere que el runtime soporte pausa/resume — si no lo soporta, MVP usa polling del state desde el runtime cada 5s para detectar approvals, y refactor a webhook viene en Bloque 9.
