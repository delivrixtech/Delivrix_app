# OPS AWS Route 53 Domains discovery · 2026-05-25

## Decisión

Se habilita fase 1 para AWS Route 53 Domains en modo discovery-only:

- Buscar disponibilidad de dominios.
- Consultar sugerencias.
- Consultar precios.
- Listar dominios ya registrados en AWS.
- Generar propuesta para OpenClaw.

No se habilita compra real todavía. `RegisterDomain`, `CreateHostedZone` y `ChangeResourceRecordSets` quedan fuera del policy inicial y bloqueados por diseño.

## Backend

Nuevo adapter:

- `packages/adapters/src/aws-route53-domains-adapter.ts`

Nuevo endpoint:

```http
GET /v1/infrastructure/domain-discovery?name=delivrix&tlds=com,net,app&suggestions=5
```

Endpoints compactos para el panel/OpenClaw:

```http
GET /v1/domains/availability?name=delivrix-mail.com
GET /v1/domains/suggestions?seed=delivrix&count=10
GET /v1/domains/prices?tlds=com,net,io
GET /v1/domains/owned
```

Respuesta:

- `summary.mode: "discovery_only"`
- `candidates[]`: disponibilidad y precio por dominio candidato.
- `suggestions[]`: alternativas disponibles.
- `proposal`: acciones permitidas, acciones bloqueadas y aprobaciones requeridas.

Los endpoints solo auditan cuando vienen con header explícito OpenClaw:

```http
X-OpenClaw-Skill-Invocation: aws-domain-discovery
X-OpenClaw-Skill-Invocation: delivrix-domains-discover
```

Acciones audit:

```text
oc.aws.route53domains.discovery
oc.domains.discover
```

## Inventory

`GET /v1/infrastructure/inventory` agrega provider:

```text
aws-route53-domains
```

Capabilities:

- `list_registered_domains`
- `check_domain_availability`
- `get_domain_suggestions`
- `list_domain_prices`
- `draft_domain_purchase_proposal`

Si `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true`, el provider declara además:

- `register_domain_requires_approval`

Ese flag no ejecuta compras por sí solo. Solo habilita capabilities para la fase futura con runbook y doble aprobación.

## IAM discovery-only

Policy:

```text
ops/aws-route53-domain-discovery-policy.json
```

Script:

```bash
ops/aws-route53-domain-discovery-setup.sh --profile <admin-profile>
```

El script crea:

- IAM policy `DelivrixRoute53DiscoverPolicy`
- IAM user `delivrix-route53-discover`
- Access key guardada solo en:

```text
~/.aws-secrets/delivrix-route53-keys.txt
```

Nunca imprime `AWS_SECRET_ACCESS_KEY`.

## Variables runtime

```env
AWS_ROUTE53_ACCESS_KEY_ID=<set>
AWS_ROUTE53_SECRET_ACCESS_KEY=<set>
AWS_ROUTE53_REGION=us-east-1
AWS_ROUTE53_CACHE_TTL_MS=300000
AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=false
```

Fallbacks soportados:

- `AWS_ROUTE53_DOMAINS_ACCESS_KEY_ID`
- `AWS_ROUTE53_DOMAINS_SECRET_ACCESS_KEY`
- `AWS_ROUTE53_DOMAINS_SESSION_TOKEN`
- `AWS_ROUTE53_DOMAINS_REGION`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`
- `AWS_REGION`

## Próxima fase

Para compra real se necesita un runbook separado:

- doble aprobación;
- budget cap por compra;
- allowlist de TLDs;
- contacto registrante validado;
- confirmación de no reembolso;
- hosted zone plan;
- rollback/compensación documentada;
- kill switch activo.

Solo después se debe agregar `RegisterDomain`, `CreateHostedZone` y `ChangeResourceRecordSets`.

## Fuentes oficiales

- `https://docs.aws.amazon.com/Route53/latest/APIReference/API_Operations_Amazon_Route_53_Domains.html`
- `https://docs.aws.amazon.com/Route53/latest/APIReference/API_domains_CheckDomainAvailability.html`
- `https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html`
