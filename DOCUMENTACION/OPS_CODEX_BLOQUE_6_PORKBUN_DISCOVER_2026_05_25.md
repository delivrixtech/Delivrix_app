# OPS Codex Bloque 6 — Porkbun Domains Fase 1 (discover/propose)

**Fecha:** 2026-05-25
**Worktree:** `/Users/juanescanar/Documents/delivrix app`
**Branch base:** `main` (HEAD post-Bloque 5 con Route53)
**Filosofía:** discover/propose **sin compra real**. Fase 2 (compra) queda detrás de doble aprobación + audit critical, igual que Route53.

## Contexto

Tras conectar AWS Route53 Domains en Bloque 5, validamos que el .com cuesta 15 USD y el .co 38 USD. Esos precios son altos para escalar el sender pool de Delivrix (10-30 dominios warmup). Porkbun es 33% más barato (.com ~$10, .co ~$26) y tiene API REST completa con sandbox. Patrón multi-registrar consistente con el multi-provider de hosting (Webdock × 3, AWS, IONOS).

OpenClaw podrá comparar precios entre Route53 y Porkbun en la fase de propuesta, y eventualmente la Fase 2 de compra ejecutará en el registrador más barato (o el que el operador elija).

## Tareas

### T1 — Cuenta Porkbun + API keys

**Juanes hace la cuenta** (no Codex — requiere método de pago aunque no se use para esta fase).

Pasos manuales en Porkbun:
1. Crear cuenta en `porkbun.com`.
2. Habilitar API en `porkbun.com/account/api`.
3. Generar `API key` + `Secret API key`. Stash en `~/.porkbun-secrets/delivrix-keys.txt` con `chmod 600`.
4. Habilitar API access en cada dominio que se vaya a gestionar (por ahora ninguno propio).

API base URL: `https://api.porkbun.com/api/json/v3/`

**Ping de validación:**
```bash
curl -X POST https://api.porkbun.com/api/json/v3/ping \
  -H "Content-Type: application/json" \
  -d '{"apikey":"pk1_...","secretapikey":"sk1_..."}'
# Esperado: {"status":"SUCCESS","yourIp":"x.x.x.x"}
```

### T2 — Adapter Porkbun

Nuevo archivo `packages/adapters/src/porkbun-adapter.ts`:

```typescript
export interface PorkbunDomainAvailability {
  domain: string;
  available: boolean;
  premium: boolean;
  firstYearPromo: boolean;
  regularPrice: number | null;
  premiumPrice: number | null;
  currency: string;
  checkedAt: string;
}

export interface PorkbunDomainSuggestion {
  domain: string;
  available: boolean;
  price: number | null;
}

export interface PorkbunPrice {
  tld: string;
  registrationPrice: number;
  renewalPrice: number;
  transferPrice: number;
  currency: string;
}

export interface PorkbunOwnedDomain {
  domain: string;
  status: string;
  tld: string;
  createDate: string;
  expireDate: string;
  autoRenew: boolean;
  whoisPrivacy: boolean;
}

export class PorkbunAdapter {
  constructor(opts: {
    apiKey?: string;        // env PORKBUN_API_KEY
    secretApiKey?: string;  // env PORKBUN_SECRET_API_KEY
    baseUrl?: string;       // default https://api.porkbun.com/api/json/v3
    cacheTtlMs?: number;    // default 5min
  });

  checkAvailability(domain: string): Promise<PorkbunDomainAvailability>;
  getSuggestions(seed: string, opts?: { count?: number }): Promise<PorkbunDomainSuggestion[]>;
  listPrices(tlds?: string[]): Promise<PorkbunPrice[]>;
  listOwnedDomains(): Promise<PorkbunOwnedDomain[]>;
  ping(): Promise<{ ok: boolean; ip: string }>;
}
```

**Notas Porkbun API:**
- Auth en cada request via body JSON: `{ apikey, secretapikey, ...rest }`. NO header.
- Method siempre POST (sí, incluso para reads). Esto NO viola el read-only boundary del gateway porque el gateway expone GETs hacia el panel y por dentro hace POST a Porkbun.
- Rate limit: 10 req/s sostenido. Cachear precios 5min, owned 1min.
- `/pricing/get` devuelve precios de TODOS los TLDs en un solo call (no acepta filtros). Filtrar lado adapter.
- `/domain/checkDomain/{domain}` — un dominio por call.
- `/domain/listAll` — paginado, page 0, batch 500.
- Suggestions: Porkbun NO tiene endpoint nativo de suggestions. Para mantener la API igual que Route53, el adapter genera sufijos heurísticos (seed + ["mail", "send", "dx", "io", "co", "app"]) y los pasa por `checkDomain` en paralelo. Documenta en JSDoc que es heurística, no LLM-driven.

### T3 — Endpoints gateway

Agregar al `apps/gateway-api/src/routes/domains-porkbun.ts` (nuevo archivo) y registrar en `apps/gateway-api/src/main.ts`:

| Método | Endpoint | Query | Response |
|---|---|---|---|
| GET | `/v1/domains/porkbun/availability?name=delivrix-mail.com` | — | `{ domain, available, premium, regularPrice, currency, checkedAt, source }` |
| GET | `/v1/domains/porkbun/suggestions?seed=delivrix&count=10` | — | `{ suggestions: [{ domain, available, price }], source }` |
| GET | `/v1/domains/porkbun/prices?tlds=com,net,io,co` | — | `{ prices: [{ tld, registrationPrice, renewalPrice, transferPrice, currency }], source }` |
| GET | `/v1/domains/porkbun/owned` | — | `{ domains: [{ domain, expireDate, autoRenew }], source }` |
| GET | `/v1/domains/porkbun/ping` | — | `{ ok, ip, source }` |

