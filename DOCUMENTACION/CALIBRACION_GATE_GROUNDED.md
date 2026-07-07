# Calibracion del gate de confianza CRAG (memoria grounded)

Fecha: 2026-07-06 · Branch: `feat/i5-write-gate` · Cierra el pendiente de calibracion del PoC grounded (ver `POC_GROUNDED_DEFECT_LEDGER.md`).

## Que se calibra

`retrieveGroundedDecisionMemory` (B1, sin embeddings) clasifica cada candidato como
`correct` / `ambiguous` / `incorrect` con:

```
score = (relevancia*0.7 + recencia*0.2 + trust*0.1) * (0.25 + reliability*0.75)
correct   <=> keywords>0  AND relevancia >= 0.25 AND reliability >= 0.5 AND score >= minScore
ambiguous <=> keywords>0  AND score >= ambiguousScore
```

Los dos umbrales son configurables:

- **Por entorno (gateway):** `OPENCLAW_GROUNDED_MIN_SCORE`, `OPENCLAW_GROUNDED_AMBIGUOUS_SCORE`
  (validados fail-closed en el arranque por `groundedConfidenceGateFromEnv`).
- **Por request (storage):** `minScore` / `ambiguousScore` en `GroundedMemoryRetrievalInput`.

## Metodo (reproducible)

```
# 1) poblar memoria con datos reales (registros de ejecucion del runtime)
node scripts/db/seed-episodic-executions.mjs            # o --dir <path a executions/>

# 2) barrer umbrales contra el corpus real
node scripts/db/calibrate-grounded-gate.mjs             # corpus desde Postgres local
node scripts/db/calibrate-grounded-gate.mjs --source executions --dir <path>   # sin DB
```

El set dorado se construye del corpus mismo:

- **positivas** — `tool + dominio` reales con outcome success (esperado: grounded);
- **negativas** — queries fuera del dominio del producto (esperado: abstain);
- **cruzadas** — tool real + dominio inexistente (esperado: NO inyectar memoria de otro
  dominio como grounded; es el vector antidelirio de S29).

El harness emula el pipeline real (candidatos = top `limit*4` por reliability/recency,
mismos pesos de scoring, via `assessGroundedMemoryCandidates`).

## Resultado (2026-07-06, corpus real local)

Corpus: 645 hechos verificados (364 runtime + 361 execution_import deduplicados + review) · 74 queries.

| minScore | recall+ | fp- | fp-x (dominio equivocado) |
|---:|---:|---:|---:|
| 0.38 | 1.000 | 0 | 0.875 |
| 0.52 (default previo) | 0.767 | 0 | 0.625 |
| 0.56 | 0.600 | 0 | 0.125 |
| **0.58 (elegido)** | **0.583** | **0** | **0.000** |
| 0.62 | 0.433 | 0 | 0.000 |

**Decision:** `minScore=0.58`, `ambiguousScore=0.35`. Es el primer umbral que elimina el
grounding con memoria de OTRO dominio (fp-x = 0). El costo es recall positivo 0.583: el
resto de las queries positivas cae a `ambiguous`/`abstain`, que es el comportamiento
seguro del agente (buscar mas / abstenerse) frente a inyectar hechos de otra entidad.

## Cuando recalibrar

- Al cambiar los pesos del scoring o el tokenizado (B1 -> embeddings/pgvector en Track B).
- Cuando el corpus crezca de forma significativa (nuevos tools/dominios).
- Si la operacion reporta abstenciones excesivas: bajar `OPENCLAW_GROUNDED_MIN_SCORE`
  por env SOLO despues de verificar en la tabla del sweep que fp-/fp-x siguen en 0.
