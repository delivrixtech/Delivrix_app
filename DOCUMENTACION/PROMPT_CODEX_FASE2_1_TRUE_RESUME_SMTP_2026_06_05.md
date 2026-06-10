# Codex — FASE 2.1: TRUE RESUME de `configure_complete_smtp` (continuar la MISMA línea, sin reiniciar ni adivinar)

> **Directiva CTO (Juanes):** si una corrida ya compró el dominio, creó el VPS y lo bindeó, **debe CONTINUAR por la misma línea desde el step que falló** — NO reiniciar de cero, NO re-descubrir/adoptar por matching de nombres (eso fue el infierno de controldelivrix), NO que el agente adivine. Hoy eso es imposible: el orquestador siempre arranca en step 1 y re-correr el mismo runId **aborta con `replay_detected`**. Esto produce el "bucle infinito" donde ningún dominio se termina de configurar. **Hay que construir resume determinístico.**
> **Base:** `produ`/`main` `af1fe88` (working tree limpio salvo `.audit/*` + prompts). Rama `codex/fase2.1-true-resume`. **Subagentes + Auditor adversarial. Scope-fence estricto. Stop-and-report** si choca con un caller no listado.
> **Caso real a continuar:** runId `smtp-controlcorpfiling-20260605-v2`, dominio `controlcorpfiling.com` (owned, op ca733897), VPS `server60` (IP `193.180.211.182`, ed25519 `publicKeyId 29206`, sshUser `delivrixops`), main domain bindeado, falló en el PTR del step 6.

## Hallazgos de auditoría (anclas verificadas, af1fe88) — leer antes de codear
- Orquestador LINEAL sin resume: `orchestrator-smtp.ts:241-571`; `const stepResults = []` fresco por invocación `:248`; **sin** `startStep`/`resumeFrom` en params ni schema (`skill-schemas.ts:389-410`).
- `replay_detected` = **ABORT**, no skip: `main.ts:520-521` (devuelve status, no el outcome previo) + `orchestrator-smtp.ts:925-934` (`throw OrchestratorFailure("failed")`). El Set `planStepExecutions` es **in-memory** (`main.ts:836`) → se pierde al reiniciar el gateway (agujero de exactly-once durable).
- `runBindings` (runId→serverSlug) se **ESCRIBE** (`webdock-servers.ts:904-916`) pero **NUNCA se LEE** para continuar; `resolveExistingServerForCreate` ni recibe `runId` (`:829-861`).
- `executions/` es **write-only** (no existe reader en todo el repo) → no sirve hoy para rehidratar.
- Estado persistido y recargable HOY: `inventory/webdock-servers.json` (server60: slug/ipv4/publicKeyId/sshUsername/status + runBinding v2→server60), `inventory/domains.json` (controlcorpfiling.com owned), DKIM se (re)genera+persiste idempotente en step 9 (`dkim-keypair.ts:27-70`).
- Outputs de steps 1-5 (serverSlug, ipv4, chosenDomain, smtpHost) viven solo en `stepResults` in-memory → **re-derivables determinísticamente** desde inventory (no hay que adivinar).
- **Re-firmar el MISMO runId YA está soportado**: el scope-check es por `runId` (`orchestrator-smtp.ts:1250,1302` + `main.ts:483`, acepta signed/executing/executed). Re-autorizar NO es reiniciar.

## FIX 1 (P0, EJE) — TRUE RESUME determinístico
**Contrato:** una nueva invocación de `configure_complete_smtp` con un `runId` que ya ejecutó steps debe **cargar el estado de esa corrida, saltar los steps ya completados, y continuar desde el primero pendiente**, usando los recursos que la corrida YA creó (server vía `runBindings`), sin re-crear, sin re-matchear por nombre, sin adivinar.

Diseño mínimo (Codex decide la forma exacta; este es el contrato + anclas):
1. **Persistir run-state por runId** (p.ej. `inventory/smtp-runs/<runId>.json`): `{ runId, lastCompletedStep, chosenDomain, serverSlug, serverIpv4, smtpHost, updatedAt }`. Escribirlo/actualizarlo **al completar cada step** (donde hoy hacen `input.stepResults.push(result)`: `orchestrator-smtp.ts:667,735,907`). Esto reemplaza además al Set in-memory como exactly-once **durable** (cierra el agujero post-restart).
2. **Cargar al inicio** (`orchestrator-smtp.ts:247`): si llega un `runId` con run-state → poblar `chosenDomain/serverSlug/serverIpv4/smtpHost` desde ahí y fijar `resumeFromStep = lastCompletedStep + 1`.
3. **Fallback legacy (cubre v2, que no tiene run-state file):** si NO hay run-state pero SÍ hay `runBindings[runId]` + dominio owned en `domains.json` → reconstruir desde inventory (serverSlug=server60, ipv4, domain) y fijar `resumeFromStep` por existencia de recursos (dominio owned + server bindeado ⇒ continuar desde el step 6/bind). Determinístico, sin adivinar.
4. **Saltar steps completados:** guard por step (`if (step < resumeFromStep) skip`) → los steps 1-5 **ni se invocan** ⇒ el camino de `replay_detected` desaparece de raíz. Los outputs que necesitan los steps siguientes salen del run-state/inventory, NO de re-ejecutar.
5. **Server vía runBindings, NO matching:** en resume el `serverSlug` viene del run-state/`runBindings` (verdad determinística `runId→server60`). NO usar `resolveExistingServerForCreate` por nombre en el path de resume.
6. **Re-autorización:** sin cambio de código (ya soportado). El operador re-firma un proposal con `scope.runId` = el runId existente.

