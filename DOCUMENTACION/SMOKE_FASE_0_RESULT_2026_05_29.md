# Smoke Fase 0 A3 - Resultado preflight

Fecha: 2026-05-29 15:28 COT  
Operador: Codex, con sub-agentes Backend, QA y Security  
Estado: PRE-FLIGHT SIN GASTO COMPLETADO. SMOKE REAL BLOQUEADO.

## Veredicto

No se ejecuto el smoke real con dinero. Costo real: USD 0.

La ejecucion A3 queda bloqueada hasta corregir o aceptar explicitamente estos puntos:

1. El runbook A3 no coincide con los contratos actuales del gateway.
2. La UI `ApprovalGate` v5 apunta a `/v1/openclaw/proposals/:auditId/sign`, pero el gateway no registra esa ruta.
3. Los handlers live reales esperan un `approvalToken` que es `executionId` de Canvas (`oc.artifact.approved`), no el token HMAC de `/v1/agent/proposals/:id/approve`.
4. El flujo A3 omite `/v1/domains/auth/configure`, requerido para generar y guardar la private key DKIM que usa `/v1/servers/:slug/provision-smtp`.
5. El OPS usa `recipientPool` para warmup seed, pero el handler real espera `seedInboxes:string[3]`; `recipientPool` solo corresponde a warmup ramp.
6. El smoke real implica compra irreversible de dominio, creacion de VPS y envio real; requiere firma humana trazable de Juanes antes de gastar o enviar.

## Cambios aplicados antes del bloqueo

- Se agrego gate de kill switch server-side para rutas live externas directas.
- Se agrego clasificador `classifyLiveActionMutation` para cubrir Route53, IONOS DNS, Webdock, SMTP, bind, warmup y onboard flows.
- Se hizo fail-closed por flags faltantes:
  - `DOMAIN_BIND_ENABLE`
  - `EMAIL_AUTH_ENABLE_WRITES`
  - `WARMUP_RAMP_ENABLE`
- Se propago `env` a `onboard-flow` para que los gates nuevos tambien apliquen en el flujo compuesto.
- Se agregaron tests para los gates nuevos y para el clasificador de live actions.

## SHAs base

- A1 audit chain verifier: `cb93e2c`
- A2 auto-rollback DNS + anchor: `13d9357`
- HEAD pre-commit A3: `13d9357`

## Preflight ejecutado

### Gateway

- `GET /health`: `status=ok`
- `GET /v1/audit-chain/verify` inicial: `ok=true`, `totalEvents=517`, `lastHash=40f69876ff48b25db5c6d434040cbd35ca9d1ae08e0fc8c3a316178fa5260d2a`
- `GET /v1/audit-chain/anchor` inicial:
  - `headSeq=517`
  - `signature=3139fab4711e402ccdb24cf69b5f40247d9e8185aea8129daebefecb69f1857e`

### Backup pre-smoke

- Path: `runtime/audit-pre-smoke-fase0.jsonl`
- Lineas: `517`
- SHA-256: `2ba3341db64069181e8a7357e53b6313489e048ee17ddd6ce9e74899bdf9bb02`

### Env flags redacted

- `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true`
- `AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD=50`
- `AWS_ROUTE53_DNS_ENABLE_WRITES=true`
- `WEBDOCK_SERVERS_ENABLE_CREATE=true`
- `SMTP_PROVISIONING_ENABLE_SSH=true`
- `WARMUP_ENABLE_SEND=true`
- `WARMUP_RAMP_ENABLE=true`
- `DOMAIN_BIND_ENABLE=true`
- `EMAIL_AUTH_ENABLE_WRITES=true`
- `AUDIT_ANCHOR_KEY=SET(64)`
- `EQUIPO_WEBHOOK_URL=MISSING` (buffer local/no remote webhook)
- Credenciales AWS/Webdock/SSH: presentes y redacted en preflight.

### Pricing/discovery sin gasto

- `GET /v1/domains/prices?tlds=click`:
  - provider: `aws-route53-domains`
  - source: `live`
  - `.click` registration: `USD 3`
  - `.click` renewal: `USD 3`
- `GET /v1/domains/availability?name=delivrix-fase0-202605291527.click`:
  - availability: `AVAILABLE`
  - source: `live`

Notas de fuentes oficiales verificadas el 2026-05-29:
- AWS Route53 indica que los dominios registrados no se pueden cambiar ni reembolsar si se registran por error, y que el hosted zone genera cargo mensual separado.
- Webdock publica precios mensuales fijos; la pagina oficial mostraba perfiles desde EUR 2.15/mes y Advanced a EUR 4.30/mes.

