# Codex — Observabilidad Canvas Live: cablear el trabajo del agente + heartbeat (resolver tabs vacías / "reconnecting")

> **Hacer ANTES de Fase 1.6.** Juanes necesita VER lo que hace el agente en tiempo real antes de darle más autonomía (adoptar dominios, cambiar NS). Hoy las tabs Live/Files/Terminal/Diff/Topología están vacías y el header dice "reconnecting" mientras el agente trabaja; solo se ve "escribiendo" en el chat.
> **Base:** `produ` (`f06cfe5`). Rama `codex/observabilidad-canvas-live`. Verificá `git log --oneline -1 produ` = `f06cfe5`.
> Subagentes senior + Auditor de Errores. Si choca → parar y reportar. Aditivo, sin tocar la lógica de gobernanza.

## Causa raíz (auditada, anclas reales)
- **El agente no emite a Canvas Live:** el bedrock-bridge se crea **sin** `canvasLiveEvents` (`apps/gateway-api/src/main.ts:342-356`; el config no tiene ese campo: `openclaw-bedrock-bridge.ts:99-129`; el tool-use no emite: `:391-400` / `tool-use-processor.ts`). **Solo** el orquestador emite (`orchestrator-smtp.ts:1016-1043` `safeEmit → deps.canvasLiveEvents?.emit`). → trabajo del agente = invisible en Live/Files/Comandos/Audit.
- **El chat va por otro canal** (`/v1/openclaw/chat/stream`, `openclaw-chat.ts` broadcasts) — por eso "escribiendo" sí aparece. Canvas live es `/v1/canvas/live/stream` (`gateway-upgrade-router.ts:29`, servicio `services/canvas-live-events.ts`).
- **Sin heartbeat:** `RawCanvasLiveWebSocketClient` (`canvas-live-events.ts:~756`) solo escucha data/close/error; no hay ping/pong → el socket idle se cae en inferencias largas → panel "reconnecting" (`canvas-live-client.ts` reconnect/backoff).
- **Token del stream:** `canvas-live-events.ts:74` usa `CANVAS_LIVE_STREAM_TOKEN ?? DELIVRIX_READ_BOUNDARY_TOKEN ?? OPENCLAW_GATEWAY_TOKEN`; si el panel manda un token distinto → WS rechaza → reconnecting.

## Fix (una solución, 3 piezas de la misma observabilidad)

### A — Cablear el bedrock-bridge para emitir eventos del trabajo del agente
1. Agregar `canvasLiveEvents?: CanvasLiveEmitter` al `OpenClawBedrockBridgeConfig` y **pasarlo desde `main.ts:342`** (ya existe la instancia del servicio).
2. En el loop del agente (`invokeBedrock` / donde despacha tool-use):
   - Al iniciar el turno/tarea: `oc.task.declare` (taskId estable: msgId/sessionId, title = resumen del mensaje del operador) + `oc.task.update` → running.
   - Por cada **tool-use**: `oc.action.now` con el `kind` correcto — `api` (llamada a tool/HTTP), `file` (read/write workspace o DNS read), `command` (SSH/shell), `audit` (acción gateada). Incluir nombre de tool, target, status.
   - Al terminar: `oc.task.update` → completed / failed.
3. Reusar los helpers/patrón del orquestador (`emitStep`/`emitFileAction`/`emitCommandAction`) para consistencia. **Redacción de secretos** igual que en el resto (nunca claves/tokens en eventos).
4. (Opcional pero ideal) emitir también los **reads** (read_route53/read_webdock/read_dns_ionos/scratch) como `oc.action.now kind:api|file` → así el diagnóstico del agente se ve en vivo.

### B — Heartbeat ping/pong en el WS de canvas (mata el "reconnecting")
En `RawCanvasLiveWebSocketClient` (`canvas-live-events.ts`): `setInterval` que envía **ping frame (RFC6455 opcode 0x9)** cada ~30s, manejar `pong`, y `clearInterval` en close. Aplicar el **mismo heartbeat al log stream** (`gateway-log-stream.ts`, `/v1/gateway/logs/stream`) para que la Terminal tampoco se caiga. (Opcional: que el cliente `canvas-live-client.ts` también pinguee.)

### C — Alinear el token del stream (panel ↔ gateway)
Verificar que el token que manda el panel (`VITE_CANVAS_LIVE_STREAM_TOKEN` o equivalente en `apps/admin-panel`) **matchee** el `streamToken` del gateway (`canvas-live-events.ts:74`). Documentar la env var correcta en ambos lados. Si no matchea, el WS rechaza y nunca conecta (otra fuente de "reconnecting"). Confirmar también que `GET /v1/canvas/live/state` (snapshot) responde 200 con ese token.

## Tests (node:test, run real)
- Un turno del agente (mock) emite `oc.task.declare` + `oc.action.now` por cada tool-use → se reciben en un cliente WS conectado.
- Heartbeat: un socket queda abierto pasado el timeout idle (se envía ping, no se cierra).
- Token correcto → WS acepta; token errado → rechaza (auth intacta).
- No-regresión: chat stream, emits del orquestador, audit, y los guardrails de Fase 1/1.5 sin cambios.

## Deploy
Cambio de **código** del gateway (bridge + WS) → **local** (reiniciar gateway, Node 24). Si tocás env del panel (token) → rebuild del panel. Sin cambio de system prompt → Hostinger no se toca (si por algo lo tocaras, regla de sync). Mergeá a `produ` tras tests verdes + tu firma.

## Hecho cuando
Mientras el agente trabaja (lee, diagnostica, llama tools), las tabs **Live/Files/Comandos/Audit se pueblan en tiempo real**, y la conexión queda **"live"** (sin "reconnecting") aún en inferencias largas. Reportá SHA + demo: un turno del agente que se vea reflejado en Live. (Recién entonces seguimos con Fase 1.6 — ya con ojos sobre lo que hace.)