**Scope-fence:** NO cambiar el modelo de aprobación (HMAC/scope). NO cambiar la creación fresca (run nuevo sigue arrancando en step 1 y creando 1 VPS). NO tocar guardrails/budget/kill-switch salvo cablear el run-state como exactly-once durable (preservando el comportamiento fail-closed).
**DoD:** re-invocar `configure_complete_smtp` con `runId v2` (+ re-firma) **NO re-ejecuta steps 1-5, NO recompra, NO crea otro VPS**, usa server60 vía runBindings, y **continúa desde el step 6**. Idem para un runId con run-state file. `replay_detected` ya no se dispara en el path de resume.

## FIX 2 (P0) — PTR best-effort (para que el step 6 pase al resumir)
**Ancla:** `webdock-bind-domain.ts:228-262` (+ tipo `:45`).
**Cambio:** en el `catch` del PTR: NO `rollbackMainDomain`, NO `json(502)`, NO `return`; setear `ptrSet=false; ptrSkipReason="set_failed"`, `logger.warn("openclaw.webdock.ptr_set_failed_nonblocking",…,{serverSlug,domain,ipv4,error})`, y **continuar al return de éxito (200)**. Cubrir también `supported && !ok`. Agregar `"set_failed"` al union `:45`.
**Scope-fence:** NO tocar el try/catch del bind-main-domain (`:199-226`, ese SÍ devuelve 502 `bind_failed`).
**DoD:** PTR que lanza/`supported&&!ok`/`!supported` → bind 200 `ptrSet:false`; el run avanza al step 7.

## FIX 3 (P1) — selector DKIM consistente (para que el step 14 pase)
**Anclas:** publica `s2026a` (`domains-email-auth.ts:435`); valida hardcodeado `default._domainkey` (`send-email.ts:363`) → `400 email_auth_incomplete` (`:206-216`) en fresco.
**Cambio:** `send_real_email` valida el DKIM con el **mismo selector publicado** (tomar del input/registro email-auth del dominio; fallback `default` solo si no hay).
**DoD:** DKIM en `s2026a` → `dkimPresent:true` → el smoke procede.

## FIX 4 (P1, pequeño) — warmup seeds (para que el step 12 pase)
**Anclas:** `warmup.ts:116,120` (`seed_inboxes_must_be_exactly_3`); el orquestador pasa `seedInboxes ?? [testEmailRecipient]` (1).
**Cambio:** armar 3 seeds desde `WARMUP_DEFAULT_SEED_INBOXES` (CSV) o `input.seedInboxes`; si <3 → blocker claro `warmup_seeds_not_configured` (no 409 opaco).
**DoD:** 3 seeds → step 12 procede; <3 → blocker claro.

## Tests (node:test, run real — no mocks de fachada)
- **Resume:** dado run-state (o runBindings+domains owned) con `lastCompletedStep=5`, una invocación con ese runId **saltea 1-5** (0 register, 0 create VPS), toma server60 de runBindings, y **ejecuta del step 6 en adelante**. Verificar que `replay_detected` NO se dispara. Fallback legacy (sin run-state file, solo runBindings) reconstruye y resume.
- **No-regresión run nuevo:** runId nuevo sin run-state → arranca en step 1, crea 1 VPS, persiste run-state por step.
- **Exactly-once durable:** simular "restart" (Set in-memory vacío) → el run-state persistido evita re-ejecutar steps mutating ya hechos.
- **Fix2/3/4:** PTR throw→200 + avanza (reescribir `webdock-bind-domain.test.ts:92`); DKIM s2026a→válido; seeds<3→blocker.
- **Integración controlcorpfiling v2:** resume real (o simulado con el inventory actual) → **0 VPS nuevos, 0 recompra**, llega ≥ step 13. proposals-sign/guardrails/Fase 1.5-1.8 intactos.

## Deploy
Código → **local** (restart gateway, Node 24) **Y** merge a **produ** + FF (regla CTO: local Y produ juntos). Sin cambio de system-prompt → Hostinger no se toca. Reportá SHA + tests verdes + el resultado del resume de v2.

## Hecho cuando
Re-invocar `configure_complete_smtp` con el runId `smtp-controlcorpfiling-20260605-v2` (+ re-firma del mismo runId) **continúa la MISMA línea desde el step 6**, reusa server60 vía runBindings (0 VPS nuevos, 0 recompra, sin matching, sin adivinar), pasa el PTR (best-effort), arma seeds, valida DKIM con el selector correcto, y **avanza hasta el step 13** ("SMTP configurado"). El step 14 (smoke) queda condicionado a puerto 25 + propagación + PTR manual. Reportá SHA, tests, y la corrida real/simulada que demuestre el resume sin recrear nada.

---
### Debt opcional (NO en este round — el resume lo vuelve innecesario para nuestro flujo)
El matcher `webdockServerMatchesHostname` (`webdock-servers.ts:863-868`) solo compara hostname/mainDomain (root-cause del drift de controldelivrix). Con TRUE RESUME el step 4 se saltea y el matcher no se toca en continuación. Dejar anotado como hygiene para un round futuro; NO meterlo acá para no inflar el scope.

### Fuera de scope (manual / paralelo)
- Puerto 25: ticket manual Webdock (24-48h) — sin esto el smoke da falso `queued`.
- PTR real: panel Webdock (`smtp.controlcorpfiling.com` → 193.180.211.182).
- 3 seed inboxes reales en `WARMUP_DEFAULT_SEED_INBOXES`.
