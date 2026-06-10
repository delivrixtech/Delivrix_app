# Codex — Patch Fase 1.6: `smtp.<dominio>` como convención ÚNICA de SMTP (enforced: write + validate + prefer)

> **Directiva del CTO (Juanes): `smtp.<dominio>` SIEMPRE, para TODOS los SMTP.** Debe quedar como regla única, enforced en código — no solo tolerada. `mail.` queda DEPRECADO (anti-spam Gmail/Outlook; ver `feedback_naming_dominios_smtp` + `REFERENCIAS_FLOW_REAL/SMTP_STACK_AUDIT`: `smtp.<dominio>` en myhostname/HELO/PTR/A/MX).
> **Sobre** `codex/fase1.6-zone-policy` (`621a722`). ANTES de mergear a produ.
> Subagentes (Backend + QA + Auditor de Errores). Si choca → parar y reportar.

## Fix 1 — WRITE: escribir SIEMPRE `smtp.<dominio>` (enforce la convención)
Auditá TODOS los sitios donde se escribe config/DNS de SMTP y estandarizá a `smtp.<dominio>` (hoy hay restos de `mail.`/apex):
- **A record:** `smtp.<dominio>` → IP del VPS.
- **MX:** `<dominio>  MX  10 smtp.<dominio>.`
- **PTR (Webdock, cuando se pueda):** IP → `smtp.<dominio>`.
- **Postfix:** `myhostname` y `smtp_helo_name` = `smtp.<dominio>`.
- **DKIM:** host/contexto del selector = `smtp.<dominio>`.
Revisar: `configure_email_auth` (`domains-email-auth.ts`), `provision_smtp_postfix` (`smtp-provisioning.ts`), bind/PTR (`webdock-bind-domain.ts`), el orquestador (`orchestrator-smtp.ts`). Donde digan `mail.<dominio>` o asuman apex para el host SMTP → `smtp.<dominio>`. (El A del apex puede quedar como extra opcional, pero el **host SMTP es `smtp.`**.)

## Fix 2 — VALIDATE / DISAMBIGUATE: `smtp.` es la canónica, se PREFIERE
En `route53-zone-policy.ts` (`hasApexMailRecords` :248 y la disambiguación :153-166):
- **Zona SMTP canónica** = tiene `A smtp.<dominio>` **y** `MX → "10 smtp.<dominio>"` (con A del target presente).
- **Tolerar legacy** (`mail.`/apex con A+MX) **solo al LEER** zonas existentes, marcándolas `legacy` — para no romper dominios viejos; pero NO es el target.
- **Disambiguación: PREFERIR la zona `smtp.`.** Si hay exactamente **una** zona con setup `smtp.` → usarla (determinístico). Si hay **varias** zonas `smtp.` (raro) o **ninguna válida** → **fail-closed** (`zone_ambiguous_manual_review`).
- **Guardrail `update_domain_nameservers`:** la zona destino debe tener el setup `smtp.` válido (o legacy tolerado), estar en nuestra cuenta, y **nunca vacía**.
- **Efecto controldelivrix:** prefiere automáticamente **Z05446832 (smtp.)** sobre Z03595092 (mail.) → realinea a la correcta **sin** pedir `preferredZoneId` manual; sugiere cleanup de la `mail.` vieja.

## Fix 3 — PROMPT v2.7 + matriz: dejarlo EXPLÍCITO
En `OPENCLAW_SYSTEM_PROMPT.md` y `OPENCLAW_PERMISSIONS_MATRIX.md`: regla única — **"El host SMTP es siempre `smtp.<dominio>` (A/MX/PTR/HELO/myhostname/DKIM). `mail.` está deprecado y no se usa en configuraciones nuevas."** Regenerar bundle (WORKTREE correcto).

## Tests (node:test, run real)
- **Write:** provisionar/configurar un dominio nuevo escribe `smtp.<dominio>` en A/MX/PTR/HELO/myhostname — **nunca `mail.`**.
- **Validate:** zona `smtp.` → canónica/válida; zona `mail.` → tolerada `legacy`; zona sin A del target MX → fail-closed.
- **Disambiguación controldelivrix** (mail. + smtp. en cuenta) → **prefiere la `smtp.` (Z05446832)** automáticamente; cleanupSuggested incluye la `mail.`.
- No-regresión: dominio nuevo, Fase 1.5 idempotencia, gating, observabilidad intactos.

## Deploy
Código + prompt → **local Y Hostinger** (toca el system prompt). Mergeá `codex/fase1.6-zone-policy` → produ tras verde + tu firma.

## Hecho cuando
`smtp.<dominio>` es la convención única enforced en **write + validate + prefer**; un dominio nuevo siempre queda en `smtp.`; controldelivrix realinea automáticamente a la zona `smtp.` (Z05446832); `mail.` solo se tolera al leer legacy. Reportá SHA + el test de "write usa smtp." y el de "disambiguación prefiere smtp.".
