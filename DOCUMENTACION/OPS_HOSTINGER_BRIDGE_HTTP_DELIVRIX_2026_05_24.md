# OPS Hostinger — Bridge HTTP/WSS para chat real Delivrix

**Fecha:** 2026-05-24
**Estado upstream Hostinger:** bloqueante para Delivrix MVP día 30
**Owner solicitante:** Delivrix (gateway local + admin panel)
**Owner ejecutor:** equipo que mantiene la imagen `ghcr.io/hostinger/hvps-openclaw`

---

## 1. Contexto

El container `openclaw-dtsf-openclaw-1` en `2.24.223.240:61175` aloja OpenClaw, un agente LLM gobernado por reglas que Delivrix usa para automatizar provisionamiento de infraestructura de envío. Tras la migración a Amazon Bedrock (`us.anthropic.claude-sonnet-4-6` cross-region us-east-1, commit `093bfc4`), el RPC interno funciona:

- `openclaw gateway call chat.send --json ...` → `status: started`.
- `openclaw gateway call chat.history --json ...` → respuestas del asistente con `provider: amazon-bedrock`.

**Lo que NO funciona** es el bridge HTTP/WSS expuesto en el puerto `61175` que Delivrix necesita para conectar el admin panel (React) y el gateway (`apps/gateway-api/`) al chat real.

Verificación 2026-05-24 (sesión Codex):

| Probe | Resultado actual | Resultado esperado |
|---|---|---|
| `GET http://2.24.223.240:61175/` | HTTP 200 + HTML login | irrelevante (puede seguir así) |
| `GET http://2.24.223.240:61175/health` | HTTP 200 + HTML login | HTTP 200 JSON `{ status: "ok", ... }` |
| `POST .../api/chat.send` (externo, Bearer token) | HTTP 200 + HTML login | HTTP 200 JSON `{ msgId, queued: true }` |
| `POST .../api/chat.send` (interno container) | HTTP 404 `Not Found` | HTTP 200 JSON `{ msgId, queued: true }` |
| `WSS .../api/chat.stream?token=...` | sin endpoint | conexión establecida + eventos `ASSISTANT_DONE` |

El bridge no existe como código fuente en la imagen, solo el bundle `/hostinger/server.mjs` que sirve el dashboard de hVPS. Una mutación manual al bundle no es aceptable porque se perdería en cualquier redeploy.

## 2. Contrato exacto requerido por Delivrix

Las tres rutas siguientes deben quedar implementadas **en la fuente de la imagen del container** y publicadas en el puerto que el container ya expone (`61175`).

### 2.1 `GET /health`

Pública, sin auth. Devuelve JSON breve para que el gateway local pueda probar liveness sin parsear HTML.

```json
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "ok",
  "service": "openclaw",
  "version": "<image tag o git sha>",
  "uptimeSec": 12345
}
```

### 2.2 `POST /api/chat.send`

Autenticada con `Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN`. Recibe mensaje del operador desde el gateway Delivrix, lo encola en OpenClaw, devuelve un ACK estricto.

**Request del gateway:**

```http
POST /api/chat.send HTTP/1.1
Host: 2.24.223.240:61175
Authorization: Bearer <token>
Content-Type: application/json

{
  "msgId": "delivrix-2026-05-24-abc123",
  "actor": "op-juanes-a",
  "text": "¿Estado del cluster A?",
  "context": {
    "originatedFrom": "delivrix.admin-panel",
    "ts": "2026-05-24T18:00:00Z"
  }
}
```

