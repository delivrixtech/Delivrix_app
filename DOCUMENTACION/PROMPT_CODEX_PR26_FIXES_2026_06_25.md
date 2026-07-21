# PROMPT CODEX -- Fixes pre-merge del PR #26 (seleccion explicita de cuenta)

Fecha: 2026-06-25 - Ejecuta: Codex - El PR #26 (rama codex/provider-account-selection, 3aa27ba) fue auditado por 6 subagentes y quedo SOLIDO: invariantes de hash/firma PASS, footgun #1 cerrado (unknown/no-write/unhealthy -> hard-fail step 0 sin orphan), resume/gated/failover OK, verdes reproducen, PR2 NO tocado, sin forbidden files. ANTES de merge quedan 1 BLOQUEANTE + 2 NITS baratos (decision Juanes: arreglarlos en este PR). Otros 3 nits van como issues (abajo).

---

## FIX P1 (BLOQUEANTE) -- validar budget/rate de la cuenta explicita ANTES de comprar el dominio

HALLAZGO (confirmado independiente): el gate de step 0 `assertRequestedCreationAccountSnapshotEligible` (orchestrator-smtp.ts:690) valida health/write/exists via snapshot (`creationAccountSnapshotIneligibleReason` :4203-4211) pero NO budget/rate. Una cuenta explicita SANA pero en cap 4/24h pasa step 0, se compra el dominio (`register_domain_route53`, ~USD15, step ~781) y recien en step 4 `resolveRequestedCreationAccount` (:4233+) hace `listWebdockCreationServers` + `evaluateCreationBudget` y lanza `requested_account_ineligible reason=rate_exceeded` -- DESPUES de gastar el dominio. (Solo el dominio se gasta; el VPS no.) Esto contradice la intencion del brief: "si el operador nombro cuenta inelegible -> falla ANTES de cualquier gasto".

FIX:
- Cuando hay `requestedServerAccountId` (cuenta explicita), hacer un PREFLIGHT de budget/rate de ESA cuenta (un read live dirigido a 1 cuenta -- barato) ANTES de `register_domain_route53` (antes de step 1/2). Reusar `resolveRequestedCreationAccount` / `evaluateCreationBudget` para esa cuenta. Si esta en cap -> fallar `requested_account_ineligible: account=X reason=rate_exceeded` en step 0, sin gastar dominio.
- MANTENER el recheck del step 4 (no quitarlo): cubre la carrera/TOCTOU entre el preflight y el create real.
- TRANSITORIO (importante, no reintroducir el bug de filing-ops): el preflight de budget hace un read live; si ese read FALLA (429/red/timeout), reintentar 1 vez con backoff corto. Si tras el retry sigue sin poder verificarse, NO gastar a ciegas: abortar con razon clara y accionable (p.ej. `requested_account_budget_unverifiable: account=X`) en vez de comprar el dominio. (Mejor pedir reintento que quemar USD15.) Distinguir esto de "cap agotado" (que es un NO definitivo).
- El preflight NO entra a params/hashInput (igual que el resto del canal; no romper idempotencia/byte-identidad del default).

DoD:
- Test: cuenta explicita SANA pero en cap 4/24h -> `status:failed`, `failedStep:0`, error `requested_account_ineligible ... reason=rate_exceeded`, y ASSERT de que `register_domain_route53` NO corrio (no spend, sin rollback de dominio).
- Test: read live de budget transitorio en el preflight -> reintenta; si persiste -> falla `..._unverifiable` SIN gastar dominio.
- Sin cuenta explicita: comportamiento byte-identico (el preflight solo corre si hay `requestedServerAccountId`).

---

## NIT A -- error tsc nuevo del PR (1 linea)

El PR sube el baseline tsc de 120 a 122. Uno es del PR: orchestrator-smtp.ts:4275 `enabled: boolean | undefined` no asignable a `enabled: boolean` (en el map del array de elegibilidad de cuenta). FIX: tipar/coercer el campo a boolean (`enabled: Boolean(x)` o el default explicito). DoD: `npx tsc --noEmit -p apps/gateway-api/tsconfig.json` no incluye el error de :4275; baseline vuelve a <=121 (los 6 de pg + los pre-existentes, sin el nuevo).

---

## NIT B -- restaurar la frase del governor en el prompt (se perdio al compactar)

Al compactar el flow paso 3 de OPENCLAW_SYSTEM_PROMPT.md, se BORRO la oracion del governor (rate 4/24h por cuenta / `creation_rate_exceeded` / override humano auditado). El comportamiento no cambia, pero el operator-facing context del prompt quedo mas delgado y OpenClaw pierde el "por que" del limite. FIX: restaurar un CROSS-REF de 1 linea en el paso 3 (p.ej. "governor: 4 VPS/24h por cuenta, bloqueo `creation_rate_exceeded`, override humano auditado -- ver [seccion governor]"). OJO BUDGET: Codex reporto 11796/11800 (~4 tokens libres); compactar otra redundancia para que entre (medir con `OPENCLAW_CONTEXT_LOCAL_ONLY=true bash scripts/openclaw/build-system-context.sh`; debe quedar <11800 o el push falla con exit 1). DoD: build local-only OK bajo budget + la linea del governor presente.

---

## ISSUES DE SEGUIMIENTO (NO en este PR -- crear como GitHub issues)

1. **Backstop `?? webdockAdapter` sin guardia** (skill-dispatcher.ts:860, main.ts:649/656/1683): hoy seguro porque el orchestrator es el UNICO productor de accountId no-default, pero un futuro caller directo del dispatcher con accountId crudo resucitaria el footgun (cae a cuenta-1 en silencio). Defense-in-depth: rechazar accountId desconocido en el resolver mismo.
2. **proposals-sign.ts:738 warns-and-drops** un serverAccountId malformado (returns undefined) en vez de lanzar, inconsistente con el schema y el orchestrator (que SI lanzan). El hard gate real es el orchestrator, asi que es seguro, pero unificar a fail-closed es mas limpio.
3. **Falta test gated+explicito-non-ops**: la combinacion "cuenta explicita != ops en el gated path" solo esta cubierta indirectamente (los tests de cuenta explicita corren con autonomy ON). Anadir un test del guard de step 0 (:687-688) para esa combinacion. Coverage, no logica.

---

## SYNC (despues de mergear, regla local+Hostinger junto)
Codex merge a `produ` -> restart gateway local (la tool nueva entra solo en proceso fresco) -> push Hostinger `build-system-context.sh` (verifica budget) -> verificar `/health` 200 + pedirle a OpenClaw un SMTP "para la cuenta <X>" y que respete o falle claro. Ver [[feedback-deploy-local-y-hostinger-sync]].
