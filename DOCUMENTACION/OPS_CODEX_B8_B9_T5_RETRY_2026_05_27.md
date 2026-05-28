# OPS Codex B8/B9/T5 Retry - 2026-05-27

Contexto: CTO habilito `WEBDOCK_API_KEY_ACCOUNT` con scope Account Read/Write para separar gestion de SSH keys de create/delete VPS.

## Cambios cerrados

- B8: `WebdockRealAdapter` registra/reusa public key con `WEBDOCK_API_KEY_ACCOUNT`, crea VPS con `WEBDOCK_API_KEY_OPS`, crea shell user `delivrixops` con `publicKeys: [keyId]` y activa `passwordlessSudoEnabled`.
- B9: runner onboard queda en orden T1 -> T2 -> T4 -> T3 -> T5 -> T6; se elimina warmup del flow demo T1-T6.
- T1: `RegisterDomain` ahora es idempotente si el dominio ya existe en Route53 Domains (`status: idempotent_already_owned`, `costUsd: 0`).
- T5: SSH runner usa `sudo -n bash -lc` cuando `SMTP_PROVISION_SSH_USER != root`.
- T5 bugfix adicional: `timeoutMs` default ya no es pisado por `undefined`.
- T5 bugfix adicional: OpenDKIM config genera `UserID opendkim`, `PidFile /run/opendkim/opendkim.pid` y crea `/run/opendkim` antes del restart.

## Tests

```text
node --test packages/adapters/src/webdock-real-adapter.test.ts apps/gateway-api/src/routes/webdock-servers.test.ts apps/gateway-api/src/routes/smtp-provisioning.test.ts apps/gateway-api/src/routes/onboard-flow.test.ts apps/gateway-api/src/routes/domains-purchase.test.ts
# tests 23
# pass 23
```

## Approval inicial

```json
{
  "status": 200,
  "artifactId": "artifact-b8-b9-t5-retry-20260527",
  "body": {
    "ok": true,
    "executionId": "exec-565505eb-a634-430e-9fc2-d6882f4bbfa1"
  }
}
```

## T1 idempotent RegisterDomain

HTTP status: `200 OK`

```json
{
  "ok": true,
  "domain": "delivrix-demo-d10-20260527.click",
  "status": "idempotent_already_owned",
  "operationId": "idempotent_already_owned",
  "costUsd": 0,
  "workspace": {
    "path": "executions/2026-05-28/010215-register_domain_route53-delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/010215-register_domain_route53-delivrix-demo-d10-20260527.click-success.md"
  }
}
```

## T2 hosted zone

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "pending",
  "domain": "delivrix-demo-d10-20260527.click",
  "zoneId": "Z01020412DOBTS9SPZZLU",
  "nameServers": [
    "ns-1954.awsdns-52.co.uk",
    "ns-326.awsdns-40.com",
    "ns-802.awsdns-36.net",
    "ns-1379.awsdns-44.org"
  ],
  "changes": [
    {
      "name": "_b8b9-smoke.delivrix-demo-d10-20260527.click.",
      "type": "TXT",
      "changeId": "C0967280138AUIWCNG6DQ"
    }
  ],
  "workspace": {
    "path": "executions/2026-05-28/010228-route53_dns_upsert-delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/010228-route53_dns_upsert-delivrix-demo-d10-20260527.click-success.md"
  }
}
```

## T4 Webdock VPS + SSH key

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "running",
  "serverSlug": "server69",
  "eventId": "17154111716a17942f1d4e46.86687222",
  "ipv4": "193.181.211.198",
  "publicKeyId": 28974,
  "sshUsername": "delivrixops",
  "shellUserId": 111542,
  "pollCount": 8,
  "port25UnlockRequired": true,
  "workspace": {
    "path": "executions/2026-05-28/010359-provision_webdock_vps-mail.delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/010359-provision_webdock_vps-mail.delivrix-demo-d10-20260527.click-success.md"
  }
}
```

Account key verification:

```json
{
  "status": 200,
  "count": 3,
  "delivrixOpsKey": {
    "id": 28974,
    "name": "delivrix-ops-f62bb8f5fbd46125",
    "created": "2026-05-27 20:02:00"
  }
}
```

SSH verification:

```text
ssh -i ~/.ssh/delivrix-ops delivrixops@193.181.211.198 'sudo -n true'
# exit 0
```

