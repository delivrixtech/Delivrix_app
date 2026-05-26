# OPS Codex Bloque 9 — Canvas Live universal: toda respuesta de OpenClaw es un artifact visual

**Fecha:** 2026-05-26
**Worktree:** `/Users/juanescanar/Documents/delivrix app`
**Branch base:** `main` (HEAD post-Bloque 8 — commits 91d3643 + af8e7bd + 0713a4e)
**Filosofía:** **Toda respuesta de OpenClaw genera artifact en Canvas Live, sin excepción.** Pregunte el operador lo que pregunte, el chat sigue mostrando texto y simultáneamente el Canvas Live se llena con un artifact visual rico (kind detectado, bloques estructurados, acciones contextuales).

## Principio central — no es opcional ni heurístico, es regla

**Cada vez que OpenClaw responde al operador → 1 task nueva + 1 artifact siempre.** No depende de que el prompt tenga verbos especiales, no depende de que el response tenga emoji 📋. Si OpenClaw habló, Canvas Live se llena. Punto.

Lo que cambia es el **kind** del artifact según lo que hizo:

| Cuándo OpenClaw responde con... | Artifact kind | Acciones disponibles |
|---|---|---|
| Propuesta accionable (compra, deploy, config con gates) | `proposal` | Aprobar / Rechazar |
| Plan ordenado de pasos para ejecutar | `plan` | Aprobar / Rechazar |
| Reporte/análisis/inventario informativo | `report` | Pin / Exportar `.md` |
| Template (config, email, dns record) | `template` | Copiar / Pin |
| Respuesta conversacional corta (saludo, aclaración) | `report` minimal | Pin opcional |

**Nada queda fuera del Canvas Live.** Si el operador pregunta "qué hora es" → artifact kind=report con un bloque "Hora actual: 14:32 UTC". Si pregunta "lista de dominios" → artifact kind=report con tabla de dominios. Si pide "propon compra de X" → artifact kind=proposal con secciones + Aprobar.

## Por qué este principio

El operador me dijo textualmente: *"no puedo preguntarle cualquier cosa porque no lo va a trabajar en el canvas live de la manera visual... dale vida a eso, dale un uso profesional"*. Traducción: **el operador espera que Canvas Live trabaje SIEMPRE, no solo cuando el prompt encaje en una heurística**.

Caso real observado 2026-05-26 que disparó este OPS:

- Operador pidió `proponer compra de "channexai.net"` (verbo accionable, prompt perfecto).
- OpenClaw respondió con propuesta de manual de calidad: 📋 + Disponibilidad + Tabla precios + Recomendación + Gates Fase 2 + path archivo guardado.
- Canvas Live quedó vacío: `"Sin propuesta aún"`. El chat tiene todo, Canvas Live nada.

Eso es inaceptable. **Cero excepciones desde este OPS en adelante.**

---

## Arquitectura

### Flow obligatorio del runtime

```python
async def process_operator_message(operator_msg: str, msg_id: str, session_id: str):
    # 1. SIEMPRE crear task. No clasificar. Toda interacción es task.
    task_id = f"task-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-{msg_id[:8]}"
    title = summarize_task_title(operator_msg)  # función LLM-asistida o heurística
    emitter.declare_task(task_id, title, status="running")

    # 2. Stream del response del LLM al chat (igual que hoy)
    response_chunks = []
    async for chunk in agent.run(operator_msg, task_id=task_id):
        response_chunks.append(chunk.text)
        yield chunk
    full_response = "".join(response_chunks)

    # 3. SIEMPRE emitir artifact. extract_artifact() nunca devuelve None.
    artifact = extract_artifact(full_response, operator_msg)
    artifact_id = f"artifact-{task_id}"
    emitter.declare_artifact(
        task_id=task_id,
        artifact_id=artifact_id,
        kind=artifact.kind,
        title=artifact.title or title
    )
    for block in artifact.blocks:
        emitter.emit_block(
            artifact_id=artifact_id,
            block_id=f"block-{block.order:02d}",
            order=block.order,
            kind=block.kind,
            content=block.content,
            editable=(artifact.kind in ("plan", "proposal")),
            status="complete"
        )

    # 4. Cerrar task
    emitter.update_task(task_id, "completed")
```

