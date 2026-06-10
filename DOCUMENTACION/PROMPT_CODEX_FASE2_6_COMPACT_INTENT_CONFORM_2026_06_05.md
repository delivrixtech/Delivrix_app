# Codex — FASE 2.6 (FINAL, tras 3 auditorías): que `compact_intent` SUCCEDA — set mínimo-quirúrgico, sin tocar el gate

> **Objetivo (CTO):** un run de `configure_complete_smtp` cierra **sin un solo ⚠️** — la memoria episódica se escribe bien, no se oculta el error. **NO romper nada.**
> **3 auditorías (6 subagentes) convergieron en esto.** Descartes importantes: (a) NO `additionalProperties:false` (riesgoso). (b) **NO el no-op por intentId** — está MAL DIAGNOSTICADO: el orquestador compacta con `intentId=smtp-<dominio>-<fecha>` y el agente con `intentId=chat:<hash>` (inyectado por el bridge, `openclaw-bedrock-bridge.ts:357,1067,1083`); **NUNCA coinciden** (verificado en 3/4 runs reales del audit) → el no-op jamás dispara.
> **Los dos caminos fallan por razones DISTINTAS:** Camino A (orquestador) por `outcomeData` fuera del allowlist; Camino B (agente) SOLO por `decision`>280 (su outcomeData es esquelético/seguro, `compactIntentStep` `openclaw-bedrock-bridge.ts:1073` no lleva outcomeData).
> **Base:** `produ` `e8fa705`. Rama `codex/fase2.6-compact-intent`. **Subagentes + Auditor.** **NO tocar la seguridad del write-gate.** Stop-and-report.

## Causa raíz (anclas e8fa705, confirmada en audit)
Write-gate de memoria (`packages/storage/src/episodic-scratch.ts`) estricto por diseño (anti-poisoning): allowlist CERRADO de keys `outcomeData` (`:193-263`), validado RECURSIVAMENTE (`walkOutcomeData :1090-1144`); `errorMessage` machine-code `/^[a-z0-9_.:-]+$/i` (`:1004`); injection/zero-width/HMAC/16KB. `decision` NO entra al gate — se valida en el envelope (`openclaw-compact-intent.ts:368` `string(...,1,280)`, y antes en `skill-schemas.ts:481` `boundedText(1,280)`).
- **Camino A** (`compactRunIntent`, SIEMPRE corre `:775/836`): `summarizeOutcome` (`orchestrator-smtp.ts:2479-2502`) copia keys CRUDAS (`output[key]=item :2500`). **≥10 keys no-allowlisted, ANIDADAS, en 8/14 steps:** `workspace.{path,absolutePath}` (~6 steps), `candidates[].spamhausDBL`/`rationale`/`registrarOptions[].registrar`, `zoneResolution.{source,smtpSetup,cleanupSuggested}`, `dkimPrivateKeyPath`, `postfixLogTail`/`preValidations`, `sent[].{to,msgId}`, `ptrSkipReason`/`operatorAction`. → `unknown_outcome_key`/`memory_payload_free_text_forbidden` (CONFIRMADO en audit, run corpdocfiling 18:05:27, `fieldPath=outcomeData.candidates[0].spamhausDBL`). En runs fallidos además `errorMessage:failure.message` (texto libre) `:2462,2466`.
- **Camino B** (tool del agente): `decision`>280 → "decision length" (`:368`) → el wrapper `invokeMemoryToolOverHttp` (`tool-use-processor.ts:778`) lo enmascara como `memory_tool_failed`.

