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

### T3 — configure email auth

Nuevo endpoint:

```http
POST /v1/domains/auth/configure
```

Body:

```json
{
  "domain": "delivrix-mail.com",
  "mxServerIp": "192.0.2.10",
  "zoneId": "Z123456",
  "selector": "default",
  "actorId": "operator/juanes",
  "approvalToken": "exec-...",
  "taskId": "optional-canvas-task"
}
```

La skill genera:

- SPF: `v=spf1 ip4:<server-ip> -all`
- DKIM RSA 2048 con selector configurable.
- DMARC inicial en `p=none` para demo segura.

La private key DKIM se guarda solo en workspace:

```text
inventory/dkim-keys/<domain>/<selector>.private
```

El contenido de la key no se escribe en audit, response ni execution record. El endpoint hace upsert de los TXT vía Route53 y actualiza `inventory/domains.json#emailAuth`.

Gates obligatorios antes de escribir DNS/auth:

- Credenciales AWS Route53 live presentes.
- `AWS_ROUTE53_DNS_ENABLE_WRITES=true`.
- Audit chain contiene `oc.artifact.approved` reciente con `metadata.executionId == approvalToken`.
- Canvas artifact asociado sigue `approved`.
- `zoneId` explícito o zona ya registrada en workspace inventory.

Emite `oc.action.now` al Canvas Live para lectura de learnings, keygen, escritura de private key, llamadas API, escritura de execution record y audit. Al completar emite:

```text
oc.email_auth.configured
```

### T4 — provision_webdock_vps

Se extendió `WebdockRealAdapter` con:

- `createServer({ profile, locationId, hostname, imageSlug, publicKey, callbackUrl })`
- `getServer(slug)`

Nuevo endpoint:

```http
POST /v1/webdock/servers/create
```

Body:

```json
{
  "profile": "bit",
  "locationId": "dk",
  "hostname": "mail.delivrix-mail.com",
  "imageSlug": "ubuntu-2404",
  "publicKey": "ssh-ed25519 ...",
  "actorId": "operator/juanes",
  "approvalToken": "exec-...",
  "taskId": "optional-canvas-task"
}
```

Mapeo seguro para demo:

- `bit` -> `vps-xeon-essential-2025`
- `nibble` -> `webdockepyc-nibble-2`
- `byte` -> `webdockepyc-byte-2`
- `kilobyte` -> `webdockepyc-kilobyte-2`
- `ubuntu-2404` -> `ubuntu-24.04-lts`

Gates obligatorios antes de crear VPS:

- `WEBDOCK_API_KEY_OPS` live.
- `WEBDOCK_SERVERS_ENABLE_CREATE=true`.
- Audit chain contiene `oc.artifact.approved` reciente con `metadata.executionId == approvalToken`.
- Canvas artifact asociado sigue `approved`.
- Public key OpenSSH explícita o `WEBDOCK_OPERATOR_SSH_PUBLIC_KEY`.

Después del `POST /servers`, la skill hace polling con `GET /servers/{slug}` y emite `oc.action.now` por cada poll. El resultado se guarda en:

```text
inventory/webdock-servers.json
```

Se marca `port25UnlockRequired: true` porque Webdock puede bloquear SMTP saliente por defecto. La private key no se guarda; solo se registra fingerprint SHA-256 corto de la public key. Al completar emite:

```text
oc.webdock.server_created
```

### T5 — install_smtp_stack via SSH

Nuevo endpoint:

```http
POST /v1/servers/{serverSlug}/provision-smtp
```

Body:

```json
{
  "domain": "delivrix-mail.com",
  "serverIp": "192.0.2.44",
  "dkimPrivateKeyPath": "inventory/dkim-keys/delivrix-mail.com/default.private",
  "selector": "default",
  "actorId": "operator/juanes",
  "approvalToken": "exec-...",
  "taskId": "optional-canvas-task"
}
```

`serverIp` y `dkimPrivateKeyPath` pueden venir explícitos o resolverse desde workspace:

- `inventory/webdock-servers.json`
- `inventory/domains.json#emailAuth`

Gates obligatorios antes de ejecutar SSH:

- `SMTP_PROVISIONING_ENABLE_SSH=true`.
- Runner SSH configurado con `SMTP_PROVISION_SSH_KEY_PATH`.
- Audit chain contiene `oc.artifact.approved` reciente con `metadata.executionId == approvalToken`.
- Canvas artifact asociado sigue `approved`.
- IP de servidor disponible.
- Private key DKIM disponible en workspace.

