# OPS Codex Bloque 10 Result — Demo viernes 29 may

**Fecha:** 2026-05-26  
**Alcance cerrado por Codex:** primera capa segura para demo real: memoria persistente OpenClaw + compra Route53 con compuertas duras.

## Implementado

### T7B — Memoria persistente OpenClaw

Se agregó `OpenClawWorkspace` en `apps/gateway-api/src/openclaw-workspace.ts`.

Directorio por defecto en Linux/Hostinger:

```text
/data/.openclaw/workspace/
```

En macOS local usa `runtime/openclaw-workspace/` para evitar depender de permisos de `/data`.

Soporta:

- `skills/*.v1.md`
- `executions/YYYY-MM-DD/*-{success|blocked|failed}.md`
- `learnings/*.md`
- `inventory/*.json`

Cada ejecución del endpoint de compra Route53 escribe un execution record sin secretos ni datos de contacto.

### T1 — Route53 register domain

Se extendió `AwsRoute53DomainsAdapter` con:

- `isPurchaseEnabled()`
- `registerDomain({ domain, years, autoRenew, adminContact, privacyProtection })`

Nuevo endpoint:

```http
POST /v1/domains/route53/register
```

Body:

```json
{
  "domain": "delivrix-mail.com",
  "years": 1,
  "autoRenew": false,
  "actorId": "operator/juanes",
  "approvalToken": "exec-..."
}
```

Gates obligatorios antes de comprar:

- Credenciales AWS Route53 live presentes.
- `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true`.
- `AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD` configurado.
- `DELIVRIX_ADMIN_CONTACT_JSON` válido.
- Audit chain contiene `oc.artifact.approved` reciente con `metadata.executionId == approvalToken`.
- Canvas artifact asociado sigue `approved`.
- Precio de registro disponible vía Route53.
- Costo del mes + costo nuevo no supera el cap.

Si falta algo, responde `409 status=blocked`, escribe workspace execution y emite audit:

```text
oc.domain.register_blocked
```

Si pasa todo y AWS acepta, llama `RegisterDomain`, actualiza `inventory/domains.json` y emite audit crítico:

```text
oc.domain.registered
```

### T2 — Route53 hosted zone + DNS upsert

Se agregó `AwsRoute53DnsAdapter` en `packages/adapters/src/aws-route53-dns-adapter.ts`.

Soporta:

- `createHostedZone(domain)`
- `upsertRecord(zoneId, { name, type, ttl, values })`
- `deleteRecord(zoneId, record)`

Nuevo endpoint:

```http
POST /v1/domains/route53/dns/upsert
```

Body:

```json
{
  "domain": "delivrix-mail.com",
  "records": [
    { "name": "@", "type": "TXT", "ttl": 300, "values": ["v=spf1 ip4:192.0.2.10 -all"] },
    { "name": "mail", "type": "A", "ttl": 300, "values": ["192.0.2.10"] }
  ],
  "actorId": "operator/juanes",
  "approvalToken": "exec-...",
  "taskId": "optional-canvas-task"
}
```

Gates obligatorios antes de escribir DNS:

- Credenciales AWS Route53 live presentes.
- `AWS_ROUTE53_DNS_ENABLE_WRITES=true`.
- Audit chain contiene `oc.artifact.approved` reciente con `metadata.executionId == approvalToken`.
- Canvas artifact asociado sigue `approved`.

La skill lee `workspace/learnings/`, escribe execution record, actualiza `inventory/domains.json#dnsZones`, emite `oc.action.now` al Canvas Live para lectura de learnings, llamadas API, escritura de workspace y audit, y emite:

```text
oc.dns.records_updated
```

## Seguridad

- No se ejecutó ninguna compra real.
- No se editaron credenciales ni `.env.local`.
- El contacto administrativo no se escribe en audit ni workspace.
- El endpoint no acepta solo UI state: exige audit chain reciente.
- La compra y las mutaciones DNS quedan deshabilitadas por defecto hasta activar env + IAM + aprobación.

## Verificación

```bash
node --test packages/adapters/src/aws-route53-domains-adapter.test.ts apps/gateway-api/src/openclaw-workspace.test.ts apps/gateway-api/src/routes/domains-purchase.test.ts
node --test packages/adapters/src/aws-route53-dns-adapter.test.ts apps/gateway-api/src/routes/domains-dns.test.ts
npm test
git diff --check
```

Resultado:

- T1/T7B focus tests: 13 passed.
- T2 focus tests: 6 passed.
- Full suite after T2: 316 passed.
- Diff check: OK.

## Pendiente para demo real

- T2 Route53 hosted zone + DNS upsert.
- T3 SPF/DKIM/DMARC skill.
- T4 Webdock create server con key write.
- T5 SSH provisioning Postfix/OpenDKIM/TLS.
- T6 bind domain to server.
- T7 warmup seed.
- T7C supervisor batch multi-agent.
- T8 flow end-to-end async con eventos Canvas Live por fase.

Bloqueantes externos:

- `DELIVRIX_ADMIN_CONTACT_JSON`.
- IAM con `route53domains:RegisterDomain`.
- Definir y activar `AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD`.
- Confirmar compra real habilitada solo para la demo.
- Webdock API key write y desbloqueo de port 25.
- Seed inboxes para warmup.
