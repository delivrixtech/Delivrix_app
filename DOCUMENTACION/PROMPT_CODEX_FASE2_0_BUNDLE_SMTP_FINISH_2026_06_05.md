# Codex — FASE 2.0: bundle para que `configure_complete_smtp` TERMINE limpio (sin 2º VPS) reusando server60

> **Objetivo:** que el resume de `configure_complete_smtp` para **controlcorpfiling.com** **reuse el VPS server60 ya creado** (NO crear un 2º), pase el step 6 (PTR), y avance hasta el step 13 con el smoke (14) listo en cuanto se abra el puerto 25. Auditoría adversarial (3 subagentes) halló **4 bugs** que hay que arreglar juntos; son quirúrgicos, en archivos distintos, **sin solape**.
> **Base:** `produ`/`main` `af1fe88` (working tree limpio salvo `.audit/*` + prompts `DOCUMENTACION/PROMPT_CODEX_*`). Rama `codex/fase2.0-smtp-finish`. **Usá subagentes + un Auditor adversarial por cada fix.** **Scope-fence estricto por fix. Stop-and-report** si algo choca con esto o con un caller no listado.
> **Estado real a reusar:** dominio owned en Route53 (USD 15, op ca733897); VPS = **server60**, IP **193.180.211.182**, ed25519 **publicKeyId 29**. El bind dejó el **OS-hostname de server60 en `controlcorpfiling.com` (bare)** y su Webdock `name` es `smtp.controlcorpfiling.com`; el rollback del bind falló (medio-estado a reconciliar).

---

## FIX 1 (P0) — PTR best-effort: nunca aborta ni rollbackea el bind
**Ancla:** `apps/gateway-api/src/routes/webdock-bind-domain.ts:228-262` (bloque PTR) + tipo `:45` + return de éxito `:286-296`.
**Causa:** si `setServerPtr` lanza, el `catch (:247)` llama `rollbackMainDomain` + `json(502, ptr_failed_rollback_failed)` + `return` → aborta TODO el run. El caso `supported && !ok` (`:242-246`) cae silencioso.
**Cambio:**
- En el `catch` del PTR: **eliminar** `rollbackMainDomain` y el `json(502,…)`+`return`. Setear `ptrSet=false; ptrSkipReason="set_failed";`, `logger.warn("openclaw.webdock.ptr_set_failed_nonblocking", …, {serverSlug,domain,ipv4,error})`, y **continuar** al return de éxito (200).
- Caso `supported && !ok`: setear `ptrSkipReason="set_failed"` (no más silencio).
- Tipo `:45` → agregar `"set_failed"` al union. (`ptrManualHint?: string` opcional en el interface `:39-50` si lo agregás al return).
**Scope-fence:** NO tocar el `try/catch` del bind del main domain (`:199-226`, ese SÍ devuelve 502 `bind_failed` — no se toca). NO tocar las ramas `operator_opt_out`/`ipv4_missing` (`:230-234`).
**DoD:** PTR que lanza / `supported&&!ok` / `!supported` → bind devuelve **200** con `ptrSet:false` + skip reason; el run **avanza al step 7**. El fallo del bind-main-domain sigue abortando.

## FIX 2 (P0, CRÍTICO) — reuse de VPS real (evita 2º VPS = el drift de controldelivrix) + reconciliar server60
**Anclas:** matcher `apps/gateway-api/src/routes/webdock-servers.ts:863-868` (`webdockServerMatchesHostname`); reuse path `:240,284-360,829-861` (`resolveExistingServerForCreate`); payload `name` `packages/adapters/src/webdock-real-adapter.ts:345`; parser `listServers` `:855-883` (deja `hostname`/`mainDomain` undefined porque el API real los trae en `name`); `runBindings` (runId→server60) en `runtime/openclaw-workspace/inventory/webdock-servers.json` **no consultado** por el reuse.
**Causa:** el matcher solo compara `server.hostname`/`server.mainDomain`, que en servers REALES vienen `undefined` (el API devuelve el nombre en `server.name`) → el reuse **nunca dispara** → se crea un 2º VPS. Los tests lo enmascaran con mocks que setean hostname/mainDomain a mano.
**Cambio:**
1. `webdockServerMatchesHostname` (`:863-868`): comparar **también `server.name`** (normalizado) contra el hostname objetivo (`smtp.<domain>`). (Alternativa/extra: en el parser `:855-883`, si `hostname`/`mainDomain` vienen vacíos, **derivar `hostname` de `name`** — así todo el código aguas arriba ve un hostname consistente.)
2. En `resolveExistingServerForCreate` (`:829-861`): **fast-path por `runBindings`** — si hay un binding `runId → serverSlug` para este run, resolver ese server primero (lookup por slug) antes del match por nombre.
3. **Reconciliar server60** en reuse: como su OS-hostname quedó `controlcorpfiling.com` (bare) y el target es `smtp.controlcorpfiling.com`, el flujo de reuse/bind debe **re-asegurar el hostname a `smtp.<domain>`** (idempotente) sin crear nada nuevo. Verificá que el short-circuit del bind (`webdock-bind-domain.ts:163-196`, `currentMainDomain===domain`) no quede atrapado por el valor bare; si hace falta, normalizar la comparación a `smtp.<domain>`.
**Scope-fence:** NO cambiar la lógica de CREATE fresco (cuando no hay match → sigue creando 1). NO cambiar el gate `webdock_existing_server_ambiguous` (>1 match → blocked). NO tocar credenciales/keys.
**DoD:** con un fixture que emule la respuesta REAL del API (server con `name` seteado y `hostname`/`mainDomain` ausentes), `resolveExistingServerForCreate` **encuentra server60** → `idempotent_already_exists` (costo 0) → **NO** hace POST /servers. El resume de controlcorpfiling.com reusa server60 y reconcilia su hostname a `smtp.`.

