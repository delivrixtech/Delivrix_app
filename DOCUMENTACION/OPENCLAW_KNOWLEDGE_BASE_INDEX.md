# OpenClaw — Knowledge Base Index

Fecha: 2026-05-18 (v2.0 expansión 2026-05-18).
Hito rector: `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md`.
Construye sobre: `OPENCLAW_SYSTEM_PROMPT.md`, `OPENCLAW_SKILLS_CATALOG.md`.

## Changelog

- **v1.0** — 3 capas, ChromaDB, decisiones técnicas.
- **v2.0** — Lista exhaustiva archivo por archivo (no categorías), schema formal del chunk metadata, métricas cuantitativas de calidad RAG con umbrales.

## 1. Propósito

Definir literal qué documentación del proyecto entra al contexto del agente y cómo
se carga. Sin knowledge base bien organizada, el agente:

- Reinventa decisiones que ya tomaste (gates, runbooks, prohibiciones).
- Cita docs inexistentes o malinterpreta los que existen.
- Gasta tokens en preámbulos innecesarios o queda sin información clave.

Con knowledge base bien diseñada, el agente cita evidencia con precisión y mantiene
coherencia entre sesiones.

## 2. Las 3 capas de conocimiento

| Capa | Qué contiene | Cómo se carga | Costo en tokens |
| --- | --- | --- | --- |
| **Capa 1 — Núcleo fijo** | Identidad, gates, matriz, skills | Concatenado al `system prompt` al arranque | ~6-8K tokens fijos |
| **Capa 2 — RAG bajo demanda** | Docs HITO_*.md, runbooks, contratos, FASE_*.md | Vector index local, top-K retrieval por query | ~1-3K tokens por query |
| **Capa 3 — Live via skills** | Estado actual del Gateway Delivrix, Webdock, telemetría | Skills tipadas (Doc 3) | Variable, según endpoint |

Esta separación es deliberada: la Capa 1 garantiza que los **gates y la identidad**
nunca se pierdan, aunque el RAG falle o el agente alucine.

## 3. Capa 1 — Núcleo fijo (siempre en contexto)

Archivos concatenados al `system prompt` en el arranque del container:

| Archivo | Por qué siempre | Aprox tokens |
| --- | --- | --- |
| `OPENCLAW_SYSTEM_PROMPT.md` (sección §4 literal) | Define identidad | 1.5K |
| `OPENCLAW_PERMISSIONS_MATRIX.md` | Cada acción se valida contra esto | 2K |
| `OPENCLAW_SKILLS_CATALOG.md` (sólo fichas resumidas) | Sin esto, el agente no sabe qué herramientas tiene | 1K |
| `NORTE_OPERATIVO_DELIVRIX.md` (resumen, no completo) | Los 31 gates | 1.5K |
| `OPENCLAW_DELIVRIX_API_CONTRACT.md` (sección §3-§5) | Endpoints válidos | 1K |

**Total estimado: ~7K tokens fijos por sesión.** Tolerable con context windows
modernos (Claude Sonnet 4.6 maneja 200K).

Build script (Codex implementa):

```bash
# scripts/openclaw/build-system-context.sh
cat \
  DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md \
  DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md \
  DOCUMENTACION/OPENCLAW_SKILLS_CATALOG.md \
  DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md \
  DOCUMENTACION/OPENCLAW_DELIVRIX_API_CONTRACT.md \
  > /openclaw/context/system.txt
```

Se ejecuta en deploy + cada vez que un doc del núcleo cambia.

## 4. Capa 2 — RAG bajo demanda

### 4.1 Qué docs entran al índice

| Categoría | Docs |
| --- | --- |
| Hitos OpenClaw conceptuales | `HITO_4_1` a `HITO_4_5_*.md` |
| Hitos panel admin | `HITO_5_4*`, `HITO_5_5*`, `HITO_5_6`, `HITO_5_7`, `HITO_5_8`, `HITO_5_9`, `HITO_5_10*` |
| Fases | `FASE_2_*`, `FASE_3_*`, `FASE_4_*`, `FASE_5_*` |
| Runbooks operativos | `OPENCLAW_RUNBOOKS_OPERATIONAL.md` (Doc 7) + cualquier `*-runbook.md` |
| Auditoría y compliance | `HITO_4_5_*.md`, `ESTANDARES_INGENIERIA.md`, `INDICE_DOCUMENTACION.md` |
| Pencil dumps | `DOCUMENTACION/pencil-dumps/*.md` (referencia UI, baja prioridad) |
| Snapshots/auditorías ad-hoc | `HITO_5_10_VARIANTES_PENCIL.md`, `HITO_5_10_CIERRE.md`, etc. |

