---
id: pause-ip
version: 1.0.0
matrix_category: supervised_local_state
delivrix_actions:
  - propose_pause_ip
  - update_sender_node_metadata
required_approvals: 1
required_roles: ["operator"]
estimated_minutes: 3
reversible: true
hito: 5.11.B
---

# Runbook · Pausar sender_node (acción defensiva)

## Propósito

Marcar un sender_node como `paused` cuando su reputación se tensiona o el
proveedor reporta el server caído. Acción defensiva: no requiere doble
firma porque su efecto neto es **dejar de enviar**, no enviar más.

## Preconditions

1. El nodo está en status `active` o `warming` (no ya pausado/retirado).
2. Kill switch armado pero no activo (si está active, el sistema ya está
   en parada total y este runbook es redundante).
3. **Una** de estas justificaciones:
   - Detección automática del rules engine (`drift-monitor`) por mismatch
     Webdock stopped + sender active.
   - Bounce spike > 5% en última hora.
   - Complaint spike > 1% en última hora.
   - Blacklist hit detectado en `ip-reputation-reports`.
   - Decisión manual del operador con razón documentada.

## Steps

1. **Recolectar evidencia.** OpenClaw o el operador adjunta:
   - Último `ip-reputation-report` del nodo.
   - Snapshot `Webdock inventory` que mostró el mismatch (si aplica).
   - Audit events últimas 2h con el `targetId`.
2. **Publicar propuesta** (si la origina el agente):
   ```json
   {
     "category": "node_pause_proposed",
     "severity": "high",
     "headline": "Pausar {nodeId}: {razón}",
     "body": "...",
     "evidenceRefs": [...],
     "runbookRef": "pause-ip-runbook.md",
     "targetRef": "{nodeId}"
   }
   ```
3. **Operador firma 1 token.** TTL 15 min como cualquier token de matrix.
4. **Aplicar.** Gateway:
   - Lock por `(sender_node, {nodeId})`.
   - Snapshot del estado previo (status, dailyLimit) → `rollbackToken`.
   - `senderNodeRegistry.updateStatus(nodeId, "paused")`.
   - Audita `oc.runbook.pause_ip.executed`.
5. **Side-effect: tarjeta Notion.** Skill `delivrix-alert-ops` (delegación)
   crea bug en `🐛 Bugs & Blockers`:
   ```python
   flag_issue(
     issue_title=f"Sender node paused: {nodeId}",
     category="Flagged Server",
     severity="High",
     affected_server=nodeId,
     description=evidence_summary
   )
   ```

## Postconditions

- `senderNode.status == "paused"`.
- `mail-policy-engine` no asigna nuevos jobs al nodo (verificado en próximo
  ciclo del worker).
- Tarjeta Notion creada con link al audit.
- Audit log último evento `oc.runbook.pause_ip.executed`.

## Rollback

Cuando la reputación se recupera o el server vuelve a `running`:

```
POST /v1/agent/runbook/revert
{
  "rollbackToken": "{token}",
  "approverIds": ["op.id"],
  "reason": "reputation_recovered" | "server_running_again"
}
```

Gateway restaura `status` previo. Audita `oc.runbook.pause_ip.reverted`.
Cierra la tarjeta Notion como `Resolved`.

## Audit IDs

| Evento | ID |
| --- | --- |
| Propuesta | `oc.proposal.submitted` |
| Token | `oc.approval.token_issued` |
| Ejecución | `oc.runbook.pause_ip.executed` |
| Side-effect Notion | `oc.notion.bug_created` |
| Rollback | `oc.runbook.pause_ip.reverted` |

## Quién puede invocar

- `drift-monitor` automáticamente cuando detecta mismatch crítico.
- `delivrix-alert-ops` cuando detecta spike.
- Operador manualmente.

## Quién aprueba

- 1 operador (acción defensiva, urgencia > consenso).

## Ejemplo de mensaje en Canvas prompt

```
Headline: "Pausar svc-warmup-02: Webdock reporta stopped"
Body: "Webdock API reporta que el servidor está stopped desde hace 12 min.
El registry local todavía lo tiene active. Si entra un job, fallará.
Recomendación: pausar mientras se investiga."
Acciones:
  primary: { kind: "open_runbook", label: "Pausar ahora",
             runbookRef: "pause-ip-runbook.md" }
  secondary: { kind: "snooze", label: "Esperar 15 min y reevaluar" }
```