## FIX 1 (núcleo, Camino A) — `conformOutcomeData` en storage (fuente única, drop recursivo)
- **Crear** en `packages/storage/src/episodic-scratch.ts`, JUNTO al gate, una función EXPORTADA `conformOutcomeData(value): unknown` que **reutilice los MISMOS Sets/predicados privados** del módulo (`outcomeStringAllowedKeys`/`outcomeStringArrayAllowedKeys`, `isStructuredOutcomeString`, `normalizeMemoryKey`, `forbiddenOutcomeKeyFragments`, injection/zero-width) y, recorriendo el árbol IGUAL que `walkOutcomeData` (con la misma semántica `(value,parentKey)`, recursión en objetos Y arrays incluyendo `candidates[]`/`sent[]`/`registrarOptions[]`): **DROPEE** toda key-string no-conforme (key no-allowlisted, o value que no pasa el patrón, o key/valor prohibido); **conserve** numbers/booleans/null tal cual (el gate no los valida). NO redactar-manteniendo-key (`redactUnsafeOutcomeData :1224` mantiene la key → el 400 persiste; NO sirve).
- En `summarizeOutcome` (`orchestrator-smtp.ts:2479-2502`) — o en su envoltorio `compactStepFromResult :2458` — pasar el outcome por `conformOutcomeData` antes de emitir. Importar la fn desde `packages/storage` (`index.ts:1` re-exporta; verificar que `conformOutcomeData` quede `export`). **NO reimplementar el walk en el orquestador** (drift, sobre todo con multi-provider 5.12).
- `summarizeOutcome` tiene **un solo caller** y NO se usa en reporte/audit/Canvas (esos arman su objeto con `stringFromOutcome :766-790`). El `step.outcome` crudo queda intacto en stepResults/reporte; solo se filtra la copia a memoria. **Cero blast radius. Gate byte-idéntico.**

## FIX 2 (núcleo, Camino A) — `errorMessage` → machine-code
En `compactStepFromResult` (`:2447-2471`): `errorMessage` debe conformar `/^[a-z0-9_.:-]+$/` — slug del primer token de `failure.message` (ya vienen machine-friendly: `plan_scope_mismatch`, `resume_scope_drift`…) o **omitir** (opcional; el detalle humano vive en el audit chain `oc.orchestrator.step_failed :810-815`). La rama `isAfterFailure` (`:2466`, frase inglesa) → omitir o code fijo `skipped_after_prior_failure`. Mantener `errorClass`.

## FIX 3 (Camino B) — truncar `decision` a 280 + log, en parser Y schema
El agente manda `decision`>280. Truncar (no rechazar) a 280 **+ un log/contador** (no silencioso) en AMBOS: `parseCompactIntentInput` (`openclaw-compact-intent.ts:368`) Y `compactIntentParamSchema` (`skill-schemas.ts:481`) — si solo el parser, el schema rechaza antes y el truncado es inalcanzable. `decisionHash` no participa de dedup (`ON CONFLICT (intent_id,step)` `episodic-scratch.ts:322`), así que truncar es benigno. (El orquestador ya hace `slice(0,280)` `:2424`; esto cubre el path del agente, que NO pasa por ese slice.)

## DESCARTADO / DIFERIDO (decisión de las auditorías)
- **DESCARTADO — no-op por intentId:** roto (A=`smtp-…`, B=`chat:…`, nunca matchean; verificado en audit). NO implementar.
- **DESCARTADO — `additionalProperties:false`** en la tool: riesgoso (drift, no replica la semántica recursiva/normalizada del gate). El gate ya saneará; con FIX 3 el Camino B succede.
- **DIFERIDO (higiene, opcional, no necesario para "sin ⚠️"):** (1) **convergencia de intentId** — que el bridge inyecte el `runId` del `configure_complete_smtp` como `_openclaw.intentId` (`openclaw-bedrock-bridge.ts:357,1067`) para que A y B usen el mismo intent y el `ON CONFLICT` evite la entrada de memoria duplicada. (2) **observabilidad** — wrapper expone el `code` real (`tool-use-processor.ts:778`) + auditar el parser-400 (`openclaw-compact-intent.ts:119-133`). Ambos buenos follow-ups; NO bloquean el "sin ⚠️".
- **OPCIONAL (CTO) — híbrido recall:** agregar `spamhausdbl`/`source`/`registrar` al allowlist del gate (aditivo, seguro, pasan validadores de valor) para preservar la memoria de "por qué se eligió el dominio". Default: omitir (gate 100% intacto, pérdida de recall marginal).

