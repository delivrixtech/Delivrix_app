# Fase 0 Contrato de Permisos - Resultado

Fecha: 2026-06-04
Rama: `codex/fase0-contrato`

## Resultado

- Bypasses legacy cerrados fisicamente en el Gateway:
  - `POST /v1/agent/proposals/{id}/approve`
  - `POST /v1/agent/runbook/execute`
  - `POST /v1/agent/runbook/revert`
- Las tres rutas legacy responden `410 canonical_hmac_signature_required` y registran `oc.legacy_authorization.deprecated`.
- El unico camino de firma humana queda en `POST /v1/openclaw/proposals/{id}/sign`.
- `PlanApproval` queda agregado a `proposals-sign.ts` detras de `OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE`, apagado por defecto.
- Con flag OFF no cambia el flujo por paso.
- Con flag ON, `configure_complete_smtp` exige scope explicito: `runId`, `domain`, `provider`, `budgetUsdMax`, `testEmailRecipient`.
- El orquestador respeta `input.runId` si viene en la propuesta.
- El Canvas legacy ya no llama endpoints `/v1/agent/...`; abre el flujo de gate canonico.
- `scripts/openclaw/build-system-context.sh` ya no apunta a un worktree viejo; usa el repo raiz relativo al script y valida `.git`.

## Defect Ledger

| ID | Severidad | Hallazgo | Estado |
| --- | --- | --- | --- |
| F0-01 | P1 | `/v1/agent/proposals/{id}/approve` aceptaba autorizacion legacy por operador y podia emitir tokens fuera de `proposals-sign.ts`. | Cerrado con `410` + auditoria. |
| F0-02 | P1 | `/v1/agent/runbook/execute` quedaba como ruta paralela al contrato canonico aunque usara HMAC. | Cerrado con `410` + auditoria. |
| F0-03 | P1 | `/v1/agent/runbook/revert` podia revertir con `X-Operator-Id` y rollback token. | Cerrado con `410` + auditoria. |
| F0-04 | P1 | Canvas legacy consumia approve/execute/revert legacy. | Cerrado; no quedan URLs legacy en admin panel. |
| F0-05 | P1 | `build-system-context.sh` tenia `WORKTREE` hardcodeado a `.claude/worktrees/youthful-mirzakhani-c517de`. | Cerrado; default relativo al repo canonico. |
| F0-06 | P2 | Test `live-tool.test.ts` podia crashear Vite/Rolldown por dep-scan al cerrar servidor SSR. | Cerrado con `optimizeDeps.noDiscovery` en el harness. |

## Checks

- `node --check apps/gateway-api/src/main.ts`: pass.
- `node --test apps/gateway-api/src/routes/proposals-sign.test.ts apps/gateway-api/src/routes/legacy-authorization.test.ts apps/gateway-api/src/openclaw-tools-builder.test.ts apps/gateway-api/src/routes/orchestrator-smtp.test.ts`: 73/73 pass.
- `npm test` con Node 24.15.0: 812/812 pass.
- `npm --workspace @delivrix/admin-panel run check` con Node 24.15.0: 34/34 pass + Vite build pass.
- `bash -n scripts/openclaw/build-system-context.sh`: pass.

## Deploy

No se hizo deploy local/Hostinger en esta ejecucion. Fase 0 deja el commit listo para revision; el deploy requiere firma operativa explicita con backup, rollback y flag `OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE` apagado.
