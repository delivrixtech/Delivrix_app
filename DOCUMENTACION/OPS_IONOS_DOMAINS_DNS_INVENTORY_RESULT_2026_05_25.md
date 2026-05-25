# OPS IONOS Domains + DNS inventory result · 2026-05-25

## Resultado

`GET /v1/infrastructure/inventory` ahora expone IONOS en dos providers:

- `ionos-cloud-dns` (`kind: "dns"`): zonas y records DNS.
- `ionos-domains` (`kind: "domain-registrar"`): dominios, estados y nameservers.

La integración es read-only. OpenClaw puede leer el inventario completo y proponer cambios, pero no puede mutar DNS, nameservers, transfer locks, DNSSEC ni auth codes sin un runbook aprobado, audit log, kill switch y rollback explícito.

## Credenciales soportadas

### IONOS Hosting DNS API

- Env: `IONOS_DNS_API_KEY` o fallback `IONOS_DOMAINS_API_KEY`, `IONOS_HOSTING_API_KEY`, `IONOS_DEVELOPER_API_KEY`.
- Auth: header `X-API-Key`.
- Base: `https://api.hosting.ionos.com/dns`.
- Endpoints usados:
  - `GET /v1/zones`
  - `GET /v1/zones/{zoneId}`

### IONOS Cloud DNS API

- Env: `IONOS_CLOUD_DNS_TOKEN` o `IONOS_API_TOKEN`.
- Auth: `Authorization: Bearer <token>`.
- Base: `https://dns.de-fra.ionos.com`.
- Endpoints usados:
  - `GET /zones?limit=1000`
  - `GET /zones/{zoneId}/records?limit=1000`

### IONOS Domains API

- Env: `IONOS_DOMAINS_API_KEY` y `IONOS_DOMAINS_TENANT_ID`.
- Fallback key env: `IONOS_HOSTING_API_KEY` o `IONOS_DEVELOPER_API_KEY`.
- Fallback tenant env: `IONOS_TENANT_ID`.
- Auth: headers `X-Api-Key` y `X-Tenant-Id`.
- Base: `https://api.hosting.ionos.com/domains`.
- Endpoints usados:
  - `GET /v1/domainitems`
  - `GET /v1/domainitems/{domainId}/nameservers`

## Redacción de datos sensibles

- TXT records se exponen como `contentPreview: "[redacted-txt:<length>]"`.
- No se leen ni se exponen contactos.
- No se leen ni se exponen auth codes.
- Nameservers muestran hostname y conteo de IPs asociadas, no datos de contacto.

## Smoke local

Comando:

```bash
curl -fsS http://127.0.0.1:3000/v1/infrastructure/inventory | jq '{providerCount:(.providers|length), providers:(.providers|map({id,status,itemCount,fetchSourceKind,errorReason}))}'
```

Resultado del 2026-05-25:

- `providerCount: 5`
- `webdock-primary`: `active`, `itemCount: 4`, `fetchSourceKind: "live"`
- `aws-bedrock-us-east-1`: `active`, `itemCount: 1`, `fetchSourceKind: "live"`
- `ionos-cloud-dns`: `planned`, `itemCount: 0`, `fetchSourceKind: "mock"` porque no hay credenciales IONOS locales aún.
- `ionos-domains`: `planned`, `itemCount: 0`, `fetchSourceKind: "mock"` porque no hay credenciales IONOS locales aún.
- `physical-medellin`: `planned`

Tres polls sin header OpenClaw dejaron `.audit/audit-events.jsonl` estable en 222 líneas.

## Verificación

- `node --test packages/adapters/src/ionos-dns-adapter.test.ts packages/adapters/src/ionos-domains-adapter.test.ts apps/gateway-api/src/routes/infrastructure.test.ts`: 18 tests OK.
- `npm test`: 234 tests OK.

## Fuentes oficiales verificadas

- IONOS Cloud DNS API: `https://api.ionos.com/docs/dns/v1/`
- IONOS Developer DNS API: `https://developer.hosting.ionos.com/docs/dns`
- IONOS Developer Domains API: `https://developer.hosting.ionos.com/docs/domains`
