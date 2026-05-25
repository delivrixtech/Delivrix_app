# OPS Codex Bloque 5 Result — AWS Route53 Domains Fase 1

**Fecha:** 2026-05-25  
**Commit implementación:** b0acd02  
**Modo:** discover/propose, sin compra real

## Resultado

Implementado backend discovery-only para AWS Route 53 Domains:

- Adapter SigV4 sin dependencia externa: `packages/adapters/src/aws-route53-domains-adapter.ts`.
- Contract types: `packages/domain/src/domains-discover.ts`.
- Endpoints gateway:
  - `GET /v1/domains/availability?name=delivrix-mail.com`
  - `GET /v1/domains/suggestions?seed=delivrix&count=10`
  - `GET /v1/domains/prices?tlds=com,net,io`
  - `GET /v1/domains/owned`
  - `GET /v1/infrastructure/domain-discovery?name=delivrix&tlds=com,net,app&suggestions=5`
- Inventory ahora expone provider `aws-route53-domains` con capabilities de búsqueda, sugerencias, precios y propuesta.
- Read boundary del panel permite solo GET para los endpoints nuevos.

## Seguridad

- No se habilitó `route53domains:RegisterDomain`.
- No se habilitó `route53:CreateHostedZone`.
- No se habilitó `route53:ChangeResourceRecordSets`.
- El policy discovery-only deja denies explícitos para compra/mutación.
- Audit `oc.domains.discover` solo se emite con header `x-openclaw-skill-invocation: delivrix-domains-discover`.
- Polls del panel sin header no contaminan la audit chain.

## IAM

Agregado script:

```bash
ops/aws-route53-domain-discovery-setup.sh --profile <admin-profile>
```

Crea:

- IAM user `delivrix-route53-discover`.
- IAM policy `DelivrixRoute53DiscoverPolicy`.
- Secret file local `~/.aws-secrets/delivrix-route53-keys.txt` con chmod restrictivo.

No se pudo ejecutar contra AWS porque la máquina local no tiene credenciales AWS activas:

```text
Unable to locate credentials.
```

## Smoke local

Gateway reiniciado con `.env.local`:

- `http://127.0.0.1:3000`
- PID `94359`

Vite reiniciado:

- `http://127.0.0.1:5173`
- PID listener `94421`

Sin credenciales AWS Route53, los endpoints responden en `source.kind: "mock"`:

```bash
curl -fsS 'http://127.0.0.1:3000/v1/domains/availability?name=delivrix-test-1234.com'
curl -fsS 'http://127.0.0.1:3000/v1/domains/suggestions?seed=delivrix&count=10'
curl -fsS 'http://127.0.0.1:3000/v1/domains/prices?tlds=com,net,io'
curl -fsS 'http://127.0.0.1:3000/v1/domains/owned'
curl -fsS 'http://127.0.0.1:5173/v1/domains/availability?name=delivrix-test-1234.com'
```

Inventory verificado:

- `webdock-primary`: active, 4 items, live.
- `aws-route53-domains`: planned, 0 items, mock.
- `ionos-domains`: active, 16 items, live.

Audit chain sin pollution por polls GET:

```text
before: 227 .audit/audit-events.jsonl
after:  227 .audit/audit-events.jsonl
```

## Tests

```text
node --test packages/adapters/src/aws-route53-domains-adapter.test.ts apps/gateway-api/src/routes/aws-domain-discovery.test.ts apps/gateway-api/src/routes/domains.test.ts apps/gateway-api/src/routes/infrastructure.test.ts apps/admin-panel/src/shared/api/client.test.ts
30/30 pass

npm test
251/251 pass

npm run test:admin
22/22 pass + vite build OK
```

## Fuentes oficiales

- https://docs.aws.amazon.com/Route53/latest/APIReference/API_Operations_Amazon_Route_53_Domains.html
- https://docs.aws.amazon.com/Route53/latest/APIReference/API_domains_CheckDomainAvailability.html
- https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html
