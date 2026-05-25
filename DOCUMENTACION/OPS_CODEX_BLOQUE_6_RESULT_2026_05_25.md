# OPS Codex Bloque 6 Result - Porkbun Discover/Propose

Fecha: 2026-05-25

## Estado

Cerrado en modo mock-safe. La integración live queda bloqueada hasta que existan `PORKBUN_API_KEY` y `PORKBUN_SECRET_API_KEY` en `.env.local`.

## Implementado

- Adapter Porkbun en `packages/adapters/src/porkbun-adapter.ts`.
- Contratos de dominio Porkbun y comparativa en `packages/domain/src/domains-porkbun.ts`.
- Gateway GET:
  - `/v1/domains/porkbun/ping`
  - `/v1/domains/porkbun/availability?name=example.com`
  - `/v1/domains/porkbun/suggestions?seed=delivrix&count=10`
  - `/v1/domains/porkbun/prices?tlds=com,net,io`
  - `/v1/domains/porkbun/owned`
  - `/v1/domains/compare?name=example.com`
- Provider `porkbun-domains` agregado a `/v1/infrastructure/inventory`.
- Auditoría `oc.domains.porkbun.discover` solo con header:
  - `x-openclaw-skill-invocation: delivrix-domains-discover`
- `.env.example` documenta las vars Porkbun y deja `PORKBUN_ENABLE_PURCHASE=false`.

## Seguridad

- No se implementó compra real.
- No se loguean API keys ni secret keys.
- `PORKBUN_ENABLE_PURCHASE=false` queda como default.
- Sugerencias live limitan checks de disponibilidad para respetar el rate-limit documentado por Porkbun; el resto se marca como `DONT_KNOW` con precios cuando estén disponibles.

## Validación

Tests:

```bash
node --test packages/adapters/src/porkbun-adapter.test.ts apps/gateway-api/src/routes/domains-porkbun.test.ts apps/gateway-api/src/routes/domains-compare.test.ts apps/gateway-api/src/routes/infrastructure.test.ts
npm test
```

Resultado:

- Tests focalizados: 27 pass.
- Suite completa: 268 pass.

Curls locales con gateway levantado en `127.0.0.1:3000`:

- `/v1/domains/porkbun/ping` -> 200, source `mock`, `purchaseEnabled=false`.
- `/v1/domains/porkbun/availability?name=delivrix-mail.com` -> 200, `DONT_KNOW`, source `mock`.
- `/v1/domains/porkbun/suggestions?seed=delivrix&count=5` -> 200, 5 sugerencias, source `mock`.
- `/v1/domains/porkbun/prices?tlds=com,net,io` -> 200, 0 precios, source `mock`.
- `/v1/domains/porkbun/owned` -> 200, 0 dominios, source `mock`.
- `/v1/domains/compare?name=delivrix-mail.com` -> 200, compara Route53 live + Porkbun mock.
- `/v1/infrastructure/inventory` -> 200, `providerCount=7`, `porkbun-domains` planned/mock.

Audit pollution:

- `.audit/audit-events.jsonl` se mantuvo en 250 líneas antes/después de 3 polls sin header a `/v1/infrastructure/inventory`.

## Pendiente Para Live

1. Crear credenciales Porkbun y agregarlas a `.env.local`:

```bash
PORKBUN_API_KEY=...
PORKBUN_SECRET_API_KEY=...
PORKBUN_BASE_URL=https://api.porkbun.com/api/json/v3
PORKBUN_CACHE_TTL_MS=300000
PORKBUN_ENABLE_PURCHASE=false
```

2. Reiniciar gateway con:

```bash
node --env-file=.env.local apps/gateway-api/src/main.ts
```

3. Repetir:

```bash
curl -fsS http://127.0.0.1:3000/v1/domains/porkbun/ping | jq .
curl -fsS "http://127.0.0.1:3000/v1/domains/porkbun/owned" | jq .
curl -fsS "http://127.0.0.1:3000/v1/infrastructure/inventory" | jq '.providers[] | select(.id=="porkbun-domains")'
```

## Fuentes

- Porkbun API documentation: https://porkbun.com/api/json/v3/documentation
- Porkbun API spec: https://porkbun.com/api/json/v3/spec