## T3 SPF/DKIM/DMARC

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "pending",
  "domain": "delivrix-demo-d10-20260527.click",
  "zoneId": "Z01020412DOBTS9SPZZLU",
  "selector": "default",
  "dkimPrivateKeyPath": "inventory/dkim-keys/delivrix-demo-d10-20260527.click/default.private",
  "records": [
    {
      "name": "delivrix-demo-d10-20260527.click.",
      "type": "TXT",
      "changeId": "C028830920R9YMGL67S3F"
    },
    {
      "name": "default._domainkey.delivrix-demo-d10-20260527.click.",
      "type": "TXT",
      "changeId": "C06463542M0NEIJM658IM"
    },
    {
      "name": "_dmarc.delivrix-demo-d10-20260527.click.",
      "type": "TXT",
      "changeId": "C06454512KWPZ570NBM6K"
    }
  ],
  "workspace": {
    "path": "executions/2026-05-28/010408-configure_email_auth-delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/010408-configure_email_auth-delivrix-demo-d10-20260527.click-success.md"
  }
}
```

## T5 SMTP provisioning

Primer intento antes del timeout fix:

```json
{
  "ok": false,
  "status": "failed",
  "serverSlug": "server69",
  "domain": "delivrix-demo-d10-20260527.click",
  "error": "smtp_provision_failed",
  "message": "SSH command timed out.",
  "workspace": {
    "path": "executions/2026-05-28/010522-install_smtp_stack-delivrix-demo-d10-20260527.click-failed.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/010522-install_smtp_stack-delivrix-demo-d10-20260527.click-failed.md"
  }
}
```

Segundo intento despues del timeout fix, antes de OpenDKIM PID fix:

```json
{
  "ok": false,
  "status": "failed",
  "serverSlug": "server69",
  "domain": "delivrix-demo-d10-20260527.click",
  "error": "smtp_provision_failed",
  "message": "SSH command failed with exit 1.",
  "workspace": {
    "path": "executions/2026-05-28/010924-install_smtp_stack-delivrix-demo-d10-20260527.click-failed.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/010924-install_smtp_stack-delivrix-demo-d10-20260527.click-failed.md"
  }
}
```

Final despues de timeout + OpenDKIM PID fix:

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "configured",
  "serverSlug": "server69",
  "domain": "delivrix-demo-d10-20260527.click",
  "serverIp": "193.181.211.198",
  "selector": "default",
  "commandCount": 13,
  "tlsStatus": "attempted_or_pending_dns",
  "workspace": {
    "path": "executions/2026-05-28/011308-install_smtp_stack-delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/011308-install_smtp_stack-delivrix-demo-d10-20260527.click-success.md"
  }
}
```

Certbot quedo como `attempted_or_pending_dns`: el primer intento fue antes de crear `mail.<domain>` A record; esto es esperado en el orden T3 -> T5 -> T6.

## T6 bind MX/A

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "pending_propagation",
  "domain": "delivrix-demo-d10-20260527.click",
  "serverSlug": "server69",
  "serverIp": "193.181.211.198",
  "mxHost": "mail.delivrix-demo-d10-20260527.click",
  "changes": [
    {
      "name": "mail.delivrix-demo-d10-20260527.click.",
      "type": "A",
      "changeId": "C06522756DN6JB20QFNZ"
    },
    {
      "name": "delivrix-demo-d10-20260527.click.",
      "type": "MX",
      "changeId": "C0010495TXXKSMUP6MAC"
    }
  ],
  "workspace": {
    "path": "executions/2026-05-28/011318-bind_domain_to_server-delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/011318-bind_domain_to_server-delivrix-demo-d10-20260527.click-success.md"
  }
}
```

## Cleanup

### DELETE VPS

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "deleting",
  "serverSlug": "server69",
  "eventId": "4735557626a1796c2de44c8.03161307",
  "workspace": {
    "path": "executions/2026-05-28/011341-cleanup_webdock_vps-global-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/011341-cleanup_webdock_vps-global-success.md"
  }
}
```

Proveedor despues del DELETE:

```json
{
  "slug": "server69",
  "status": "stopped",
  "pendingDeletion": true,
  "ipv4": "193.181.211.198",
  "passwordlessSudoEnabled": true,
  "profileData": {
    "slug": "vps-xeon-essential-2025",
    "price": {
      "amount": 215,
      "currency": "EUR"
    }
  }
}
```

### DELETE hosted zone

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "deleted",
  "zoneId": "Z01020412DOBTS9SPZZLU",
  "domain": "delivrix-demo-d10-20260527.click",
  "deletedRecordCount": 6,
  "deleteChangeId": "C0427364173DSIIJK56D1",
  "workspace": {
    "path": "executions/2026-05-28/011342-route53_hosted_zone_delete-delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/011342-route53_hosted_zone_delete-delivrix-demo-d10-20260527.click-success.md"
  }
}
```

## Costos adicionales

- T1: `USD 0.00` porque el dominio ya estaba comprado y el endpoint devolvio `idempotent_already_owned`.
- Hosted zone: creada y eliminada en el mismo run; esperado `USD 0.00` por grace de Route53 si aplica dentro de 12h.
- Webdock VPS: plan live `2.15 EUR/month`, creado `2026-05-28 03:02:39` Webdock time y DELETE aceptado `2026-05-28T01:13:41Z`; costo prorrateado esperado menor a `USD 0.01`.
- Total adicional esperado: menor a `USD 0.01`; bajo el limite solicitado de `< USD 0.50`.

## Bugs encontrados y estado

- B8 cerrado: la key se registra con account key y Webdock crea shell user real con keyId.
- B9 cerrado: orden del runner corregido y cubierto por test.
- T5 bug cerrado: timeout default pisado por `undefined`.
- T5 bug cerrado: OpenDKIM en Ubuntu 24.04 requeria `PidFile /run/opendkim/opendkim.pid`.
- Riesgo residual: `certbot` queda pendiente hasta que el A record de `mail.<domain>` exista y propague; el flow actual instala stack antes de T6, por eso TLS queda `attempted_or_pending_dns`.
