# OPS Codex — Skill `suggest_safe_domain` (implementar HOY como skill independiente)

**Fecha despacho:** 2026-05-31 domingo 14:30 COT.
**Fecha ejecución:** **HOY MISMO. Paralelizable con OPS 1/2/3.**
**Severidad:** P1 — bloquea autonomía de naming. Sin esta skill OpenClaw chat seguiría proponiendo dominios con prefix `mail/notify/email` (caso real: `delivrix-notify.com` registrado sábado, $15 USD perdidos en reputación inicial flag-spam).
**Owner:** Codex backend senior.
**PM:** Claude.
**Modo:** URGENT.

**Reemplaza:** `OPS_CODEX_FASE_1_SKILL_NAMING_SAFE_DOMAIN_2026_05_31.md` (versión Fase 1 que asumía tool calling Bedrock ya wired). Este OPS define la skill como **endpoint REST independiente HOY**, invocable por:

1. OpenClaw chat via tool_use cuando Fase 1 esté lista (Codex en paralelo).
2. `curl` directo por el operador HOY mismo.
3. Frontend Canvas Live (botón "Sugerir dominios").

---

## Síntoma / Motivación

Juanes pidió 2026-05-31: *"compramos otro... son names que no podemos usar... pedirle a openclaw que aprenda de eso. Que aprenda los nombres... para que nos permita saber cuales comprar."*

Sábado, OpenClaw propuso registrar `delivrix-notify.com` — el prefijo `notify` es flag-spam reconocido por Gmail/Outlook/Spamhaus. Juanes firmó (asumió que la skill validaba), AWS Route53 registró el dominio, $15 cobrados, dominio bajo reputación inicial cero/negativa.

OpenClaw debe **sugerir candidatos validados ANTES** del registro. No debe ser un wrapper opaco — debe explicar por qué cada candidato pasa o no pasa.

---

## Decisión arquitectónica

- **Categoría matrix:** `read_only` (NO firma operador). Es lectura/sugerencia, no muta nada. La firma queda para `register_domain_route53` posterior.
- **Sincrónica:** retorna candidatos en < 30s. Si Route53 availability API tarda, retorna con `available: "unknown"` para los que no respondieron.
- **Idempotente:** llamadas repetidas con mismo brand/intent retornan el mismo set (orden determinístico por `namingScore` desc).
- **Audit event:** `oc.naming.candidates_suggested` con metadata `{ brand, intent, count, candidatesReturned, blockedReasonsBreakdown }`. Aunque sea read_only, dejamos rastro para aprendizaje futuro (qué dominios sugerimos y cuáles terminó comprando el operador).
- **Integración con `register_domain_route53`:** el handler del registro DEBE validar contra el mismo `naming-validator` interno y rechazar si score < 70 (incluso si la skill `suggest_safe_domain` no fue invocada antes).

---

## Tarea 1 — Schema zod

**Archivo nuevo:** `apps/gateway-api/src/routes/domains-suggest.ts`.

```typescript
import { z } from "zod";

export const suggestSafeDomainParamSchema = z.object({
  brand: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9]+$/, "brand_must_be_lowercase_alphanumeric"),
  intent: z.enum(["smtp", "reporting", "filing", "saas", "ops", "general"]).default("general"),
  tlds: z.array(z.string().regex(/^[a-z]{2,12}$/)).default(["com", "net", "io", "app"]),
  count: z.number().int().min(1).max(20).default(5),
  actorId: z.string().min(1).max(120)
});

export type SuggestSafeDomainParams = z.infer<typeof suggestSafeDomainParamSchema>;

export interface DomainCandidate {
  domain: string;
  available: boolean | "unknown";
  priceUsd: number | null;
  namingScore: number;            // 0-100
  blockedReasons: string[];       // ["contains_notify", "tld_problematic"]
  spamhausDBL: "clean" | "listed" | "error" | "skipped";
  registrarOptions: Array<{ registrar: "route53" | "porkbun"; priceUsd: number; available: boolean }>;
  rationale: string;              // 1-2 frases explicando por qué pasa o no
}

export interface SuggestSafeDomainResult {
  candidates: DomainCandidate[];
  patternsUsed: string[];         // ["brand+intent+tld", "verb+brand+tld"]
  prohibitedWordsFiltered: string[];
  eventId: string;
  durationMs: number;
}
```

