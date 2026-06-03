# Codex — PoC Agente Grounded (Workflow determinístico + RAG-gated memory)

> Esto NO es una "fase" del roadmap (no confundir con Fase 0/1 del ROADMAP_AUTONOMIA). Es el **PoC de implementación del ADR `2026-06-03-arquitectura-agente-local-mastra-rag.md`** — el primer slice ejecutable y medible.

> Copiar/pegar a Codex. Adjuntar `DOCUMENTACION/decisiones/2026-06-03-arquitectura-agente-local-mastra-rag.md` (el ADR es la fuente de verdad). **Nada de esto es opcional.**

---

## ROL Y MISIÓN

Eres el **orquestador técnico** del PoC del agente grounded de Delivrix (implementa el ADR 2026-06-03). Misión: hacer que el agente **deje de divagar** y **deje de consultar mal su memoria**, ejecutando el PoC del ADR con **pruebas reales y medibles**. No es una refactorización cosmética: es convertir el flujo de provisión SMTP en un **workflow determinístico grounded** y la recuperación de memoria en un **RAG con gate de confianza**, manteniendo el gobierno intacto.

**No trabajás solo. Es OBLIGATORIO desplegar subagentes expertos** y un **auditor de errores** que mida e imprima fallas en cada paso.

## ORQUESTACIÓN MULTI-AGENTE (obligatoria)

Desplegá estos subagentes. Cada track tiene un owner; QA y el Auditor de Errores son transversales.

- **AI Engineer Senior** — diseño del workflow determinístico, grounding agéntico (ReAct/verify-after-step), gate de retrieval CRAG, calibración de scoring, prompts de paso acotados.
- **Backend Senior** — Postgres/migraciones, episodic-scratch, exactly-once, write-gate, integración Mastra à la carte, tools.
- **Full-Stack Senior** — visibilidad en Canvas Live del estado del workflow + decisiones del gate de memoria + ApprovalGate (suspend/resume).
- **QA Senior** — golden set, graders (outcome + tool-calls + faithfulness), `pass^k`, suites node:test, regression en CI.
- **Auditor de Errores Senior (transversal, NO opcional)** — ver §AUDITOR. Corre tras cada track, **imprime un Defect Ledger** y bloquea el avance si hay regresión.

Regla: **ningún track se cierra sin (a) sus tests verdes y (b) el visto del Auditor de Errores.** El orquestador integra y resuelve conflictos entre tracks.

## CONTEXTO TÉCNICO (verificado en el repo — usalo, no asumas)

- **Sustrato ya presente:** Postgres + pgvector conectado (`apps/gateway-api/src/main.ts:365` `new Pool`), migraciones 001–007 (próxima = **008**). Usan `ON CONFLICT` y CAS (`consumeRollbackSnapshot` con `WHERE status=… + changes===1`).
- **El embrión del workflow YA existe:** `apps/gateway-api/src/routes/orchestrator-smtp.ts` tiene `runGatedStep`/`runReadOnlyStep` (`:539`) y **14 steps** (1–14; mutantes vía `runGatedStep`, lecturas vía `runReadOnlyStep`), `submitAndAwaitApproval` (dep de aprobación), `compactRunIntent`/`compactStepFromResult` (`:858`/`:917`), `ensureBudgetForStep` (`:935`). **Evolucionar esto, NO reescribir.**
- **Memoria:** `packages/storage/src/episodic-scratch.ts` — `insertEpisodicEntry` (`:71`, `ON CONFLICT` `:93`), `retrieveTrustWeighted` (`:226`) con scoring **mal calibrado** en `:252` (`trust*100 − días`), `defaultTrustScore` (`:369`), `expireOldEntries` (`:260`). pgvector está **muerto** (sin embedder) — migraciones 002/007.
- **Hueco de auth:** `apps/gateway-api/src/routes/episodic-scratch.ts:23` es **fail-open** (`if (deps.readBoundaryToken && …)`); `main.ts:1274` no pasa el fallback `?? DELIVRIX_OPENCLAW_TOKEN`.
- **Carrera de doble firma:** `apps/gateway-api/src/routes/proposals-sign.ts` — check `:164`, mutación `:314`, dispatch `:367`, con `await`s en medio. `proposalsStore` es array en RAM (`main.ts:677`).
- **Runtime/herramientas del repo:** **Node ≥24** (Mastra requiere ≥22.13 → compatible). Test runner = **`node --test` (node:test)**, NO vitest — ver el script `test` de `package.json` (globs `**/*.test.ts`). Workspaces `apps/*`,`packages/*`. **`@mastra` NO está instalado todavía.**
- **Inferencia:** Claude Sonnet vía Bedrock (`@ai-sdk/amazon-bedrock`).

