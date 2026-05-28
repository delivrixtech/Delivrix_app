# OPS Codex D10 Real E2E - 2026-05-27

Contexto: Camino B CTO. OpenClaw ejecuta T1-T6 con una firma `juanescanar-cto`.

## Cambios aplicados antes del smoke

- `register_domain` paso a `requiredApprovals: 1` en `DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md`.
- `evaluateOpenClawActionPermission` acepta `register_domain` con una firma wallet CTO y rechaza 0 firmas.
- Audit append-only emitido: `oc.matrix.policy_updated` con diff `requiredApprovals: 2 -> 1`.
- Fix AWS Route53 Domains: para contactos `CountryCode: "CO"` se omite `State` en `AdminContact`, `RegistrantContact` y `TechContact`.

## Verificacion de tests

```text
node --test packages/domain/src/openclaw-runbook.test.ts
# pass 6

node --test packages/adapters/src/aws-route53-domains-adapter.test.ts
# pass 11

node --check packages/domain/src/openclaw-runbook.ts
# pass

node --check packages/adapters/src/aws-route53-domains-adapter.ts
# pass
```

## Cleanup previo

### Hosted zone previa

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "deleted",
  "zoneId": "Z10356663H9JL5E42XW7S",
  "domain": "nfcfilings.com",
  "deletedRecordCount": 0,
  "deleteChangeId": "C055945132LUZ2SCV9P91",
  "workspace": {
    "path": "executions/2026-05-27/235538-route53_hosted_zone_delete-nfcfilings.com-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-27/235538-route53_hosted_zone_delete-nfcfilings.com-success.md"
  }
}
```

### Webdock server48

Reboot directo Webdock: `202 Accepted`, callback `7063004296a17847ae135e7.96118953`.

DELETE via gateway: HTTP status `200 OK`

```json
{
  "ok": true,
  "status": "deleting",
  "serverSlug": "server48",
  "eventId": "15162144846a1784a5aafd13.58594642",
  "workspace": {
    "path": "executions/2026-05-27/235624-cleanup_webdock_vps-global-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-27/235624-cleanup_webdock_vps-global-success.md"
  }
}
```

Proveedor despues del DELETE: `status: "stopped"`, `pendingDeletion: true`.

## D10 approval

Approval artifact: `artifact-d10-real-e2e-retry3-20260527`

```json
{
  "status": 200,
  "artifactId": "artifact-d10-real-e2e-retry3-20260527",
  "body": {
    "ok": true,
    "executionId": "exec-e6e7033b-ff1a-4cf1-9a1d-4c1e78efbca7"
  }
}
```

## T1 RegisterDomain

Dominio: `delivrix-demo-d10-20260527.click`

Precio live previo: USD 3 registration, USD 3 renewal.

Primer intento fallo por validacion AWS de contacto Colombia:

```json
{
  "ok": false,
  "status": "failed",
  "domain": "delivrix-demo-d10-20260527.click",
  "error": "route53_register_failed",
  "message": "AWS Route 53 Domains API returned 400 Bad Request: {\"__type\":\"InvalidInput\",\"message\":\"Invalid request. Problems: ADMIN.STATE is not required for Colombia, and should not be set,OWNER.STATE is not required for Colombia, and should not be set,TECH.STATE is not required for Colombia, and shou",
  "workspace": {
    "path": "executions/2026-05-28/000241-register_domain_route53-delivrix-demo-d10-20260527.click-failed.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/000241-register_domain_route53-delivrix-demo-d10-20260527.click-failed.md"
  }
}
```

Retry despues del fix: HTTP status `200 OK`

```json
{
  "ok": true,
  "domain": "delivrix-demo-d10-20260527.click",
  "operationId": "6a3b6fcb-28a4-4ae3-86e4-a301b8d540a1",
  "expectedExpiry": "2027-05-28T00:07:17.362Z",
  "costUsd": 3,
  "status": "pending",
  "workspace": {
    "path": "executions/2026-05-28/000717-register_domain_route53-delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/000717-register_domain_route53-delivrix-demo-d10-20260527.click-success.md"
  }
}
```

## T2 Hosted Zone

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "pending",
  "domain": "delivrix-demo-d10-20260527.click",
  "zoneId": "Z05327973A49TYP46LYIN",
  "nameServers": [
    "ns-1641.awsdns-13.co.uk",
    "ns-558.awsdns-05.net",
    "ns-1449.awsdns-53.org",
    "ns-189.awsdns-23.com"
  ],
  "changes": [
    {
      "name": "_d10-smoke.delivrix-demo-d10-20260527.click.",
      "type": "TXT",
      "changeId": "C06030601ASA5MT09LJEF"
    }
  ],
  "workspace": {
    "path": "executions/2026-05-28/000817-route53_dns_upsert-delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/000817-route53_dns_upsert-delivrix-demo-d10-20260527.click-success.md"
  }
}
```

## T4 Webdock VPS

