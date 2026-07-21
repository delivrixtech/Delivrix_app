# PROMPT CODEX -- Seleccion explicita de cuenta+proveedor (first-class) para configure_complete_smtp

Fecha: 2026-06-25 - Ejecuta: Codex - Auditado por 15 subagentes read-only sobre el working tree (evidencia file:line abajo).
SUPERSEDE el FIX2 de `PROMPT_CODEX_GOVERNOR_CUENTA_FILING_OPS_2026_06_25.md`. FIX1/FIX4 de ese brief SIGUEN VALIDOS (se referencian aqui). FIX3 (prompt) se reescribe aqui (FASE F).

DECISION DE ALCANCE (Juanes, 2026-06-25): se monta PRIMERO el PR1 (este, AUTONOMO); el PR2 (Contabo) va DESPUES, cuando el operador conecte las creds de sus cuentas Contabo. >>> CODEX: ARRANCA SOLO POR PR1. NO implementes PR2 todavia. <<<
- PR1 = seleccion explicita de cuenta (Webdock) sobre el registro ACTUAL + FASES A-G. Entrega valor solo y resuelve el caso filing-ops. NO toca Contabo ni unifica el registro.
- PR2 (diferido) = registro unificado provider:account + multi-cuenta Contabo (factory N-cuentas + governor Contabo con la MISMA politica 4/24h por cuenta que Webdock).
El registro unificado se hace en PR2 (es donde se necesita) para que PR1 sea minimo y de bajo riesgo. Naming neutral (`serverAccountId`) desde PR1 -> PR2 NO re-trabaja el contrato del tool ni la firma. Detalle/anchors en SECCION 9. Verificado por subagente dedicado: el CORE del governor ya es provider-agnostico; la extension a Contabo (PR2) es WIRING, no logica nueva de rate.

---

## 0. EL MODELO CORRECTO (lo que el operador exige)

NO es "el governor elige la cuenta y opcionalmente se puede override". ES:

- El operador nombra **proveedor + cuenta** (ej. proveedor `webdock`, cuenta `quaternary`/emael). El SMTP se crea **EXACTAMENTE AHI**.
- El governor **solo auto-elige cuando el operador NO especifica cuenta**. Sin especificacion -> comportamiento byte-identico al de hoy.
- Si la cuenta nombrada **no es elegible** (no write-capable / no sana / sin budget / no existe) -> **FALLA CLARO con la razon**, NUNCA cae en silencio a 'ops' ni a cuenta-1.
- Debe ser **proveedor-neutral en el naming** (no `webdockAccountId`). Hoy la seleccion de cuenta solo aplica a Webdock (5 cuentas); Contabo es single-account. Validar el PAR (proveedor, cuenta); no romper eso.

El plumbing YA EXISTE: `serverAccountId` es un canal paralelo hermano de `vpsProviderId`, deliberadamente FUERA de `params`/`hashInput`. La ruta autonoma de create (path B) ya rutea por `accountId`. Esto NO es un hito desde cero: es exponer + sellar + validar + auditar el canal que ya corre.

---

## 1. INVARIANTES DURAS (no romper -- son la razon de auditar)

1. **Default byte-identico**: si NO se especifica cuenta, `serverAccountId` queda `undefined`, se OMITE de `stableStringify`, el governor corre igual. `hashInput` y `scopeHash` byte-identicos. (Garantiza no romper single-account.)
2. **`serverAccountId` NUNCA entra a `params`/`hashInput`** (orchestrator-smtp.ts:910-918). Si entra, cambia el inputHash del step create -> `resume_scope_drift: step_input_changed` (:2358-2359) en cada resume -> bloquea resume legitimo. Viaja por canal paralelo (como hoy).
3. **Path A HTTP (`/v1/webdock/servers/create`, main.ts:1619-1631) NO se toca**: esta pineado a ops por diseno, su body no tiene campo cuenta, lo usan onboard-flow legacy + tests, NO OpenClaw. Tocarlo es footgun. Solo se toca **path B** (dispatcher autonomo plan-firmado).
4. **Gated path sigue single-account**: `submitAndAwaitApproval` aborta con `gated_multiaccount_unsupported` si `serverAccountId !== "ops"` (orchestrator-smtp.ts:2769). La seleccion explicita SOLO funciona en la ruta autonoma plan-firmada. NO relajar el gated path; SI hacer que falle claro (no que aterrice en ops).
5. **No meter secretos/inventario crudo en audit** (solo booleans de estado por cuenta).
6. **Claves Webdock BARE** (aplica en PR2, al unificar el registro a provider:account): el accountId emitido para Webdock sigue bare ("ops", no "webdock:ops") -> `get("ops")` / audit / inventoryHash byte-identicos cuando solo hay Webdock. (Footgun del registro unificado, ver SECCION 9 PR2. En PR1 no aplica porque el registro no se toca.)

