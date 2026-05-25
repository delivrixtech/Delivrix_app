# OPS Codex Bloque 5 — AWS Route53 Domains Fase 1 (discover/propose)

**Fecha:** 2026-05-25
**Worktree:** `/Users/juanescanar/Documents/delivrix app`
**Branch base:** `main` (HEAD `abb1a01` post-mega-sprint)
**Filosofía:** discover/propose **sin compra real**. La fase 2 (compra) requiere doble aprobación y se documenta en OPS separado.

## Contexto

Delivrix necesita registrar dominios para los nodos de envío. Hito 5.12 ya tiene AWS Bedrock conectado (cuenta `397450413307`, IAM user `delivrix-openclaw-prod`). Vamos a sumar Route53 Domains a la misma cuenta AWS con un usuario IAM **separado**, **acotado**, y **sin permisos de write/compra** en esta fase.

## Tareas

### T1 — IAM user dedicado `delivrix-route53-discover`

**No reusar `delivrix-openclaw-prod`** — separación de responsabilidades + blast radius reducido.

Crear via AWS CLI (Codex con awscli en `.venv-awscli/`):

```bash
aws iam create-user --user-name delivrix-route53-discover
aws iam create-access-key --user-name delivrix-route53-discover
# Stash en ~/.aws-secrets/delivrix-route53-keys.txt con chmod 600
```

Policy custom `DelivrixRoute53DiscoverPolicy` con SOLO read:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Route53DomainsDiscover",
      "Effect": "Allow",
      "Action": [
        "route53domains:CheckDomainAvailability",
        "route53domains:GetDomainSuggestions",
        "route53domains:ListPrices",
        "route53domains:ListDomains",
        "route53domains:GetOperationDetail"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Route53HostedZonesRead",
      "Effect": "Allow",
      "Action": [
        "route53:ListHostedZones",
        "route53:GetHostedZone",
        "route53:ListResourceRecordSets"
      ],
      "Resource": "*"
    }
  ]
}
```

**NO incluir** en esta fase:
- `route53domains:RegisterDomain` (compra real)
- `route53:CreateHostedZone` (escritura)
- `route53:ChangeResourceRecordSets` (escritura)

### T2 — Adapter Route53 Domains

Nuevo archivo `packages/adapters/src/aws-route53-domains-adapter.ts`:

```typescript
export interface Route53DomainAvailability {
  domain: string;
  available: "AVAILABLE" | "UNAVAILABLE" | "RESERVED" | "DONT_KNOW";
  checkedAt: string;
}

export interface Route53DomainSuggestion {
  domain: string;
  availability: "AVAILABLE" | "UNAVAILABLE" | "RESERVED" | "DONT_KNOW";
}

export interface Route53Price {
  tld: string;
  registrationPrice: number;
  renewalPrice: number;
  currency: string;
}

export class AwsRoute53DomainsAdapter {
  constructor(opts: {
    region?: string;       // default us-east-1
    accessKeyId?: string;  // env AWS_ROUTE53_ACCESS_KEY_ID
    secretAccessKey?: string;
    cacheTtlMs?: number;   // default 5min
  });

  checkAvailability(domain: string): Promise<Route53DomainAvailability>;
  getSuggestions(seed: string, opts?: { onlyAvailable?: boolean; count?: number }): Promise<Route53DomainSuggestion[]>;
  listPrices(tlds: string[]): Promise<Route53Price[]>;
  listOwnedDomains(): Promise<{ domain: string; expiry: string }[]>;
}
```

Cache TTL 5min para no quemar rate limit Route53 (50 RPS hard limit).

### T3 — Endpoints gateway

Agregar al `apps/gateway-api/src/main.ts`:

| Método | Endpoint | Body / query | Response |
|---|---|---|---|
| GET | `/v1/domains/availability?name=delivrix-mail.com` | — | `{ domain, available, checkedAt }` |
| GET | `/v1/domains/suggestions?seed=delivrix&count=10` | — | `{ suggestions: [{ domain, availability }] }` |
| GET | `/v1/domains/prices?tlds=com,net,io` | — | `{ prices: [{ tld, registration, renewal, currency }] }` |
| GET | `/v1/domains/owned` | — | `{ domains: [{ domain, expiry }] }` |

Todos GET-only (compatibles con el read-only proxy boundary del panel).

Audit event `oc.domains.discover` SOLO cuando viene de OpenClaw skill (header `x-openclaw-skill-invocation: delivrix-domains-discover`). Polls normales del panel NO audit (mismo patrón que webdock inventory fix #21).

### T4 — Contract types en domain

Crear `packages/domain/src/domains-discover.ts` con los 4 interfaces de respuesta + helper `buildDomainDiscoverResponse`.

### T5 — Tests

`apps/gateway-api/src/routes/domains.test.ts` cubriendo:
- 200 con domain disponible (mock adapter).
- 200 con suggestions vacías cuando seed inválido.
- 200 con prices de 3 TLDs.
- Cache hit no llama al SDK (verificar con spy).
- 422 cuando query `name` falta.
- Audit chain NO se contamina con polls panel (sin header).

### T6 — Env vars

Documentar en `.env.example`:

```bash
# AWS Route53 Domains — Fase 1 discover/propose (NO compra)
AWS_ROUTE53_REGION=us-east-1
AWS_ROUTE53_ACCESS_KEY_ID=<from ~/.aws-secrets/delivrix-route53-keys.txt>
AWS_ROUTE53_SECRET_ACCESS_KEY=<from ~/.aws-secrets/delivrix-route53-keys.txt>
AWS_ROUTE53_CACHE_TTL_MS=300000
```

## Fase 2 (FUTURA, no en este OPS)

Cuando habilitemos compra:
- POST `/v1/domains/register` con body `{ domain, autoRenew, contact }`.
- Doble aprobación (regla 2 personas) + audit critical.
- Skill OpenClaw `delivrix-domains-register` con gate `requires_human_approval`.
- BudgetAction AWS para cap mensual de compras.

## Done criteria Fase 1

- `npm test` 230+ tests verdes.
- 4 endpoints respondiendo con mocks + integración real.
- `curl http://127.0.0.1:3000/v1/domains/availability?name=delivrix-test-1234.com` → JSON real.
- Audit chain íntegro tras polls de 5min (igual #21 webdock).
- Doc `OPS_CODEX_BLOQUE_5_RESULT_2026_05_25.md` con SHAs + smoke curls.

## Coordinación con Claude

Claude trabaja en frontend si surge. Codex toca SOLO:
- `packages/adapters/src/aws-route53-domains-adapter.ts`
- `packages/domain/src/domains-discover.ts`
- `apps/gateway-api/src/routes/domains.ts` + tests
- `apps/gateway-api/src/main.ts` (router)
- `.env.example`
- IAM AWS

Claude NO toca esos archivos hasta que Codex pushee.
