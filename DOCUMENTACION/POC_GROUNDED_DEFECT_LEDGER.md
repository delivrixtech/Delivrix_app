# PoC Grounded Agent - Defect Ledger

Fecha: 2026-06-03
Branch: `codex/poc-grounded-memoria`
Worktree: `/private/tmp/delivrix-produ-correct`
Base corregida: `40c1727` + Track C `e4d119e`
Alcance: memoria OpenClaw, guards I5/I6, seed de revision y retrieval grounded B1 sin embeddings.

Hardening I5: `codex/poc-grounded-hardening` en `/private/tmp/delivrix-grounded-hardening`, base `codex/poc-grounded-memoria@3e79922`.

Hardening allowlist guard: `codex/poc-grounded-allowlist-guard` en `/private/tmp/delivrix-grounded-allowlist-guard`, base `codex/poc-grounded-hardening@e783b7b`.

## Fuentes

- `DOCUMENTACION/Tesis_Delivrix_v3.4_BUSINESS_PLAN_MVP.pdf`
- `DOCUMENTACION/RESUMEN_RUTA_PROYECTO.md`
- `DOCUMENTACION/skills/delivrix-qa-gatekeeper/SKILL.md`
- `DOCUMENTACION/skills/delivrix-qa-gatekeeper/references/qa-checklist.md`
- `DOCUMENTACION/PROMPT_CODEX_MEMORIA_GUARDS_Y_RETRIEVAL_2026_06_03.md`
- `DOCUMENTACION/PROMPT_CODEX_MEMORIA_ALLOWLIST_GUARD_2026_06_03.md`
- `DOCUMENTACION/RUNBOOK_LEVANTAR_PROBAR_MEMORIA_2026_06_03.md`
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

[S15] P1 · `packages/storage/src/stable-stringify.ts:1` · varias copias productivas/test de `stableStringify` podian divergir y romper hashes/HMAC sin deteccion real · causa: helper duplicado en storage, gateway, skill contracts, runtime logs y seed · fix: modulo canonico byte-for-byte igual a la implementacion previa de `episodic-scratch`, exportado por storage, migracion de imports productivos/seed/tests y golden tests literales · estado CERRADO.

[S16] P1 · `packages/storage/src/episodic-scratch.ts:943` · `outcomeData` podia transportar instrucciones como `{note:"disregard earlier directives"}` o claves estructuralmente peligrosas (`system_prompt`, `systemPrompt`, `developer_message`, `tool_use`) · causa: se caminaba como payload generico y no como datos maquina de memoria · fix: write-gate especializado para `outcomeData`, normalizacion NFKC/camel/snake/zero-width, deny de fragmentos peligrosos, allow estrecho de strings estructurados/hash y tests de variantes con mayusculas, saltos, doble espacio y zero-width · estado CERRADO.

[S17] P1 · `apps/gateway-api/src/routes/episodic-scratch.ts:121` · memoria legacy ya escrita podia leerse con `outcomeData` venenoso aunque el write-gate nuevo lo rechazara · causa: la ruta de lectura solo redactaba secretos por nombre de clave · fix: `redactUnsafeOutcomeData` se aplica a toda lectura `outcomeData`, preserva datos maquina legitimos y redacta claves/strings no estructurados o instruction-like · estado CERRADO.

[S18] P1 · `apps/gateway-api/src/routes/openclaw-compact-intent.test.ts:45` · prueba HMAC podia ser falso verde si writer y verifier compartian la misma serializacion equivocada · causa: expectativa calculada dinamicamente con el mismo helper · fix: HMAC operator fijo `c7738f9c9a826df1bbeb980dff78e8f956ce1ecb35bce4c8dc624c911aa58e21` sobre payload canonico y test directo de `compactIntent` rechazando `outcomeData` venenoso antes de persistir · estado CERRADO.

[S19] P1 · `scripts/db/seed-episodic.test.mjs:60` · seed de revision podia seguir verde sin pasar por invariantes reales de storage · causa: test inyectaba insert mock y las observaciones `openclaw` intentaban fijar `reliability` · fix: observaciones ya no autoasignan reliability; test nuevo inserta las 18 entradas con `insertEpisodicEntry` real y valida default 0.35 para `openclaw` · estado CERRADO.

[S20] P2 · `apps/gateway-api/src/routes/orchestrator-smtp.ts:950` · compaction desde orquestador podia reenviar strings largas o DKIM publico crudo a `outcomeData` · causa: `summarizeOutcome` copiaba campos no secretos casi tal cual · fix: strings no-record y strings >200 se convierten a `...Hash` + `...Present`, `dkimPublicKey` se hashifica explicitamente y secretos por clave se omiten · estado CERRADO.

[S21] P1 · `packages/storage/src/episodic-scratch.ts:1264` · los rechazos del write-gate de memoria no tenian metadata segura para diagnosticar drift de allowlist sin exponer payload crudo · causa: `EpisodicScratchValidationError` solo transportaba codigo/mensaje · fix: `EpisodicScratchValidationDetails` agrega `rejectionStage`, `rejectionKind`, `fieldPath`, forma del valor y flags de redaccion con `rawValueLogged=false`, `rawErrorMessageLogged=false`, `requestBodyLogged=false` · estado CERRADO.