Nota: T4 se ejecuto antes de T3 porque el endpoint T3 exige `mxServerIp` para escribir SPF real.

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "running",
  "serverSlug": "server57",
  "eventId": "16953298776a178796b44765.70427347",
  "ipv4": "193.181.211.200",
  "pollCount": 10,
  "port25UnlockRequired": true,
  "workspace": {
    "path": "executions/2026-05-28/000954-provision_webdock_vps-mail.delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/000954-provision_webdock_vps-mail.delivrix-demo-d10-20260527.click-success.md"
  }
}
```

Live plan: `vps-xeon-essential-2025`, `2.15 EUR/month`.

## T3 DKIM/SPF/DMARC

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "pending",
  "domain": "delivrix-demo-d10-20260527.click",
  "zoneId": "Z05327973A49TYP46LYIN",
  "selector": "default",
  "dkimPrivateKeyPath": "inventory/dkim-keys/delivrix-demo-d10-20260527.click/default.private",
  "records": [
    {
      "name": "delivrix-demo-d10-20260527.click.",
      "type": "TXT",
      "changeId": "C06887153TMINMAHW394X"
    },
    {
      "name": "default._domainkey.delivrix-demo-d10-20260527.click.",
      "type": "TXT",
      "changeId": "C06956363PR4TXMFEQ171"
    },
    {
      "name": "_dmarc.delivrix-demo-d10-20260527.click.",
      "type": "TXT",
      "changeId": "C063300346SK72QNA2A4"
    }
  ],
  "workspace": {
    "path": "executions/2026-05-28/001004-configure_email_auth-delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/001004-configure_email_auth-delivrix-demo-d10-20260527.click-success.md"
  }
}
```

## T5 SMTP install

HTTP status: `502 Bad Gateway`

```json
{
  "ok": false,
  "status": "failed",
  "serverSlug": "server57",
  "domain": "delivrix-demo-d10-20260527.click",
  "error": "smtp_provision_failed",
  "message": "SSH command failed with exit 255.",
  "workspace": {
    "path": "executions/2026-05-28/001035-install_smtp_stack-delivrix-demo-d10-20260527.click-failed.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/001035-install_smtp_stack-delivrix-demo-d10-20260527.click-failed.md"
  }
}
```

Evidence adicional:

```text
ssh -i ~/.ssh/delivrix-ops root@193.181.211.200 true
root@193.181.211.200: Permission denied (publickey).
```

Webdock live:

```json
{
  "serverSlug": "server57",
  "status": "running",
  "pendingDeletion": false,
  "shellUsers": []
}
```

`POST /account/publicKeys` con `WEBDOCK_API_KEY_OPS` y `WEBDOCK_API_KEY_PRIMARY` devolvio `401`, por falta de scope `write:account`. Durante diagnostico se creo `delivrixops` con key de cuenta existente `Claude`, pero no hay private key local correspondiente; el VPS fue eliminado en cleanup.

## T6 Bind MX/A

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "pending_propagation",
  "domain": "delivrix-demo-d10-20260527.click",
  "serverSlug": "server57",
  "serverIp": "193.181.211.200",
  "mxHost": "mail.delivrix-demo-d10-20260527.click",
  "changes": [
    {
      "name": "mail.delivrix-demo-d10-20260527.click.",
      "type": "A",
      "changeId": "C05238573SEMCME7P9LMO"
    },
    {
      "name": "delivrix-demo-d10-20260527.click.",
      "type": "MX",
      "changeId": "C05222392MX3BGIJBZMMI"
    }
  ],
  "workspace": {
    "path": "executions/2026-05-28/001412-bind_domain_to_server-delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/001412-bind_domain_to_server-delivrix-demo-d10-20260527.click-success.md"
  }
}
```

## Cleanup D10

Approval artifact: `artifact-d10-cleanup-20260527`

```json
{
  "status": 200,
  "artifactId": "artifact-d10-cleanup-20260527",
  "body": {
    "ok": true,
    "executionId": "exec-3125da15-1494-473c-a47f-faef599927d0"
  }
}
```

### DELETE VPS

HTTP status: `200 OK`

```json
{
  "ok": true,
  "status": "deleting",
  "serverSlug": "server57",
  "eventId": "11844329566a1788ec31ae81.45789373",
  "workspace": {
    "path": "executions/2026-05-28/001439-cleanup_webdock_vps-global-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/001439-cleanup_webdock_vps-global-success.md"
  }
}
```

Proveedor despues del DELETE:

```json
{
  "slug": "server57",
  "status": "stopped",
  "pendingDeletion": true,
  "ipv4": "193.181.211.200",
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
  "zoneId": "Z05327973A49TYP46LYIN",
  "domain": "delivrix-demo-d10-20260527.click",
  "deletedRecordCount": 6,
  "deleteChangeId": "C0145376P8L06XVDBQJQ",
  "workspace": {
    "path": "executions/2026-05-28/001440-route53_hosted_zone_delete-delivrix-demo-d10-20260527.click-success.md",
    "absolutePath": "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions/2026-05-28/001440-route53_hosted_zone_delete-delivrix-demo-d10-20260527.click-success.md"
  }
}
```

## Costos

- Dominio `.click`: `USD 3.00` registrado por Route53 Domains. El dominio queda comprado.
- Hosted zone: creada y eliminada en el mismo run; esperado `USD 0.00` por grace de Route53 para zonas eliminadas dentro de 12h.
- Webdock VPS: plan live `2.15 EUR/month`; creado 2026-05-28 02:08:54 Webdock time y DELETE aceptado 2026-05-28 00:14:39Z gateway. Cobro prorrateado esperado: menor a USD 0.01 si Webdock prorratea por tiempo; factura exacta no expuesta por el endpoint consultado.
- Total real confirmado por API en este run: `USD 3.00` dominio + prorrateo VPS pendiente de factura.

## Bugs nuevos / riesgos

1. `T5` fallo: Webdock no instala la key enviada como `publicKey` en `POST /servers`; `GET /servers/server57/shellUsers` devolvio `[]` y SSH root fallo con `Permission denied (publickey)`.
2. El endpoint oficial de Webdock para registrar keys (`POST /account/publicKeys`) requiere `write:account`; ambos tokens disponibles devolvieron `401`.
3. Webdock `DELETE` retorna 200 pero el proveedor deja el server como `stopped` + `pendingDeletion: true`; no desaparece inmediatamente del inventario.
4. T3 depende de la IP del VPS, por lo que el orden operativo real fue T1, T2, T4, T3, T5, T6.
