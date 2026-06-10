# Codex — FASE 2.3: el wait de propagación DKIM/DMARC rechaza el underscore (`_domainkey`) → step 11 muere con `params_validation_failed`

> **Contexto (run real v2, 2026-06-05 05:35):** la reanudación de `configure_complete_smtp` (runId `smtp-controlcorpfiling-20260605-v2`) **avanzó hasta el step 11** reusando server60 ($0, sin 2º VPS), con PTR best-effort OK, Postfix+OpenDKIM provisionados (`status:"configured"`, selector `s2026a`), y SPF/DKIM/DMARC publicados. **Falló en el step 11 instantáneamente (15 ms, NO timeout) con `params_validation_failed`.** Es un bug determinístico que afecta a TODO SMTP (primera vez que se llega al step 11).
> **Base:** `produ`/`main` `af8cf0a`. Rama `codex/fase2.3-dkim-wait-underscore`. Subagentes + Auditor. Scope-fence estricto. Stop-and-report.

## Causa raíz (anclas verificadas, af8cf0a)
- Step 11 del orquestador = `wait_for_dns_propagation` con `params:{ domain:"s2026a._domainkey.controlcorpfiling.com", maxWaitMs:600000, pollIntervalMs:30000 }` (visto en el stepResults del run y en `orchestrator-smtp.ts`, el wait del DKIM TXT).
- El schema de ese skill valida el host con el validador **estricto `domain()`** (`apps/gateway-api/src/skill-schemas.ts:568` → `tryNormalizeStrictDomainName`), que **rechaza el underscore** de `_domainkey` (y de `_dmarc`) → `SkillSchemaError: domain must be a valid domain` → `params_validation_failed` → `oc.orchestrator.run_failed` failedStep 11.
- Ya existe el validador **lenient `dnsRecordName()`** (`skill-schemas.ts:586`) cuyo regex **permite `_`** (`^[a-z0-9_]...`). Es el validador correcto para nombres de record DNS arbitrarios (DKIM/DMARC usan labels con underscore por RFC).

## FIX 1 (P0) — validar el host de propagación con `dnsRecordName()`, no `domain()`
- En el param schema de `wait_for_dns_propagation` (y en cualquier skill de espera/lectura de propagación que reciba un host objetivo), validar el campo host/`domain` con **`dnsRecordName()`** (acepta `_domainkey`/`_dmarc`) en vez de `domain()`. Mantener `domain()` estricto donde corresponde a un dominio real (compra/zona), pero NO para el target de un wait de TXT.
- Verificar TODOS los call-sites del orquestador que esperan records con underscore: el wait del **DKIM** (`s2026a._domainkey.<dominio>`) y, si existe, el del **DMARC** (`_dmarc.<dominio>`). Ambos deben pasar.
- Confirmá que el polling real (`dns-wait.ts`) ya resuelve TXT en hosts con underscore (debería; el bug es solo de validación de params). Si el lookup necesita `recordType:"TXT"` explícito y el orquestador no lo pasa, agregarlo en el step 11 (DKIM) para no resolver A por defecto.

**Scope-fence:** NO relajar `domain()` donde valida dominios reales (register/zona/bind). Solo el host objetivo de los waits de propagación pasa a `dnsRecordName()`. NO tocar resume/PTR/idempotencia (Fase 2.1/2.2 intactas).
**DoD:** step 11 con host `s2026a._domainkey.<dominio>` valida OK y espera la propagación real (no más `params_validation_failed`); el orquestador completa 11→12→13→14 en una sola tool-call de `configure_complete_smtp`.

## FIX 2 (P1, NO código — env) — subir el tope de iteraciones del agente
Con el step 11 arreglado, el orquestador completa solo y el agente NO improvisa, así que no debería explotar el cap. Igual, como colchón: subir **`OPENCLAW_TOOL_MAX_ITERATIONS`** (default 10, leído en `openclaw-bedrock-bridge.ts:880`) a **~25** y reiniciar el gateway. (El `bedrock_invoke_error` del run anterior fue exactamente este tope: el agente hizo >10 tool-calls manuales tras el fallo del step 11.)

## FIX 3 (P1) — compactación episódica falla con firma
En el cierre del run se vio `oc.orchestrator.compact_intent_failed: "signatureId must match a verified operator signature in the audit chain."` (gap conocido). Revisar `compactRunIntent`/`compactIntent`: la compactación de memoria episódica NO debe requerir una firma de operador verificada (o debe usar la del run); hoy rompe en cada cierre. Hacerla no-bloqueante / con la firma correcta. **Scope:** solo la compactación; no tocar el audit-chain de proposals.

## Tests (node:test, run real)
- **Fix1:** param schema de wait_for_dns_propagation acepta `s2026a._domainkey.<dom>` y `_dmarc.<dom>` (vía `dnsRecordName`), rechaza basura. El orquestador en step 11 (DKIM) valida y entra al polling (mockear el resolver). Regresión: hosts normales (`smtp.<dom>`) siguen OK.
- **Integración:** resume de un run que quedó en step 10/11 → ahora pasa step 11 → 12 → 13 → 14 sin `params_validation_failed`, en una sola invocación del orquestador (sin que el agente llame sub-tools manualmente).
- **Fix3:** cierre de run compacta intent sin lanzar (o con la firma del run); no más `compact_intent_failed`.
- proposals-sign/guardrails/Fase 1.x/2.1/2.2 intactas. 880/880 + nuevos.

## Deploy
Código → **local** (restart gateway, Node 24) **Y** produ + FF (regla CTO). Env `OPENCLAW_TOOL_MAX_ITERATIONS=25` en el entorno del gateway. Sin cambio de system-prompt → Hostinger no se toca. Reportá SHA + tests + un resume real de v2 que pase step 11.

## Hecho cuando
`configure_complete_smtp` reanuda v2 y **completa 11→14 limpio en una sola tool-call** (DKIM TXT validado y esperado correctamente), sin `params_validation_failed`, sin que el agente improvise sub-tools, sin tocar el cap de iteraciones, y con la compactación episódica sin error. Reportá SHA, tests, y el run de v2 llegando al smoke.

---
### Fuera de scope (operador)
Verificar entrega real a infra@delivrix.com + `dig TXT s2026a._domainkey.controlcorpfiling.com` (la propagación DKIM no se confirmó por este bug). Puerto 25 ya abierto en la cuenta Webdock (confirmado por Juanes). PTR manual en panel Webdock.