---

## 2. FASE A -- Exponer la cuenta en el tool-schema (path B)

HOY: `configure_complete_smtp` input_schema (openclaw-tools-builder.ts:932-962) tiene 13 props, NINGUNA de cuenta. `vpsProviderId` es PROVEEDOR (enum webdock|contabo, skill-schemas.ts:781), no cuenta. La validacion es allowlist estricta (`configureCompleteSmtpSkillParamSchema`, skill-schemas.ts:505-530; claves no listadas se descartan).

HACER:
- Anadir prop OPCIONAL `serverAccountId?: string` al input_schema (openclaw-tools-builder.ts:932) y al skill schema (skill-schemas.ts:505), guardado `undefined -> {}` EXACTAMENTE como `vpsProviderId`.
- **NO hardcodear un enum** de cuentas (son dinamicas). Validar el valor en runtime contra el inventario de cuentas (`resolveWriteCapableCreationAccounts` / `listCreationAccounts` / inventory_accounts) y **fallar cerrado** si no existe/no es del proveedor.
- Threadear `input.serverAccountId` a `effectiveInput` (mismo patron sibling que `vpsProviderId`).

DoD: el LLM puede pasar `serverAccountId:"quaternary"`; un valor desconocido NO se descarta en silencio -> se valida y falla claro.

---

## 3. FASE B -- Governor: honrar la cuenta explicita + fail-clear

HOY: `resolveCreationAccount` (orchestrator-smtp.ts:3813-4034) hace read live por cuenta, filtra healthy/budget, y elige por tie-break (compareSelectionCandidates: max remaining, luego localeCompare; DEFAULT_CREATION_ACCOUNT_ID='ops', creation-rate-governor.ts:5,411-422). La reuse-gate (:878-882) ya reutiliza `runState.serverAccountId` en intento 0 ANTES de llamar al governor.

HACER (mirror del patron `vpsProviderId`/`resolveVpsProviderId`):
- Sembrar la eleccion del operador en `runState.serverAccountId` ANTES del failover loop (orchestrator-smtp.ts:877) para que la reuse-gate (:878-882) la consuma en intento 0; O threadear `requestedAccountId` y que :883 lea `operatorChoice ?? reuseAccountId ?? resolveCreationAccount(...)`.
- Si hay cuenta explicita: validar elegibilidad (enabled && healthy && budget allowed) reusando la evaluacion por-cuenta que el governor YA computa; si elegible -> usarla, **bypass del tie-break** (no `evaluateAccountSelection`).
- Si NO elegible (no write-capable / unhealthy / budget exhausted / no existe) -> **throw `OrchestratorFailure("failed", ...)` con razon especifica** (`requested_account_ineligible: account=X reason=<not_write_capable|unhealthy|rate_exceeded|unknown>`), reusando el bloque de audit/emit existente (:3989-4033). NUNCA caer a `evaluateAccountSelection` ni a 'ops'.

OJO FOOTGUN (critico): hoy un accountId desconocido cae en silencio a `webdockOpsAdapter`/cuenta-1 (`skill-dispatcher.ts:844-861` `?? webdockAdapter`; main.ts:649). Con cuenta explicita esto DEBE ser hard-fail, no fallback. (Es exactamente el modo de falla de filing-ops, amplificado.)

DoD: cuenta explicita elegible -> aterriza ahi; inelegible -> falla claro sin crear VPS; sin cuenta -> governor byte-identico.

---

## 4. FASE C -- Sellar la cuenta en el scope firmado + drift-check + persistir para resume

HOY: `PlanApprovalScope` (proposals-sign.ts:48-57) sella runId/domain/provider/requireExistingDomain/budgetUsdMax/recipient/plannedSkill/plannedSteps. NO sella `serverAccountId` NI `vpsProviderId` (hueco pre-existente). `scopeHash = sha256(stableStringify(scope))` (:720), DISJUNTO de `hashInput`. El drift-check de resume/fresh (orchestrator-smtp.ts:1876-1880, 3263-3282) verifica provider pero NO cuenta.

