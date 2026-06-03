# Codex - MEMORIA: cerrar guards (I5+I6) + retrieval grounded testeable (Track B1)

> Rama base: `produ` (ya rebaseada sobre la remediacion, base `40c1727`, Track C = `e4d119e`).
> **Foco unico: el subsistema de MEMORIA.** NADA de push, merge a main, ni otros tracks (A/E). Si aparece, para y reporta.

## ORQUESTACION MULTI-AGENTE (OBLIGATORIA)

Eres el orquestador. No trabajes solo: desplega subagentes expertos. Asigna cada Parte a su owner y haz que QA y el Auditor firmen el cierre.

Subagentes:

- **AI Engineer Senior** - diseno del retrieval grounded, gate de confianza CRAG, scoring calibrado, validacion estructural del write-gate.
- **Backend Senior** - `episodic-scratch.ts`, `openclaw-compact-intent.ts`, migraciones, seed, integracion Postgres.
- **QA Senior** - suites node:test, cobertura de cada invariante, conteos de run real.
- **Auditor de Errores Senior** - corre tras cada Parte, actualiza `DOCUMENTACION/POC_GROUNDED_DEFECT_LEDGER.md` en formato `[Sxx] severidad · archivo:linea · que falla · causa · fix · estado`, reporta delta de tests, marca falsos verdes y bloquea regresiones.

Regla dura: ninguna Parte se cierra sin tests verdes de un run real y visto del Auditor. Reportar plan de subagentes antes de tocar codigo.

## Objetivo

Dejar la memoria en estado testeable de grounding, no solo almacenamiento con guardas.

## Parte 1 - Cerrar guards pendientes (I5 + blindaje I6)

### I5 - write-gate completo

- `errorMessage` se guardaba verbatim y no pasaba por `walkPayload`.
- Fix: pasar `errorMessage` y todo texto libre persistido por write-gate; validacion estructural; redactar en lectura campos sensibles o reinyectables.
- Test: inyeccion en `errorMessage`, con doble espacio/sinonimos/zero-width, rechazada o estructurada/redactada, nunca verbatim.

### I6 - storage fail-closed

- `hasValidOperatorProvenance` hacia fail-open si faltaba `OPENCLAW_OPERATOR_HMAC_SECRET`.
- Fix: si el secreto no esta configurado, rechazar `source='operator'`/`plane='verified_fact'`; documentar secreto en `.env.example`.
- Test: operator sin secreto rechazado; con secreto + HMAC valido aceptado.

## Parte 2 - Datos de prueba

- Crear `scripts/db/seed-episodic.mjs` idempotente con 15-20 entradas representativas via `insertEpisodicEntry`.
- Cubrir `verified_fact`, `observation`, distintas `reliability`, `invalid_at`, varios `tool/outcome/intent_id`, provenance correcta.
- Marcarlo como seed de revision, no produccion.
- Documentar flujo minimo: `docker-compose up` -> `npm run db:migrate` -> `node scripts/db/seed-episodic.mjs`.
- No ejecutarlo contra BD real; Docker es accion del operador.

## Parte 3 - Track B1 retrieval grounded sin embeddings

1. Lectura de decisiones: solo `plane='verified_fact' AND invalid_at IS NULL`.
2. Scoring calibrado: relevancia keyword/tsvector local + recencia + `reliability` como multiplicador acotado.
3. Gate de confianza estilo CRAG: correcto inyecta, incorrecto descarta, ambiguo busca mas o se abstiene.
4. Inyeccion estructurada: datos tipados, nunca prosa libre reinyectada.

Tests:

- Memoria invalidada o baja reliability no se devuelve.
- `observation` no alimenta decision.
- Sin `verified_fact` relevante hay abstencion.
- Orden respeta reliability + recencia, no el viejo `trust*100-dias`.

## Parte 4 - No ahora

Embeddings + pgvector quedan diferidos: Bedrock Cohere Embed Multilingual v3, indice HNSW, busqueda hibrida vector + keyword/RRF y rerank.

## Hecho cuando

Partes 1-3 con tests verdes, ledger actualizado, seed + doc listos, retrieval grounded demostrablemente abstiene sin verified facts. Reportar SHAs y conteo real de tests. Branch `codex/poc-grounded-memoria`.