La skill ejecuta un plan idempotente por SSH:

- espera `cloud-init`;
- instala `postfix`, `opendkim`, `opendkim-tools`, `certbot`;
- escribe `/etc/mailname`, `/etc/postfix/main.cf`, `/etc/opendkim.conf`;
- instala la private key DKIM por `stdin` con audit redacted;
- escribe `key.table`, `signing.table`, `trusted.hosts`;
- intenta certbot para `mail.<domain>` y deja `tlsStatus=attempted_or_pending_dns` si DNS aún no apunta;
- reinicia/activa `opendkim` y `postfix`;
- valida listener SMTP local.

Cada comando emite `oc.action.now kind=command`. El resultado se guarda en:

```text
inventory/smtp-provisioning.json
```

Al completar emite:

```text
oc.smtp.provisioned
```

### T6 — bind_domain_to_server

Nuevo endpoint:

```http
POST /v1/domains/bind
```

Body:

```json
{
  "domain": "delivrix-mail.com",
  "serverSlug": "mail-delivrix-test",
  "serverIp": "192.0.2.44",
  "zoneId": "Z123456",
  "actorId": "operator/juanes",
  "approvalToken": "exec-...",
  "taskId": "optional-canvas-task"
}
```

`serverIp` y `zoneId` pueden venir explícitos o resolverse desde workspace:

- `inventory/webdock-servers.json`
- `inventory/domains.json#dnsZones`

La skill publica:

- `A mail.<domain> -> <serverIp>`
- `MX @ -> 10 mail.<domain>.`

Gates obligatorios antes de escribir DNS:

- Credenciales AWS Route53 live presentes.
- `AWS_ROUTE53_DNS_ENABLE_WRITES=true`.
- Audit chain contiene `oc.artifact.approved` reciente con `metadata.executionId == approvalToken`.
- Canvas artifact asociado sigue `approved`.
- Zona Route53 disponible.
- IP del servidor disponible.

El resultado queda en `inventory/domains.json#bindings` con `status=pending_propagation`, porque la propagación DNS real puede tardar más que la ejecución del endpoint. Al completar emite:

```text
oc.domain.bound_to_server
```

### T7 — start_warmup_seed

Nuevo endpoint:

```http
POST /v1/warmup/start
```

Body:

```json
{
  "domain": "delivrix-mail.com",
  "serverSlug": "mail-delivrix-test",
  "serverIp": "192.0.2.44",
  "seedInboxes": [
    "seed.one@gmail.com",
    "seed.two@outlook.com",
    "seed.three@delivrix.com"
  ],
  "actorId": "operator/juanes",
  "approvalToken": "exec-...",
  "taskId": "optional-canvas-task"
}
```

Gates obligatorios antes de enviar:

- `WARMUP_ENABLE_SEND=true`.
- Runner SSH configurado.
- Audit chain contiene `oc.artifact.approved` reciente con `metadata.executionId == approvalToken`.
- Canvas artifact asociado sigue `approved`.
- IP del servidor disponible por body o workspace.
- Exactamente 3 seed inboxes.

La skill ejecuta `/usr/sbin/sendmail -t -f noreply@<domain>` por SSH, una vez por inbox. El contenido del mensaje viaja por `stdin`; el comando auditado solo muestra destino enmascarado.

El resultado queda en:

```text
inventory/warmup-progress.json
```

Para privacidad, audit/workspace guardan `seedHash`, `seedDomain`, `msgId`, no el email completo. Al completar emite:

```text
oc.warmup.started
```

### T7C — supervisor_onboard_batch multi-agent

Nuevo endpoint:

```http
POST /v1/flows/onboard-batch
```

Body:

```json
{
  "domains": [
    "delivrix-send.com",
    "delivrix-relay.com",
    "delivrix-mta.com"
  ],
  "profile": "bit",
  "actorId": "operator/juanes",
  "approvalToken": "exec-...",
  "seedInboxes": [
    "seed.one@gmail.com",
    "seed.two@outlook.com",
    "seed.three@delivrix.com"
  ]
}
```

El endpoint devuelve `202 Accepted` con `parentTaskId` y `subTaskIds` inmediatamente. La ejecución corre en background:

