# Codex — Patch observabilidad: cerrar fuga de clave PEM truncada (antes de mergear)

> **Sobre** `codex/observabilidad-canvas-live` (commit `0602c6e`). Patch chico, antes de mergear a produ.
> Subagentes (Backend + QA + Auditor de Errores). Si choca → parar y reportar.

## Problema (auditado)
El bridge trunca `result.error` a 500 chars **ANTES** de la redacción (`openclaw-bedrock-bridge.ts` `canvasActionEventForTool`, `String(result.error ?? "tool_failed").slice(0,500)`); recién después `canvas-live-events.ts` aplica `redactCanvasLiveText` (que hace `redactRuntimeLogSecrets(v).slice(0, maxChars)`). El regex de clave privada exige el bloque completo `-----BEGIN … PRIVATE KEY----- … -----END … PRIVATE KEY-----`. Si una clave DKIM (~1700 chars) cae en un error/stderr y se trunca a 500, el `-----END-----` se pierde → el regex **no matchea** → fragmento de clave puede filtrarse al broadcast/snapshot/JSONL.

## Fix
1. **Redactar ANTES de truncar** en TODOS los campos de texto de eventos (`error`, `stderr`, `stdout`, `responseBody`): aplicar `redactRuntimeLogSecrets`/`redactGatewayLogSecrets` sobre el string **completo** y recién después cortar. Quitar cualquier `.slice(0,500)` que ocurra antes de la redacción (en el bridge `canvasActionEventForTool` y en `canvas-live-events.ts`).
2. **Regex de PEM truncado** (defensa en profundidad) en `redactGatewayLogSecrets`/`redactRuntimeLogSecrets`: agregar `/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g` → `"[REDACTED_PARTIAL_KEY]"` para cubrir el caso `BEGIN` sin `END`. (Mantener el regex de bloque completo también.)
3. Subir el cap de `stderr`/`stdout`/`error` a ≥2000 chars si hace falta para no cortar bloques legítimos — pero **la redacción-antes-de-truncar es lo principal**.

## Test (node:test)
- Una clave DKIM real (~1700 chars PEM) embebida en `result.error` Y en `stderr` de un evento `oc.action.now kind:command` → tras emit, **NO aparece ningún fragmento** (ni `-----BEGIN`, ni base64 de la clave) en broadcast, snapshot ni `tasks.jsonl`; aparece `[REDACTED_PRIVATE_KEY]`/`[REDACTED_PARTIAL_KEY]`. Incluir explícitamente el **caso truncado** (clave cortada a 500 sin `END`).
- El test de redacción existente (`canvas-live.test.ts`) sigue verde.

## Deploy
Local (reiniciar gateway). Mergear `codex/observabilidad-canvas-live` → `produ` recién tras este patch verde + tu firma.

## Hecho cuando
Ningún fragmento de clave PEM (completo o truncado) puede llegar al feed Live ni a la persistencia, con test que cubre el caso truncado. Reportá SHA.