---

## Tarea 2 — Validador interno reutilizable

**Archivo nuevo:** `apps/gateway-api/src/services/naming-validator.ts`.

```typescript
// Palabras prohibidas en dominio o subdomain (case-insensitive)
export const PROHIBITED_DOMAIN_WORDS = [
  "mail", "email", "notify", "noreply", "notification",
  "alert", "marketing", "bulk", "send", "sender",
  "inbox", "blast", "spam", "promo", "newsletter",
  "campaign", "broadcast"
];

// TLDs prohibidos o penalizados
export const TLD_PENALTY: Record<string, number> = {
  click: -100,    // prohibido
  top: -100,
  xyz: -80,
  work: -80,
  zip: -100,
  country: -70,
  bid: -90,
  tk: -100,
  ml: -100,
  ga: -100,
  cf: -100,
  // OK
  com: 10,
  net: 5,
  io: 5,
  app: 5,
  co: 0
};

export interface NamingValidationResult {
  score: number;                  // 0-100, suma de penalties + bonuses
  blockedReasons: string[];
  passes: boolean;                // score >= 70 && blockedReasons.length === 0
}

export function validateDomainNaming(domain: string): NamingValidationResult {
  const reasons: string[] = [];
  let score = 100;

  const parts = domain.toLowerCase().split(".");
  if (parts.length < 2) {
    return { score: 0, blockedReasons: ["domain_no_tld"], passes: false };
  }

  const sld = parts[0];
  const tld = parts.slice(1).join(".");

  // 1. Prohibited words
  for (const word of PROHIBITED_DOMAIN_WORDS) {
    if (sld.includes(word)) {
      reasons.push(`contains_${word}`);
      score -= 50;
    }
  }

  // 2. TLD penalty
  const tldPenalty = TLD_PENALTY[tld] ?? -30;  // unknown TLD = -30
  score += tldPenalty;
  if (tldPenalty <= -70) reasons.push("tld_problematic");

  // 3. Pattern penalties
  if (/^\d/.test(sld)) {
    reasons.push("starts_with_digit");
    score -= 20;
  }
  if ((sld.match(/-/g)?.length ?? 0) > 2) {
    reasons.push("excessive_hyphens");
    score -= 15;
  }
  if (/\d{3,}/.test(sld)) {
    reasons.push("contains_long_number");
    score -= 25;
  }
  if (/(\d{4}|20\d{2})/.test(sld)) {
    reasons.push("contains_year");
    score -= 15;
  }
  if (sld.length < 4) {
    reasons.push("sld_too_short");
    score -= 10;
  }
  if (sld.length > 25) {
    reasons.push("sld_too_long");
    score -= 10;
  }

  // 4. Bonus por brand alignment (pattern preferido)
  // Si el SLD termina con sufijo común de operaciones serias
  const goodSuffixes = ["ops", "report", "reporting", "filing", "pro", "corp", "io"];
  if (goodSuffixes.some((s) => sld.endsWith(s))) {
    score += 10;
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    blockedReasons: reasons,
    passes: score >= 70 && reasons.length === 0
  };
}

export function validateHostnameNaming(hostname: string): NamingValidationResult {
  // Para hostnames, el prefijo es lo más importante (no debe ser mail/smtp/etc).
  const reasons: string[] = [];
  let score = 100;

  const labels = hostname.toLowerCase().split(".");
  const firstLabel = labels[0];

  for (const word of PROHIBITED_DOMAIN_WORDS) {
    if (firstLabel === word || firstLabel.startsWith(`${word}-`) || firstLabel.startsWith(`${word}.`)) {
      reasons.push(`hostname_prefix_${word}`);
      score -= 60;
    }
  }

  // El resto del hostname (dominio) sigue las reglas de validateDomainNaming
  const domainPart = labels.slice(1).join(".") || labels[0];
  const domainCheck = validateDomainNaming(domainPart);
  score = Math.min(score, domainCheck.score);
  reasons.push(...domainCheck.blockedReasons);

  return {
    score: Math.max(0, score),
    blockedReasons: reasons,
    passes: score >= 70 && reasons.length === 0
  };
}
```

