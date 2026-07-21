> ## ⛔ SUPERSEDED / NO EJECUTAR (2026-06-20)
> Este brief quedó **redundante**. Ya existe uno más completo, auditado y EN MARCHA:
> **`DOCUMENTACION/PROMPT_CODEX_RECABLEADO_MULTIPROVEEDOR_DNS_DOMINIOS_2026_06_18.md`**
> (worktree `dns-seam-stage1` / rama `feat/dns-provider-seam-stage1`; **Etapa 1 ya hecha y verde en `produ`**).
> Ese brief cubre los mismos 4 subproblemas + el patrón canal-hermano `dnsProviderId`, las 2 minas, el gate de regresión y el smoke E2E. **Continuar desde su Etapa 2, no desde acá.**
> Este documento se conserva solo como confirmación independiente del diagnóstico.

# BRIEF CODEX — Adoptar dominios IONOS existentes en configure_complete_smtp (hoy es Route53-only)

Fecha: 2026-06-20 · Auditado por Claude + subagente senior (grounded, file:línea, read-only) · Ejecuta: **Codex con subagentes**.

## Por qué (operativo)
Los 8 SMTPs actuales están en blacklist (8/8 ivmSIP24). El operador necesita SMTPs limpios y tiene **13 dominios ya pagados en IONOS** (ej. `annualcorpfilings.com`, blacklist-clean). Plan correcto: dominio IONOS limpio + VPS Contabo (rango IP distinto al Webdock quemado). **Bloqueante:** `configure_complete_smtp` no sabe **adoptar** un dominio que ya existe en IONOS — está cableado a AWS Route53 de punta a punta para 3 cosas (comprar dominio, verificar ownership, escribir DNS).

## Síntomas en runtime (cadena de fallos, todos el mismo cableado Route53-only)
1. Step 2 registro: `AWS Route53 Domains API 400 / "Given domain is unavailable"` — intenta COMPRAR el dominio que ya es nuestro en IONOS.
2. Con `requireExistingDomain: true`: `plan_scope_mismatch: requireExistingDomain` — el plan se firmó SIN el flag; el scope-hash no coincide.
3. `domain_ownership_not_verified: domain=annualcorpfilings.com` — el ownership solo se verifica vía Route53.

## Hallazgo clave
Las piezas IONOS **YA EXISTEN** (adapters domains + DNS, rutas, tools, el flag firmado) pero **el orquestador nunca las invoca** (`grep -i ionos orchestrator-smtp.ts` = 0 matches). El trabajo es **enrutamiento condicional por proveedor dentro del orquestador**, no construir capacidades nuevas. Tamaño: **mediano**. Los 4 subproblemas deben ir juntos (un fix parcial falla más adelante en step 6).

## Subproblema 1 — Firmar el plan CON `requireExistingDomain: true` (0 código de gateway)
El mecanismo de hash del scope funciona correcto: el flag entra al hash solo si es `=== true` (`proposals-sign.ts:700`), y el orquestador compara firmado-vs-esperado (`orchestrator-smtp.ts:2896-2905`). El plan se firmó sin el flag → mismatch.
- **Acción:** asegurar que el caller (OpenClaw) propague `requireExistingDomain: true` a `proposal.params` ANTES de firmar, cuando el dominio es de adopción IONOS. El endpoint ya lo parsea (`proposals-sign.ts:673`). Verificar el path OpenClaw -> proposal.params -> firma. (Nota prompt: el agente debe SETEAR el flag al adoptar; coordinar con el system-context.)
- NO tocar el hashing.