## FIX 3 (P1) — selector DKIM consistente en el smoke (step 14)
**Anclas:** publica selector `s2026a` en provision/email-auth (`apps/gateway-api/src/routes/domains-email-auth.ts:435`); valida hardcodeado `default._domainkey` en `apps/gateway-api/src/routes/send-email.ts:363` → `validateEmailAuth` da `dkimPresent:false` → `400 email_auth_incomplete` (`:206-216`) antes de enviar, determinístico en fresco.
**Cambio:** `send_real_email` debe validar el DKIM con el **mismo selector que se publicó** (`s2026a`), no `default`. Parametrizar el lookup: tomar el selector del input/config del run (o del registro de email-auth del dominio), con fallback a `default` solo si no hay uno. NO hardcodear.
**Scope-fence:** NO cambiar cómo se publica el DKIM (`s2026a` se queda). Solo alinear el lookup de validación.
**DoD:** en un dominio con DKIM en `s2026a._domainkey`, `validateEmailAuth` lo encuentra (`dkimPresent:true`) y el smoke procede al envío (no más `email_auth_incomplete` por selector).

## FIX 4 (P1, pequeño) — warmup seeds: 3 reales + blocker claro
**Anclas:** `apps/gateway-api/src/routes/warmup.ts:116,120` (`seed_inboxes_must_be_exactly_3`); el orquestador pasa `seedInboxes ?? [testEmailRecipient]` (1 solo) en el step 12.
**Cambio:** el orquestador debe armar los **3 seed inboxes** desde `WARMUP_DEFAULT_SEED_INBOXES` (CSV) o `input.seedInboxes`; si hay <3, **frenar con blocker explícito `warmup_seeds_not_configured`** (mensaje claro: "configurar 3 seed inboxes") en vez de pasar 1 y morir con el 409 genérico.
**Scope-fence:** NO cambiar la regla de "exactamente 3" en warmup.ts. Solo la fuente de los seeds + el mensaje.
**DoD:** con `WARMUP_DEFAULT_SEED_INBOXES` (3) → step 12 procede; sin ello → blocker claro `warmup_seeds_not_configured` (no 409 opaco).

---

## Tests (node:test, run real — no mocks de fachada)
- **Fix1:** PTR throw / `supported&&!ok` / `!supported` → 200 + `ptrSet:false` + skip reason; sin rollback; el step avanza. Bind-main-domain falla → sigue 502 `bind_failed`. **Reescribir** `webdock-bind-domain.test.ts:92` ("rolls back if PTR fails") al nuevo contrato.
- **Fix2:** fixture con shape REAL del API (`name` seteado, `hostname`/`mainDomain` ausentes) → matcher encuentra el server → `idempotent_already_exists`, **0 POST /servers**. runBindings fast-path resuelve por runId. Reconciliación de hostname bare→`smtp.` idempotente. No-regresión: 0 matches → create 1; >1 → ambiguous blocked.
- **Fix3:** DKIM en `s2026a` → `validateEmailAuth dkimPresent:true`; el smoke no aborta por selector. Fallback `default` cuando no hay selector configurado.
- **Fix4:** 3 seeds (env) → step 12 procede; <3 → `warmup_seeds_not_configured`.
- **Integración / resume:** simular resume de controlcorpfiling.com (domain owned + server60 con shape real) → **register noop $0**, **reuse server60 (0 VPS nuevos)**, bind reconciliado, PTR soft-skip, avanza ≥ step 13. proposals-sign / guardrails / Fase 1.5-1.8 intactos.

## Deploy
Código → **local** (restart gateway, Node 24) **Y** merge a **produ** + FF (regla CTO: local Y produ juntos, nunca dejar el remoto congelado). **Sin cambio de system-prompt** → Hostinger system-context no se toca. Reportá SHA + todos los tests en verde + el resultado del resume simulado.

## Hecho cuando
El resume de `configure_complete_smtp` para controlcorpfiling.com **reusa server60 (no crea un 2º VPS)**, pasa el step 6 sin abortar por PTR, arma 3 seeds, valida el DKIM con el selector correcto, y **avanza hasta el step 13** ("SMTP configurado"). El step 14 (smoke) queda condicionado a: puerto 25 abierto (ticket manual Webdock) + propagación + PTR manual. Reportá SHA, los tests, y el run/resume real o simulado que demuestre **0 VPS nuevos**.

---
### Fuera de scope (manual / paralelo — NO en este bundle)
- **Puerto 25:** ticket manual a Webdock (24-48h) — sin esto el smoke da falso `queued` y el correo no se entrega. (`DOCUMENTACION/runbooks-demo-viernes/webdock-ticket-port-25-draft.md`)
- **PTR real:** setear reverse DNS manual en el panel Webdock (`smtp.controlcorpfiling.com` → 193.180.211.182) para reputación. La API no lo soporta confiablemente.
- **3 seed inboxes reales:** los provee el operador en `WARMUP_DEFAULT_SEED_INBOXES`.