## Kill switch negative test

Se activo temporalmente el kill switch para validar que una ruta live externa queda bloqueada antes de tocar proveedor:

- `POST /v1/kill-switch`: enabled `true`
- `POST /v1/domains/route53/register` con payload dummy:
  - HTTP `423 Locked`
  - `rejectReason=kill_switch_armed`
  - `operation=apply_live_infrastructure_action`
  - Audit: `oc.live_action.blocked_by_kill_switch`
- `POST /v1/kill-switch`: enabled `false`

Audit chain final:

- `GET /v1/audit-chain/verify`: `ok=true`, `totalEvents=520`, `lastHash=dee96bcf3814356b31d094887a73a3ee614c91220a4d34f249eab1e54eaff885`
- `GET /v1/audit-chain/anchor`:
  - `headSeq=520`
  - `signature=263ab2887bccf0275198ad9e236e3d4424f7ce3fb9b3aa4fd2ac284f22401b92`

## Tests

- `npm run build --workspace @delivrix/gateway-api`: pass
- Focused tests:
  - `live-action-kill-switch.test.ts`
  - `domains-bind.test.ts`
  - `domains-email-auth.test.ts`
  - `warmup-ramp.test.ts`
  - `onboard-flow.test.ts`
  - `domains-dns.test.ts`
  - Resultado: `21/21` pass
- Full gateway suite:
  - `npm test --workspace @delivrix/gateway-api`
  - Resultado final: `146/146` pass

## Contratos corregidos para A3

Usar estos contratos, no los curls originales del OPS:

- Compra dominio: `POST /v1/domains/route53/register`
  - body: `{ domain, years, autoRenew?, actorId, approvalToken }`
- DNS Route53: `POST /v1/domains/route53/dns/upsert`
  - body: `{ domain, zoneId?, records:[{ name, type, ttl, values:string[] }], actorId, approvalToken, taskId? }`
- Email auth antes de SMTP: `POST /v1/domains/auth/configure`
  - body: `{ domain, mxServerIp, zoneId?, selector?, dmarcPolicy?, actorId, approvalToken, taskId? }`
- Webdock create: `POST /v1/webdock/servers/create`
  - `profile`: `bit | nibble | byte | kilobyte`
  - `imageSlug`: `ubuntu-2404 | debian-12`
- SMTP provision: `POST /v1/servers/:serverSlug/provision-smtp`
  - body: `{ domain, serverIp?, dkimPrivateKeyPath?, selector?, actorId, approvalToken, taskId? }`
- Bind domain: `POST /v1/domains/bind`
  - body: `{ domain, serverSlug?, serverIp?, zoneId?, actorId, approvalToken, taskId? }`
- Warmup seed: `POST /v1/warmup/start` o `/v1/warmup/seed`
  - body: `{ domain, serverSlug?, serverIp?, seedInboxes:string[3], actorId, approvalToken, taskId? }`

## Webhook y rollback

- `runtime/webhook-buffer.jsonl`: no existe. No hubo broadcast porque no se ejecuto mutacion real externa.
- `runtime/rollback-snapshots/`: no existe. No hubo DNS write real que requiriera snapshot de rollback.
- Auto-rollback events reales: `0`.

## Evidencia Gmail

No aplica. No se enviaron correos reales.

## Requisitos antes de desbloquear A3 real

1. Alinear `ApprovalGate` con el flujo real de `executionId` Canvas o implementar `/v1/openclaw/proposals/:auditId/sign` en gateway con la misma semantica auditada.
2. Generar un Canvas artifact aprobable por cada plan live A3 o por un plan compuesto que cubra dominio, VPS, DNS, SMTP, bind y warmup.
3. Reemplazar los curls del OPS por contratos actuales.
4. Confirmar por escrito de Juanes:
   - presupuesto maximo global: USD 25
   - dominio candidato
   - perfil Webdock
   - 3 seed inboxes Gmail autorizados
   - aceptacion de irreversibilidad de dominio/email
5. Volver a correr:
   - `/health`
   - `/v1/audit-chain/verify`
   - `/v1/audit-chain/anchor`
   - prueba kill-switch negativa

## Sign-off

Codex: preflight cerrado, smoke real bloqueado correctamente.

Juanes: pendiente de firma explicita para gasto/envio real.