**No entran al índice:**

- Scripts de commit (`COMMIT_FASE_*.md`) — son operativos de git, no doctrina.
- Archivos de ops temporales (`OPS_OPENCLAW_DIAGNOSE_AGENT_FAILED.md`) — son
  one-shot, no fuente de verdad permanente.
- Release docs (`RELEASE_HITO_*.md`) — operativos.

### 4.2 Tooling

| Pieza | Decisión |
| --- | --- |
| Vector DB | ChromaDB embebido en el container OpenClaw (no requiere infra extra) |
| Embedding model | `text-embedding-3-small` (OpenAI) o el default de Anthropic si Hostinger lo expone. Sin elección compleja |
| Chunking | Por encabezado de nivel 2 (`## `), max 1500 tokens por chunk, overlap 150 |
| Retrieval | Top 5 chunks por query, similarity cutoff 0.55 |
| Reranking | Sin reranking en MVP. Si la calidad es mala, evaluamos después |

### 4.3 Cómo el agente invoca el RAG

Cuando el LLM razona y necesita contexto extra, llama implícitamente la skill
`kb-search` (plugin TS, no `SKILL.md`):

```typescript
const chunks = await kb.search({
  query: "qué dice el runbook de pausa de IP caliente",
  topK: 5,
  collection: "delivrix-docs"
});
// El LLM recibe los chunks como tool result, los cita con sus refs.
```

Cada chunk retornado trae `docPath` y `sectionAnchor` para que el agente cite
así: *"según `OPENCLAW_RUNBOOKS_OPERATIONAL.md §3.2`..."*.

## 5. Capa 3 — Live via skills

Datos que NO se preindexan porque cambian en runtime:

| Dato | Skill que lo trae |
| --- | --- |
| Inventario Webdock actual | `webdock-inventory-sync` (Doc 3 §3.4) |
| Estado canvas Delivrix | `delivrix-fleet-ops` |
| Alertas críticas en curso | `delivrix-alert-ops` |
| Audit log último N eventos | `delivrix-alert-ops` |
| Drift detectado | `drift-monitor` |

Regla: si el dato cambia más rápido que el ciclo de reindex (Capa 2 reindexa
nightly), va por skill, no por RAG.

## 6. Frecuencia de actualización

| Capa | Cuándo se actualiza | Disparador |
| --- | --- | --- |
| Capa 1 (núcleo) | Cada cambio en sus 5 archivos fuente | Commit que toca docs del núcleo + redeploy container |
| Capa 2 (RAG) | Nightly cron `0 3 * * *` UTC | Job en container que rescanea `DOCUMENTACION/*.md`, calcula diff vs índice, reindexa lo cambiado |
| Capa 3 (live) | Por query (no se cachea) o cache 30s en skill | Implícito al invocar skill |

El cron del RAG audita su run con `oc.kb.reindex_completed` indicando archivos
cambiados y tokens consumidos en embeddings.

## 7. Cómo se entrega el repo al container

Dos opciones, decidimos en deploy:

### Opción A — Bind mount (recomendado para MVP)

```bash
docker run -v /path/to/Delivrix_app/DOCUMENTACION:/openclaw/docs:ro ...
```

El container ve los docs en `/openclaw/docs/` read-only. El cron del RAG lo lee
desde ahí. Pros: simple, sin sync. Contras: el container debe correr en una VPS
que tenga acceso al repo.

### Opción B — Git pull en el container

```bash
docker exec openclaw-dtsf-openclaw-1 sh -c "cd /openclaw/repo && git pull"
```

Cada nightly. Pros: aislamiento. Contras: requiere SSH key del repo en el container.

**MVP: Opción A si el agente vive cerca del repo. Opción B si vive remoto.**
Decisión se confirma en deploy con el operador.

## 8. Gates duros