HACER:
- Anadir `serverAccountId?` (y, recomendado, `vpsProviderId?` para cerrar el hueco gemelo) a `PlanApprovalScope` (:48-57), poblado en `extractConfigureCompleteSmtpPlanScope` (:670-706). Entra al `scopeHash` (firma/audit, a prueba de manipulacion) SIN tocar `hashInput`. Campo opcional -> omitido cuando ausente -> firmas single-account byte-identicas.
- Anadir enforcement drift-check: `serverAccountId` runtime == `scope.serverAccountId` (mirror del check de provider :3279); si difiere -> fail-closed. **Sin enforcement, sellar la cuenta es decorativo** y un canal buggy/malicioso podria re-rutear.
- **RESUME (sutil, mi brief lo omitio)**: el resume del step create lee la cuenta de `runState.serverAccountId` (:878), NO de scope/params. Por eso la eleccion DEBE persistirse durablemente en `runState.serverAccountId` en sign/launch (patron existente :896). Si solo va al scope, un resume en proceso fresco cae al governor -> cuenta equivocada / VPS huerfano. Sellar en scope da binding de firma; persistir en runState da reconstruccion en resume. Se necesitan AMBOS.

DoD: plan firmado con `serverAccountId:"quaternary"` -> el create va ahi o falla explicando; resume tras reinicio del gateway respeta la misma cuenta; firma single-account sin cambios.

---

## 5. FASE D -- Gate de elegibilidad PRE-FIRMA (antes de gastar ~USD 15)

HOY: la resolucion de cuenta ocurre DESPUES de firmar y de empezar a gastar (sign en orchestrator-smtp.ts:645-647; resolveCreationAccount en :884, justo antes del create :899; compra de dominio :747). El read del governor es UNO por cuenta SIN retry (:3863-3869); cualquier throw o `sourceKind!=live` -> healthy:false -> cuenta excluida en silencio (:3878). Cache asimetrica: ops cacheTtlMs:0 (main.ts:398) vs secundarias TTL 60s (webdock-real-adapter.ts:182,265) -> las secundarias se congelan con un hipo transitorio (causa raiz de filing-ops).