## GUARDRAILS DE IMPLEMENTACIÓN (condición de GO — verificado por auditoría final)
1. **FIX 1 = "walkOutcomeData pero DROP en vez de THROW", reusando los MISMOS predicados privados** del gate (`outcomeStringAllowedKeys`, `outcomeStringArrayAllowedKeys`, `isStructuredOutcomeString`, `normalizeMemoryKey`, `forbiddenOutcomeKeyFragments`, `injectionPattern`, `zeroWidthPresencePattern`, `isHashOutcomeString`). Dropear una key-string si falla CUALQUIERA de los 5 checks — **no solo por key no-allowlisted, también por VALOR inválido** (key allowlisted con value que no pasa `structuredOutcomeStringPattern` DEBE dropearse). Recursión en objetos Y arrays con la misma semántica `(value, parentKey)` (parentKey heredado en arrays). Esto da garantía por construcción (probado: 24/24 contra el gate real). Conservar numbers/booleans/null. Correr DESPUÉS del pre-hash existente de `summarizeOutcome`.
2. **FIX 3 = truncar `decision` INLINE** en las 2 líneas (`openclaw-compact-intent.ts:368` y `skill-schemas.ts:481`) — **NO modificar los helpers compartidos `string()` (13 callers) / `boundedText()` (12 callers)**; tocarlos sería regresión en intentId/tool/errorMessage. Truncar solo el valor `decision`.
3. **FIX 2 = cubrir AMBAS ramas** de `compactStepFromResult`: `isFailureStep` (`errorMessage:failure.message`, `:2462`) Y `isAfterFailure` (frase con espacios, `:2466`). Las dos emiten free-text que el gate rechaza.

## NO TOCAR
Seguridad del write-gate (`guardedText`, `injectionPattern`, zero-width, HMAC, 16KB, validadores de valor); `read_episodic_scratch`/RAG; SMTP 1-14; el guard `signatureId`/`plan:` (`:2469`); el `slice(0,280)` del orquestador (`:2424`); los helpers compartidos `string()`/`boundedText()`.

## Tests (node:test — el hueco fue testear con MOCK; usar el gate/conformador REAL)
- **DoD anti-whack-a-mole:** correr `conformOutcomeData(summarizeOutcome(outcome))` sobre los outcomes REALES de los 14 steps (incluido `suggest_safe_domain` con `candidates[].spamhausDBL` y los mutating con `workspace.path`) y verificar que el resultado pasa `assertStructuredOutcomeData`/`validateEpisodicEntryInput` SIN throw. Cubrir anidamiento (objetos + arrays).
- **errorMessage:** run fallido con `failure.message` free-text → compact SUCCEDE (machine-code).
- **Camino B decision:** decision>280 → truncado (parser + schema), SUCCEDE; sin "decision length".
- **Seguridad intacta:** payload con free-text/injection bajo cualquier key → el gate SIGUE rechazando (no debilitamos). `conformOutcomeData` dropea, el gate sigue siendo la barrera dura.
- No-regresión: read_episodic_scratch/RAG, SMTP 1-14, suite completa (ignorar flake `approval-token.test.ts` `/private/tmp`).

## Deploy
Código → local + produ + FF. **Push produ a origin/produ** (+46). **Sin cambio de system-prompt → Hostinger NO se toca.** Reportá SHA + el test DoD (14 outcomes reales pasan el gate vía conformOutcomeData) + un run/simulación donde `compact_intent` SUCCEDA sin ⚠️.

## Hecho cuando
Un run de `configure_complete_smtp` cierra con `compact_intent` **exitoso** en ambos caminos (A: outcomeData conformado; B: decision truncado), reporte **sin ⚠️ porque no hay error**, y el write-gate igual de fuerte (sigue rechazando inyección). Reportá SHA, tests, y la corrida limpia.