### `extract_artifact()` — nunca devuelve None

```python
@dataclass
class ExtractedArtifact:
    kind: Literal["proposal", "plan", "template", "report"]
    title: str
    blocks: list[ExtractedBlock]

def extract_artifact(response_md: str, operator_msg: str) -> ExtractedArtifact:
    """
    Detecta kind por patrones en response + intención del operador.
    SIEMPRE devuelve algo. Si no hay estructura clara, devuelve report
    con un único bloque conteniendo todo el response como markdown.
    """
    # 1. Detección de kind (prioridad por especificidad)
    kind = detect_kind(response_md, operator_msg)

    # 2. Extracción de title
    title = extract_title(response_md, operator_msg)

    # 3. Particionado en bloques
    blocks = partition_into_blocks(response_md)

    # 4. Fallback: si solo hay 0 bloques, meter todo el response como block paragraph único.
    if not blocks:
        blocks = [ExtractedBlock(
            order=1, kind="paragraph", content=response_md.strip()
        )]

    return ExtractedArtifact(kind=kind, title=title, blocks=blocks)


KIND_PATTERNS = {
    "proposal": [
        r"📋\s*Propuesta", r"^Propuesta:", r"DRY-RUN", r"doble aprobación",
        r"Gates? para Fase 2", r"Aprobación Humana"
    ],
    "plan": [
        r"📋\s*Plan", r"^Plan\s+de", r"^Pasos?:", r"^Roadmap",
        r"^Implementación:", r"\d+\.\s+[A-Z]"  # listas numeradas con pasos
    ],
    "template": [
        r"📄\s*Template", r"^Template:", r"^```\w+\n",  # bloque de código completo
        r"DKIM\s+key", r"DMARC\s+policy", r"BEGIN PGP"
    ],
    "report": [
        r"📊\s*Reporte", r"^Auditoría", r"^Reporte\s+", r"^Análisis",
        r"^Inventario", r"^Estado\s+(actual|operativo)", r"^Resumen"
    ]
}

PROMPT_KIND_HINTS = {
    "proposal": ["proponer", "propon", "compra", "comprar", "registrar", "configurar"],
    "plan": ["plan", "planificar", "preparar", "roadmap", "implementar", "remediar"],
    "template": ["template", "ejemplo", "snippet", "genera", "muestra el código"],
    "report": ["auditar", "analizar", "investigar", "listar", "muestra", "consulta", "estado"]
}

def detect_kind(response_md: str, operator_msg: str) -> str:
    """Prioridad: response patterns > prompt hints > default 'report'."""
    for kind, patterns in KIND_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, response_md, re.IGNORECASE | re.MULTILINE):
                return kind
    lower_prompt = operator_msg.lower()
    for kind, hints in PROMPT_KIND_HINTS.items():
        if any(hint in lower_prompt for hint in hints):
            return kind
    return "report"  # default safe: read-only, sin botones de aprobación