- declara una task padre `Onboarding batch · N domains`;
- declara una sub-task por dominio con `parentTaskId`;
- ejecuta los dominios en paralelo con `Promise.all`;
- reintenta cada sub-task hasta `maxRetries` (default 1);
- si un dominio falla, escribe learning automático y no tumba el batch completo;
- al final emite artifact consolidado tipo `report`;
- escribe execution record `supervisor_onboard_batch`;
- actualiza `inventory/onboard-batches.json`;
- emite audit `oc.flow.onboard_batch_completed`.

### T8 — Canvas Live jerárquico + flow async end-to-end

Se extendió el contrato compartido `packages/domain/src/canvas-live.ts`:

```ts
CanvasLiveTaskDeclareEvent.parentTaskId?: string
CanvasLiveTaskSnapshot.parentTaskId?: string
```

El normalizador backend acepta `parentTaskId` y `parent_task_id`, conserva la jerarquía al persistir/releer `tasks.jsonl`, y mantiene `lastAction` al completar sub-tasks.

Nuevo endpoint individual:

```http
POST /v1/flows/onboard-sender-domain
```

El runner productivo encadena los endpoints T1-T7 ya implementados:

1. `POST /v1/domains/route53/register`
2. `POST /v1/domains/route53/dns/upsert`
3. `POST /v1/webdock/servers/create`
4. `POST /v1/domains/auth/configure`
5. `POST /v1/servers/{serverSlug}/provision-smtp`
6. `POST /v1/domains/bind`
7. `POST /v1/warmup/start`

Cada fase emite `oc.action.now` al task del dominio. Los handlers internos siguen aplicando sus propias compuertas de env + audit approval + canvas artifact aprobado, así que el flow no bypassa seguridad.

## Seguridad

- No se ejecutó ninguna compra real.
- No se editaron credenciales ni `.env.local`.
- El contacto administrativo no se escribe en audit ni workspace.
- La private key DKIM queda restringida al workspace y fuera de audit/response.
- La public key SSH de Webdock se recibe como parámetro/fallback env, pero audit solo guarda fingerprint.
- La private key DKIM viaja a SSH por `stdin`; el comando auditado queda redacted.
- Los seed inboxes de warmup se enmascaran en respuesta y se hashean en workspace/audit.
- El flow batch no bypassa gates: llama los handlers T1-T7 con el mismo `approvalToken`.
- Las sub-tasks fallidas quedan aisladas; el supervisor genera learning y artifact de resumen.
- El endpoint no acepta solo UI state: exige audit chain reciente.
- La compra, las mutaciones DNS, la autenticación de email, la creación de VPS, el provisioning SSH y el envío warmup quedan deshabilitados por defecto hasta activar env + permisos + aprobación.

## Verificación

```bash
node --test packages/adapters/src/aws-route53-domains-adapter.test.ts apps/gateway-api/src/openclaw-workspace.test.ts apps/gateway-api/src/routes/domains-purchase.test.ts
node --test packages/adapters/src/aws-route53-dns-adapter.test.ts apps/gateway-api/src/routes/domains-dns.test.ts
node --test apps/gateway-api/src/openclaw-workspace.test.ts apps/gateway-api/src/routes/domains-email-auth.test.ts
node --test packages/adapters/src/webdock-real-adapter.test.ts apps/gateway-api/src/routes/webdock-servers.test.ts
node --test apps/gateway-api/src/openclaw-workspace.test.ts apps/gateway-api/src/routes/smtp-provisioning.test.ts
node --test apps/gateway-api/src/routes/domains-bind.test.ts
node --test apps/gateway-api/src/routes/warmup.test.ts
node --test apps/gateway-api/src/routes/canvas-live.test.ts apps/gateway-api/src/routes/onboard-flow.test.ts
npm test
git diff --check
```

Resultado:

- T1/T7B focus tests: 13 passed.
- T2 focus tests: 6 passed.
- T3 focus tests: 4 passed.
- T4 focus tests: 7 passed.
- T5 focus tests: 4 passed.
- T6 focus tests: 3 passed.
- T7 focus tests: 2 passed.
- T7C/T8 focus tests: 15 passed.
- Full suite after T7C/T8: 334 passed.
- Diff check: OK.

## Pendiente para demo real

- Smoke test real con 3 dominios staging cuando estén activos los bloqueantes externos.

Bloqueantes externos:

- `DELIVRIX_ADMIN_CONTACT_JSON`.
- IAM con `route53domains:RegisterDomain`.
- Definir y activar `AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD`.
- Confirmar compra real habilitada solo para la demo.
- Webdock API key write y desbloqueo de port 25.
- Seed inboxes para warmup.
