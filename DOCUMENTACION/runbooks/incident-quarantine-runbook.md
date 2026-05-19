---
id: incident-quarantine
version: 1.0.0
matrix_category: supervised_local_state
delivrix_actions:
  - propose_quarantine
  - update_sender_node_metadata
required_approvals_business_hours: 1
required_approvals_off_hours: 2
required_roles: ["operator"]
estimated_minutes: 5
reversible: true
hito: 5.11.B
---

# Runbook · Cuarentena por incidente de reputación

## Propósito

Acción defensiva ante un evento crítico de reputación. Marca el nodo
como `quarantined` (más fuerte que `paused`), abre tarjeta crítica en
Notion, y prepara el camino al análisis de causa raíz.

## Diferencia vs pause-ip

| | `pause-ip` | `quarantine` |
| --- | --- | --- |
| Severity | high | critical |
| Status final | `paused` | `quarantined` |
| Aprobaciones | 1 | 1 (horario) / 2 (off-hours) |
| Notion severity | High | Critical |
| Resolución típica | Reactivar | Investigar → retirar o reactivar tras root cause |

## Preconditions

1. Detectado **uno** de:
   - Blacklist hit confirmado (Spamhaus, SURBL, UCEPROTECT, etc.).
   - Complaint spike > 1% en última hora.
   - Bounce spike > 5% en última hora.
   - Reporte de abuse de proveedor (Webdock notification, ARIN report).
2. Kill switch armado pero no activo (si está active, ya estamos en parada
   total y esto sería redundante).
3. Sender node en `active`, `warming` o `paused` (no ya quarantined o
   retired).

## Steps

1. **Recolectar evidencia agresiva.** OpenClaw consolida:
   - Último `ip-reputation-report` del nodo.
   - Audit events últimas 6h con `targetId`.
   - `send-results` últimas 6h con desglose de bounces/complaints.
   - Si hay blacklist hit: URL del listing.

2. **Detectar horario.** El Gateway resuelve si es horario laboral (08:00–
   20:00 hora del operador principal) o off-hours.

3. **Publicar propuesta** (severity: critical):
   ```json
   {
     "category": "node_quarantine_proposed",
     "severity": "critical",
     "headline": "Cuarentena: {nodeId} ({razón corta})",
     "body": "...",
     "evidenceRefs": [...],
     "runbookRef": "incident-quarantine-runbook.md",
     "targetRef": "{nodeId}"
   }
   ```

4. **Firmar.** 1 firma en horario, 2 firmas off-hours (proceso más
   conservador cuando hay menos gente vigilando).

5. **Aplicar.** Gateway:
   - Lock por `(sender_node, {nodeId})`.
   - Snapshot status previo → `rollbackToken`.
   - `senderNodeRegistry.updateStatus(nodeId, "quarantined")`.
   - Audita `oc.runbook.quarantine.executed`.

6. **Side-effects auditados:**
   - `delivrix-alert-ops` crea bug Notion severity `Critical`.
   - `delivrix-report-ops` agrega el incidente al próximo Daily Standup.
   - Si hay sponsor on-call (futuro), email/sms manual (Hito 6+).

## Postconditions

- `senderNode.status == "quarantined"`.
- `mail-policy-engine` rechaza cualquier job al nodo.
- Tarjeta Notion abierta severity Critical con link al audit y evidencia.
- Próximo Daily Standup tendrá la entrada.

## Rollback

Quarantine **no se revierte automáticamente**. Requiere proceso explícito:

1. Análisis de causa raíz documentado.
2. Plan de remediación firmado.
3. **Operador decide**: pasar a `active` (problema resuelto), `retired`
   (nodo descartado) o seguir en quarantine (investigación abierta).
4. Llama `POST /v1/agent/runbook/revert` con `reason` documentada y el
   nuevo status target en `metadata.targetStatus`.

## Audit IDs

| Evento | ID |
| --- | --- |
| Propuesta crítica | `oc.proposal.submitted` (con severity=critical) |
| Tokens | `oc.approval.token_issued` |
| Ejecución | `oc.runbook.quarantine.executed` |
| Notion bug crítico | `oc.notion.bug_created` |
| Rollback decidido | `oc.runbook.quarantine.reverted` con `newStatus` |

## Quién puede invocar

- `delivrix-alert-ops` automático cuando detecta spike crítico.
- `drift-monitor` si hay mismatch + blacklist hit.
- Operador manualmente con evidencia adjunta.

## Quién aprueba

- 1 operador en horario laboral del operador principal.
- 2 operadores distintos en off-hours.

## Ejemplo de mensaje en Canvas prompt

```
Headline: "🚨 Cuarentena urgente: svc-warmup-01 — blacklist hit Spamhaus"
Body: "Listado en Spamhaus SBL (https://check.spamhaus.org/...) detectado
hace 18 min. Complaint rate spike a 0.42% en última hora (umbral 0.2%).
Bounce rate 4.1%. Recomendación: cuarentena inmediata + análisis."
Acciones:
  primary: { kind: "open_runbook", label: "Cuarentena urgente",
             runbookRef: "incident-quarantine-runbook.md" }
  secondary: { kind: "view_evidence", label: "Ver evidencia completa" }
```
