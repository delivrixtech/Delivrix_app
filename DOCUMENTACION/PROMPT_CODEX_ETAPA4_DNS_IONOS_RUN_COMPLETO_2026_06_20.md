# BRIEF CODEX — Etapa 4: completar el run de adopción IONOS (DNS a IONOS) + fix silent-catch del ownership

Fecha: 2026-06-20 · De: Juanes + auditoría Claude (live, grounded) · Ejecuta: **Codex con subagentes** · Rama base: **`produ`**

## Estado actual (verificado en vivo, NO re-investigar)
- **Etapa 3 (ownership multi-registrar) MERGEADA a `produ`** (PR #7, merge `28033d7`). `domain-ownership.ts` verifica Route53 + IONOS; el gate quedó agnóstico (`orchestrator-smtp.ts:2813` = `verification.owned !== true`). 1052/1052 tests.
- **IONOS quedó LIVE**: creds cargadas en `config/gateway.env` (`IONOS_DNS_API_KEY` formato `public.secret`, gitignored). El 503 inicial era **propagación transitoria de la key recién activada** — ya resuelto. Inventario live: **21 dominios IONOS, incluido `annualcorpfilings.com`** (confirmado por `GET /v1/infrastructure/inventory` → provider `ionos-domains`, status `active`).
- **`IONOS_DNS_ENABLE_WRITES` está en OFF** (se cargó read-only). Para que el step de DNS escriba en IONOS hay que prenderlo de forma controlada (ver Etapa 6 / smoke).

## Objetivo
Que un dominio **adoptado en IONOS** (caso: `annualcorpfilings.com`) corra `configure_complete_smtp` **de punta a punta quedándose en IONOS**: ownership por IONOS (ya hecho), **NO** registrar en Route53, y **escribir el DNS (MX/SPF/DKIM/DMARC) en IONOS**, no en Route53. Diseño canónico = **Etapa 4 del brief `PROMPT_CODEX_RECABLEADO_MULTIPROVEEDOR_DNS_DOMINIOS_2026_06_18.md`** (leelo, es la fuente; esto lo aterriza con el contexto live).

## Disciplina (igual que el brief 06-18)
- Base `produ` (NUNCA `main`). Rama dedicada + worktree. PR chico, verde, reversible. Verificá `git rev-list --left-right --count produ...HEAD` → primer número `0`.
- **NO toques** `main`, `feature/canvas-v5-preview`, otros worktrees.
- Type-stripping: prohibido `parameter properties`, `enum`, `namespace`.
- Subagentes para las pasadas de lectura/verificación; el hilo principal edita.

## Invariante de oro (no romper)
La selección de proveedor DNS va por **canal hermano `dnsProviderId` FUERA de `params`** (igual que `vpsProviderId`/`serverAccountId`). Meterlo en `params` cambia `inputHash` → falso `resume_scope_drift` + rompe el lease (HTTP 423). **NO toques** `hashInput`, `hashPlanApprovalScope`, el set de 8 campos de `PlanApprovalScope`, ni `plannedSteps`. Default (`dnsProviderId` ausente) ⇒ Route53 ⇒ byte-idéntico.

> **Nota sobre anclas:** los números de línea son as-of `529fbae` (= `produ` post-Etapa-3). El brief 06-18 trae líneas PRE-Etapa-3 (desfasadas — p.ej. el gate de ownership que cita en `:2636` hoy está en `:2813`). Anclá por identificadores estables (nombres de skill/función, strings) y grepeá; los números son orientativos.

## Piezas a construir (todas juntas o falla en step 6)

**1. Canal `dnsProviderId` (el patrón de `vpsProviderId` verbatim).**
Resolver state-first (`state.dnsProviderId ?? input.dnsProviderId`), persistir en `SmtpRunState` ANTES del step mutante (junto a `providerId`/`serverAccountId`, patrón `orchestrator-smtp.ts:711-715`), propagar como arg hermano hasta el dispatch. Nunca en `params`. Default → route53.

**2. Ruteo + traducción de shape del DNS (MINA #2).**
Steps 6 (`upsert_dns_route53`) y 10 (`configure_email_auth`) hoy fijan `skill:"upsert_dns_route53"` con `params:{domain,records}` (`orchestrator-smtp.ts:856` skill, `:860-866` params; step 10 en `:929`). Para `dnsProviderId==="ionos"`: enrutar a `upsert_dns_ionos` (dispatcher `skill-dispatcher.ts:634`). **OJO con el shape (MINA #2 ya NO es como el brief 06-18):** el schema del skill IONOS (`ionosUpsertParamSchema`, `skill-schemas.ts:326`) HOY acepta `zone ?? zoneName ?? domain` (`:339`) — mandar `domain` valida (zone←domain, correcto para IONOS); PERO la ruta HTTP `routes/dns-ionos-upsert.ts:111` exige `zone` literal. Codex: confirmar por cuál camino pasa el orquestador (dispatcher-skill vs ruta) y que los `records` (name/type/values) traduzcan bien Route53→IONOS. El actuator IONOS (`ionos-dns-actuator.ts`) con X-API-Key usa `writeApiKind="hosting-dns"` → base `api.hosting.ionos.com/dns` + paths `/v1/zones...` (correcto, ya verificado).

**3. Saltar el registro Route53 para dominio adoptado.**
Cuando `verifiedOwnedDomain === chosenDomain` y el provider es IONOS, **NO ejecutar** `register_domain_route53` (hoy: ownership en `resolveExistingDomainOwnership` `:643`/def `:2776`; build del skill en `:664`; espera `awaitFreshRoute53Registration` call `:672`/def `:1854`). Saltar el step 2 entero o rutearlo a un no-op `already_owned`. (Mantener intacto el path fresh-purchase Route53.)

**4. NS check del step 3.**
Hoy `contains:awsdns` aparece en DOS lugares: el wait NS del step 3 (`orchestrator-smtp.ts:692`) y el reconcile legacy (`:1679`). Un dominio IONOS adoptado ya tiene NS de IONOS → ajustar/saltar AMBOS para el carril IONOS.

**5. Fix silent-catch del ownership (opción 3 / QA LOW de PR #7).**
`domain-ownership.ts` `safeVerify` (≈líneas 111-121) traga la excepción sin loggear → si IONOS falla (otro 503, key vencida, etc.) el operador queda ciego. Agregar logging estructurado antes de devolver el fallo: `log.warn("domain_ownership_check_failed", { provider: check.id, error: (err as Error).message })`. Preserva fail-closed; solo agrega trazabilidad. (Puede ir en el mismo PR de Etapa 4.)

## DoD
- Un run de `configure_complete_smtp` sobre `annualcorpfilings.com` (IONOS): ownership por IONOS, **sin** intentar comprar en Route53, **DNS escrito en IONOS**, y completa los steps E2E (smoke gated por `IONOS_DNS_ENABLE_WRITES=true` + aprobación humana, estilo demo 27-may).
- Carril Route53 (compra fresca) **byte-idéntico** cuando NO hay adopción (default `dnsProviderId` ausente).
- `npm test` verde; respeta el **gate de regresión** del brief 06-18 §8. Sin tocar hashInput/scope/plannedSteps. Sin exponer secretos/DKIM.

## Anclas
- Diseño completo: `DOCUMENTACION/PROMPT_CODEX_RECABLEADO_MULTIPROVEEDOR_DNS_DOMINIOS_2026_06_18.md` (Etapa 4 + §7 lockstep + §8 regresión + §9 visibilidad).
- `orchestrator-smtp.ts` (líneas as-of `529fbae`): DNS skill `:856`/params `:860-866`/step10 `:929`, catálogo steps `:360,:364,:368`, register build `:664`/ownership `:643,:2776`/awaitFresh `:672,:1854`, NS check `:692` y `:1679`, persistencia hermana `:708-716` (patrón `vpsProviderId`), gate ownership `:2813`.
- `skill-dispatcher.ts:634` (`upsert_dns_ionos`); `routes/dns-ionos-upsert.ts:111` (exige `zone`; gate `IONOS_DNS_ENABLE_WRITES`); `skill-schemas.ts:326,:339` (schema IONOS acepta domain→zone).
- `domain-ownership.ts` `safeVerify` (silent-catch).