- La Capa 1 nunca pasa de 10K tokens. Si crece más, se promueven secciones a Capa 2.
- La Capa 2 sólo indexa docs versionados en git, nunca chats ni archivos efímeros.
- El RAG nunca expone documentos fuera de `DOCUMENTACION/*.md` (no lee `apps/`,
  `packages/`, ni `node_modules`).
- Si el embedding model cambia, se reindexa completo y se bumpa
  `knowledgeBaseVersion`.
- El agente cita siempre con `docPath` y `sectionAnchor`. Si no puede citar,
  responde "no encuentro respaldo documental, no afirmo".

## 9. Lista exhaustiva — archivos al RAG (v2.0)

Inventario literal de `DOCUMENTACION/*.md` con clasificación de inclusión.
Snapshot 2026-05-18.

### 9.1 SÍ indexar (Capa 2 RAG)

| Archivo | Prioridad | Tags |
| --- | --- | --- |
| `NORTE_OPERATIVO_DELIVRIX.md` | crítica | norte, gates, doctrina |
| `RESUMEN_RUTA_PROYECTO.md` | crítica | overview, arquitectura |
| `ROADMAP_PROYECTO.md` | alta | planning |
| `ANALISIS_CRITICO_ROADMAP.md` | alta | planning, riesgos |
| `ARQUITECTURA_BASE_1.md` | alta | arquitectura |
| `ESTANDARES_INGENIERIA.md` | crítica | estándares, append-only, código |
| `INDICE_DOCUMENTACION.md` | media | navegación |
| `FRONTEND_DESIGN_SYSTEM.md` | media | UI tokens |
| `FRONTEND_UX_CONTRACT_GUIDE.md` | alta | contract-first, GET-only |
| `FASE_2_ADMIN_OVERVIEW.md` | media | fase 2 |
| `FASE_2_HEALTH_CHECKS.md` | alta | health, monitoring |
| `FASE_2_KILL_SWITCH.md` | crítica | kill switch |
| `FASE_2_METRICAS_BASICAS.md` | media | KPIs |
| `FASE_2_MOCK_INGESTION_BOUNCES_COMPLAINTS.md` | media | mock data |
| `FASE_2_PIPELINE_WEBDOCK.md` | alta | webdock |
| `FASE_2_RATE_LIMITS.md` | alta | rate limit, mail-policy |
| `FASE_2_RESULTADOS_SIMULADOS.md` | media | send-results |
| `FASE_2_RUNBOOK_OPERATIVO.md` | crítica | runbook |
| `FASE_2_SENDER_NODE_MANUAL_CONTROLS.md` | alta | sender-node |
| `FASE_2_STUCK_JOB_RECOVERY.md` | alta | stuck-jobs |
| `FASE_3_INFRAESTRUCTURA_PROPIA.md` | alta | infra, Proxmox |
| `FASE_4_OPENCLAW_INFRAESTRUCTURA.md` | crítica | OpenClaw conceptual |
| `FASE_5_MVP_DEMOSTRABLE.md` | alta | MVP |
| `HITO_4_0_ALINEACION_CONTROL_PLANE.md` | alta | control plane |
| `HITO_4_1_OPENCLAW_ONBOARDING.md` | crítica | onboarding |
| `HITO_4_2_CLUSTER_TOPOLOGY_PLANNER.md` | alta | topology |
| `HITO_4_3_PROVISIONING_DRY_RUN.md` | crítica | dry-run |
| `HITO_4_4_OPENCLAW_SCHEDULER_SKILLS.md` | crítica | scheduler, skills conceptuales |
| `HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md` | crítica | permisos, runbook |
| `HITO_5_0_DEMO_BLUEPRINT_REVISION_PATRONES.md` | media | demo |
| `HITO_5_1_DEMO_RUNNER_LOCAL.md` | media | demo runner |
| `HITO_5_2_OPENCLAW_INCIDENTE_SIMULADO.md` | alta | incidente, simulación |
| `HITO_5_3_DEMO_REPORT_FINAL.md` | media | demo report |
| `HITO_5_4_ADMIN_PANEL_VISUAL_ARQUITECTURA.md` | alta | panel admin |
| `HITO_5_4A_ADMIN_PANEL_READ_ONLY.md` | alta | GET-only |
| `HITO_5_4B_ADMIN_PANEL_WORKFLOW.md` | alta | workflow |
| `HITO_5_4C_ADMIN_CLUSTERS_OPENCLAW_LEARNING.md` | alta | clusters, learning |
| `HITO_5_5_AUDITORIA_FRONTEND_UI_PROCESOS.md` | media | UX |
| `HITO_5_5A_CANVAS_OPENCLAW_TELEMETRIA_HARDWARE.md` | crítica | canvas, telemetría |
| `HITO_5_6_CONTRATOS_CANVAS_HARDWARE_ML_DEVOPS.md` | crítica | contratos |
| `HITO_5_7_ADMIN_PANEL_REACT_CANVAS.md` | alta | React canvas |
| `HITO_5_8_COLLECTOR_SUPERVISADO_READ_ONLY.md` | alta | collector |
| `HITO_5_9_INGESTA_MANUAL_SNAPSHOT_UX.md` | media | manual snapshot |
| `BACKLOG_CONTRATOS_5_11.md` | media | backlog 5.11 |
| `OPENCLAW_PERMISSIONS_MATRIX.md` | crítica | matriz |
| `OPENCLAW_SKILLS_CATALOG.md` | crítica | skills |
| `OPENCLAW_DELIVRIX_API_CONTRACT.md` | crítica | contract API |
| `OPENCLAW_SYSTEM_PROMPT.md` | crítica | prompt |
| `OPENCLAW_RUNBOOKS_OPERATIONAL.md` | crítica | runbooks |
| `OPENCLAW_AUDIT_INTEGRATION.md` | crítica | audit |
| `OPENCLAW_KNOWLEDGE_BASE_INDEX.md` | media | self-reference |
| `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md` | crítica | rector hito 5.11.B |
| `runbooks/warming-step-runbook.md` | crítica | runbook |
| `runbooks/pause-ip-runbook.md` | crítica | runbook |
| `runbooks/register-sender-node-local-runbook.md` | alta | runbook |
| `runbooks/rotate-dns-record-runbook.md` | media | runbook bloqueado |
| `runbooks/incident-quarantine-runbook.md` | crítica | runbook |
| `runbooks/daily-report-runbook.md` | media | runbook |
| `skills/delivrix-fleet-ops/SKILL.md` | crítica | skill literal |
| `skills/delivrix-alert-ops/SKILL.md` | crítica | skill literal |
| `skills/delivrix-report-ops/SKILL.md` | crítica | skill literal |
| `skills/webdock-inventory-sync/SKILL.md` | alta | skill literal |
| `skills/drift-monitor/SKILL.md` | crítica | skill literal |

