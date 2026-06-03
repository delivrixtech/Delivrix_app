# PoC Grounded Agent - Defect Ledger

Fecha: 2026-06-03
Branch: `produ`
Worktree: `/private/tmp/delivrix-produ-correct`
Auditor: Codex orchestrator + subagentes Track C / RAG / QA
Alcance: primer slice del ADR `2026-06-03-arquitectura-agente-local-mastra-rag.md`, Track C guards + baseline.
Base corregida: `codex/cierre-auditoria-2026-06-02` en `40c1727`. El intento anterior sobre `cfb3b02` fue invalidado porque no contenia la remediacion completa.

## Fuentes Leidas

- `DOCUMENTACION/Tesis_Delivrix_v3.4_BUSINESS_PLAN_MVP.pdf`
- `DOCUMENTACION/RESUMEN_RUTA_PROYECTO.md`
- `DOCUMENTACION/skills/delivrix-qa-gatekeeper/SKILL.md`
- `DOCUMENTACION/skills/delivrix-qa-gatekeeper/references/qa-checklist.md`
- `DOCUMENTACION/decisiones/2026-06-03-arquitectura-agente-local-mastra-rag.md`
- `DOCUMENTACION/PROMPT_CODEX_PoC_AGENTE_GROUNDED_2026_06_03.md`

## Baseline

| Comando | Resultado | Nota |
|---|---:|---|
| `node --test scripts/db/*.test.mjs packages/domain/src/*.test.ts packages/domain/src/runbooks/*.test.ts packages/adapters/src/*.test.ts packages/local-store/src/*.test.ts packages/queue/src/*.test.ts packages/storage/src/*.test.ts apps/gateway-api/src/*.test.ts apps/gateway-api/src/**/*.test.ts apps/worker/src/*.test.ts` | PASS despues de enlazar `node_modules` local | Baseline auditado antes de Track C: 764/764 tests. Post Track C sobre base corregida: 770/770 tests. El conteo 691/691 queda invalidado por haber sido ejecutado sobre `cfb3b02`. |
| `node --test packages/storage/src/episodic-scratch.test.ts apps/gateway-api/src/routes/openclaw-episodic-memory.test.ts apps/gateway-api/src/episodic-scratch-ttl.test.ts` | PASS | Post Track C: 29/29 tests. |
| `node --test apps/gateway-api/src/routes/openclaw-compact-intent.test.ts` | PASS | Post Track C: 4/4 tests. |
| `npm run test:admin` | NO RUN | El script ejecuta `vite build` y escribe `dist`; queda fuera de esta pasada de guards backend. |
| `npm run test:evals` | NO RUN | Track D aun no implementado en este commit. |

## Ledger

