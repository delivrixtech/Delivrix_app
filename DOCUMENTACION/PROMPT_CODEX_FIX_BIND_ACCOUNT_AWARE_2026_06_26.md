# PROMPT CODEX -- FIX P0: bind_webdock_main_domain account-aware (incidente run quaternary)

Fecha: 2026-06-26 - Ejecuta: Codex - Diagnostico confirmado por 9 subagentes read-only sobre run-state + audit + chat + codigo (evidencia file:line abajo).

## CONTEXTO (que paso, con certeza)
El PRIMER SMTP real sobre una cuenta Webdock NO-default (quaternary/emael, runId `smtp-bizreport-control-webdock-quaternary-20260626`) creo server140 EN quaternary correctamente (pasos 1-7 done) pero MURIO en el paso 8 `bind_webdock_main_domain` con `server_not_found`.

CAUSA RAIZ (confirmada): el bind NO es account-aware -> busca el server en la cuenta DEFAULT (ops/cuenta-1) en vez de quaternary -> `getServer(server140)` 404 -> `server_not_found` (webdock-bind-domain.ts:237-239). PR #26 hizo account-aware el create (paso 4), wait_server_running (paso 5) y el resolver de delete, PERO dejo el bind (paso 8) en la asuncion single-account.

IMPORTANTE (narrativa): el PR #26 NO rompio lo que andaba bien. `git diff ae80093..51a7d41 -- webdock-bind-domain.ts` = VACIO (el PR nunca toco el bind). El bind NUNCA fue account-aware. En el mundo viejo (todo en ops) create y bind ambos iban a ops -> funcionaba. El PR #26 permitio que create aterrice en quaternary, y eso EXPUSO la asuncion single-account latente del bind. El default ops sigue byte-identico: los runs en ops NO estan rotos. El gap solo se activa con una cuenta no-default.

ALCANCE (mapa de pasos, confirmado): create(4) account-aware OK; wait_server_running(5) account-aware OK (server-running-wait.ts:125-138, por eso paso); **bind(8) NO account-aware = el unico roto**; pasos 9-14 (provision_smtp_postfix, configure_email_auth, seed_warmup, send_real_email) operan por SSH-sobre-IP / DNS, no usan la API de cuenta de Webdock -> no necesitan la cuenta, no afectados.

---

## FIX 1 (P0 BLOQUEANTE) -- bind_webdock_main_domain account-aware
Sin esto, NINGUN run en cuenta no-default (quaternary/emael/...) puede completar: todos mueren en el paso 8.

Sitios (3 cambios + comentario):
1. **orchestrator-smtp.ts:1080-1086** (dispatch del paso 8): hoy pasa solo `providerId: vpsProviderId`. ANADIR `serverAccountId: runState.serverAccountId,`. El plumbing ya existe end-to-end (executePlanApprovedStep forwards serverAccountId :2899 -> main.ts:874 lo mapea a dispatchSkillHandler({accountId})). Corregir el comentario stale :1084-1085 ("Webdock bind usa siempre la cuenta-1") -> es la asuncion incorrecta.
2. **skill-dispatcher.ts:518** (invoke de `bindWebdockMainDomain`): destructurar `accountId` (hoy solo `{request, response, deps, providerId}`). En **:530** reemplazar `webdockAdapter: deps.webdockAdapter` por el adapter resuelto por cuenta `resolveWebdockCreateAdapter(deps, accountId, providerId)` (mismo resolver que usa create :501; el adapter Webdock que retorna implementa getServer/setServerIdentity/setServerMainDomain/setServerPtr que el bind necesita).
3. **webdock-bind-domain.ts ~111-128** (`BindWebdockMainDomainDeps`): hoy solo carga `webdockAdapter` (single). Asegurar que el handler reciba el adapter ya resuelto por cuenta (o el registro `webdockCreateAdapters` para resolver). Verificar que el tipo del adapter Webdock resuelto cumple el contrato del bind.

INVARIANTE (no romper):
- `serverAccountId` NO entra a params/hashInput (canal paralelo, como hoy).
- default (ops / serverAccountId undefined) -> `resolveWebdockCreateAdapter` retorna `deps.webdockAdapter` byte-identico (skill-dispatcher.ts:857-858). Runs en ops sin cambio.
- el scope validator solo chequea serverAccountId para `create_webdock_server` (:3383) -> pasarlo al bind NO dispara `plan_scope_mismatch`.
- Contabo sigue por la rama providerId (no toca esto).

