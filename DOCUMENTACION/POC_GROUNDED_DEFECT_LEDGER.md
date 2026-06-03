# PoC Grounded Agent - Defect Ledger

Fecha: 2026-06-03
Branch: `codex/poc-grounded-memoria`
Worktree: `/private/tmp/delivrix-produ-correct`
Base corregida: `40c1727` + Track C `e4d119e`
Alcance: memoria OpenClaw, guards I5/I6, seed de revision y retrieval grounded B1 sin embeddings.

## Fuentes

- `DOCUMENTACION/Tesis_Delivrix_v3.4_BUSINESS_PLAN_MVP.pdf`
- `DOCUMENTACION/RESUMEN_RUTA_PROYECTO.md`
- `DOCUMENTACION/skills/delivrix-qa-gatekeeper/SKILL.md`
- `DOCUMENTACION/skills/delivrix-qa-gatekeeper/references/qa-checklist.md`
- `DOCUMENTACION/PROMPT_CODEX_MEMORIA_GUARDS_Y_RETRIEVAL_2026_06_03.md`
- `DOCUMENTACION/decisiones/2026-06-03-arquitectura-agente-local-mastra-rag.md`

## Ledger

[S01] P1 · `packages/storage/src/episodic-scratch.ts:545` · `errorMessage` podia persistir prosa libre/instrucciones fuera del walk de payload · causa: el campo se validaba como string acotado y no como dato estructurado · fix: `guardedText` aplica normalizacion NFKC, zero-width stripping, patron anti-instrucciones y exige codigo maquina `^[a-z0-9_.:-]+$` · estado CERRADO.

[S02] P1 · `packages/storage/src/episodic-scratch.ts:556` · operador podia aportar `operatorSignatureVerified=true` sin HMAC cuando faltaba secreto · causa: provenance operator previa era autocontenida/fail-open · fix: `source='operator'` requiere `OPENCLAW_OPERATOR_HMAC_SECRET`, HMAC valido y provenance verificable · estado CERRADO.

[S03] P1 · `apps/gateway-api/src/routes/openclaw-compact-intent.ts:323` · `compact_intent` podia persistir memoria operator sin secreto configurado · causa: el preflight no era fail-closed antes de llamar storage · fix: error tipado `operator_hmac_secret_required` antes de insertar · estado CERRADO.

[S04] P1 · `apps/gateway-api/src/routes/openclaw-compact-intent.ts:357` · HMAC operator no estaba ligado a la fila de memoria concreta · causa: firmaba solo actor/audit/proposal/signature/signedAt · fix: payload canonico incluye `memoryIntentId`, `memoryStep`, `memoryTool`, `memoryInputHash`, `memoryOutcome`, `memoryOutcomeHash` y errores tipados opcionales; storage recalcula contra la fila real · estado CERRADO.

[S05] P1 · `packages/storage/src/episodic-scratch.ts:423` · la lectura que alimenta decisiones podia mezclar observaciones o hechos invalidados · causa: retrieval historico no modelaba plano de decision · fix: query B1 limita a `ttl_expires_at > NOW() AND invalid_at IS NULL AND plane='verified_fact'` · estado CERRADO.

[S06] P1 · `packages/storage/src/episodic-scratch.ts:982` · score viejo podia favorecer freshness/trust y devolver memoria baja reliability · causa: scoring no tenia gate de reliability/relevancia para decision · fix: score B1 usa relevancia keyword/query, recencia, trust menor y reliability como multiplicador; `memories` exige query/keywords, relevancia minima, reliability >= 0.5 y score >= umbral · estado CERRADO.

[S07] P1 · `apps/gateway-api/src/skill-schemas.ts:386` · retrieval grounded podia ejecutarse sin senales semanticas y "acertar" por frescura · causa: `grounded=true` aceptaba tool/inputHash sin query/keywords · fix: schema y endpoint exigen query o keywords para retrieval grounded; si no, abstencion/error tipado · estado CERRADO.

[S08] P1 · `apps/gateway-api/src/tool-use-processor.test.ts:218` · B1 existia en endpoint pero podia quedar desconectado del tool path de OpenClaw · causa: schema de `read_episodic_scratch` no exponia `query/keywords/grounded` · fix: contrato Bedrock + schema + processor HTTP enrutan `query` como `grounded=true` · estado CERRADO.

[S09] P1 · `scripts/db/seed-episodic.mjs:37` · la tabla de memoria arrancaba vacia para revision B1 · causa: solo se llenaba via flujos reales/compact intent · fix: seed idempotente de revision con 18 entradas `verified_fact`/`observation`, reliabilities variadas, invalidaciones y operator HMAC; protegido contra produccion y URLs no-locales · estado CERRADO.

[S10] P2 · `infra/README.md:31` · flujo minimo del seed episodico no estaba documentado · causa: Parte 2 no tenia runbook operador · fix: doc `docker compose -f infra/docker-compose.yml up -d` -> `npm run db:migrate` -> `node scripts/db/seed-episodic.mjs`, aclarando que Codex no ejecuta BD real · estado CERRADO.

[S11] P2 · `.env.example:10` · secreto nuevo `OPENCLAW_OPERATOR_HMAC_SECRET` no estaba documentado · causa: I6 se endurecio sin ejemplo de configuracion · fix: variable agregada con placeholder no-real · estado CERRADO.

[S12] P2 · `DOCUMENTACION/decisiones/2026-06-03-arquitectura-agente-local-mastra-rag.md:110` · Parte 4 podia confundirse con B1 · causa: ADR hablaba de pgvector/embeddings como norte general · fix: anotado corte B1 sin embeddings y diferido explicito de Cohere Embed Multilingual v3 + pgvector/HNSW + RRF/rerank · estado CERRADO.

[S13] P2 · `package.json:8` · entorno local de esta sesion usa Node v22.22.3 mientras el repo exige `>=24` · causa: runtime de workspace no coincide con engines · fix: no corregido en este corte; CI/operador debe repetir suite en Node >=24 antes de merge productivo · estado ABIERTO.

[S14] P2 · `scripts/db/seed-episodic.mjs:132` · seed no se ejecuto contra Postgres real · causa: Docker/OrbStack es accion explicita del operador y estaba no disponible en la sesion previa · fix: script y tests fake-pool listos; ejecutar localmente cuando Docker este arriba · estado ABIERTO OPERADOR.

## Evidencia de tests

- `node --test packages/storage/src/episodic-scratch.test.ts apps/gateway-api/src/routes/openclaw-episodic-memory.test.ts apps/gateway-api/src/routes/openclaw-compact-intent.test.ts apps/gateway-api/src/episodic-scratch-ttl.test.ts apps/gateway-api/src/tool-use-processor.test.ts apps/gateway-api/src/openclaw-tools-builder.test.ts scripts/db/seed-episodic.test.mjs` -> PASS 72/72.
- `npm test` -> PASS 781/781.
- `git diff --check` -> PASS.
- `node --version` -> `v22.22.3`; residual S13 mantiene la repeticion en Node >=24 como gate de merge productivo.
- `node scripts/db/seed-episodic.mjs` contra Postgres real -> NO RUN por instruccion del prompt; Docker/Postgres es accion explicita del operador.
