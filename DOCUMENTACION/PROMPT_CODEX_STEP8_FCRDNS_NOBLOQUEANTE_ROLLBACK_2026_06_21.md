# BRIEF CODEX — Step 8 FCrDNS robusto: espera acotada + fallback no-fatal (Contabo) + no proponer rollback-delete de VPS adoptado

> Direccion de fix elegida por el CTO (2026-06-21): HIBRIDO. Mantener el FCrDNS como verificacion real de entrega, pero con espera acotada bajo el step-timeout y fallback no-fatal (no `handler_timeout`). Ver "Fix 1 (HIBRIDO)" abajo.

Fecha: 2026-06-21 · Auditado por 2 subagentes senior convergentes (anclas file:linea, read-only, sin mutar working tree) · Ejecuta: **Codex** · Base: **`produ`** · Despues: **merge a `produ`**

## Contexto: el run v9 llego al step 8 y el SSH-as-root (PR #10) FUNCIONO
Run `smtp-annualcorpfilings-contabo-20260621-v9` sobre VPS Contabo `contabo-203386827` (IP `66.94.96.220`), dominio IONOS `annualcorpfilings.com`:
- Steps 1-7 OK: reuse `idempotent_already_exists` (PR #9) + DNS A/MX/SPF/DKIM/DMARC en IONOS.
- **Step 8 `bind_webdock_main_domain`: el hostname se setea por SSH como `root` SIN problema** — PR #10 confirmado en vivo. El audit emite `oc.bind.contabo_manual_ptr_required` a los ~5s, NO el viejo exit 255.
- PERO el step 8 muere a los **300000ms con `handler_timeout`**, y eso dispara una propuesta de rollback que **propone BORRAR el VPS reusado**.

Dos defectos independientes a corregir. (Nota operativa: el PTR ya fue seteado manualmente en el panel Contabo a `smtp.annualcorpfilings.com`; estos fixes son de robustez para que el run no dependa de la propagacion del rDNS ni proponga destruir IPs limpias.)

---

## Defecto 1 — `handler_timeout`: el FCrDNS bloquea el step (timeouts desalineados)

Causa raiz (probada end-to-end): el step-timeout generico del orquestador (5 min) es **mas corto** que el poll-window interno de FCrDNS del bind Contabo (15 min). El handler nunca alcanza a devolver su `424 fcrdns_pending`; el dispatcher lo mata antes con `handler_timeout`.

- El timeout `300000` es **generico por-step**, NO especifico del bind: `apps/gateway-api/src/main.ts:5965` (`approvalTimeoutForPlanStep`, default `OPENCLAW_PLAN_STEP_TIMEOUT_MS`), aplicado en `apps/gateway-api/src/routes/orchestrator-smtp.ts:740`. (La entry del bind declara `timeoutMs: 120_000` en `skill-dispatcher.ts:460`, pero el orquestador la sobreescribe via `input.timeoutMs ?? entry.timeoutMs`, `skill-dispatcher.ts:274`; por eso el evento real reporta `timeoutMs:300000`.)
- `handler_timeout` se emite en `apps/gateway-api/src/skill-dispatcher.ts:304-305` (`withTimeout` en `:299`, `DispatchTimeoutError` `:728-749`).
- El consumo de los 5 min = el **poll de FCrDNS del CONTABO BIND PATH**: `bindNonWebdockMainDomain` (`apps/gateway-api/src/routes/webdock-bind-domain.ts:484-730`). Setea hostname por SSH (`:566-598` -> `setHostnameViaSsh:737-787`, rapido), emite manual-PTR (`:602-621`), y luego `verifyFcrdnsWithRetry` (`:624-631`) con `maxWaitMs: deps.fcrdnsMaxWaitMs ?? 900_000` (`:628`) y poll loop `:977-995`. Como el PTR Contabo es panel-only y no estaba seteado, `checkFcrdns` (`:997-1016`) nunca verifica -> espera el techo de **15 min**. Los deps del dispatch NO inyectan `fcrdnsMaxWaitMs` (`skill-dispatcher.ts:470-482`) -> prod corre con `900000`. La rama `424 fcrdns_pending` (`:633-682`) jamas se alcanza.
- El manual-PTR se surfacea bien en `webdock-bind-domain.ts:602-621` (riskLevel `high`, con `serverIp`/`targetPtr`/`instruction`). **Mantener.**

### Fix 1 (HIBRIDO, SOLO Contabo): espera acotada que VERIFICA, con fallback no-fatal
Decision de CTO (2026-06-21): mantener el FCrDNS como verificacion REAL de entrega (no desactivar el gate), pero con espera ACOTADA bajo el step-timeout y fallback no-fatal en vez del `handler_timeout` opaco. El PTR ya esta seteado en el panel Contabo (`66.94.96.220 -> smtp.annualcorpfilings.com`), asi que el rDNS propaga en minutos y el step 8 deberia VERIFICAR dentro de la ventana en el caso normal.

En `bindNonWebdockMainDomain`, tras setear el hostname y emitir el manual-PTR audit:

1. **Acotar el wait de FCrDNS del path Contabo a una ventana MODERADA, bajo el step-timeout de 300s** (p.ej. const/env `CONTABO_FCRDNS_MAX_WAIT_MS`, default ~180000-240000ms = 3-4 min). Clave: que el path Contabo NO use el default `900000` (que excede el step-timeout y causa el `handler_timeout`). Inyectar ese `fcrdnsMaxWaitMs` corto SOLO para Contabo desde `skill-dispatcher.ts:470-482` (deps), o via const dedicada. Esto le da al PTR recien seteado una oportunidad REAL de verificar dentro del step.
2. **Si VERIFICA dentro de la ventana** -> happy-path actual (`oc.bind.contabo_identity_aligned`, `200`/aligned). Sin cambios. Es el caso esperado con el PTR ya seteado.
3. **Si NO verifica dentro de la ventana** -> cambiar la rama `if (!fcrdns.verified)` del Contabo (`webdock-bind-domain.ts:633-682`) de FATAL-pending (`424`/`ok:false` -> aborta el run) a **NO-FATAL advisory**: devolver `200`/`ok:true` con `fcrdnsStatus:"pending"` + `ptrSkipReason:"fcrdns_pending"` + `operatorAction` claro (setear/esperar PTR). Conservar los audits (`oc.bind.contabo_manual_ptr_required` + `oc.bind.contabo_identity_pending_fcrdns` informativo). Asi `runPlanApprovedStep` lo trata como `executed` (`orchestrator-smtp.ts:2559`) y el run AVANZA al step 9 sin quedar trabado.
   - El shape cabe sin romper contrato: `BindWebdockMainDomainResult.fcrdnsStatus` ya es `"verified" | "pending"` (`:56`) y `ptrSkipReason` ya incluye `"fcrdns_pending"` (`:54`); solo cambia statusCode/`ok` en la rama no-verificada.
   - **Reportar el `fcrdnsStatus` final (verified vs pending) en el outcome del run**, para que el operador sepa si la entrega quedo sobre rDNS confirmado. El buffer natural de los steps 9-13 (Postfix, DNS, warmup; varios minutos) le da al rDNS tiempo extra antes del send del step 14.

**Por que el hibrido y no full-advisory ni full-block:** full-advisory (no esperar nada / 1 check) puede dejar pasar un smoke HUECO (envia con rDNS roto -> spam/rechazo); full-block (esperar los 15 min o fallar duro) traba el run y revive el `handler_timeout`. El hibrido PREFIERE confirmar el FCrDNS (entrega real) pero no se cuelga ni tira el rollback equivocado.

**Webdock byte-identico:** tocar EXCLUSIVAMENTE `bindNonWebdockMainDomain` (se alcanza solo si `providerId && !== "webdock"` + adapter en registry, `:216-231`). NO tocar `handleBindWebdockMainDomain` (`:233-471`) ni su `verifyFcrdnsWithRetry ?? 900_000` (`:342`). NO compartir la funcion ni cambiar defaults globales; acotar solo en el call-site Contabo (`:624-631`).

---

## Defecto 2 — el rollback propone borrar un VPS ADOPTADO (no creado por el run)

Causa raiz: el rollback no distingue si ESTE run creo el VPS o lo reuso.

- La propuesta se genera en `apps/gateway-api/src/routes/orchestrator-smtp.ts:1250-1273` (catch del run, `:1225`). Gate actual: `if (serverSlug && failure.step >= 6 && deps.submitRollbackProposal)`. Skill `delete_webdock_server`, `reason: configure_complete_smtp failed at step N`. **Sin ninguna condicion sobre el origen del VPS.**
- El step 4 reuse da outcome `status:"idempotent_already_exists"` (costUsd 0) en `webdock-servers.ts:388-397`. PERO el orquestador en `:945-947` lee SOLO `slug/serverSlug` + `ipv4`, **nunca `outcome.status`** -> se pierde el dato "fue reuse". `SmtpRunState` (`:434-461`) no tiene campo de origen.
- **NO hay auto-delete:** `submitRollbackProposal` (`apps/gateway-api/src/main.ts:789-819`) solo hace `auditLog.append(oc.rollback.proposal_requested)` y devuelve un id sintetico; no llama adapters. El delete fisico vive detras de `DELETE /v1/webdock/servers/:slug` (`webdock-servers.ts:~604-706`), con triple puerta (write key + `WEBDOCK_SERVERS_ENABLE_DELETE==="true"` + `findRecentApproval`), nunca invocado por el orquestador. NO existe path Contabo de cancel/delete. El riesgo es **operacional/UX**: la propuesta aparece para aprobacion humana proponiendo destruir una IP limpia; alguien podria aprobarla por error.

### Fix 2 (minimo): no proponer rollback-delete de VPS adoptado
Persistir el origen del VPS en `SmtpRunState` y gatear la propuesta.

1. **Campo nuevo en `SmtpRunState`** (junto a serverSlug/providerId, `~:434-447`), opcional para backward-compat: `serverCreatedByRun?: boolean` (true = ESTE run lo creo; undefined/false = adoptado o runState viejo).
2. **Registrar el origen en el step 4** (`:945-947`):
   ```
   const createStatus = stringFromOutcome(vps.outcome, ["status"], "");
   runState.serverCreatedByRun = createStatus !== "idempotent_already_exists";
   ```
   y persistir en el `persistSmtpRunState` ya existente (`:952`). Default conservador: cualquier status que NO sea reuse -> creado.
3. **Gatear la propuesta** (`:1250`): `if (serverSlug && runState?.serverCreatedByRun === true && failure.step >= 6 && deps.submitRollbackProposal)`. VPS adoptado -> NO se emite propuesta de delete. El run igual reporta `failed`; solo se omite el delete del VPS reusado. (Opcional: audit/log `rollback_delete_skipped_reused_server` para dejar rastro.)

**Robustez:**
- Backward-compat: runStates viejos tienen `serverCreatedByRun===undefined` -> con el gate `=== true` NO elegibles (conservador y seguro: no proponen borrar).
- Resume firmado: el flag se lee de `runState` (persistido), NO del outcome (en resume el step 4 no se re-ejecuta; serverSlug viene de `runState.serverSlug`, `:632`). El fix ya lo hace asi.
- Reconstruccion legacy (`:1957-1970`): si esa ruta puede llegar al rollback, setear `serverCreatedByRun = (binding.source !== "idempotent_already_exists")` ahi tambien (el reuse persiste runBinding con `source` en `webdock-servers.ts:340-347`). Verificar.

**Webdock preservado:** un VPS Webdock realmente creado sale con status de provisioning (`running`/etc), nunca `idempotent_already_exists` -> `serverCreatedByRun=true` -> sigue elegible para rollback. Un reusado (Webdock o Contabo) -> no elegible. El payload de la propuesta queda byte-identico (mismo spread condicional de `providerId`, `:1270`).

---

## DoD
- Un run Contabo con PTR aun no propagado: el step 8 setea el hostname, surfacea el PTR como `operatorAction`, y CONTINUA (no `handler_timeout`) a steps 9-14. Cuando el FCrDNS verifica (PTR propagado), el happy-path Contabo sigue dando aligned/verified.
- Ante un fallo de step con VPS ADOPTADO (`idempotent_already_exists`), NO se propone `delete_webdock_server`. Con VPS creado por el run, el rollback sigue igual.
- Webdock byte-identico (bind path y rollback de VPS creado intactos). `npm test` verde. Sin tocar hashInput/scope firmado. Sin exponer secretos.

### Tests
- **Actualizar** `apps/gateway-api/src/routes/webdock-bind-domain.test.ts:284-316` ("Contabo run ends pending (424)..."): con Fix 1 ya NO debe esperar `424`/`ok:false`/`error:"fcrdns_pending"`; pasa a esperar `200`/`ok:true` con `fcrdnsStatus:"pending"` + `operatorAction`/`ptrSkipReason:"fcrdns_pending"`, manteniendo asserts de hostname seteado (`:313`) y audits `oc.bind.contabo_manual_ptr_required` (`:314`).
- **Sin cambios** (invariantes que el fix preserva): happy-path Contabo `:220-282` (FCrDNS verifica -> 200/aligned), `502` SSH-fail `:318-343`, no-regresion Webdock `:345-381`.
- **Agregar (Fix 1)**: test con `fcrdnsMaxWaitMs` realista (>0) + resolver que nunca verifica, asertando que el handler retorna por si mismo un outcome no-fatal (no cuelga hasta el techo). El harness hoy fuerza `fcrdnsMaxWaitMs:0`/`pollInterval:0` (`:417-418`), por eso no cubre la regresion.
- **Agregar (Fix 2)**: test de rollback gateado por `serverCreatedByRun` -> reusado no propone delete; creado si propone.

## Anclas (file:linea)
- Step-timeout `300000` generico: `main.ts:5965` (`approvalTimeoutForPlanStep:5954-5966`); aplicado en `orchestrator-smtp.ts:740`.
- Emit `handler_timeout`: `skill-dispatcher.ts:304-305` (`:299`/`:274`; `withTimeout:728-749`); entry bind `:460`; deps dispatch `:470-482`.
- FCrDNS poll Contabo (consume el tiempo): `webdock-bind-domain.ts:624-631` (`?? 900_000` en `:628`), loop `:977-995`, `checkFcrdns:997-1016`.
- Rama pending-fatal a convertir en no-fatal: `webdock-bind-domain.ts:633-682`; tipos `fcrdnsStatus:56`/`ptrSkipReason:54`.
- Manual-PTR surface (mantener): `webdock-bind-domain.ts:602-621`.
- Branch provider bind: `webdock-bind-domain.ts:216-231`; Webdock path `:233-471` (su FCrDNS `:342`).
- Rollback proposal: `orchestrator-smtp.ts:1250-1273` (gate `:1250`, payload `:1258-1271`); catch `:1225`.
- Outcome reuse `idempotent_already_exists`: `webdock-servers.ts:388-397`; runBinding `source` `:340-347`.
- Orquestador descarta status del create: `orchestrator-smtp.ts:945-947`; `SmtpRunState` `:434-461`; resume serverSlug `:632`; reconstruccion legacy `:1957-1970`.
- Propose-only (sin auto-delete): `main.ts:789-819`; delete real `webdock-servers.ts:~604-706`.

## Luego: merge a produ
Tras verde + auditoria, **mergear a `produ`**. El gateway corre el working tree de `feature/canvas-v5-preview`: integrar `produ` + `bash scripts/gateway-restart.sh` para que tome.
