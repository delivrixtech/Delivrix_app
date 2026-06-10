# Codex — FASE 1.5 (revisada v2): que el orquestador FINALICE un dominio existente, autónomo

> **Contexto (auditado en vivo):** OpenClaw no puede terminar `controldelivrix.app` autónomo por DOS causas encadenadas. El orquestador fue diseñado **solo para dominios nuevos** (suggest→comprar→construir) y rechaza uno existente; y el "escape hatch" de subtools está roto. Fix quirúrgico, 3 partes.
> **Base:** `produ` (`0aa6b5b`). Rama `codex/fase1.5-resume-existing`. Verificá `git log --oneline -1 produ` = `0aa6b5b`.
> Subagentes senior + Auditor de Errores. Si choca → parar y reportar. Mantener guardrails de Fase 1 intactos (aditivo).

## Diagnóstico (anclas verificadas)
- **A. El orquestador rechaza dominios existentes:** `orchestrator-smtp.ts:305` `chooseDomainForRun(suggestions,...)` + `:1084-1094` `plan_domain_not_in_suggestions` → si el dominio aprobado no está en los candidatos de `suggest_safe_domain`, **falla**. controldelivrix.app ya está registrado → no es candidato fresco → rechazado.
- **B. `create_webdock_server` NO es idempotente:** `webdock-servers.ts:230` llama `createServer()` sin chequear si ya existe → crearía un **2º VPS** (server10 no se detecta).
- **C. Escape hatch inalcanzable:** el guard lee `repairReason`/`explicitRepairScope` (`tool-use-processor.ts:1007-1009`) pero esos params **no están en el schema de ningún tool** → el agente no puede pasarlos → subtools sueltas bloqueadas sin escape.
- (Ya idempotentes, NO tocar: `register_domain_route53` `domains-purchase.ts:210` `idempotent_already_owned`; `bind_webdock_main_domain` `webdock-bind-domain.ts:165` `alreadyBound`; upsert_dns / email-auth por upsert.)

## Fix 1 (CLAVE) — Adoptar un dominio existente OWNED en `configure_complete_smtp`
Permitir que el orquestador finalice un dominio que **ya es nuestro**, sin exigir que venga de `suggest_safe_domain`:
1. Si `input.domain` está provisto, **verificar ownership SERVER-SIDE** (no confiar en el agente): `read_route53_domain_detail(domain)` / `listOwnedDomains()` (el mismo check de `domains-purchase.ts:765`). Si es owned → es un dominio válido para el run.
2. En la validación de candidatos (`orchestrator-smtp.ts:1084`), **bypass** la regla `plan_domain_not_in_suggestions` cuando el dominio está **verificado como owned**. (suggest_safe_domain sigue para dominios nuevos.)
3. El paso 2 `register_domain_route53` ya es idempotente → no-op (no re-compra). 
4. Respetar el scope del plan (domain del plan firmado) y los verified_fact de los 7 dominios prod (avisar si se intenta adoptar uno de prod sin intención).

## Fix 2 — `create_webdock_server` idempotente (reusar server existente)
En `webdock-servers.ts`, **antes de `createServer()`**: listar servers (data de `read_webdock_servers`) y matchear por **hostname == dominio** o **main domain bound == dominio**. Si hay exactamente uno → **reusar** su `serverSlug`+IP, `status:"idempotent_already_exists"`, `costUsd:0`, audit `oc.webdock.create_idempotent`. Cero → crear. Ambiguo/no mapeable → **FAIL-CLOSED** (no crear a ciegas). Espejá el patrón de `register_domain_route53`. (Robustez: persistir `runId→serverSlug`.)

## Fix 3 — Arreglar el escape hatch roto (o eliminarlo)
El hatch de reparación puntual es inalcanzable hoy. Elegí UNA:
- (Preferido) **Exponer** `repairReason` y `explicitRepairScope` como params opcionales en el schema de las subtools SMTP (`openclaw-tools-builder.ts`), para que una reparación puntual legítima sea posible; o
- **Eliminar** el path muerto y el mensaje `repairEscapeHatch` (`tool-use-processor.ts:189`) si decidimos que NO se permiten subtools sueltas (todo por orquestador). 
Decidí con criterio; documentá la decisión. (Con Fix 1, controldelivrix ya no necesita subtools, pero el hatch roto es un bug latente.)
- Revisar también la **consistencia de alias**: `bind_domain_to_server` corrió (no está en la blocklist) pero `bind_webdock_main_domain` sí — unificar para que el guard no tenga huecos por alias.

## Tests (node:test, run real)
- `configure_complete_smtp(domain=controldelivrix.app)` con dominio owned → **adopta** (no `plan_domain_not_in_suggestions`), verifica ownership server-side.
- `create_webdock_server` con server existente → reusa, `costUsd:0`, no crea 2º VPS; ambiguo → fail-closed; limpio → crea.
- Dominio NUEVO de suggest → flujo normal (no-regresión Fase 1).
- (Fix 3) subtool con repairReason/scope válidos → permitida; sin ellos → bloqueada (o, si se elimina, subtool siempre por orquestador).
- proposals-sign/reject + guardrails (budget/kill-switch/scope) intactos.

## Deploy
Cambio de **código** (orquestador + skill + schema), no de prompt → deploy **local** (reiniciar gateway, Node 24). Si tocás el system prompt para describir "adoptar dominio existente", entonces también Hostinger (regla de sync). Mergeá a `produ` tras tests verdes + firma.

## Hecho cuando
`configure_complete_smtp` **finaliza controldelivrix.app autónomo**: adopta el dominio owned, reusa server10 (sin 2º VPS ni re-cobro), completa A/MX→Postfix+DKIM→SPF/DKIM/DMARC→warmup→smoke con 1 firma; el escape hatch queda funcional o eliminado (sin path muerto). Reportá SHA + confirmación de que (a) adoptó el dominio existente, (b) NO creó server nuevo, (c) qué hiciste con el hatch.
