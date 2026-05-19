---
id: register-sender-node-local
version: 1.0.0
matrix_category: supervised_local_state
delivrix_actions:
  - propose_register_sender_node
  - register_sender_node_local
required_approvals: 1
required_roles: ["operator"]
estimated_minutes: 5
reversible: true
hito: 5.11.B
---

# Runbook · Registrar sender_node nuevo en registry local

## Propósito

Incorporar un VPS Webdock al registry local de sender_nodes para que entre
al pipeline supervisado de Delivrix. No crea ni modifica el server en
Webdock — solo registra metadata local.

## Preconditions

1. El server existe en Webdock con status `running` (confirmado vía
   `webdock-inventory-sync`).
2. La IP no aparece en `suppression-list`.
3. La reputación inicial estimada (vía `ip-reputation-reports` para esa IP)
   no es `critical`.
4. No existe ya un sender_node con el mismo `id` o `ipAddress` en el
   registry.
5. Kill switch armado pero no activo.

## Steps

1. **Construir payload.** OpenClaw o el operador prepara:
   ```typescript
   const input: RegisterSenderNodeInput = {
     id: server.slug,                   // ej: "svc-prod-eu-01"
     label: server.name,
     provider: "webdock",
     status: "warming",                 // siempre arranca en warming
     ipAddress: server.ipv4,
     hostname: server.name + ".delivrix.local",
     dailyLimit: 50,                    // base de día 1
     warmupDay: 1
   };
   ```
2. **Publicar propuesta:**
   ```json
   {
     "category": "node_register_proposed",
     "severity": "low",
     "headline": "Registrar svc-prod-eu-01 en sender_node registry",
     "body": "Server existe en Webdock (running, fi-hel-2). IP 185.243.12.40
              limpia. Iniciar como warming día 1, dailyLimit 50.",
     "evidenceRefs": [<hash de webdock inventory>, <hash de ip-reputation>],
     "runbookRef": "register-sender-node-local-runbook.md",
     "targetRef": "svc-prod-eu-01"
   }
   ```
3. **Operador firma.**
4. **Aplicar.** Gateway:
   - Lock por `(sender_node, {nodeId})`.
   - `senderNodeRegistry.register(input)`.
   - Snapshot del estado previo (no-existencia) → `rollbackToken`.
   - Audita `oc.runbook.register_sender_node.executed`.
5. **Verificación inmediata:** Gateway hace `senderNodeRegistry.list()` y
   confirma que el nodo aparece. Si no, marca el step como `failed_partial`
   y rollback.

## Postconditions

- `GET /v1/sender-nodes` incluye el nodo nuevo.
- `drift-monitor` deja de proponer registro para este slug en el próximo
  run (dedupe por hash).
- Audit log último evento `oc.runbook.register_sender_node.executed`.

## Rollback

`senderNodeRegistry` no soporta `delete` directo (regla de auditoría). El
rollback aquí significa marcar el nodo como `retired_pending_approval`:

```
POST /v1/agent/runbook/revert
{
  "rollbackToken": "{token}",
  "approverIds": ["op.id"],
  "reason": "registration_was_error"
}
```

Gateway pasa el nodo a `retired_pending_approval` y audita
`oc.runbook.register_sender_node.reverted`.

## Audit IDs

| Evento | ID |
| --- | --- |
| Propuesta | `oc.proposal.submitted` |
| Token | `oc.approval.token_issued` |
| Ejecución | `oc.runbook.register_sender_node.executed` |
| Rollback | `oc.runbook.register_sender_node.reverted` |
| Falla post-verificación | `oc.runbook.register_sender_node.failed_partial` |

## Quién puede invocar

- `drift-monitor` cuando detecta server Webdock sin sender_node correspondiente.
- Operador manualmente.

## Quién aprueba

- 1 operador.

## Ejemplo de mensaje en Canvas prompt

```
Headline: "Registrar svc-prod-eu-01 en sender_node registry"
Body: "Server existe en Webdock (running, fi-hel-2). IP 185.243.12.40 limpia.
Sin entrada en registry local. Iniciaría como warming día 1, dailyLimit 50."
Acciones:
  primary: { kind: "open_runbook", label: "Registrar",
             runbookRef: "register-sender-node-local-runbook.md" }
  secondary: { kind: "snooze", label: "Ignorar este server" }
```
