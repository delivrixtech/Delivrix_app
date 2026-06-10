# Codex — FASE 2.2: máquina de RESUME endurecida para `configure_complete_smtp` (general, segura, exactly-once durable)

> **Directiva CTO (Juanes):** esto DEBE funcionar para **toda corrida futura** (cualquier dominio, fallando en cualquier step, cualquier provider futuro), sin debilitar guardrails. Una revisión adversarial de 3 subagentes confirmó que un "skip completados" ingenuo **debilita exactly-once, abre una carrera, resetea el budget cap y corrompe estado**. Este spec construye el resume BIEN: máquina de estados durable con write-ahead + lock por runId, clonando patrones que YA existen en el repo. **NO simplificar ninguno de los 9 guardrails.**
> **Base:** `produ`/`main` `af1fe88`. Rama `codex/fase2.2-resume-endurecido`. **Subagentes + Auditor adversarial por componente. Scope-fence estricto (solo el orquestador SMTP + helpers de workspace + guards puntuales en 5 skills). Stop-and-report** si choca con un caller no listado.
> **Patrones de referencia en el repo (CLONAR, no inventar):** lock two-tier `withRoute53MonthSpendLock` (`domains-purchase.ts:625-683`: mutex in-process + `mkdir` O_EXCL filesystem + retries + release en finally); write-ahead `reserveRoute53MonthlySpend` (`domains-purchase.ts:593-599→333`: persistir intención ANTES del efecto real).
> **Caso de validación:** runId `smtp-controlcorpfiling-20260605-v2`, dominio `controlcorpfiling.com` (owned), VPS `server60` (`193.180.211.182`, publicKeyId 29206), falló en PTR del step 6.

## Hallazgos de auditoría (anclas af1fe88) — leer antes de codear
- Orquestador lineal sin resume, `stepResults=[]` fresco por invocación (`orchestrator-smtp.ts:241-571,248`); steps consumen vars `let` en memoria (`chosenDomain:327`, `serverSlug/serverIpv4:381-382`, `dkimPublicKey:470`).
- Exactly-once = Set in-memory marcado ANTES de dispatch (`main.ts:520-523,602`, key `:5486-5494`); `replay_detected`=ABORT (`orchestrator-smtp.ts:925-934`). Se pierde al reiniciar.
- **Sin lock por runId** en ningún lado (`handleConfigureCompleteSmtp:204-239` solo chequea kill-switch una vez).
- Budget tally = `totalEstimatedCost(input.stepResults)` in-memory, arranca en 0 (`orchestrator-smtp.ts:1684-1728`). `compactRunIntent` solo corre al final (`:546,603`).
- `runBindings` se escribe (`webdock-servers.ts:904`) pero no se lee para continuar; `executions/` write-only; step 6 bind **no persiste binding** (solo audit, `webdock-bind-domain.ts:165-226`).
- DKIM key se busca en disco por **selector** (`smtp-provisioning.ts:152`, `domains-email-auth.ts:225-227`); keys en disco hoy = `default`/`dkim1`, NO `s2026a`. Selector hoy es literal en código (`orchestrator-smtp.ts:452,470,485`).
- Gates por step (kill-switch fail-closed, scope, budget) viven DENTRO de `runPlanApprovedStep` (`:864-868`) + `executePlanApprovedStep` (`main.ts:509-512`). Re-firma por mismo runId YA soportada (`:1250,1302`+`main.ts:483,490` valida expiry).

---
## COMPONENTE A (P0) — Run-state durable por runId con 3 fases por step
Persistir `inventory/smtp-runs/<runId>.json` (atomic write: tmp+rename, nunca write-in-place parcial):
```
{ runId, provider, requireExistingDomain,
  budgetUsdMax, budgetSpentUsd,                      // reconciliación de budget
  chosenDomain, serverRef, serverIpv4, smtpHost,     // outputs intermedios (serverRef genérico, no solo slug)
  selector,                                          // DKIM selector real (no literal)
  testEmailRecipient, testEmailSubject, testEmailBody, seedInboxes,  // "delivery" — fuente de verdad, no el request
  steps: { <n>: { status: "pending"|"in_flight"|"done", attemptId, leaseUntil, inputHash, outcome, costUsd } },
  lastCompletedStep }
```
**Write-ahead obligatorio** (clonar `reserveRoute53MonthlySpend`): por cada step → escribir `in_flight` (+attemptId+leaseUntil) **ANTES** del dispatch; escribir `done`+outcome+costUsd **DESPUÉS** del ok. Reemplaza al Set in-memory como exactly-once **durable**, preservando el fail-closed (`in_flight` con lease vivo ⇒ tratar como `replay_detected`/`step_in_flight`).