DoD tests:
- webdock-bind-domain.test.ts: bind con `serverAccountId="quaternary"` resuelve el adapter de quaternary (getServer NO da server_not_found); bind con ops/undefined -> deps.webdockAdapter (byte-identico).
- orchestrator-smtp.test.ts: run completo con `serverAccountId="quaternary"` -> el executor recibe `serverAccountId` EN EL PASO 8 (no solo en create); run ops NO manda serverAccountId (regresion). >>> ESTE es el test que el PR #26 nunca tuvo: la DoD asertaba "create aterriza en X", NO "el run OPERA (bind/etc.) sobre X". Lo que dejo pasar el gap. <<<
- scope test: bind con serverAccountId NO lanza plan_scope_mismatch.

---

## FIX 2 (P1, PROMPT) -- resume correcto de un run parcialmente gastado
El run quedo failed en paso 8 y OpenClaw intento reanudar MAL (2 errores del AGENTE, no del orquestador):
- (a) cambio `requireExistingDomain` false->true -> `plan_scope_mismatch: requireExistingDomain`. El scope firmado es INMUTABLE; el drift-check es PRE-EXISTENTE (git blame: af1fe88c, 2026-06-04, 3 semanas ANTES del PR #26) y correctamente rechaza el cambio. NO es regresion del PR #26.
- (b) alucino "no tengo el zoneId, el orquestador no lo expone" y se lo pidio al operador, cuando el zoneId ESTA en el run-state: `steps.6.result.outcome.zoneId = Z06956412W08YBY6BZ0NV`. OpenClaw nunca leyo su propio run-state.

Prompt fix (seccion flow / resume): al reanudar un run parcialmente ejecutado -> MISMO runId, MISMO scope firmado, NUNCA mutar flags del scope (`requireExistingDomain`). El orquestador detecta el dominio ya comprado por runId (`chooseDomainForRun` lee `scope.domain` :3129). ANTES de declarar un dato "no disponible" o escalar a manual, LEER el run-state (`steps.*.result.outcome`) por artefactos ya producidos (zoneId, serverSlug, serverIpv4). No pedir al operador lo que ya esta en el estado. Budget del prompt: 11755/11800 -> compactar si no entra.

---

## HALLAZGO 3 (P1, ANALISIS APARTE -- NO meter en este PR) -- el rollback autonomo NO ejecuta el delete
Independiente del bind, pero serio: `submitRollbackProposal` (main.ts:930-961) ante un fallo NO dispara el DELETE del server -> solo registra `oc.rollback.proposal_requested` en audit (con serverAccountId correcto :954) y retorna un id sintetico. `auto-rollback.ts` solo hace DNS/warmup, nunca deleteServer. Resultado: el rollback no auto-ejecuta para NINGUNA cuenta, y como NO existe reaper/sweep de servers huerfanos, server140 quedo VIVO y FACTURADO en quaternary sin que nada lo rastree. Recomiendo issue/analisis aparte (gap de safety-net mas grande). Mitigacion inmediata: el operador decide rescatar o borrar manual (DELETE con `accountId:"quaternary"` + providerId en el body; el resolver de delete SI es account-aware: webdock-servers.ts:806-825).

---

## RESCATE del run (decidir tras verificar la IP)
Estado: server140 VIVO en quaternary (IP 92.113.148.188, running), dominio bizreport-control.com comprado, DNS A/MX/SPF/DMARC OK, pasos 1-7 done, falta bind(8)+9-14. budgetSpent USD 15.14. El lease del paso 8 + la firma del plan YA EXPIRARON (04:28Z) -> no hay 423 permanente; el resume necesita NUEVA firma.
- OPCION A (recomendada SI la IP esta limpia): aplicar FIX 1 -> resume con MISMO runId + nueva firma + MISMO scope (sin tocar requireExistingDomain). serverAccountId=quaternary esta persistido (run-state line 702), asi que el bind -ya account-aware- encuentra server140. Recupera los USD 15.14.
- OPCION B (si la IP esta quemada en blacklist): descartar; borrar server140 manual (DELETE accountId quaternary) para no dejar el orphan facturado; recrear cuando convenga.
(Verificar reputacion de 92.113.148.188 ANTES de decidir.)