## REGLAS GLOBALES (no negociables)

1. **Evolucionar, no reescribir.** Construir sobre `orchestrator-smtp.ts`, `episodic-scratch.ts`, el gobierno existente.
2. **Gobierno que NO se cede:** acción irreversible/real = 1 firma humana (ApprovalGate vía `suspend()`) + audit chain SHA-256 + rollback. Mastra entra como **librería** (`@mastra/core/workflows`, `@mastra/rag`, `@mastra/pg`), nunca como runtime/loop/memoria-fuente-de-verdad. **Pinnear** la versión de Mastra.
3. **Fail-closed siempre.** Token ausente = rechazar. Skill no mapeado = tier crítico. El agente nunca sube su propio `reliability`.
4. **No adivinar:** todo paso verifica estado real con read-tools antes de avanzar.
5. **Tests de concurrencia obligatorios** para invariantes de carrera (no solo secuenciales) — un test verde secuencial es falso verde.
6. **Tests = node:test**, archivos `*.test.ts` que matcheen los globs del `package.json`. NO introducir vitest/jest.
7. Rama por track (`codex/poc-grounded-<track>`), commit atómico, QA firma + Auditor de Errores firma.
8. Si un fix toca dinero real o rompe un contrato del panel, **pará y reportá a Juanes**.

---

## TRACKS

### Track A — Workflow determinístico grounded  ·  owner: AI Engineer Senior + Backend Senior  ·  rama `codex/poc-grounded-workflow`

**Objetivo:** que el flujo SMTP deje de ser un loop LLM-driven y sea una **máquina de estados determinística**; el LLM solo rellena cada paso acotado.

1. Instalar `@mastra/core` (pinneado) y modelar el flujo de `orchestrator-smtp.ts` como **workflow** (`createWorkflow().then()/.branch()`), un step por nodo, reusando la estructura de 14 steps existente. El control de flujo vive en código, no en el LLM.
2. **Verify-after-step (C2):** tras cada step mutante, verificar estado real con la read-tool correspondiente (`read_route53_zone_records`, `read_webdock_servers`, `wait_for_dns_propagation`, `read_route53_domain_detail`) antes de marcar el step OK. Si la verificación falla → no avanzar; emitir evento y (según política) reintentar acotado o suspender.
3. **ApprovalGate como `suspend()/resume()`** en los steps Tier C (mutantes irreversibles): el workflow se suspende esperando la firma; al firmar, `resume()` con snapshot durable. Mantener el `submitAndAwaitApproval` actual como puente.
4. **Step budget + detección de acción duplicada:** cap de iteraciones/tiempo; si el agente repite misma tool+args 3× → abortar y escalar (no loop infinito).
5. **Salidas estructuradas (Zod)** por step + capa de validación de contenido propia (JSON válido ≠ correcto).

**Gate (tests node:test):**
- I-A1: el workflow ejecuta el flujo de 1 dominio en orden fijo; un step que falla la verificación **no** avanza al siguiente.
- I-A2 (concurrencia): no hay doble ejecución de un step ante reintento.
- I10: loop forzado (misma acción 3×) → aborta y escala.

### Track B — Memoria RAG-gated (lectura)  ·  owner: AI Engineer Senior + Backend Senior  ·  rama `codex/poc-grounded-memoria-rag`

**Objetivo:** que el agente recupere **solo hechos verificados relevantes y de alta confianza**, nunca basura.