## Subproblema 2 — Ownership vía IONOS (CHICO/MEDIANO)
`verifyOwnedDomain` (`main.ts:728-749`) solo consulta `awsRoute53DomainsAdapter.listInventory()`. El adapter IONOS ya existe e instanciado: `ionosDomainsAdapter` (`main.ts:392`), `IonosDomainsAdapter.listInventory()` (`packages/adapters/src/ionos-domains-adapter.ts:90`, devuelve name/status/nameservers).
- **Acción:** ampliar `verifyOwnedDomain` para consultar TAMBIÉN IONOS y devolver `{owned:true, provider:"ionos"}` si el dominio aparece ahí.
- Cambiar el tipo `OwnedDomainVerification.provider` de literal `"route53"` a unión `"route53" | "ionos"` (`orchestrator-smtp.ts:102-108`).
- Relajar el gate `verification.provider !== "route53"` (`orchestrator-smtp.ts:2820`) para aceptar `"ionos"`.
- Persistir qué proveedor verificó (lo necesitan los steps DNS).

## Subproblema 3 — Saltar el registro para dominio adoptado (MEDIANO)
Hoy, aunque el costo va a 0 cuando `verifiedOwnedDomain === chosenDomain` (`orchestrator-smtp.ts:669,679`), el step 2 **igual ejecuta** `register_domain_route53` (dispatcher `skill-dispatcher.ts:621` -> `domains-purchase.ts`, falla en `:516/582`).
- **Acción:** cuando el dominio está adoptado (owned + provider ionos), **saltar el step 2 entero** (o enrutarlo a un no-op `already_owned`). Tocar `orchestrator-smtp.ts:660-680` + `awaitFreshRoute53Registration` (`:1862-1934`).

## Subproblema 4 — DNS en IONOS en vez de Route53 (MEDIANO/GRANDE, lo más invasivo)
Steps 6 (`upsert_dns_route53`) y 10 (`configure_email_auth`) escriben MX/SPF/DKIM/DMARC en Route53 (`orchestrator-smtp.ts:362-370`). Para IONOS hay que enrutarlos a `upsert_dns_ionos` (dispatcher `skill-dispatcher.ts:628`; ruta `routes/dns-ionos-upsert.ts`, gated por `IONOS_DNS_ENABLE_WRITES`; adapters `ionos-dns-adapter.ts`/`ionos-dns-actuator.ts`).
- **Acción:** selector de proveedor DNS por-run. Patrón recomendado: canal hermano `dnsProviderId` análogo a `vpsProviderId` (`orchestrator-smtp.ts:715`) — NO entra al hashInput pero SÍ se persiste en `SmtpRunState` (`:395-411`); opcional firmarlo en scope (`proposals-sign.ts:588-604/655-707`).
- Ajustar el NS check del step 3 que hoy espera `contains:awsdns` (`orchestrator-smtp.ts:694`) — un dominio IONOS adoptado ya tiene NS de IONOS; saltar/ajustar la verificación de delegación.
- Verificar que `wait_for_dns_propagation` (steps 3/7/11) y el DKIM server-side (node:crypto) funcionen contra nameservers IONOS.
- Requiere kill-switch `IONOS_DNS_ENABLE_WRITES` ON + creds `IONOS_DNS_API_KEY`.
- `read_dns_ionos` YA está autorizado en el scope firmado (`proposals-sign.ts:594`) pero el orquestador no lo ejecuta — aprovechar.

## DoD
- Pedir configurar SMTP sobre `annualcorpfilings.com` (IONOS) → el run NO intenta comprar en Route53, verifica ownership en IONOS, escribe DNS en IONOS, y completa los 15 steps E2E (smoke incluido).
- El flujo de dominio Route53 (comprar fresco) sigue funcionando byte-idéntico cuando NO es adopción.
- `node --test` gateway verde; extender tests existentes (`orchestrator-smtp.test.ts:1433,1454,1476` documentan el comportamiento actual). Sin exponer secretos/DKIM. Sin tocar el hashing del scope ni los adapters (ya andan).

## NO hacer
- NO el brief de "Fase A / endurecer prompt para invocar la tool" — ese NO es el problema (el agente YA invoca la tool correctamente; lo verificamos en runtime con la propuesta `ad176bcd`). El nudo es el cableado Route53-only del orquestador.

## Riesgo
El orquestador asume Route53 en puntos implícitos (NS `awsdns`, costo de registro, DKIM/DNS write path). Cubrir los 4 subproblemas JUNTOS o el run falla en step 6.