HACER:
- Anadir un gate de elegibilidad PRE-FIRMA: si el operador nombro cuenta, validar `canCreate && health=="healthy"` usando el **snapshot ya pulido** por el poller de health (`classifyComputeAccountHealth` / account-health de PR#18/#23) -- NO un read live fragil nuevo. Si no elegible -> "cuenta X no disponible: <razon>" ANTES de cualquier gasto.
- Distinguir transitorio de inhabil: gate duro en `unauthorized`/`suspended`; `degraded` como soft (warn + 1 retry acotado), para no cambiar "excluir en silencio" por "bloquear en falso".
- El gate NO entra a hashInput (canal paralelo, consistente con FASE C).

NOTA cache (de FIX1 del brief previo, sigue valido): preferir invalidar la cache de la cuenta antes del read del governor sobre poner TTL=0 global (TTL=0 global anade un live call por cuenta en el hot path -> latencia/429 bajo failover).

DoD: nombrar una cuenta no-sana -> falla ANTES de comprar dominio/VPS, con razon.

---

## 6. FASE E -- Auditar la eleccion + evento de skip por-cuenta

HOY: `oc.plan.signed` (proposals-sign.ts:366-383) NO lleva la cuenta (no esta en el scope). En exito, el governor solo hace `logger.info` (:3930), NO audit-chain; en fallo SI audita (:3989-4001) -- asimetria. No existe evento `creation_account_chosen`. `creation_rate_read_failed` solo se emite si NINGUNA cuenta leyo live (evaluations.length===0, :3902-3924); la exclusion de quaternary con ops sana NO dejo rastro (gap filing-ops).

HACER:
- Con FASE C, `serverAccountId` entra al scope -> `oc.plan.signed` prueba la intencion firmada.
- En exito (:3928-3939) emitir `oc.orchestrator.creation_account_chosen` con `selectedAccountId` + `selection.candidates[]` (por cuenta: enabled/healthy/budgetAllowed/remaining). Un evento = prueba de a-donde-fue + por-que-los-otros-se-saltaron. (Solo booleans, sin inventario crudo.)
- Esto cubre el "evento de skip por-cuenta" de FIX1: la proxima exclusion deja traza aunque haya cuentas sanas.

DoD: tras un run, el audit prueba cuenta pedida (signed scope) y cuenta usada (creation_account_chosen) y el estado de las saltadas.

---

## 7. FASE F -- Prompt OpenClaw (reescribe el FIX3) + budget

HOY (OPENCLAW_SYSTEM_PROMPT.md): linea 216 describe `configure_complete_smtp(...)` como caja negra sin params; linea 188 dice "Webdock (5 cuentas)" sin nombrarlas; linea 277 presenta el governor solo como LIMITE de rate, nunca como SELECTOR. El agente YA recibe accountId+accountLabel por cuenta en `## inventory_accounts` del live context (openclaw-bedrock-bridge.ts:1068, :2014-2023) -- el prompt nunca dice que son targeteables.

HACER (3 ediciones quirurgicas, sin bloque nuevo):
1. Linea 216: nombrar params -> `configure_complete_smtp(...,provider,serverAccountId,...)`, anotando que ambos default al governor si se omiten.
2. Seccion [14] paso 3 (~:277): "si el operador nombra cuenta/proveedor, resuelve `serverAccountId` contra `inventory_accounts` (accountId/accountLabel) y pasalo; si no existe, ABSTENTE (no firmes); el governor elige cuenta SOLO cuando no se especifica."
3. Seccion [14] paso 5 (~:284): anadir `serverAccountId` a la tupla de scope firmado (gate de satisfacibilidad ANTES de firmar).

BUDGET: solo ~14 tokens de headroom (11786/11800, cap duro `exit 1`). Compactar la duplicacion de reglas flag-spam/preconditions entre [10]/[11A]/[13] (lineas ~158/195-204/271) a un cross-ref de una linea. Medir con `OPENCLAW_CONTEXT_LOCAL_ONLY=true bash scripts/openclaw/build-system-context.sh` antes de pushear.

NOTA: el prompt es inerte hasta que el orquestador honre `serverAccountId` (FASES A-C). Coordinar para que prompt + wiring aterricen JUNTOS.

---

## 8. FASE G -- Frontend (minimo, recomendado, ~10 lineas)

HOY: la tarjeta de aprobacion (`formatPendingProposalDryRun`, PendingApprovalGate.tsx:263-281) muestra skill/severity/runbook/target/budget pero NO cuenta ni proveedor. CanvasV5 muestra `providerId` como tag (:286-287) pero no `serverAccountId` (existe en live-tool-types.ts:220, sin render). No existe UI de picker (la seleccion es 100% via chat OpenClaw).

HACER (opcional pero recomendado para que el operador verifique ANTES de firmar):
- En `formatPendingProposalDryRun` anadir lineas `account: ${params.serverAccountId ?? '-'}` + `provider: ${params.provider ?? params.vpsProviderId}` (mismo patron que ya lee `budgetUsdMax`).
- Solo es confiable si la cuenta esta sellada en el scope (FASE C). Cero-frontend es aceptable si el scope firmado se muestra en el chat; mostrarlo en la tarjeta es la UX segura.

---

## 9. CONTABO MULTI-CUENTA -- ALCANCE COMPLETO (decision Juanes 2026-06-25)

DECISION: las cuentas Contabo YA existen y se conectan en dias -> alcance COMPLETO en 2 PRs PEGADOS la misma semana. El governor gobierna Contabo con la MISMA politica que Webdock (4 VPS/24h por cuenta; mismo riesgo de reputacion de rango). VERIFICADO (subagente dedicado): el CORE del governor (creation-rate-governor.ts) YA es provider-agnostico (toma `{creationDate}[]` + accountId string); la extension a Contabo es WIRING + factory + registro, NO logica nueva de rate.

### PR1 (primero, AUTONOMO) -- seleccion explicita de cuenta (Webdock)
- Todo lo de FASES A-G. Usa el registro Webdock ACTUAL: `webdockCreateAdapters.get(accountId)` (main.ts:649, skill-dispatcher.ts:860) YA resuelve una cuenta Webdock explicita -> NO hace falta unificar el registro para PR1. Webdock queda funcional end-to-end y se testea solo. Resuelve el caso filing-ops.
- Naming neutral desde ya (`serverAccountId`, no `webdockAccountId`) -> cuando llegue PR2 no se re-trabaja el contrato del tool ni la firma.
- PR1 NO toca Contabo ni el registro -> cambio acotado, SIN el footgun de claves bare (ese riesgo vive en PR2). En PR1 Contabo sigue como hoy (1 cuenta via providerId); si el operador pide Contabo, `serverAccountId` no aplica (1 sola cuenta) -- la validacion estricta del par llega en PR2.

### PR2 (despues, cuando haya creds Contabo) -- registro unificado + multi-cuenta Contabo + governor Contabo
- **Registro unificado** (se mueve aqui desde PR1): unificar a clave compuesta `provider:account` (o `Map<provider,Map<account>>`) en vez de los dos mapas separados: `webdockCreateAdapters` keyed-by-accountId (main.ts:405) + `vpsProviderAdapters` keyed-by-providerId (main.ts:410). `resolveWebdockCreateAdapter` (skill-dispatcher.ts:844-861) selecciona por (provider,account). FOOTGUN byte-identico: las claves Webdock DEBEN seguir exponiendo el accountId BARE ("ops","quaternary"...) para no romper `webdockCreateAdapters.get("ops")` (main.ts:649, skill-dispatcher.ts:860), ni audit accountId, ni `inventoryHash` (orchestrator-smtp.ts:3849). Ej.: clave interna `webdock:ops` pero accountId emitido sigue "ops". DoD: inventoryHash byte-identico cuando solo hay Webdock.
- **Factory Contabo N-cuentas**: espejar el loop de slots de Webdock (webdock-real-adapter.ts:1019-1022,1086-1100) -> escanear env `CONTABO_<SLOT>_CLIENT_ID/SECRET/API_USER/PASSWORD`, emitir N entradas con accountId/providerId distintos. HOY `createContaboAdaptersFromEnv` retorna 1 sola hardcodeada accountId "contabo" (contabo-adapter.ts:866-870).
- **Enumerar Contabo en `listCreationAccounts`**: hoy `listWebdockCreationAccounts` (main.ts:509-524) solo itera webdockCreateAdapters -> Contabo nunca entra. Anadir las cuentas de vpsProviderAdapters (per-account, `canCreate()`).
- **QUITAR el short-circuit** que salta el governor para no-Webdock (orchestrator-smtp.ts:839-848, `if isNonWebdockProviderId -> skip resolveCreationAccount`). ESTE es el cambio que mete a Contabo bajo el cap 4/24h. Con el, Contabo corre `resolveCreationAccount` con candidatos provider:account.
- El **core del governor NO cambia** (creation-rate-governor.ts ya cuenta por creationDate + accountId). `VpsProvider.listServers?()`/`canCreate?()` ya existen (vps-provider.ts:35,41); ContaboAdapter setea `creationDate` (contabo-adapter.ts:799). CAVEAT a verificar: que el `createdDate` de Contabo sea ISO-parseable por `Date.parse` (governor `parseCreationDateMs`:433) para contar bien la ventana 24h.
- **Allowlist**: derivar del registro, no del literal "contabo" (`assertKnownNonWebdockVpsProviderId`, orchestrator-smtp.ts:4180). Generalizar audit `targetType:"webdock_account"` -> `"vps_account"` (orchestrator-smtp.ts:935,3958,3989,4007,4075).
- **Validar el PAR** (proveedor, cuenta): una cuenta Webdock bajo Contabo (o al reves) -> falla claro.

### Por que 2 PRs y en este orden
PR1 entrega y se testea SOLO (Webdock = el problema real de filing-ops), sin depender de Contabo. PR2 toca el governor (zona delicada) + el registro unificado + depende de las creds Contabo conectadas -> va DESPUES, sin prisa. El naming neutral (`serverAccountId`) desde PR1 garantiza que PR2 NO re-trabaja el contrato del tool ni la firma. PR1 es de bajo riesgo justamente porque NO toca el registro ni el governor multi-proveedor. (PR1 y PR2 son independientes en el tiempo; no hay dependencia tecnica que obligue a pegarlos.)

---

## 10. DoD TESTS (extender el scaffolding existente)

- (a) cuenta explicita -> aterriza ahi: extender DoD#2 (orchestrator-smtp.test.ts:667, patron `serverAccountId="secondary"` asertado en step4+state+rollback).
- (b) cuenta inelegible -> falla claro, nunca 'ops': nuevo, mirror FIX1 (orchestrator-smtp.test.ts:961 `gated_multiaccount_unsupported`); asertar codigo de error, sin VPS huerfano, sin ruteo silencioso a ops.
- (c) sin cuenta -> default byte-identico: DoD#1 (:618) + PROVIDER#a (:1013, inputHash byte-identico).
- (d) idempotencia/resume, cuenta NO en hashInput: PROVIDER#a + resume tipo PROVIDER#d3 (:1160); asertar "hashInput excluye serverAccountId".
- (e) scope firmado lleva la cuenta: proposals-sign.test.ts (mirror :107 de vpsProviderId). NOTA: esa suite esta env-gated local (no abre la DB de approval en sandbox) -- correr en CI.
- (f) Contabo multi-cuenta (PR2): cuenta Contabo explicita -> aterriza ahi; 5to create en 24h en una cuenta Contabo -> bloqueado por governor (4/24h, mismo cap que Webdock); cuenta Webdock bajo provider contabo (o al reves) -> falla claro. Tests: skill-dispatcher.test.ts (resolver provider:account), creation-rate-governor.test.ts (Contabo bajo el cap, mismo conteo por creationDate), + test de registro que asegure inventoryHash byte-identico Webdock-only (footgun claves bare).
- Suites relevantes: orchestrator-smtp.test.ts (104/104 hoy), skill-dispatcher.test.ts (26), skill-schemas.test.ts (11), webdock-servers.test.ts (21), creation-rate-governor.test.ts. Correr `node --test <file>` desde apps/gateway-api.

TSC BASELINE (CORRECCION importante): `npx tsc --noEmit -p apps/gateway-api/tsconfig.json` = **120 errores, NO todos ambientales**. Solo 6 son TS7016 por `pg` sin @types; los otros 114 son REALES pre-existentes (45 en .test.ts). El repo gatea en `node --check`/`node --test`, no tsc. DoD: no exceder 120 ni anadir nuevos (idealmente resolver los 6 de pg).

---

## 11. PLAN DE SYNC (local + Hostinger + GitHub) -- el orden importa

1. **Codex mergea a `produ`** (PR `codex/*` -> `produ`, patron #18/#21/#22/#23). Fuente unica primero.
2. **Local: restart** `bash scripts/gateway-restart.sh` (o el canonico delivrix-gateway-start.sh): mata :3000, relanza node, curl /health. POR QUE primero: la tool nueva / governor solo entra al tool-set de Bedrock en proceso fresco (`buildToolsForOpenClaw(env)` se evalua al boot, openclaw-bedrock-bridge.ts:444; no hay hot-reload).
3. **Hostinger: push del system-context** `bash scripts/openclaw/build-system-context.sh` (regenera desde DOCUMENTACION, enforce budget 11800, SSH root@2.24.223.240, docker cp al container, escribe `oc.kb.capa1_built`). POR QUE despues del merge: lee el prompt mergeado; corre solo si pasa budget.
4. **Verificar**: dry-run `OPENCLAW_CONTEXT_LOCAL_ONLY=true bash ...build-system-context.sh` (token_est<11800, sin mutacion remota); post-push, probar la tool por chat (pedir cuenta explicita) + grep la linea fresca `oc.kb.capa1_built`.

DESYNC RISKS: overflow de budget aborta el push (trim antes); restart olvidado -> tool 404 en Bedrock; push no corrido -> marker stale, prompt Hostinger atras de produ; arbol COMPARTIDO con Codex (no restart a mitad de merge).
ROLLBACK: codigo -> Codex `git revert` el PR en produ; local -> re-restart en el commit revertido; Hostinger -> re-push desde commit revertido (el container guarda `AGENTS.md.bak-capa1-<ts>`).

---

## 12. LO QUE NO SE TOCA (resumen de blast-radius)

- Path A HTTP `/v1/webdock/servers/create` (ops-pineado, legacy/tests).
- Semantica del gated path (sigue single-account; solo falla mas claro).
- `hashInput` / params del step (cuenta JAMAS entra ahi).
- El governor cuando NO hay cuenta explicita (byte-identico).
- Secretos/artefactos (.audit/*, config/*.bak-*).

## 13. REFERENCIAS A BRIEFS PREVIOS
- FIX1 (governor retry + skip event + TTL): incorporado en FASE D + E. Sigue valido.
- FIX4 (chequeo blacklist de IP en el flujo): ORTOGONAL al ruteo, sigue valido tal cual (read_mxtoolbox_health ya existe; marcar WARNING si la IP esta listada antes de declarar 'completado').
- FIX3 (prompt): reescrito en FASE F.
