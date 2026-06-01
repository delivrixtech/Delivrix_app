# OPS Codex Fase 1 — Skill `suggest_safe_domain`

**Fecha:** 2026-05-31 domingo (pre-armado).
**Severidad:** P1 — bloquea autonomía de naming para registros de dominio.
**Owner:** Codex backend senior.
**PM:** Claude.
**Pre-requisito:** Fase 1 tool calling Bedrock activa (ver `OPS_CODEX_FASE_1_TOOL_CALLING_BEDROCK_2026_06_01.md`).

---

## Motivación

Juanes pidió 2026-05-31: *"compramos otro... son names que no podemos usar... pedirle a openclaw que aprenda de eso. Que aprenda los nombres... para que nos permita saber cuales comprar."*

Hoy OpenClaw NO valida naming antes de proponer `register_domain_route53`. Eso causó que paso 1 sábado registrara `delivrix-notify.com` con `notify` en el nombre — flag spam de origen. $15 cobrados, dominio bajo reputación inicial.

OpenClaw debe **sugerir** candidatos validados ANTES del registro.

---

## Skill nueva: `suggest_safe_domain`

**Input:**

```typescript
{
  brand: string;              // "delivrix", "nfcorp", etc.
  intent?: string;            // "smtp" | "reporting" | "filing" | "saas" | "ops"
  tlds?: string[];            // default ["com", "net", "io", "app"]
  count?: number;             // default 5 (top viables retornados)
}
```

**Output:**

```typescript
{
  candidates: Array<{
    domain: string;
    available: boolean;         // via Route53 availability check
    priceUsd: number;
    spamhausDBL: "clean" | "listed" | "error";
    suricata: "clean" | "flagged" | "error";  // si se integra
    senderScore?: number;       // si retornable para dominio no usado
    namingScore: number;        // 0-100, score interno calculado
    blockedReasons: string[];   // ["contains_mail_prefix", "tld_problematic", "spamhaus_listed"]
  }>;
  patternUsed: string;          // "brand + intent + tld"
  prohibitedWordsFiltered: string[];
}
```

## Reglas naming embebidas

**Palabras prohibidas en dominio o hostname:**
- `mail`, `email`, `notify`, `noreply`, `notification`, `alert`, `marketing`, `bulk`, `send`, `sender`, `inbox`, `blast`, `spam`, `promo`

**TLDs prohibidos / penalizados:**
- `.click`, `.top`, `.xyz`, `.work`, `.zip`, `.country`, `.bid`, `.tk`, `.ml`, `.ga`, `.cf`

**Patrones penalizados:**
- Fecha hardcoded en dominio: `mail-2026-05`, `app20260527`
- Hyphens excesivos: `corp-app-ops-mail.com`
- Números aleatorios: `corp4928.com`, `app-h8x3.com`

**Patrón preferido (basado en SMTPs running de Juanes):**
- `<brand><intent>.<tld>` — `delivrixops.com`, `nfcorpreport.com`
- `<verb><brand>.<tld>` — `fileyourcorp.app`
- `<brand><adjetivo>.<tld>` — `filecorppro.net`

## Validaciones API (pre-suggestion)

1. **Route53 availability check** — `GET /v1/domains/route53/availability?domain=<X>` (endpoint ya existe Fase 1)
2. **Spamhaus DBL** — DNS lookup `<domain>.dbl.spamhaus.org`. Si responde, listado → descartar.
3. **SenderScore** opcional si Webdock provee, sino skip.
4. **Brand uniqueness** — confirmar `<brand>` no choca con marca registrada conocida (lista interna).

## Integración con `register_domain_route53`

Modificar skill existente:

```typescript
// Antes de submitear propuesta register_domain_route53
const namingValidation = validateDomainNaming(proposal.params.domain);
if (namingValidation.score < 70 || namingValidation.blockedReasons.length > 0) {
  return {
    proposal_blocked: true,
    rejectReason: "domain_naming_high_risk",
    details: namingValidation.blockedReasons,
    alternativeSuggestions: await suggestSafeDomain({ brand, intent }).slice(0, 3)
  };
}
```

## Tests

`apps/gateway-api/src/services/naming-validator.test.ts`:

- `delivrix-notify.com` → score < 50, blockedReasons: ["contains_notify"]
- `delivrix-mail.click` → score < 30, blockedReasons: ["contains_mail", "tld_problematic"]
- `delivrixops.com` → score > 80, blockedReasons: []
- `nfcorpreport.com` → score > 85
- `mail.fileyourcorp.app` → hostname rechazado, score < 60 (mail prefix)

## UX en chat OpenClaw

Usuario: *"OpenClaw, sugiere 3 dominios para nuevo SMTP de Delivrix"*

OpenClaw (con tool calling Fase 1):
1. Invoca `suggest_safe_domain({ brand: "delivrix", intent: "smtp", count: 5 })`
2. Recibe candidatos validados
3. Responde con tabla limpia + recomendación

> *"Generé 5 candidatos viables, filtrados contra Spamhaus + Sender Score + reglas anti-spam:*
> 
> *1. `delivrixops.com` (score 92, disponible $15)*
> *2. `delivrixreport.com` (score 88, disponible $15)*
> *3. `delivrixfiling.com` (score 85, disponible $15)*
> 
> *Recomiendo `delivrixops.com` — pattern alineado con tus SMTPs running (fileyourcorp.app, nfcorpreport.com). ¿Querés que arme propuesta `register_domain_route53` con ese?"*

---

— Claude PM