def partition_into_blocks(response_md: str) -> list[ExtractedBlock]:
    """
    Parte el response en bloques. Cada heading (h1-h3) o emoji-prefixed section
    inicia un nuevo bloque. Las tablas markdown son su propio bloque kind=table_row.
    Los code blocks son bloques kind=code. Resto es paragraph.
    """
    blocks = []
    order = 0
    lines = response_md.split("\n")
    buffer: list[str] = []
    buffer_kind = "paragraph"

    def flush():
        nonlocal order, buffer, buffer_kind
        content = "\n".join(buffer).strip()
        if content:
            order += 1
            blocks.append(ExtractedBlock(
                order=order, kind=buffer_kind, content=content
            ))
        buffer = []
        buffer_kind = "paragraph"

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Heading h1-h3 o emoji section → nuevo bloque
        if re.match(r"^#{1,3}\s+", stripped) or re.match(r"^[📋📌📊📄✅💰🔐🛡️⚠️🧠📍🎯]\s", stripped):
            flush()
            buffer = [line]
            buffer_kind = "title" if i == 0 else "paragraph"
            i += 1
            continue

        # Code block triple-backtick
        if stripped.startswith("```"):
            flush()
            code_lines = [line]
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i])
                i += 1
            if i < len(lines):
                code_lines.append(lines[i])
                i += 1
            order += 1
            blocks.append(ExtractedBlock(
                order=order, kind="code", content="\n".join(code_lines)
            ))
            continue

        # Tabla markdown (línea con | y siguiente con |---|)
        if "|" in stripped and i + 1 < len(lines) and re.match(r"^\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$", lines[i + 1]):
            flush()
            table_lines = [line]
            i += 1
            while i < len(lines) and "|" in lines[i].strip():
                table_lines.append(lines[i])
                i += 1
            order += 1
            blocks.append(ExtractedBlock(
                order=order, kind="table_row", content="\n".join(table_lines)
            ))
            continue

        # Línea normal
        buffer.append(line)
        i += 1

    flush()
    return blocks


def extract_title(response_md: str, operator_msg: str) -> str:
    """Primer heading o frase prominente del response. Fallback: summarize prompt."""
    first_h = re.search(r"^(?:[📋📌📊📄]\s*)?(?:#{1,2}\s+)?(.+)$", response_md.strip().split("\n")[0])
    if first_h:
        title = first_h.group(1).strip()
        title = re.sub(r"^(Propuesta|Plan|Reporte|Template|Análisis|Auditoría):\s*", "", title, flags=re.I)
        return title[:80]
    return summarize_task_title(operator_msg)
```

### `summarize_task_title()` — del prompt al título

```python
def summarize_task_title(operator_msg: str) -> str:
    """
    Heurística simple por patrones del prompt del operador.
    Si no encaja en patrón, devuelve los primeros 60 chars del prompt.
    """
    lower = operator_msg.lower()

    # Pattern: "proponer compra de X" → "Propuesta · X"
    m = re.search(r"compra\s+de\s+[\"']?([^\"'\s]+)[\"']?", lower)
    if m:
        return f"Propuesta · {m.group(1)}"

    # Pattern: "auditar X" → "Auditoría · X"
    m = re.search(r"audit[aoí]r?\s+(?:el|los|las)?\s*([a-z0-9\s.-]{3,40})", lower)
    if m:
        return f"Auditoría · {m.group(1).strip()}"

    # Pattern: "verifica/comprueba/consulta X" → "Verificación · X"
    m = re.search(r"verifica|comprueba|consulta", lower)
    if m:
        # extraer objeto post-verbo
        rest = operator_msg[m.end():].strip(" :,")[:50]
        return f"Verificación · {rest}"

    # Pattern: "lista/muestra X" → "Listado · X"
    m = re.search(r"lista|enlista|muestra|enseña", lower)
    if m:
        rest = operator_msg[m.end():].strip(" :,")[:50]
        return f"Listado · {rest}"

    # Default: primeros 60 chars del prompt
    return operator_msg[:60] + ("…" if len(operator_msg) > 60 else "")
```

---

## Tareas

### T1 — Refactor `process_operator_message()` para emitir SIEMPRE

Como en la arquitectura de arriba. No hay `if is_task` ni heurística que decida si emitir o no. Toda interacción del operador genera task + artifact.

### T2 — Implementar `extract_artifact()` con las funciones de arriba

Archivo nuevo `bridge/artifact_extractor.py`. Tests unitarios con 10+ ejemplos cubriendo: proposal estructurada, plan numerado, reporte con tablas, template con code block, response conversacional corto, response vacío, response con solo párrafo de prosa.

### T3 — Cuando OpenClaw escribe archivo workspace, emitir `oc.action.now kind=file`

Skills como `save_proposal`, `write_audit_log`, `save_template`, `persist_inventory` deben llamar `emitter.emit_file_op(...)` después del write efectivo. Path real del archivo, diff summary, preview primeros 500 chars.

### T4 — Cuando OpenClaw llama API externa o herramienta, emitir `oc.action.now`

Ya está en Bloque 8 pero validar que **todas** las skills lo hacen. Auditar: `check_availability`, `dns_resolve`, `blacklist_lookup`, `whois_query`, `ssh_exec`, `aws_route53_*`, `porkbun_*`, `ionos_*`. Cada una debe emitir su action al task_id corriente.

### T5 — Smoke tests universales

No solo channexai.net. Probar 6 casos distintos con el mismo principio:

```bash
PROMPTS=(
  "proponer compra de delivrix-mail.com"
  "auditar reputación de los 16 dominios IONOS"
  "lista todos los dominios bajo gestión"
  "genera template DKIM para nfcfilings.com"
  "verifica si el kill switch está armado"
  "qué hora es en utc"
)

