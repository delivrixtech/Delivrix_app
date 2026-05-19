---
id: warming-step
version: 1.0.0
matrix_category: supervised_local_state
delivrix_actions:
  - propose_warming_step
  - record_human_decision
required_approvals: 2
required_roles: ["operator", "operator"]
estimated_minutes: 10
reversible: true
hito: 5.11.B
---

# Runbook · Subir warming N → N+1

## Propósito

Avanzar el día de warming de un sender_node en una unidad. La acción es
**local** (modifica el registry, no toca el VPS). El crecimiento real de
volumen lo hace el `mail-policy-engine` consultando el `warmupDay`.

## Preconditions (todas obligatorias)

1. IP del sender_node tiene reputación verde **48h continuas** (ver
   `read_ip_reputation_reports`).
2. Bounces < 2% en últimos 7 días.
3. Quejas < 0.2% en últimos 7 días.
4. Kill switch armado pero no activo.
5. Sender node está en status `warming` (no `paused`, no `quarantined`,
   no `retired`).
6. El `warmupDay` actual no excede el día máximo configurado del MVP
   (default 30).

Si alguna falla, el runbook se aborta con `rejectReason: preconditions_failed`.

## Steps (orden estricto)

1. **Recolectar evidencia.** OpenClaw invoca `delivrix-fleet-ops` y
   `delivrix-alert-ops`. Captura snapshots y los pin-ea con hashes.
2. **Publicar propuesta.** OpenClaw POSTea `/v1/agent/proposals` con:
   ```json
   {
     "category": "warming_step_proposed",
     "severity": "low",
     "headline": "Subir warming de {nodeId} a día {N+1}",
     "body": "Reputación verde 48h. Quejas 0.18%. Bounces 1.4%. Listo para avanzar.",
     "evidenceRefs": ["{hashes}"],
     "runbookRef": "warming-step-runbook.md",
     "targetRef": "{nodeId}",
     "delivrix_actions_required": ["propose_warming_step", "record_human_decision"]
   }
   ```
3. **Operador 1 firma.** Desde fuera del panel (CLI o tool firmado), genera
   `ApprovalToken` con `approverId = operator_1.id` y firma HMAC.
4. **Operador 2 firma.** Independiente. `approverId` distinto, mismo
   `targetId`. Genera segundo token.
5. **Aplicar.** Gateway recibe `POST /v1/agent/runbook/execute` con los 2
   tokens. Pipeline evalúa (Doc 2 §4.1), serializa con lock, persiste
   `senderNode.warmupDay = N+1` y emite `rollbackToken`.
6. **Audit.** Evento `oc.runbook.warming_step.executed` con
   `approverIds: [op1.id, op2.id]`, `prevWarmupDay`, `newWarmupDay`,
   `rollbackToken`.

## Postconditions (validación obligatoria post-step)

- `GET /v1/sender-nodes` devuelve el nodo con `warmupDay = N+1`.
- Audit log último evento es `oc.runbook.warming_step.executed`.
- `mail-policy-engine` aplica el nuevo `dailyLimit` correspondiente al día.
- Ningún job pendiente queda en estado inconsistente.

## Rollback

Si dentro de 24h se detecta degradación de reputación:

```
POST /v1/agent/runbook/revert
{
  "rollbackToken": "{token emitido en step 5}",
  "approverIds": ["op1.id"],  // 1 firma basta para rollback
  "reason": "reputation_degraded"
}
```

Gateway:
1. Valida token sin caducidad (rollback tokens tienen TTL 7 días).
2. Restaura `senderNode.warmupDay = N` desde snapshot persistido.
3. Audita `oc.runbook.warming_step.reverted`.

## Audit IDs

| Evento | ID |
| --- | --- |
| Propuesta publicada | `oc.proposal.submitted` |
| Token op1 emitido | `oc.approval.token_issued` |
| Token op2 emitido | `oc.approval.token_issued` |
| Ejecución | `oc.runbook.warming_step.executed` |
| Rollback (si aplica) | `oc.runbook.warming_step.reverted` |
| Falla de precondition | `oc.runbook.warming_step.preconditions_failed` |

## Quién puede invocar

- OpenClaw (skill `drift-monitor` o por solicitud directa del operador).
- Operador humano vía CLI firmado.

## Quién aprueba

- 2 operadores con `role: operator` distintos (no la misma persona dos veces).
- Identidades resueltas vía `read_iam_sessions`.

## Ejemplo de mensaje al operador en el Canvas prompt

```
Headline: "Subir warming de svc-warmup-01 a día 8"
Body: "Reputación verde por 52h continuas. Quejas 0.15%. Bounces 1.2%.
Plan dry-run: incrementar warmupDay 7 → 8. dailyLimit subiría de 100 a 150.
Requiere 2 firmas. Runbook: warming-step-runbook.md"
Acciones:
  primary: { kind: "open_runbook", label: "Revisar plan dry-run",
             runbookRef: "warming-step-runbook.md" }
  secondary: { kind: "snooze", label: "Posponer 24h" }
```
