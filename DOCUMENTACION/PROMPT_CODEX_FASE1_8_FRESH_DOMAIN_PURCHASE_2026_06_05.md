# Codex — FASE 1.8: restaurar la COMPRA de dominio fresco (regresión de la adopción)

> **Problema:** `configure_complete_smtp` aborta en step 1 con **`domain_ownership_not_verified` (424)** para un dominio NUEVO no-owned → **nunca compra**. La verificación de ownership (agregada para ADOPCIÓN en Fase 1.6) quedó como **HARD GATE** para todo dominio explícito no-en-suggestions, rompiendo el path de compra fresca. **Es una regresión** del diseño de adopción — restaurar la compra SIN romper la adopción.
> **Base:** `produ` `93cc9a5`. Rama `codex/fase1.8-fresh-purchase`. Subagentes + Auditor. Stop-and-report.

## Causa raíz (anclas, 93cc9a5)
- `orchestrator-smtp.ts:316-323`: `if (explicitDomain && !domainInSuggestions(suggestions, explicitDomain)) { verifiedOwnedDomain = await verifyExistingDomainOwnership({...}) }`.
- `verifyExistingDomainOwnership` (`:1147-1199`) **lanza `domain_ownership_not_verified` (424)** (`:1177` y `:1186`) si el dominio NO es owned. → dominio fresco explícito (no en suggestions, no owned) = 424, aborta antes del step 2 `register_domain_route53` (`:332`, la compra).
- `chooseDomainForRun` (`:1086-1128`): el gate `domain_not_in_suggestions_or_owned` (`:1102`) refuerza el bloqueo.

## Fix: ownership = ROUTER, no HARD GATE
La verificación de ownership debe **decidir el camino**, no abortar:
1. **Dominio explícito + OWNED** → ADOPTA (verifiedOwnedDomain = domain; saltea register; `costo 0`). [ya anda]
2. **Dominio explícito + NO owned** → es **COMPRA FRESCA**: **NO lanzar 424**; marcar el dominio como "a comprar" y dejar que el **step 2 `register_domain_route53`** lo compre (si `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE` y está disponible). Si register falla porque está **tomado por otro** → error real `domain_unavailable` (no 424 genérico).
3. **Sin dominio explícito** → `suggest_safe_domain` → elegir → register (compra). [path normal]
4. **`domain_ownership_not_verified` (424) SOLO** cuando hay intención explícita de "adoptar un dominio existente" (p.ej. flag `requireExistingDomain` / scope de adopción del plan) **Y** no es owned. **NUNCA** para una compra fresca.
- Mantener intactos: entity-guard (no inventar dominios), validación de naming (`smtp.`/anti-blacklist), budget cap (compra ~$15 ≤ budget 25), idempotencia de register (owned → no-op `costo 0`), Fase 1.5/1.6 (zona, server, SSH), guardrails de plan.

## Tests (node:test, run real)
- **Dominio explícito FRESCO** (no owned, disponible) → **compra** (register_domain_route53) → sigue al VPS. ← el caso que hoy da 424.
- Dominio explícito **owned** → adopta (`costo 0`). (no-regresión adopción)
- **Sin** dominio explícito (suggest) → compra el sugerido.
- Dominio **tomado por otro** → `domain_unavailable` (no 424 genérico).
- `requireExistingDomain` + no owned → 424 (adopción estricta sigue funcionando).
- proposals-sign/guardrails/Fase 1.5/1.6 intactos.

## Deploy
Código → **local** (restart gateway, Node 24). Sin cambio de prompt → Hostinger no se toca (salvo que ajustes el system prompt para describir compra-vs-adopción, entonces sync). Merge a produ tras verde + firma.

## Hecho cuando
`configure_complete_smtp` **compra un dominio FRESCO de punta a punta** (suggest o explícito → register → VPS → DNS smtp. → Postfix/DKIM → warmup → smoke) **Y** sigue adoptando dominios owned (`costo 0`). El 424 solo aplica a adopción estricta. Reportá SHA + el test de compra fresca en verde + un run real (dry o con budget bajo) que compre y avance.
