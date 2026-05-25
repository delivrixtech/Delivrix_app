# OPS Codex Bloque 2 - Resultado

**Fecha:** 2026-05-24  
**Scope:** cierre de pendientes backend + verificacion de chat real OpenClaw Hostinger.

## Estado ejecutivo

**T1 OpenClaw chat real: AMARILLO/BLOQUEANTE.** El contenedor Hostinger esta arriba y Bedrock responde por el RPC interno de OpenClaw, pero el contrato HTTP/WSS que Delivrix espera no esta implementado en el servidor expuesto por el contenedor.

Impacto: el panel no debe considerar enviado un mensaje si upstream devuelve login HTML o cualquier respuesta distinta a `{ msgId, queued: true }`.

## Evidencia T1

- `http://2.24.223.240:61175/` responde HTTP 200 con HTML de login.
- `http://2.24.223.240:61175/health` responde HTML de login, no health JSON.
- `POST http://2.24.223.240:61175/api/chat.send` desde fuera devuelve HTTP 200 con HTML de login cuando pasa por el entrypoint publico.
- Desde dentro del contenedor, el mismo `POST /api/chat.send` autenticado llega al proxy interno y devuelve HTTP 404 `Not Found`.
- El contenedor `openclaw-dtsf-openclaw-1` esta corriendo y expone `61175`.
- `OPENCLAW_GATEWAY_TOKEN` existe dentro del contenedor, pero la longitud observada no coincide con la longitud del token local cargado en `.env.local`; no se imprimieron secretos.
- Las variables `BEDROCK_REGION` y `BEDROCK_MODEL_ID` no aparecen como env directas del contenedor, pero el RPC interno si puede hablar con Bedrock.
- RPC interno probado:
  - `openclaw gateway call chat.send --json ...` devuelve `status: started`.
  - `openclaw gateway call chat.history --json ...` devuelve respuestas del asistente con provider `amazon-bedrock` y modelo `us.anthropic.claude-sonnet-4-6`.

Conclusion: Bedrock no es el bloqueo principal. El bloqueo esta en el bridge HTTP/WSS `/api/chat.send` + `/api/chat.stream` del contenedor Hostinger.

## Mitigacion aplicada en gateway

El gateway local ahora valida el ACK de upstream para `POST /v1/openclaw/chat/send`:

- Requiere JSON parseable.
- Requiere `queued: true`.
- Si upstream incluye `msgId`, debe coincidir con el `msgId` enviado por el gateway.
- Si upstream devuelve login HTML con HTTP 200, el gateway responde 502 y audita `oc.chat.operator_message` como `reject` con `upstreamResponse: invalid_chat_send_ack`.

Esto evita el falso positivo previo donde cualquier HTTP 200 del login HTML se convertia en `{ queued: true }`.

## Pendiente para verde

Implementar o desplegar en el contenedor Hostinger el contrato:

- `POST /api/chat.send` autenticado con `Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN`.
- Respuesta estricta `{ "msgId": "<id>", "queued": true }`.
- `WSS /api/chat.stream?token=$OPENCLAW_GATEWAY_TOKEN`.
- Al terminar una respuesta del agente, emitir `ASSISTANT_DONE` hacia clientes conectados.

La implementacion debe ser persistente en la imagen o fuente del contenedor, no solo una mutacion manual del bundle `/hostinger/server.mjs`.

## T2 C2 canonical substrings

**Estado: CERRADO.** Commit `2906a89 fix(gateway): normalize C2 detector canonical tokens`.

Verificado en suite:

- `read_only` no se marca como hallucination si existe `allowed_read_only`.
- `dry_run` no se marca como hallucination si existe `allowed_dry_run`.
- Tokens inventados siguen marcandose como hallucination.

## T3 Webdock inventory audit pollution

**Estado: CERRADO.** Commit de verificacion `52f74e8 chore(ops): verify backend pending tasks`.

Evidencia:

- `GET /v1/webdock/inventory` no llama audit append en el handler de polls normales.
- Prueba de 5 minutos con polling cada 30s dejo `.audit/audit-events.jsonl` estable:
  - lineas: `212`
  - bytes: `155280`
  - sha256: `647bbbbbacba5e9f69ee37054a8b8a75de2d895c2636a7de925b17b7e152c17b`

## T4 Token en gateway local

**Estado: CERRADO.** Gateway reiniciado con `.env.local` cargado y `OPENCLAW_GATEWAY_TOKEN` disponible en runtime.

Nota: el endpoint local de chat ahora debe devolver 502 mientras el contenedor Hostinger siga entregando HTML/404 en lugar del ACK JSON requerido. Ese 502 es correcto y evita que el UI quede en falso "queued" por login HTML.

## Verificacion local

- `node --test apps/gateway-api/src/openclaw-chat.test.ts` -> pass.
- `npm test` -> pass, 209 tests.
- `POST http://localhost:3000/v1/openclaw/chat/send` con mensaje de diagnostico -> HTTP 502 `openclaw_chat_send_invalid_response`, esperado mientras Hostinger no entregue ACK JSON valido.