| ID | Track | Sev | Estado | Area | Hallazgo | Evidencia | Impacto | Fix aplicado/recomendado | Criterio de cierre | Owner | Commit/PR |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C-001 | Baseline | P1 | ABIERTO | Runtime | `package.json` exige Node `>=24`, pero el runtime de la sesion reporto Node v22.22.3. | `npm test` TAP mostro Node.js v22.22.3. | La suite puede no representar el runtime requerido por el repo. | Ejecutar CI/local con Node >=24 antes de merge productivo. | Suite completa verde en Node >=24. | QA | Pendiente |
| C-002 | Baseline | P2 | ABIERTO | Admin UI | `test:admin` escribe build output. | Script `npm --workspace @delivrix/admin-panel run check` incluye `vite build`. | No sirve como auditoria read-only sin limpiar artefactos. | Definir check read-only separado o aceptar artefacto controlado. | `test:admin:readonly` o politica documentada. | Full-stack | Pendiente |
| C-003 | Baseline | P2 | ABIERTO | Dependencias | Worktree limpio no tenia `node_modules`; primer baseline fallo por modulos no resueltos. | `ERR_MODULE_NOT_FOUND` para `pg`, `imapflow`, `@aws-sdk/client-bedrock-runtime`. | Los worktrees limpios requieren install/symlink explicito para test local. | Usar entorno CI o dependencia compartida no versionada; no commitear symlink. | Baseline reproducible sin pasos manuales. | QA | Pendiente |
| C-003B | Baseline | P1 | CERRADO | Git | `produ` fue construido inicialmente desde `cfb3b02`, sin los 19 commits de remediacion auditada. | `git merge-base produ codex/cierre-auditoria-2026-06-02` devolvia `cfb3b02`; `git log codex/cierre-auditoria-2026-06-02 ^produ` listaba `a34672d..40c1727`. | Conteo de tests 691/691 era falso para la rama objetivo y faltaban fixes auditados. | Rebase de Track C sobre `40c1727` sin tocar la rama audit; migracion renumerada a `008`; suite final 770/770. | `codex/cierre-auditoria-2026-06-02` es ancestro de `produ` y no quedan commits audit pendientes contra `produ`. | Codex | Este commit |
| C-004 | Track C / I3 | P1 | CERRADO | Auth | `/v1/openclaw/scratch` era fail-open cuando faltaba `readBoundaryToken`. | `apps/gateway-api/src/routes/episodic-scratch.ts`. | Memoria operacional legible sin token en entornos mal configurados. | Ahora falta de token configurado devuelve `401 read_boundary_token_required`; token invalido devuelve `401 read_boundary_token_invalid`. | Test fail-closed verde. | Backend | Este commit |
| C-005 | Track C / I3 | P2 | CERRADO | Config | Gateway no usaba fallback `DELIVRIX_OPENCLAW_TOKEN` para read-boundary scratch. | `apps/gateway-api/src/main.ts`. | Drift entre herramientas OpenClaw y gateway. | `sensitiveReadBoundaryToken = DELIVRIX_READ_BOUNDARY_TOKEN || DELIVRIX_OPENCLAW_TOKEN`, reutilizado por scratch, Route53 read-tools y tool processor. | Endpoint y tool processor reciben token efectivo. | Backend | Este commit |
| C-006 | Track C / I4 | P1 | CERRADO | Memoria TTL | TTL borraba fisicamente filas, incluso hechos/operator. | `packages/storage/src/episodic-scratch.ts`. | Perdida de evidencia auditada y memoria humana. | Nueva migracion agrega `plane`, `provenance`, `reliability`, `valid_at`, `invalid_at`; TTL borra observaciones y marca hechos/operator con `invalid_at`. | Tests de TTL verde. | Backend | Este commit |
| C-007 | Track C / I5 | P1 | CERRADO | Write-gate | Escrituras aceptaban payloads de memoria con texto instructivo. | `packages/storage/src/episodic-scratch.ts`. | Superficie de poisoning/instrucciones reinyectadas. | Write-gate por tamano, claves prohibidas y patrones de inyeccion. | Tests de payload malicioso verde. | Backend | Este commit |
| C-008 | Track C / I6 | P1 | CERRADO | Reliability | OpenClaw podia setear `trustScore`; el prompt exige no auto-promocion. | `packages/storage/src/episodic-scratch.ts`. | El agente podia elevar su propia memoria. | `source=openclaw` no puede setear `trustScore`, `reliability` ni `plane=verified_fact`. | Test no auto-promocion verde. | Backend | Este commit |
| C-009 | Track C / I7 | P1 | CERRADO | Bi-temporalidad | No habia API de invalidacion factual sin borrar fila. | `packages/storage/src/episodic-scratch.ts`. | Contradicciones/bounces no quedaban modelados como invalidacion temporal. | Nueva funcion `invalidateEpisodicFacts` marca `invalid_at` y metadata de evidencia. | Test de invalidacion verde. | Backend | Este commit |
| C-010 | ADR/RAG | P2 | ABIERTO | Arquitectura factual | Subagente RAG recomienda tabla separada `openclaw_verified_facts`. | Auditoria read-only Track B. | Riesgo de mezclar scratch episodico con hechos autoritativos a largo plazo. | Diferir a Track B: crear read path/facts separados antes de usar RAG para decisiones reales. | ADR Track B implementado con tests I8/I-B2. | AI/Backend | Pendiente |

## Invariantes

| Invariante | Estado | Evidencia |
|---|---|---|
| I3 `/scratch` sin token rechaza | CERRADO | Test `handleReadEpisodicScratchHttp fails closed when no read boundary token is configured`. |
| I4 TTL no borra hechos/operator | CERRADO | Test `expireOldEntries deletes old observations but invalidates operator and verified facts`. |
| I5 write-gate rechaza prosa/inyeccion | CERRADO | Test `write gate rejects instruction-like memory payloads`. |
| I6 agente no auto-promueve reliability | CERRADO | Test `OpenClaw cannot promote observations or set reliability`. |
| I7 contradiccion invalida sin borrar | CERRADO | Test `invalidateEpisodicFacts marks facts invalid without deleting rows`. |
| I8 retrieval CRAG | PENDIENTE | Track B. |
| I1/I2/I9/I10 workflow/signature/budget | PENDIENTE | Tracks A/C posteriores. |

## Veredicto Track C

Pass with notes. No hay defectos P1 abiertos dentro del alcance Track C implementado; quedan abiertos riesgos de entorno y de arquitectura futura que deben cerrarse antes de producir decisiones reales con RAG/workflow.