---

## Tarea 3 — Generador de candidatos

```typescript
const INTENT_SUFFIXES: Record<string, string[]> = {
  smtp: ["ops", "relay", "delivery", "outbound"],
  reporting: ["report", "reporting", "metrics", "stats"],
  filing: ["filing", "docs", "records", "ledger"],
  saas: ["app", "platform", "io", "cloud"],
  ops: ["ops", "infra", "control"],
  general: ["pro", "corp", "io", "app"]
};

const PATTERNS = [
  // brand + intentSuffix + tld
  (brand: string, intentSuffix: string, tld: string) => `${brand}${intentSuffix}.${tld}`,
  // brand + dash + intentSuffix + tld
  (brand: string, intentSuffix: string, tld: string) => `${brand}-${intentSuffix}.${tld}`,
  // intentSuffix + brand + tld (only if length OK)
  (brand: string, intentSuffix: string, tld: string) => `${intentSuffix}${brand}.${tld}`
];

export function generateCandidates(input: {
  brand: string;
  intent: string;
  tlds: string[];
  count: number;
}): string[] {
  const suffixes = INTENT_SUFFIXES[input.intent] ?? INTENT_SUFFIXES.general;
  const candidates = new Set<string>();

  for (const tld of input.tlds) {
    for (const suffix of suffixes) {
      for (const pattern of PATTERNS) {
        const d = pattern(input.brand, suffix, tld);
        if (d.length >= 6 && d.length <= 40) candidates.add(d);
      }
    }
  }

  return Array.from(candidates);
}
```

---

## Tarea 4 — Spamhaus DBL check

```typescript
import { promises as dns } from "node:dns";

async function checkSpamhausDBL(domain: string): Promise<"clean" | "listed" | "error"> {
  try {
    await dns.resolve4(`${domain}.dbl.spamhaus.org`);
    return "listed";   // si responde con A record, está listado
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    if (code === "ENOTFOUND") return "clean";
    return "error";
  }
}
```

---

## Tarea 5 — Handler HTTP