## COMPONENTE B (P0) — Lock por runId (clonar withRoute53MonthSpendLock)
Envolver TODA la corrida del runId en `withRunStateLock(runId)`: mutex in-process (`Map` de promesas) **+** lock filesystem `inventory/.locks/run-<runId>.lock` vía `mkdir` O_EXCL con retries + lease TTL + release en `finally`. Segundo entrante del mismo runId ⇒ devolver `run_already_in_progress` (NO ejecutar). Lectura de run-state, decisión skip/run y avance: **todo dentro del lock**.

## COMPONENTE C (P0) — Carga, rehidratación y cursor de resume
Al inicio de `configureCompleteSmtp`: si llega `runId` con run-state → **cargar y rehidratar** `chosenDomain/serverRef/serverIpv4/smtpHost/selector/testEmail*/seedInboxes/budgetSpentUsd` en las vars que hoy se derivan en memoria, y fijar `resumeFromStep` desde `steps`/`lastCompletedStep`. **Saltar steps completados FUERA del runner** (`if (steps[n].status==="done") skip`); todo step que SÍ se ejecuta entra por `runPlanApprovedStep`/`runGatedStep` **intacto** (mismos kill-switch/scope/budget). Re-sembrar el tally de budget desde `budgetSpentUsd` ANTES del primer step nuevo (no arrancar en 0, no re-sumar lo saltado).

## COMPONENTE D (P0) — Consistencia de scope re-firmado vs run-state
Antes del primer step en un resume, validar que el plan re-firmado **coincide con el run-state**:
`scope.domain===runState.chosenDomain` ∧ `scope.provider===runState.provider` ∧ `scope.recipient===runState.testEmailRecipient` ∧ `scope.requireExistingDomain===runState.requireExistingDomain` ∧ `scope.budgetUsdMax >= runState.budgetSpentUsd`. Si no coincide ⇒ rechazar `resume_scope_drift` (exigir runId nuevo). Además **re-validar la firma** (`resolveAndValidatePlanApproval:290`) y **rechazar firma expirada** — no resumir bajo firma vencida.

## COMPONENTE E (P1) — Idempotencia por-step (re-ejecutar el step que falló sin duplicar)
Guards mínimos (un step se marca `done` SOLO si terminó 100%; si quedó `in_flight`, reconciliar por estado real antes de re-ejecutar):
- **step 2 register** (`domains-purchase.ts:142-197,397-416`): re-ejecutar SOLO si inventory ≠ `owned`. Si `pending`/`purchase_reserved`/`needs_reconciliation` → reconciliar contra Route53 (`GetOperationDetail` del `operationId` persistido) antes de decidir; nunca re-`registerDomain` a ciegas (doble cobro).
- **step 9 provision** (`smtp-provisioning.ts:504-580`): skip si `smtp-provisioning.json` = `configured`; si re-ejecuta, anteponer check `/etc/letsencrypt/live/<host>` para no quemar cuota certbot (rate-limit LE 5/sem). Resto idempotente (apt/install/systemctl).
- **step 12 warmup** (`warmup.ts:166-195,372-374`): **NO re-ejecutar a ciegas** (hoy appendea run + re-envía seeds = duplica). Skip si ya hay run para el dominio; fix de raíz: `updateWarmupInventory` upsert por `domain`, no append.
- **step 14 send_real_email** (`send-email.ts:265,561`): dedupe por Message-ID derivado de runId (o marcar done si ya hay audit `oc.smtp.real_email_sent` para el runId). Evita correo duplicado al cliente.
- **step 6 bind**: que escriba un **binding al inventory** (hoy solo audit) para dejar rastro reconstruible.
- steps 3/4/7/8/10/11 + DKIM ensure: ya idempotentes (reuse/UPSERT/already-bound/ensureDkimKeyPair) — confirmar, no romper.