**Response esperada (estricta):**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "msgId": "delivrix-2026-05-24-abc123",
  "queued": true
}
```

Reglas que el gateway local ya valida y por las que **rechaza con HTTP 502 `openclaw_chat_send_invalid_response`** si no se cumplen (commit `093bfc4`):

- Response debe ser JSON parseable. HTML 200 (página de login) → rechazo.
- `queued: true` obligatorio.
- Si upstream incluye `msgId`, debe coincidir con el enviado.

Errores válidos (no causan 502 sino propagación con código):
- HTTP 401 si el Bearer token no coincide con `$OPENCLAW_GATEWAY_TOKEN` interno.
- HTTP 429 si la cola está saturada.
- HTTP 503 si OpenClaw está reiniciando.

### 2.3 `WSS /api/chat.stream?token=<OPENCLAW_GATEWAY_TOKEN>`

Conexión WebSocket persistente que el admin panel usa para streaming de respuestas del agente.

**Handshake:**

```
GET /api/chat.stream?token=<token> HTTP/1.1
Upgrade: websocket
Connection: Upgrade
```

Token vía query param (no header) porque el browser WebSocket API no permite custom headers en el handshake.

**Eventos emitidos por el server** (texto JSON, una línea por evento):

```json
{ "type": "ASSISTANT_TYPING", "msgId": "delivrix-...", "ts": "2026-05-24T18:00:01Z" }
{ "type": "ASSISTANT_DELTA", "msgId": "delivrix-...", "delta": "El cluster A ", "ts": "..." }
{ "type": "ASSISTANT_DELTA", "msgId": "delivrix-...", "delta": "está activo.", "ts": "..." }
{ "type": "ASSISTANT_DONE", "msgId": "delivrix-...", "ts": "2026-05-24T18:00:03Z" }
```

El `ASSISTANT_DONE` es obligatorio al finalizar — el panel cierra el "loading" del bubble cuando lo recibe. Sin ese evento el UI se queda colgado en "Pensando…".

Si OpenClaw decide que una respuesta requiere aprobación humana antes de continuar, debe emitir:

```json
{ "type": "ASSISTANT_BLOCKED", "msgId": "...", "reason": "<rule-id>", "ts": "..." }
```

## 3. Persistencia

El bridge debe quedar en la **fuente** de la imagen, no en parches a `/hostinger/server.mjs` dentro del container corriendo. Razones:

- Cualquier `docker compose pull && up` borra parches manuales.
- No tenemos visibilidad sobre la cadencia con la que Hostinger actualiza la imagen base.
- El audit Delivrix exige que el contrato esté commiteado y reproducible.

Sugerencia (no prescriptiva): exponer las 3 rutas como un sidecar express/fastify dentro de la imagen, montado en el mismo puerto vía reverse proxy interno. El RPC `openclaw gateway call chat.send` ya existe — el bridge HTTP solo lo expone con auth + ACK estricto.

## 4. Verificación que Delivrix correrá al recibir el deploy

```bash
# 1. health
curl -fsS http://2.24.223.240:61175/health
# esperado: { "status": "ok", ... }

# 2. chat.send con token bueno
curl -fsS -X POST http://2.24.223.240:61175/api/chat.send \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "msgId": "smoke-001", "actor": "delivrix-smoke", "text": "hola" }'
# esperado: { "msgId": "smoke-001", "queued": true }

# 3. chat.send con token malo
curl -fsS -X POST http://2.24.223.240:61175/api/chat.send \
  -H "Authorization: Bearer wrong" \
  -d '{}'
# esperado: HTTP 401

# 4. WSS handshake
wscat -c "ws://2.24.223.240:61175/api/chat.stream?token=$OPENCLAW_GATEWAY_TOKEN"
# esperado: conexión establecida; al hacer chat.send debe llegar al menos un
#           ASSISTANT_DONE para ese msgId.
```

Una vez los 4 probes pasen, Delivrix corre suite local `node --test apps/gateway-api/src/openclaw-chat.test.ts` apuntada al host real para confirmar fin-a-fin.

## 5. Lo que NO se pide

- No se pide cambiar el provider (Bedrock está OK).
- No se pide exponer el panel administrativo hVPS al público.
- No se pide ningún token nuevo — `OPENCLAW_GATEWAY_TOKEN` ya existe dentro del container.
- No se pide migrar de modelo (`us.anthropic.claude-sonnet-4-6` está bien).

## 6. Estado mitigación lado Delivrix (no requiere acción del equipo Hostinger)

Mientras el bridge no esté implementado, Delivrix:

- Gateway local rechaza HTML200 como falso ACK y devuelve HTTP 502 explícito.
- Admin panel Canvas v4 muestra empty state con indicador `✕ offline`.
- Suite `npm test` pasa (209/209).
- Workflow operativo del MVP sigue funcionando por las rutas no-chat (Webdock, Hardware, Safety, Learning, Reports).

Esto es comportamiento esperado, no urgencia para parches manuales.

## 7. Referencias

- Commit gateway mitigation: `093bfc4 fix(gateway): reject invalid OpenClaw chat acknowledgements`.
- Test suite: `apps/gateway-api/src/openclaw-chat.test.ts`.
- Doc de cierre del bloque que descubrió el problema: `DOCUMENTACION/OPS_CODEX_BLOQUE_2_RESULT_2026_05_24.md`.
- Contract types lado Delivrix: `packages/domain/src/openclaw-chat.ts`.