1. **Migración 008**: agregar a `openclaw_episodic_scratch` las columnas `plane` (`observation` | `verified_fact`), `provenance` (inmutable), `reliability` (real 0–1), `valid_at`, `invalid_at`. (Migración nueva, no editar las aplicadas.)
2. **Dos planos:** las lecturas que alimentan decisiones leen **solo** `plane='verified_fact' AND invalid_at IS NULL`. Las observaciones quedan cuarentenadas.
3. **Retrieval CRAG (C3):** pipeline con `@mastra/rag` sobre pgvector + búsqueda híbrida (vector + `tsvector`/full-text, fusión RRF) + rerank, y un **evaluador de confianza** con umbral: Correcto→inyecta, Incorrecto→descarta, Ambiguo→busca-más/abstiene. Mejor 3 memorias buenas que 20 mediocres.
4. **Reemplazar el scoring** de `retrieveTrustWeighted` (`episodic-scratch.ts:252`, `trust*100 − días`) por **relevancia + recencia(decay) + importancia + reliability(multiplicador acotado, no filtro)**.
5. **Embeddings:** Bedrock Cohere Embed Multilingual v3 (interface pluggable para swap a `bge-m3` local). Índice **HNSW** (no IVFFlat).
6. **Nunca reinyectar texto libre**: lo recuperado entra como datos estructurados/tipados.

**Gate:**
- I8: una memoria irrelevante/baja-confianza **no** entra al prompt (test del gate CRAG).
- I-B2: el retrieval que alimenta decisiones ignora `observation` y `invalid_at IS NOT NULL`.
- RAGAS context-precision/recall sobre un set de queries (ver Track D).

### Track C — Seguridad + write-gate mínimo  ·  owner: Backend Senior  ·  rama `codex/poc-grounded-guards`

**Objetivo:** cerrar los bordes abiertos hoy.

1. **`/scratch` fail-closed (I3):** `episodic-scratch.ts:23` rechazar si no hay token; `main.ts:1274` pasar `?? DELIVRIX_OPENCLAW_TOKEN`; documentar `DELIVRIX_READ_BOUNDARY_TOKEN` en `.env.example`.
2. **TTL excluye verificado (I4):** `expireOldEntries` no borra `plane='verified_fact'`/`source='operator'`; usar soft-delete (`invalid_at`) no `DELETE` físico para hechos.
3. **Write-gate (I5):** todo write a memoria valida estructura (rechaza prosa libre / instrucción inyectada), tamaño (anomalía) y provenance, antes de commitear.
4. **No auto-promoción (I6):** el agente no puede setear/subir su propio `reliability`; solo una tool determinística o el operador lo suben.
5. **Bi-temporal (I7):** un bounce real (o contradicción del operador) marca `invalid_at` sin borrar.

**Gate:** tests I3, I4, I5, I6, I7 (rojo→verde).

### Track D — Evals + Golden set  ·  owner: QA Senior  ·  rama `codex/poc-grounded-evals`

**Objetivo:** poder MEDIR que no divaga, para iterar con datos.

1. **Golden set** de **20 tareas SMTP reales** (de fallos observados), balanceado (debe/no-debe actuar), con reference solution. Guardar en `apps/gateway-api/src/evals/golden/` (o equivalente), versionado.
2. **Graders code-based:** outcome verification (¿el registro DNS existe de verdad?, ¿el VPS responde?), tool-calls verification (tools correctas + params), transcript checks. Más **faithfulness/groundedness** (estilo RAGAS: faithfulness, context-precision, context-recall) vía LLM-judge calibrado con salida `Unknown`.
3. **Métrica de fiabilidad `pass^k`** (que pase las k veces; no `pass@k`).
4. **CI:** suite node:test que corre el golden set; **capability** (sube) + **regression** (~100%). Integrar al `npm test`/script dedicado `test:evals`.

**Gate:** baseline medido (pre-cambios) + post-cambios; reportar delta de `pass^k` y faithfulness. El éxito del PoC se define por este número, no por impresión.

### Track E — Visibilidad grounded en Canvas Live  ·  owner: Full-Stack Senior  ·  rama `codex/poc-grounded-canvas`

