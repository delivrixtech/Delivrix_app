# PoC Grounded Agent - Track C Reporte

Fecha: 2026-06-03
Branch: `produ`
Commit scope: seguridad minima de memoria + baseline auditor.
Base corregida: `codex/cierre-auditoria-2026-06-02` en `40c1727`, con Track C aplicado encima. El intento previo sobre `cfb3b02` queda descartado como baseline invalido.

## Plan de Subagentes Ejecutado

| Subagente | Rol | Resultado |
|---|---|---|
| AI/Backend Track C | Auditar guards I3-I7 | Confirmo cambios requeridos: fail-closed, migracion, TTL soft-delete, write-gate, no auto-promocion y bi-temporalidad. |
| ADR/RAG governance | Auditar memoria factual | Recomendo separar hechos autoritativos en Track B; este commit mantiene scratch gobernado sin convertirlo en autoridad factual final. |
| QA/Auditor | Baseline y ledger | Registro baseline, riesgos de entorno y formato del Defect Ledger. |

## Que Cambio

- `/v1/openclaw/scratch` ahora falla cerrado si no hay token configurado o si el header `x-delivrix-token` no coincide.
- `main.ts` usa `DELIVRIX_READ_BOUNDARY_TOKEN` con fallback a `DELIVRIX_OPENCLAW_TOKEN` para continuidad.
- `.env.example` documenta `DELIVRIX_READ_BOUNDARY_TOKEN`.
- `openclaw_episodic_scratch` gana plano, provenance, reliability 0-1, ventana temporal e invalidacion via migracion `008_openclaw_episodic_scratch_guards.sql`.
- `retrieveTrustWeighted` solo devuelve `plane='verified_fact'` activo, no observaciones.
- `expireOldEntries` borra observaciones expiradas, pero invalida hechos/operator con `invalid_at` sin borrar evidencia.
- `insertEpisodicEntry` rechaza payloads con claves/prosa de instrucciones, payloads demasiado grandes y auto-promocion de OpenClaw.
- `compact_intent` escribe `plane` y `provenance` deterministas por step.
- Se agrego `invalidateEpisodicFacts` para contradicciones/bounces sin borrar filas.

## Checks

| Comando | Resultado |
|---|---:|
| `node --test scripts/db/*.test.mjs packages/domain/src/*.test.ts packages/domain/src/runbooks/*.test.ts packages/adapters/src/*.test.ts packages/local-store/src/*.test.ts packages/queue/src/*.test.ts packages/storage/src/*.test.ts apps/gateway-api/src/*.test.ts apps/gateway-api/src/**/*.test.ts apps/worker/src/*.test.ts` | PASS, 770/770, despues de enlazar `node_modules` local al worktree limpio. |
| `node --test packages/storage/src/episodic-scratch.test.ts apps/gateway-api/src/routes/openclaw-episodic-memory.test.ts apps/gateway-api/src/episodic-scratch-ttl.test.ts` | PASS, 29/29. |
| `node --test apps/gateway-api/src/routes/openclaw-compact-intent.test.ts` | PASS, 4/4. |
| `npm run test:admin` | No ejecutado; escribe `dist` via `vite build`. |
| `npm run test:evals` | No ejecutado; Track D pendiente. |

## Pendientes

- Track B debe decidir si `openclaw_verified_facts` se separa de scratch antes de RAG productivo.
- Track D debe crear golden set, graders y `test:evals`.
- Track A debe modelar workflow deterministico con verify-after-step y budget/loop guard.
- Track E debe exponer estado grounded en Canvas Live.
- Ejecutar CI con Node >=24; la sesion local reporto Node v22.22.3.

## Veredicto

Track C queda cerrado para el primer PoC slice: I3-I7 tienen pruebas focalizadas verdes. No habilita acciones reales nuevas ni cambia los gates de aprobacion humana.