[S22] P1 · `apps/gateway-api/src/routes/openclaw-compact-intent.ts:176` · `compactIntent` podia insertar filas parciales si un step posterior fallaba el write-gate · causa: el flujo validaba e insertaba step por step · fix: construye `pendingEntries`, prevalida todas con `validateEpisodicEntryInput` y solo despues persiste; test cubre cero filas escritas ante rechazo tardio · estado CERRADO.

[S23] P1 · `apps/gateway-api/src/routes/openclaw-compact-intent.ts:119` · el endpoint HTTP de compaction devolvia error crudo y no dejaba auditoria especifica cuando storage rechazaba `outcomeData` · causa: el catch mezclaba validacion de contrato con rechazo del write-gate · fix: respuesta `compact_intent_rejected` con `rejectReason=memory_compaction_rejected`, metadata segura y evento `oc.episodic.compaction_rejected` · estado CERRADO.

[S24] P1 · `apps/gateway-api/src/routes/orchestrator-smtp.ts:909` · el orquestador podia perder memoria silenciosamente cuando storage rechazaba compaction · causa: solo registraba warn generico y seguia sin audit event accionable · fix: detecta codigos `memory_payload_*`, loguea metadata segura, y emite `oc.episodic.compaction_rejected` con evidencia `openclaw_intent`/`compact_intent` · estado CERRADO.

[S25] P2 · `apps/gateway-api/src/audit/schema.ts:6` y `packages/local-store/src/local-file-audit-log.ts:187` · `memory_compaction_rejected` no estaba permitido por los normalizadores/schema de auditoria · causa: la razon nueva no existia en el contrato de audit log · fix: reason agregada a schema y local-store con pruebas de preservacion/validacion · estado CERRADO.

[S26] P2 · `packages/storage/src/episodic-scratch.ts:1117` · allowlist de `outcomeData` podia bloquear claves maquina reales del productor SMTP/DNS o aceptar formatos demasiado laxos bajo claves conocidas · causa: la lista previa era estrecha pero no estaba sincronizada contra productores reales/futuros · fix: se agregan claves maquina esperadas (`hostname`, `zone`, `recordName`, `recordValue`, `changeId`, `operationId`, `scheduledAt`, `tlsStatus`, etc.) con validadores estructurales por tipo DNS, provider id, region, timestamp, selector y hashes · estado CERRADO.

[S27] P2 · `apps/gateway-api/src/routes/orchestrator-smtp.test.ts:326` · no habia contrato CI que demostrara que `configureCompleteSmtp` pasa por el write-gate real ni que sus claves de productor sigan sincronizadas · causa: la cobertura previa podia mockear invariantes de storage · fix: tests de path real `configureCompleteSmtp -> compactIntent -> insertEpisodicEntry`, drift de claves productor, rechazo auditado, schema/local-store rejectReason y seed sincronizado · estado CERRADO.

[S28] P2 · `apps/gateway-api/src/routes/episodic-scratch.ts:94` · la ruta de lectura de memoria podia devolver mensajes internos del store en `details` · causa: el catch exponia `error.message` en errores de storage/validacion · fix: respuestas sanitizadas con `_errors` generico y test que verifica que un mensaje sensible del pool no sale en JSON · estado CERRADO.

## Evidencia de tests

- Corte previo B1: `node --test packages/storage/src/episodic-scratch.test.ts apps/gateway-api/src/routes/openclaw-episodic-memory.test.ts apps/gateway-api/src/routes/openclaw-compact-intent.test.ts apps/gateway-api/src/episodic-scratch-ttl.test.ts apps/gateway-api/src/tool-use-processor.test.ts apps/gateway-api/src/openclaw-tools-builder.test.ts scripts/db/seed-episodic.test.mjs` -> PASS 72/72.
- Corte previo B1: `npm test` -> PASS 781/781.
- `node --test packages/storage/src/stable-stringify.test.ts packages/storage/src/episodic-scratch.test.ts apps/gateway-api/src/routes/openclaw-compact-intent.test.ts apps/gateway-api/src/routes/openclaw-episodic-memory.test.ts scripts/db/seed-episodic.test.mjs` -> PASS 48/48.
- `npm test` -> PASS 787/787.
- `git diff --check` -> PASS.
- `node --test packages/storage/src/episodic-scratch.test.ts apps/gateway-api/src/routes/openclaw-compact-intent.test.ts apps/gateway-api/src/routes/openclaw-episodic-memory.test.ts apps/gateway-api/src/routes/orchestrator-smtp.test.ts apps/gateway-api/src/audit/hash-chain.test.ts packages/local-store/src/local-file-audit-log.test.ts scripts/db/seed-episodic.test.mjs` -> PASS 106/106.
- `npm test` -> PASS 798/798.
- `git diff --check` -> PASS.
- `node --version` -> `v22.22.3`; residual S13 mantiene la repeticion en Node >=24 como gate de merge productivo.
- `node scripts/db/seed-episodic.mjs` contra Postgres real -> NO RUN por instruccion del prompt; Docker/Postgres es accion explicita del operador.