**Objetivo:** que el operador VEA el agente grounded (estado del workflow, verificación por step, decisión del gate de memoria, suspensión por firma).

1. Emitir/Renderizar el estado del workflow (step actual, verificación OK/fallida, qué memoria se inyectó y con qué confianza, por qué se suspendió).
2. ApprovalGate: el `suspend()` del workflow se muestra como propuesta firmable; al firmar, `resume()`.
3. Sin texto decorativo: cada elemento accionable o de estado real (respetar la visión de Canvas Live).

**Gate:** test de contrato cliente↔gateway (sin `as never`, sin shape roto) + render sin crash con estados nuevos.

---

## EL AUDITOR DE ERRORES SENIOR (transversal — IMPRIME y MIDE)

Subagente dedicado que corre **después de cada track** y al final. No escribe features; **mide y reporta**. Produce un **Defect Ledger** impreso (archivo `DOCUMENTACION/POC_GROUNDED_DEFECT_LEDGER.md`, actualizado en cada pasada) con este formato por hallazgo:

```
[Sxx] <severidad 🔴/🟠/🟡/🟢> <título>
  archivo:línea
  qué falla (evidencia: test rojo / output real)
  causa
  fix sugerido
  estado: ABIERTO | EN PROGRESO | CERRADO (commit)
```

Responsabilidades del Auditor:
1. Correr **toda la suite** (`npm test`) + el golden set (`test:evals`) tras cada track y registrar: tests verdes/rojos, `pass^k`, faithfulness, context-precision/recall, y cualquier regresión vs el baseline.
2. **Imprimir el Defect Ledger** con severidad y archivo:línea — para que veamos en tiempo real qué vamos fallando y corrijamos a tiempo.
3. **Bloquear el cierre de un track** si hay regresión (test que estaba verde y se puso rojo) o si el `pass^k`/faithfulness baja respecto al baseline.
4. Marcar explícitamente **falsos verdes** (tests solo-secuenciales para invariantes de concurrencia).
5. Al final, un **resumen ejecutivo**: invariantes I1–I10 + I-A*/I-B* con estado ✅/🟡/❌, delta de métricas, y lista de defectos abiertos priorizados.

El Auditor es la red que evita "divagar": mide objetivamente si el agente mejoró, no por impresión.

---

## ORDEN DE EJECUCIÓN

1. **Track C** (guards) — barato, cierra bordes abiertos. Auditor corre baseline ANTES (para tener contra qué medir).
2. **Track D** (evals + golden set + baseline) — necesario para medir todo lo demás.
3. **Track B** (memoria RAG-gated) — arregla "consulta mal la memoria".
4. **Track A** (workflow determinístico) — arregla "delira". Depende de B para grounding con hechos verificados.
5. **Track E** (Canvas) — visibilidad, en paralelo cuando A esté avanzado.
6. **Auditor de Errores** corre tras cada uno + cierre final.

## DEFINICIÓN DE "HECHO" (criterio de éxito del PoC)

- Invariantes I1–I10 (matriz del ADR §5) + I-A*/I-B* en ✅, con sus tests node:test (incluido el de concurrencia).
- `pass^k` del golden set **sube** vs baseline; **faithfulness** medido y reportado; context-precision/recall reportados.
- El flujo de 1 dominio corre como **workflow determinístico** con verify-after-step; **cero divagación** observable; **gobierno intacto** (Tier C sigue exigiendo firma).
- **Defect Ledger** impreso, sin defectos 🔴/🟠 abiertos.
- `/scratch` fail-closed, TTL no borra verificado, write-gate rechaza prosa libre, agente no auto-promueve.

## ENTREGABLES

Por track: rama, commits atómicos, tests añadidos (incluido concurrente donde aplique), y el visto del Auditor. Al cierre: el **Defect Ledger** final + el **reporte de evals** (baseline vs post) + resumen de invariantes. Reportá el plan de subagentes (qué subagente toma qué track) **antes** de tocar código, y los SHAs al cerrar cada track.

**Empezá por el plan de subagentes + Track C + baseline del Auditor. Letsgo.**