```typescript
export async function handleSuggestSafeDomain(input: {
  request: IncomingMessage;
  response: ServerResponse;
  deps: SuggestSafeDomainDeps;
}): Promise<void> {
  const body = await readJsonBody(input.request);
  const parsed = suggestSafeDomainParamSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(input.response, 400, { error: "invalid_params", details: parsed.error.format() });
    return;
  }
  const params = parsed.data;
  const startedAt = input.deps.now();

  // 1. Generar candidatos brutos
  const rawCandidates = generateCandidates({
    brand: params.brand,
    intent: params.intent,
    tlds: params.tlds,
    count: params.count * 4   // sobreproducir, después filtramos
  });

  // 2. Validar naming de cada uno (paralelo, en memoria)
  const scored = rawCandidates.map((domain) => ({
    domain,
    validation: validateDomainNaming(domain)
  }));

  // 3. Filtrar los que pasan naming + ordenar por score desc
  const passing = scored
    .filter((s) => s.validation.passes)
    .sort((a, b) => b.validation.score - a.validation.score)
    .slice(0, params.count * 2);   // top N*2 antes de spamhaus/availability

  // 4. Spamhaus DBL paralelo
  const spamhausResults = await Promise.all(
    passing.map(async (s) => ({
      domain: s.domain,
      result: await checkSpamhausDBL(s.domain)
    }))
  );
  const spamhausMap = new Map(spamhausResults.map((r) => [r.domain, r.result]));

  // 5. Filtrar listados spamhaus
  const stillPassing = passing.filter((s) => spamhausMap.get(s.domain) !== "listed");

  // 6. Availability (Route53 + Porkbun en paralelo)
  const availabilityResults = await Promise.all(
    stillPassing.slice(0, params.count).map(async (s) => {
      const route53 = await input.deps.route53Availability(s.domain).catch(() => ({
        available: "unknown" as const,
        priceUsd: null
      }));
      const porkbun = await input.deps.porkbunAvailability(s.domain).catch(() => ({
        available: "unknown" as const,
        priceUsd: null
      }));
      return { domain: s.domain, route53, porkbun };
    })
  );

  // 7. Construir respuesta
  const candidates: DomainCandidate[] = stillPassing.slice(0, params.count).map((s, idx) => {
    const avail = availabilityResults[idx];
    const registrarOptions: DomainCandidate["registrarOptions"] = [];
    if (avail.route53.priceUsd !== null) {
      registrarOptions.push({
        registrar: "route53",
        priceUsd: avail.route53.priceUsd,
        available: avail.route53.available === true
      });
    }
    if (avail.porkbun.priceUsd !== null) {
      registrarOptions.push({
        registrar: "porkbun",
        priceUsd: avail.porkbun.priceUsd,
        available: avail.porkbun.available === true
      });
    }
    const cheapest = registrarOptions.reduce<DomainCandidate["registrarOptions"][number] | null>(
      (acc, opt) => (opt.available && (!acc || opt.priceUsd < acc.priceUsd) ? opt : acc),
      null
    );
    return {
      domain: s.domain,
      available: cheapest ? true : avail.route53.available === false && avail.porkbun.available === false ? false : "unknown",
      priceUsd: cheapest?.priceUsd ?? null,
      namingScore: s.validation.score,
      blockedReasons: s.validation.blockedReasons,
      spamhausDBL: spamhausMap.get(s.domain) ?? "skipped",
      registrarOptions,
      rationale: buildRationale(s.domain, s.validation.score, cheapest)
    };
  });

  // 8. Audit event
  const blockedBreakdown: Record<string, number> = {};
  for (const s of scored) {
    for (const r of s.validation.blockedReasons) {
      blockedBreakdown[r] = (blockedBreakdown[r] ?? 0) + 1;
    }
  }

  const evt = await input.deps.auditLog.append({
    type: "oc.naming.candidates_suggested",
    actorId: params.actorId,
    metadata: {
      brand: params.brand,
      intent: params.intent,
      tlds: params.tlds,
      countRequested: params.count,
      countReturned: candidates.length,
      candidatesReturned: candidates.map((c) => c.domain),
      blockedReasonsBreakdown: blockedBreakdown
    }
  });

  sendJson(input.response, 200, {
    candidates,
    patternsUsed: ["brand+intentSuffix+tld", "brand-intentSuffix+tld", "intentSuffix+brand+tld"],
    prohibitedWordsFiltered: PROHIBITED_DOMAIN_WORDS,
    eventId: (evt as { id?: string }).id ?? "",
    durationMs: input.deps.now() - startedAt
  } satisfies SuggestSafeDomainResult);
}

function buildRationale(domain: string, score: number, cheapest: { registrar: string; priceUsd: number } | null): string {
  if (!cheapest) return `Naming OK (score ${score}/100) pero disponibilidad no confirmada en registrars.`;
  return `Naming OK (score ${score}/100). Disponible en ${cheapest.registrar} a $${cheapest.priceUsd}/año. Sin palabras flag-spam ni TLD problemático.`;
}
```

---

## Tarea 6 — Integración bloqueante con `register_domain_route53`

**Archivo modificado:** `apps/gateway-api/src/routes/domains-purchase.ts` (handler existente).

Antes de aceptar la propuesta `register_domain_route53`, validar:

```typescript
import { validateDomainNaming } from "../services/naming-validator.ts";

// dentro del handler de register_domain_route53, antes de invocar Route53 API:
const naming = validateDomainNaming(params.domain);
if (!naming.passes) {
  // Emit audit event de rechazo
  await deps.auditLog.append({
    type: "oc.domain.purchase_blocked_naming",
    actorId: params.actorId,
    metadata: { domain: params.domain, score: naming.score, blockedReasons: naming.blockedReasons }
  });
  sendJson(response, 422, {
    error: "domain_naming_high_risk",
    details: {
      domain: params.domain,
      score: naming.score,
      blockedReasons: naming.blockedReasons,
      hint: "Llama POST /v1/skills/suggest-safe-domain para obtener alternativas validadas."
    }
  });
  return;
}
```