for prompt in "${PROMPTS[@]}"; do
  RESP=$(curl -s -X POST http://127.0.0.1:3000/v1/openclaw/chat/send \
    -H "Content-Type: application/json" \
    -d "{\"content\":\"$prompt\"}")
  MSG_ID=$(echo "$RESP" | jq -r .msgId)
  sleep 5
  TASK_COUNT=$(curl -s http://127.0.0.1:3000/v1/canvas/live/state | jq "[.tasks[] | select(.taskId | contains(\"$(echo $MSG_ID | cut -c1-8)\"))] | length")
  ARTIFACT_COUNT=$(curl -s http://127.0.0.1:3000/v1/canvas/live/state | jq "[.artifacts[] | select(.taskId | contains(\"$(echo $MSG_ID | cut -c1-8)\"))] | length")
  test "$TASK_COUNT" -ge 1 || (echo "FAIL: no task for '$prompt'" && exit 1)
  test "$ARTIFACT_COUNT" -ge 1 || (echo "FAIL: no artifact for '$prompt'" && exit 1)
  echo "✓ '$prompt' → task + artifact emitidos"
done
```

**Los 6 prompts deben generar 6 tasks + 6 artifacts.** Sin excepción.

### T6 — Documentación

`docs/openclaw-canvas-live.md`:

> Cada respuesta de OpenClaw genera un task + artifact en Canvas Live, sin excepción. El kind del artifact se infiere del contenido (proposal/plan/template/report); si no hay estructura clara, default es report con un solo bloque paragraph. Esto NO es opcional: si tu skill responde texto al operador, debe responder via emit_artifact también. No hay "responses conversacionales que solo viven en chat" — todo se materializa.

---

## Done criteria

- **Los 6 smoke tests del T5 pasan al 100%.** Ningún prompt deja Canvas Live vacío.
- `npm test` 290+ tests verdes (10+ nuevos para artifact_extractor unit tests).
- En el panel: cualquier prompt → task aparece en sidebar en <2s + artifact a la derecha lleno con bloques.
- Artifacts kind=report aparecen con botones "Copiar" / "Exportar .md" (frontend Claude ya implementado).
- Artifacts kind=proposal/plan aparecen con botones "Aprobar" / "Rechazar".
- Doc `OPS_CODEX_BLOQUE_9_RESULT_2026_05_26.md` con SHAs + outputs de los 6 smoke tests + screenshot del panel después de cada prompt.

---

## Coordinación con Claude

Claude trabaja paralelo. NO toca:

- `bridge/openclaw_runtime.py`
- `bridge/artifact_extractor.py` (nuevo)
- `bridge/skills/*.py` (audit + add emit_file_op donde falta)
- Tests del bridge
- Doc del bridge

Una vez Codex pushee, Claude solo verifica visualmente que los 6 casos de smoke se ven bien renderizados. Si algún artifact se ve feo (ej. tabla muy ancha, bloque streaming sin cerrar), refina renderer en `live-tool.tsx`.

---

## Bloqueo previo

Ninguno. T1-T6 pueden empezar inmediatamente.

## Compromiso de calidad

**Cero responses de OpenClaw quedan fuera de Canvas Live después de este OPS.** Si un prompt del operador no genera task + artifact, es bug crítico que regresa a Codex hasta cerrarse.
