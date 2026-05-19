---
id: rotate-dns-record
version: 1.0.0
matrix_category: future_live_requires_new_phase
delivrix_actions:
  - propose_rotate_dns
required_approvals: 2
required_roles: ["operator", "operator"]
estimated_minutes: 30
reversible: true
hito: bloqueado en 5.11.B · habilitado en hito futuro
---

# Runbook · Cambiar registro DNS (BLOQUEADO en hito actual)

> ⚠️ **Este runbook está documentado para hito futuro.** En Hito 5.11.B
> está bloqueado por el gate `future_live_requires_new_phase`. El Gateway
> rechaza la acción `propose_rotate_dns` con HTTP 403 +
> `rejectReason: live_blocked_hito_5_11_b`.
>
> Cuando se habilite (hito posterior), debe actualizarse antes:
> 1. `NORTE_OPERATIVO_DELIVRIX.md` quita `no_live_dns_change_without_dry_run_and_approval` o lo reclasifica.
> 2. `OPENCLAW_PERMISSIONS_MATRIX.md` mueve `propose_rotate_dns` de `future_live_requires_new_phase` a `supervised_local_state` o crea `live_with_2pa`.
> 3. Este runbook bumpa a `version: 2.0.0` con `hito` actualizado.

## Propósito (cuando se habilite)

Cambiar un registro DNS (A, AAAA, MX, TXT, PTR, SPF/DKIM/DMARC) en zona
controlada por Delivrix. Aplica vía IONOS API o Route 53 según proveedor.

## Preconditions

1. Operador valida que el cambio está en runbook escrito previo (no acción
   ad-hoc).
2. Ventana de mantenimiento declarada y comunicada.
3. Snapshot completo de la zona DNS exportado y persistido (S3 + audit).
4. TTL del record actual conocido y planeado en la ventana.
5. Kill switch armado pero no activo.
6. **Doble aprobación con 2 operadores distintos.**

## Steps

1. **Export snapshot zona.** Llama API del proveedor:
   ```
   GET https://api.ionos.com/dns/v1/zones/{zoneId}
   # o
   aws route53 list-resource-record-sets --hosted-zone-id {Z123}
   ```
   Guarda en S3 con SSE-KMS y emite `oc.dns.snapshot_taken`.

2. **Generar diff.** OpenClaw compara estado actual vs deseado. Output:
   ```yaml
   changes:
     - type: UPSERT
       record: { name: "delivrix.io", type: "MX", ttl: 300, value: "10 mail.delivrix.io" }
   ```

3. **Operador 1 firma.** Token con `actionId: rotate_dns`, `targetType: dns_record`, `targetId: "delivrix.io:MX"`.

4. **Operador 2 firma.** Independiente.

5. **Aplicar.** Gateway con ambos tokens válidos:
   - Lock por `(zone, record_fqdn, type)`.
   - Aplica vía API del proveedor.
   - Espera propagación: `TTL + 60s buffer`.

6. **Validar propagación.** `dig` desde 3 resolvers públicos (8.8.8.8,
   1.1.1.1, 9.9.9.9). Si los 3 reportan el nuevo valor → OK. Si alguno
   sigue con valor viejo → log + esperar otro TTL antes de marcar éxito.

7. **Audit.** `oc.runbook.rotate_dns.executed` con diff y `rollbackToken`.

## Postconditions

- 3 resolvers públicos devuelven el nuevo valor.
- Audit log último evento OK.
- Snapshot pre-cambio disponible en S3.

## Rollback

Si dentro de 1h se detecta problema (deliverabilidad cae, bounces spike):

```
POST /v1/agent/runbook/revert
{
  "rollbackToken": "{token}",
  "approverIds": ["op1.id", "op2.id"],   // doble firma también para rollback
  "reason": "deliverability_dropped"
}
```

Gateway aplica el record previo desde el snapshot S3. Audita
`oc.runbook.rotate_dns.reverted`. Espera propagación TTL+60s. Re-valida.

## Audit IDs

| Evento | ID |
| --- | --- |
| Snapshot pre-cambio | `oc.dns.snapshot_taken` |
| Propuesta | `oc.proposal.submitted` |
| Tokens emitidos | `oc.approval.token_issued` (x2) |
| Ejecución | `oc.runbook.rotate_dns.executed` |
| Propagación OK | `oc.dns.propagation_verified` |
| Rollback | `oc.runbook.rotate_dns.reverted` |
| Bloqueo en 5.11.B | `oc.runbook.rotate_dns.live_blocked_hito_5_11_b` |

## Mientras esté bloqueado en 5.11.B

Si OpenClaw recibe trigger para esta acción, debe:

1. NO publicar propuesta como `future_live_requires_new_phase` al canvas.
2. Crear tarjeta Notion en Bugs & Blockers con título "DNS change request
   bloqueado por fase actual" y descripción de lo que se pidió.
3. Audit `oc.runbook.rotate_dns.live_blocked_hito_5_11_b`.

## Quién puede invocar (cuando se habilite)

- Operador manualmente con plan dry-run firmado.

## Quién aprueba

- 2 operadores distintos.
