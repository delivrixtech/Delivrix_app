---
name: delivrix-publish-proposal
slug: delivrix-publish-proposal
version: 1.0.0
description: "Delivrix HMAC proposal publisher. Use when the operator asks OpenClaw to submit a supervised dry-run proposal to the private Delivrix Gateway endpoint. Publishes generic runbook proposals with X-OpenClaw-Signature and X-OpenClaw-Timestamp."
homepage: https://delivrix.local/openclaw/skills/delivrix-publish-proposal
trigger: "publicar propuesta | enviar propuesta al gateway | proponer pausa | proponer warming | proponer quarantine"
delivrix_actions:
  - propose_register_sender_node
  - propose_warming_step
  - propose_pause_ip
  - propose_quarantine
  - update_sender_node_metadata
  - record_human_decision
returns: structured-markdown
audit_id_prefix: oc.skill.publish_proposal
fallback: none
metadata:
  openclaw:
    emoji: "P"
    requires:
      bins: ["curl", "jq", "openssl", "od"]
---

# Delivrix Publish Proposal

## Proposito

Publica una propuesta ad-hoc del agente OpenClaw hacia el Gateway Delivrix usando el contrato privado `POST /v1/agent/proposals`.

## Cuando se invoca

Usala cuando el operador pide una accion supervisada y el agente ya tiene evidencia suficiente para proponer un runbook local: registrar sender node, subir warming, pausar IP o quarantine simulada.

## Endpoints que consume

- `POST /v1/agent/proposals`

La autenticacion es HMAC obligatoria: `X-OpenClaw-Signature` y `X-OpenClaw-Timestamp`. No uses Bearer para submit de propuestas.

## Formato de ejecucion

Ejecuta:

```bash
/data/.openclaw/skills/delivrix-publish-proposal/scripts/delivrix-publish-proposal.sh \
  --runbook-id pause-ip \
  --target-ref svc-mvp-test-03 \
  --headline "Pausar nodo de prueba" \
  --body "Evidencia resumida y razon operacional" \
  --evidence-ref "gateway:/v1/sender-nodes#sha256:..."
```

## Respuesta esperada

La salida corta contiene `status`, `httpStatus`, `proposalId`, `requiredApprovals` e `injectedIntoCanvas`.

## Errores y fallback

Si el Gateway rechaza la propuesta, no reintentes cambiando permisos. Reporta el `httpStatus` y `rejectReason`.