Todos GET-only. Audit event `oc.domains.porkbun.discover` SOLO cuando viene de OpenClaw skill (header `x-openclaw-skill-invocation: delivrix-domains-discover`). Polls del panel NO audit, igual que Route53.

### T4 — Contract types en domain

Crear `packages/domain/src/domains-porkbun.ts` con los 4 interfaces de respuesta + helper `buildPorkbunResponse`. Mantener la convención `source: { kind: "live" | "mock"; trusted: boolean }` igual que el Bloque 5.

### T5 — Adaptar `/v1/infrastructure/inventory`

Agregar Porkbun como `provider` adicional en el inventario unificado (Hito 5.12):

```json
{
  "id": "porkbun",
  "displayName": "Porkbun",
  "kind": "domain-registrar",
  "status": "active",
  "itemCount": 0,
  "fetchSourceKind": "live",
  "capabilities": ["discover", "propose"]
}
```

Cuando llegue Fase 2 se agrega `"register"` y `"transfer"` a capabilities.

### T6 — Tests

`apps/gateway-api/src/routes/domains-porkbun.test.ts` cubriendo:
- 200 con domain disponible (mock adapter).
- 200 con suggestions vacías cuando seed inválido.
- 200 con prices de 3 TLDs.
- Cache hit no llama al SDK (verificar con spy).
- 422 cuando query `name` falta.
- Audit chain NO se contamina con polls panel (sin header).
- Comparativa: si misma query a Route53 + Porkbun devuelve precios distintos, el endpoint comparativo `/v1/domains/compare?name=foo.com` devuelve ambos.

### T7 — Endpoint comparativo (bonus)

Nuevo `GET /v1/domains/compare?name=foo.com`:

```json
{
  "domain": "foo.com",
  "providers": [
    {
      "id": "aws-route53",
      "available": "AVAILABLE",
      "registrationPrice": 15.00,
      "renewalPrice": 15.00,
      "currency": "USD"
    },
    {
      "id": "porkbun",
      "available": true,
      "registrationPrice": 10.07,
      "renewalPrice": 10.07,
      "currency": "USD"
    }
  ],
  "recommendation": "porkbun",
  "savingsPercent": 33,
  "source": { "kind": "live", "trusted": true }
}
```

OpenClaw usa este endpoint para sus propuestas: "te recomiendo comprar X en Porkbun, ahorras 33% vs Route53". Operador aprueba.

### T8 — Env vars

Documentar en `.env.example`:

```bash
# Porkbun Domains — Fase 1 discover/propose (NO compra)
PORKBUN_API_KEY=<from ~/.porkbun-secrets/delivrix-keys.txt>
PORKBUN_SECRET_API_KEY=<from ~/.porkbun-secrets/delivrix-keys.txt>
PORKBUN_BASE_URL=https://api.porkbun.com/api/json/v3
PORKBUN_CACHE_TTL_MS=300000
PORKBUN_ENABLE_PURCHASE=false  # Fase 2
```

## Fase 2 (FUTURA, no en este OPS)

Cuando habilitemos compra:
- `POST /v1/domains/porkbun/register` con body `{ domain, years, autoRenew, contact }`.
- Doble aprobación (regla 2 personas) + audit critical.
- Skill OpenClaw `delivrix-domains-register-porkbun` con gate `requires_human_approval`.
- BudgetAction para cap mensual de compras combinado entre Route53 + Porkbun.
- Comparación automática: OpenClaw siempre propone el más barato a menos que el operador especifique provider.

## Done criteria Fase 1

- `npm test` 235+ tests verdes (10 nuevos para Porkbun).
- 5 endpoints respondiendo con mocks + integración real.
- `curl http://127.0.0.1:3000/v1/domains/porkbun/ping` → JSON real con tu IP.
- `curl 'http://127.0.0.1:3000/v1/domains/compare?name=delivrix-test.com'` → comparativa Route53 + Porkbun.
- Audit chain íntegro tras polls de 5min (igual #21 webdock, igual Bloque 5 Route53).
- Doc `OPS_CODEX_BLOQUE_6_RESULT_2026_05_25.md` con SHAs + smoke curls + tabla comparativa de precios.

## Coordinación con Claude

Claude trabaja en frontend si surge. Codex toca SOLO:
- `packages/adapters/src/porkbun-adapter.ts`
- `packages/domain/src/domains-porkbun.ts`
- `apps/gateway-api/src/routes/domains-porkbun.ts` + tests
- `apps/gateway-api/src/routes/domains-compare.ts` + tests
- `apps/gateway-api/src/main.ts` (router)
- `apps/gateway-api/src/services/infrastructure-inventory.ts` (agregar Porkbun como provider)
- `.env.example`

Claude NO toca esos archivos hasta que Codex pushee. Cuando Codex termine, Claude puede extender el feature Dominios del panel (`apps/admin-panel/src/features/domains/index.tsx`) para mostrar precios comparativos Route53 vs Porkbun en el SearchHero — eso queda como follow-up tras este OPS.

## Bloqueo previo

T1 está bloqueado por Juanes (crear cuenta Porkbun + API keys + stash secrets). Codex puede empezar T2-T8 con mocks mientras llegan las keys reales, y validar live al final. El adapter ya con tests passing es entregable parcial OK.