**Importante:** este check corre **incluso si OpenClaw nunca llamó `suggest_safe_domain`**. Es la última barrera antes de gastar $15+ USD.

---

## Tarea 7 — Wire en `main.ts` + `skill-dispatcher.ts`

1. **main.ts:** `POST /v1/skills/suggest-safe-domain`.
2. **skill-dispatcher.ts:**

```typescript
const suggestSafeDomain: SkillHandlerEntry = {
  paramSchema: suggestSafeDomainParamSchema,
  timeoutMs: 30_000,
  canRollback: false,    // read_only
  invoke: ({ request, response, deps }) =>
    handleSuggestSafeDomain({
      request,
      response,
      deps: {
        auditLog: deps.auditLog,
        route53Availability: deps.route53Availability,
        porkbunAvailability: deps.porkbunAvailability,
        now: deps.now
      }
    })
};

return {
  // ... existing
  suggest_safe_domain: suggestSafeDomain,
  naming_suggest: suggestSafeDomain
};
```

3. **OPENCLAW_PERMISSIONS_MATRIX.md:** fila con categoría `read_only`, costo `$0` (lectura), reversible `n/a`.

---

## Tarea 8 — Bedrock tool spec (cuando Fase 1 esté wired)

Cuando `openclaw-tools-builder.ts` exista (Fase 1), agregar:

```typescript
tools.push({
  name: "suggest_safe_domain",
  description: "Genera 3-5 dominios candidatos validados contra naming rules (sin prefijos flag-spam como mail/notify/email), Spamhaus DBL, y availability en Route53 + Porkbun. Read-only, no requiere firma. Llamar ANTES de register_domain_route53 cuando el operador pida un dominio nuevo.",
  input_schema: {
    type: "object",
    properties: {
      brand: { type: "string", description: "Marca base (ej. delivrix, nfcorp)" },
      intent: { type: "string", enum: ["smtp", "reporting", "filing", "saas", "ops", "general"] },
      tlds: { type: "array", items: { type: "string" } },
      count: { type: "integer", minimum: 1, maximum: 20 }
    },
    required: ["brand"]
  }
});
```

---

## Tarea 9 — Tests obligatorios

**Archivo:** `apps/gateway-api/src/services/naming-validator.test.ts` (≥ 10 tests):

1. `delivrix-notify.com` → `passes: false`, `blockedReasons: ["contains_notify"]`, score < 50.
2. `delivrix-mail.click` → `passes: false`, reasons incluye `contains_mail` + `tld_problematic`, score < 30.
3. `delivrixops.com` → `passes: true`, score > 80.
4. `nfcorpreport.com` → `passes: true`, score > 85.
5. `mail.fileyourcorp.app` → hostname check: `hostname_prefix_mail`, score < 50.
6. `corp4928.com` → `contains_long_number`, score < 70.
7. `app-h8x3-mail-2026.work` → multiple penalties: `contains_mail`, `tld_problematic`, `contains_year`, score ~ 0.
8. `delivrix.com` → `sld_too_short` se aplica? (no, "delivrix" = 8 chars). Verificar boundary.
9. `a.com` → `sld_too_short`, score baja.
10. TLD desconocido `delivrixops.foo` → penalty -30.

**Archivo:** `apps/gateway-api/src/routes/domains-suggest.test.ts` (≥ 8 tests):

11. Happy path `{ brand: "delivrix", intent: "smtp", count: 3 }` → retorna 3 candidatos con `namingScore >= 70`, ninguno con `notify/mail/email`.
12. Spamhaus listed → candidato filtrado.
13. Route53 availability falla → candidato con `available: "unknown"`, no crashea.
14. `brand` con uppercase → HTTP 400 `brand_must_be_lowercase_alphanumeric`.
15. `count: 21` → HTTP 400 (max 20).
16. Audit event `oc.naming.candidates_suggested` emitido con `blockedReasonsBreakdown`.
17. TLDs custom `["co"]` → respeta lista.
18. Generator determinístico: 2 llamadas con mismo input → mismo set de candidatos.

**Archivo:** `apps/gateway-api/src/routes/domains-purchase.test.ts` (test nuevo en suite existente):