Total: **63 archivos** indexados.

### 9.2 NO indexar

| Archivo | Razón |
| --- | --- |
| `HITO_5_10_*.md` (3 archivos cierre Hito UI) | Operacional UI, no doctrina del agente |
| `pencil-dumps/*.md` | Referencia visual UI, ruido para agente |
| `OPS_OPENCLAW_DIAGNOSE_AGENT_FAILED.md` | Doc one-shot operativa, no doctrina |
| `COMMIT_FASE_*.md` | Scripts de git |
| `RELEASE_HITO_*.md` | Operativos de release |

## 10. Schema del chunk metadata (formal)

Cuando un `.md` se chunkea para indexar, cada chunk tiene este metadata
asociado en ChromaDB:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["docPath", "sectionAnchor", "chunkIndex", "priority", "tags", "tokenCount", "indexedAt"],
  "properties": {
    "docPath":        { "type": "string", "description": "Path relativo desde DOCUMENTACION/" },
    "sectionAnchor":  { "type": "string", "description": "## Sección o similar, slugificado" },
    "chunkIndex":     { "type": "integer", "minimum": 0 },
    "priority":       { "type": "string", "enum": ["crítica", "alta", "media", "baja"] },
    "tags":           { "type": "array", "items": { "type": "string" }, "maxItems": 6 },
    "tokenCount":     { "type": "integer", "minimum": 1, "maximum": 1500 },
    "indexedAt":      { "type": "string", "format": "date-time" },
    "docVersion":     { "type": "string", "description": "git SHA del commit que indexó" },
    "embeddingModel": { "type": "string", "description": "Modelo usado para embedding" }
  }
}
```

Ejemplo de chunk almacenado:

```json
{
  "id": "doc_OPENCLAW_PERMISSIONS_MATRIX__sec_3-1__chunk_0",
  "embedding": [0.012, -0.045, ...],
  "document": "## 3.1 Lectura (allowed_read_only) ...",
  "metadata": {
    "docPath": "OPENCLAW_PERMISSIONS_MATRIX.md",
    "sectionAnchor": "3-1-lectura-allowed-read-only",
    "chunkIndex": 0,
    "priority": "crítica",
    "tags": ["matriz", "lectura", "permisos"],
    "tokenCount": 980,
    "indexedAt": "2026-05-18T03:00:00Z",
    "docVersion": "a1b2c3d",
    "embeddingModel": "text-embedding-3-small"
  }
}
```

## 11. Métricas de calidad RAG (umbrales aceptables)

CI nightly mide y emite audit `oc.kb.quality_check`:

| Métrica | Definición | Umbral mínimo aceptable | Acción si bajo umbral |
| --- | --- | --- | --- |
| `recall@5` | % de queries de test donde el chunk relevante está en top 5 | 80% | Alerta + tunear chunking |
| `precision@5` | % de chunks devueltos que son realmente relevantes | 60% | Considerar reranking |
| `latency_p95_ms` | Latencia p95 del retrieval | 800ms | Investigar índice o reducir top-K |
| `chunks_with_evidence_citation` | % de respuestas del agente con `oc.read.*` evidencia citada | 95% | Bug del agente, refinar prompt |
| `chain_integrity` | Hash chain del audit del KB (Doc 8) | 100% | Bloquear writes + investigar |
| `reindex_duration_s` | Tiempo de reindex nightly completo | < 600s | Investigar tamaño de docs |

### 11.1 Test set para evaluación

`scripts/kb/eval-recall.ts` corre 30 queries representativas contra el índice
y mide recall@5. Las queries cubren:

```
Q01: "qué dice el norte sobre SMTP real?"          → esperado: NORTE_OPERATIVO §gates SMTP
Q02: "cómo funciona el kill switch?"               → esperado: HITO_4_5 §kill switch + FASE_2_KILL_SWITCH
Q03: "qué pasos tiene el warming step runbook?"    → esperado: runbooks/warming-step-runbook.md §Steps
Q04: "cuántas firmas necesita pausar una IP?"      → esperado: runbooks/pause-ip-runbook.md §Quién aprueba
Q05: "qué hace la skill drift-monitor?"            → esperado: skills/drift-monitor/SKILL.md §Propósito
Q06: "qué categorías tiene la permissions matrix?" → esperado: OPENCLAW_PERMISSIONS_MATRIX §2
...
Q30: "cuál es el formato del audit event?"         → esperado: OPENCLAW_AUDIT_INTEGRATION §3
```

El set se mantiene en `scripts/kb/eval-queries.json` y se versiona en git.
Cada query tiene la respuesta esperada (docPath + sectionAnchor) y la
evaluación es exact-match contra los metadata de los top 5 chunks.

### 11.2 Cómo se reportan las métricas

Cada reindex nightly:

1. Reindexa lo cambiado vs ayer.
2. Corre `eval-recall.ts` contra el nuevo índice.
3. Emite audit `oc.kb.quality_check` con:
   ```json
   {
     "metadata": {
       "recall_at_5": 0.83,
       "precision_at_5": 0.71,
       "latency_p95_ms": 620,
       "reindex_duration_s": 145,
       "chunks_total": 1042,
       "chunks_added": 27,
       "chunks_removed": 4
     }
   }
   ```
4. Si alguna métrica baja del umbral → bug Notion severity High.

## 12. Referencias

- `OPENCLAW_SYSTEM_PROMPT.md` (Doc 5 — entra como parte de Capa 1)
- `OPENCLAW_PERMISSIONS_MATRIX.md` (Doc 2 — entra como parte de Capa 1)
- `OPENCLAW_SKILLS_CATALOG.md` (Doc 3 — define skills de Capa 3 y `kb-search`)
- `OPENCLAW_RUNBOOKS_OPERATIONAL.md` (Doc 7 — entra a Capa 2)
- `OPENCLAW_AUDIT_INTEGRATION.md` (Doc 8 — define `oc.kb.reindex_completed`)
- `DOCUMENTACION/INDICE_DOCUMENTACION.md` (el índice oficial de documentos del repo)