## COMPONENTE F (P1) — Reconstrucción legacy CONSERVADORA (cubre v2 y futuros)
Si NO hay run-state file pero sí `runBindings[runId]` + dominio owned: reconstruir `serverRef/ipv4/domain` y `resumeFromStep` **conservador** — ante ambigüedad (server bound pero `smtp-provisioning.json` ≠ `configured`), reanudar desde el **primer step idempotente** (re-validar DNS / re-provisionar, que es idempotente con los guards de E), **nunca saltar provisioning sin evidencia de que corrió**. La inferencia es fallback de último recurso; el camino normal es `lastCompletedStep` explícito (Componente A).

## Fixes de desbloqueo (para que el resume LLEGUE al final)
- **PTR best-effort** (`webdock-bind-domain.ts:228-262`+tipo`:45`): catch del PTR → `ptrSkipReason="set_failed"`, warn, 200, sin rollback (NO tocar el catch del bind-main-domain `:199-226`). Cubrir `supported && !ok`. Reescribir test `:92`.
- **Selector DKIM en smoke** (`send-email.ts:363`): validar con el selector del run-state (no `default` hardcoded; fallback `default` solo si no hay selector).
- **Warmup seeds**: armar 3 desde `WARMUP_DEFAULT_SEED_INBOXES`/`input.seedInboxes`; <3 → blocker claro `warmup_seeds_not_configured`.

## Tests (node:test, run real — no mocks de fachada)
- **Write-ahead/exactly-once:** simular crash entre `in_flight` y `done` → el resume NO re-ejecuta a ciegas un mutating (reconcilia por estado). Doble-submit mismo runId → segundo recibe `run_already_in_progress` (lock) o `step_in_flight`.
- **Lock/race:** dos invocaciones concurrentes del mismo runId → solo una avanza; cero doble-create/doble-charge.
- **Budget:** resume que saltea step 2 ($15) → tally arranca con `budgetSpentUsd` correcto (no 0, no re-suma); un step costoso re-ejecutado no excede el cap acumulado.
- **Rehidratación:** resume desde step 6/9/12/14 → `serverRef/chosenDomain/selector/recipient/seeds` correctos (no vacíos, no del request).
- **Scope-drift:** re-firma con domain/budget/recipient distintos → `resume_scope_drift` (rechaza). Firma expirada → rechaza.
- **Idempotencia por-step:** re-correr step 12 → no duplica seeds/run; step 2 `pending` → reconcilia, no doble-cobra; step 14 → no duplica correo; step 9 → no re-quema certbot.
- **Legacy:** v2 (sin run-state, solo runBindings) → reconstruye conservador, resume desde 6, 0 VPS nuevos, 0 recompra. Run legacy que falló en 9 → NO saltea provisioning.
- **No-regresión run nuevo:** runId nuevo → 1→14 lineal, persiste run-state por step, crea 1 VPS. proposals-sign/guardrails/Fase 1.5-1.8 intactos. Kill-switch fail-closed en cada step ejecutado.
- **Integración v2:** resume real/simulado → llega ≥ step 13 sin recrear nada.

## Deploy
Código → **local** (restart gateway, Node 24) **Y** merge a **produ** + FF (regla CTO: local Y produ juntos). Sin cambio de system-prompt → Hostinger no se toca. Reportá SHA + TODOS los tests verdes + el resume real de v2.

## Hecho cuando
`configure_complete_smtp` es una **máquina resumible, durable y exactly-once**: re-invocar un runId existente (+ re-firma del mismo runId, validada contra el run-state) **continúa desde el step que falló**, rehidrata su estado, reusa sus recursos (server vía runBindings), **no re-cobra, no re-crea, no duplica seeds/correos, no excede budget, no corre concurrente, no corre bajo firma vencida**, y funciona **para cualquier dominio/step/provider futuro**. Validado en v2 (controlcorpfiling.com → ≥ step 13). Reportá SHA, los tests de los 9 guardrails, y la corrida real.

---
### Fuera de scope (manual / paralelo)
Puerto 25 (ticket Webdock 24-48h), PTR real (panel Webdock `smtp.controlcorpfiling.com`→193.180.211.182), 3 seed inboxes reales en `WARMUP_DEFAULT_SEED_INBOXES`.
### Debt anotado (NO acá)
Matcher reuse por nombre (`webdock-servers.ts:863-868`, root-cause drift) — el resume lo sortea vía runBindings; hygiene futura. Multi-provider real (skills `_webdock` hardcoded) — el run-state ya lleva `provider/serverRef` para prepararlo.
```
