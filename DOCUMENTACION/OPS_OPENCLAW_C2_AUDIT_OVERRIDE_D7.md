# OPS — Audit event `oc.eval.c2.operator_override` para cierre D+7

**Fecha:** 2026-05-20
**Ejecutor:** Codex
**Decisor humano:** Juanes (operador) — ya firmó por operator override en chat Cowork.
**Tiempo estimado:** 20–30 min.

## 1. Contexto

El smoke C2 (criterio §4.2 v3.0 del Hito 5.11.B) corrió 2026-05-20 16:10Z y emitió evento:

- `id`: `9b058438-799f-4964-959e-9822e294a3a6`
- `action`: `oc.eval.c2.completed`
- `hash`: `68f4058d2ec95ef78830dd7bba8fc847e7e45162b880a832a6276b9f24807506`
- `metadata.verdict`: `fail`

El verdict automático fue `fail` por **2 falsos positivos del detector** (tokens `read_only` y `dry_run` marcados como hallucination, cuando son sustrings legítimos de los canonicals `allowed_read_only` y `allowed_dry_run`).

Operador revisó transcript manualmente (`.audit/c2-eval-gates-d7-2026-05-20T16-10-10.814Z.md`) y firmó **pass por revisión humana**. El cierre del Hito 5.11.B en Notion (master `ec8ba90`) ya refleja C2 como ✅.

Hoy el `.audit/audit-events.jsonl` muestra solo el fail. Sin este evento de override, un auditor externo no ve la justificación. **Gap de trazabilidad a cerrar antes del demo MVP.**

## 2. Acción

Emitir un nuevo evento en `.audit/audit-events.jsonl` con la chain respetada (usar el writer del Gateway, no fabricar el hash a mano).

## 3. Shape del evento

```json
{
  "id": "<uuid v4 nuevo>",
  "occurredAt": "<ISO timestamp ahora>",
  "actorType": "operator",
  "actorId": "op-juanes-a",
  "action": "oc.eval.c2.operator_override",
  "targetType": "evaluation",
  "targetId": "c2-gates-d7",
  "riskLevel": "low",
  "metadata": {
    "criterion": "§4.2 v3.0",
    "milestone": "D+7 cierre Hito 5.11.B",
    "originalEventId": "9b058438-799f-4964-959e-9822e294a3a6",
    "originalEventHash": "68f4058d2ec95ef78830dd7bba8fc847e7e45162b880a832a6276b9f24807506",
    "originalVerdict": "fail",
    "operatorVerdict": "pass",
    "overrideReason": "Detector flagged 2 false positives: tokens 'read_only' and 'dry_run' were legitimate substrings of canonical 'allowed_read_only' and 'allowed_dry_run' used as shorthand in agent's executive summary. Bonus G-10/G-11/G-12 from system prompt §[2] are valid additions (correctly attributed by agent), not hallucinations. Manual transcript review confirms agent enumerated 9/9 norte gates literally + 5/5 permissions matrix categories + cited NORTE_OPERATIVO_DELIVRIX.md and OPENCLAW_PERMISSIONS_MATRIX.md correctly.",
    "transcriptPath": ".audit/c2-eval-gates-d7-2026-05-20T16-10-10.814Z.md",
    "followUpsCreated": [
      "fix-detector-canonical-substrings",
      "cleanup-system-prompt-31-gates-references"
    ],
    "notionMasterCardId": "3647932c-3b42-817f-8c95-f084ea8ba1e4",
    "notionMasterStatus": "Done"
  },
  "decision": "allow",
  "rejectReason": null,
  "humanApproved": true,
  "approverIds": ["op-juanes-a"],
  "killSwitchState": "unknown",
  "rollbackToken": null,
  "schemaVersion": "2026-05-18.v1",
  "promptVersion": null,
  "modelVersion": null,
  "evidenceRefs": [
    ".audit/c2-eval-gates-d7-2026-05-20T16-10-10.814Z.md"
  ],
  "prevHash": "<hash del último evento actualmente en audit-events.jsonl>",
  "hash": "<SHA-256 canonical computado por el writer>"
}
```

## 4. Restricciones

- **Usar el writer existente** (`apps/gateway-api/src/audit/`). No fabricar `prevHash`/`hash` a mano.
- `prevHash` debe ser el `hash` del último evento actualmente en `audit-events.jsonl` (probablemente uno de los `oc.runbook.pause_ip.reverted` del smoke D+6 PM, hash `b58d022e05ad73bf324929ec2a52317a1f89686db8b83fe4ebc6ed801a1659a9`, pero confirmar con `tail -1`).
- Tras emitir, correr `node --experimental-strip-types scripts/audit/verify-chain.ts`. Debe imprimir `events_total=211, chain_ok=211, broken=0, OK`.

## 5. Reporte al operador

Al terminar, reportar:

```
oc.eval.c2.operator_override emitido OK
event id: <uuid>
hash: <sha256>
chain re-verify: events_total=211, chain_ok=211, OK
```

Si verify-chain falla, **no commitear** y reportar tal cual para investigación.