19. `register_domain_route53` con `domain: "delivrix-notify.com"` → HTTP 422 `domain_naming_high_risk`, NO se llama Route53 API.
20. `register_domain_route53` con `domain: "delivrixops.com"` → pasa naming gate, continúa flow normal.

---

## Tarea 10 — UX en chat OpenClaw (cuando Fase 1 esté wired)

Cuando `OPENCLAW_SYSTEM_PROMPT.md` se actualice, agregar bloque:

```
[domain_purchase_protocol]
Cuando el operador pida comprar un dominio nuevo:
1. SIEMPRE llamar primero `suggest_safe_domain` con la brand inferida del contexto.
2. NUNCA proponer `register_domain_route53` con un dominio que contenga: mail, email, notify, noreply, alert, bulk, send, sender, inbox.
3. NUNCA usar TLDs: .click, .top, .xyz, .work, .zip.
4. Mostrar al operador los top 3 candidatos con score, precio y rationale.
5. Esperar confirmación explícita del operador antes de armar la proposal de register_domain_route53.
```

---

## Sign-off requerido

- [ ] Codex confirma SHA final del commit + push a main.
- [ ] `pnpm tsc --noEmit` clean.
- [ ] `pnpm vitest run` verde con ≥ 18 tests nuevos (validator + suggest + purchase guard).
- [ ] Smoke manual: `curl POST /v1/skills/suggest-safe-domain -d '{"brand":"delivrix","intent":"smtp","actorId":"juanes-cto"}'` retorna ≥ 3 candidatos, ninguno con prefijo flag-spam.
- [ ] Smoke purchase guard: intentar `POST /v1/skills/register-domain-route53` con `domain: "delivrix-notify.com"` retorna HTTP 422, audit chain registra `oc.domain.purchase_blocked_naming`.
- [ ] Lista `PROHIBITED_DOMAIN_WORDS` revisada por PM Claude (puede ampliarse).
- [ ] PM Claude revisa diff antes de merge.

---

## Entregables

1. **Código:**
   - `apps/gateway-api/src/services/naming-validator.ts` (validator reutilizable)
   - `apps/gateway-api/src/services/naming-validator.test.ts` (≥ 10 tests)
   - `apps/gateway-api/src/routes/domains-suggest.ts` (handler + schema)
   - `apps/gateway-api/src/routes/domains-suggest.test.ts` (≥ 8 tests)
   - `apps/gateway-api/src/routes/domains-purchase.ts` (modificar para usar validator — añadir gate)
   - `apps/gateway-api/src/routes/domains-purchase.test.ts` (+ 2 tests del gate)
   - `apps/gateway-api/src/main.ts` (wire ruta suggest)
   - `apps/gateway-api/src/skill-dispatcher.ts` (entry + alias)
   - `DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md` (fila nueva)

2. **Smoke evidence:** `runtime/suggest-safe-domain-smoke-{timestamp}.json`.

3. **Docs:** actualizar `OPENCLAW_SYSTEM_PROMPT.md` con bloque `[domain_purchase_protocol]`.

---

## Notas finales del PM

- **Esta skill es read-only pero es la PRIMERA LÍNEA DE DEFENSA.** El gate en `register_domain_route53` (tarea 6) es la SEGUNDA. Ambos deben estar implementados juntos en este OPS.
- **El gate en `register_domain_route53` es retroactivo:** aplica incluso si OpenClaw o el operador no llamaron `suggest_safe_domain` antes. Eso evita que se repita el caso `delivrix-notify.com`.
- **NO bypass el gate "porque es urgente".** Si Juanes necesita registrar un dominio con prefijo flag-spam por una razón concreta, abrir nueva skill `register_domain_route53_emergency_override` con doble firma. NO debilitar el gate.
- **Si Spamhaus DBL timeout** (resolver lento), retornar `spamhausDBL: "error"` y NO bloquear al candidato. Pero loggear el error para debug.
- **La skill es invocable HOY mismo via curl** — no esperar Fase 1 tool calling. El frontend Canvas Live puede agregar un botón "Sugerir dominios" que llame este endpoint directo.
- **Reportar a PM Claude** al terminar implementación + tests + smoke manual.

— Claude PM
