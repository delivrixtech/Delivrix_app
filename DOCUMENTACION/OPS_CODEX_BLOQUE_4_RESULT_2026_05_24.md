# OPS Codex Bloque 4 Result — Webdock multi-cuenta + SSH bridge OpenClaw chat

**Fecha de cierre:** 2026-05-25  
**Branch:** `main`  
**Estado:** cerrado con una limitacion operativa para smoke SSH real

## T1 — Webdock multi-cuenta

**Commit:** `c5da438 feat(gateway): support Webdock multi-account inventory`

Implementado:

- `WebdockRealAdapter` acepta `apiKey`, `apiBase`/`baseUrl`, `accountId`, `accountLabel`, `env`, cache TTL independiente y fallback mock por instancia.
- Nuevo helper `createWebdockAdaptersFromEnv()`:
  - Lee `WEBDOCK_API_KEY_PRIMARY`, `WEBDOCK_API_KEY_SECONDARY`, `WEBDOCK_API_KEY_TERTIARY`.
  - Lee labels `WEBDOCK_ACCOUNT_PRIMARY_LABEL`, `WEBDOCK_ACCOUNT_SECONDARY_LABEL`, `WEBDOCK_ACCOUNT_TERTIARY_LABEL`.
  - Si no hay cuentas nuevas, usa fallback legacy `WEBDOCK_API_KEY`.
  - Si no hay ninguna key, conserva adapter mock `default` para desarrollo.
- `GET /v1/infrastructure/inventory` ahora construye un provider por cuenta Webdock:
  - `webdock-primary`
  - `webdock-secondary`
  - `webdock-tertiary`
  - o fallback `webdock-default`
- Cada item Webdock incluye metadata no sensible:
  - `accountId`
  - `accountLabel`
- La auditoria `oc.infrastructure.inventory.fetch` no registra IPs, hostnames ni nombres de servidores.

Tests agregados:

- 3 cuentas activas -> 3 providers con counts distintos.
- Cuenta legacy -> 1 provider `webdock-default`, label `Webdock`.
- Una cuenta fallando -> provider `error` con `errorReason`, sin ocultar cuentas sanas.
- Helper env multi-cuenta/legacy/mock.

Smoke local:

```bash
curl -i http://127.0.0.1:3000/v1/infrastructure/inventory
```

Resultado local: `HTTP/1.1 200 OK`, 4 providers totales:

- `webdock-default`: `active`, `itemCount: 3`, `fetchSourceKind: mock`
- `aws-bedrock-us-east-1`: `active`, `itemCount: 1`
- `ionos-cloud-dns`: `planned`
- `physical-medellin`: `planned`

Nota: este entorno local no tiene las 3 keys Webdock configuradas, por eso el smoke real cae en fallback legacy/mock. El camino multi-cuenta queda cubierto por tests automatizados.

## T2 — SSH bridge OpenClaw chat

**Commit:** `10edc5d feat(gateway): add OpenClaw SSH chat bridge`

Implementado:

- Nuevo adapter `apps/gateway-api/src/openclaw-ssh-bridge.ts`.
- `sendMessage()` ejecuta `ssh` con `spawn` y argumentos separados, luego `docker exec ... openclaw gateway call chat.send`.
- El ACK valida `status === "started"` y responde `{ msgId, queued: true }`.
- `streamHistory()` hace polling de `chat.history`, emite:
  - `ASSISTANT_TYPING`
  - `ASSISTANT_DELTA`
  - `ASSISTANT_DONE`
  - `ASSISTANT_BLOCKED`
- `OpenClawChatProxy` conmuta por env:
  - `OPENCLAW_BRIDGE_KIND=ssh` usa SSH bridge.
  - default/http conserva proxy HTTP actual.
  - tras N fallos consecutivos SSH, cae a HTTP.
- El WSS `/v1/openclaw/chat/stream` sigue exponiendo 101 al panel.

Tests agregados:

- Mock de runner SSH parsea `status: started`.
- Polling `chat.history` emite typing/delta/done.
- Fallback a HTTP tras fallos consecutivos SSH.
- Parser soporta `ASSISTANT_TYPING` y `ASSISTANT_BLOCKED`.

Smoke local:

```bash
curl -i --http1.1 --max-time 2 \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==' \
  -H 'Sec-WebSocket-Version: 13' \
  http://127.0.0.1:3000/v1/openclaw/chat/stream
```

Resultado: `HTTP/1.1 101 Switching Protocols`, primer frame `{"type":"AGENT_OFFLINE"}` bajo bridge HTTP/default.

```bash
curl -i --max-time 45 \
  -X POST http://127.0.0.1:3000/v1/openclaw/chat/send \
  -H 'content-type: application/json' \
  -d '{"message":"hola"}'
```

Resultado local actual: `HTTP/1.1 502 Bad Gateway`, `openclaw_chat_send_invalid_response`.

Limitacion operativa: el smoke SSH real no se pudo ejecutar porque este `.env.local` no tiene `OPENCLAW_BRIDGE_KIND=ssh` ni las variables SSH requeridas, y `~/.ssh/openclaw-hostinger` no existe en esta maquina. No se parcheo el contenedor Hostinger; el workaround queda listo para activarse cuando la key y el env esten disponibles.

Env requerido para activar SSH:

```bash
OPENCLAW_BRIDGE_KIND=ssh
OPENCLAW_SSH_HOST=2.24.223.240
OPENCLAW_SSH_PORT=22
OPENCLAW_SSH_USER=root
OPENCLAW_SSH_KEY_PATH=~/.ssh/openclaw-hostinger
OPENCLAW_CONTAINER_ID=openclaw-dtsf-openclaw-1
```

Limitaciones del SSH bridge:

- Es temporal y no debe considerarse produccion.
- Depende de llave SSH local, container corriendo y `docker exec` disponible.
- Tiene mas latencia y mas puntos de fallo que el bridge HTTP nativo.
- Debe retirarse cuando Hostinger entregue `/api/chat.send` y `/api/chat.stream`.

## Verificacion

```bash
node --test packages/adapters/src/webdock-real-adapter.test.ts apps/gateway-api/src/routes/infrastructure.test.ts
node --test apps/gateway-api/src/openclaw-ssh-bridge.test.ts apps/gateway-api/src/openclaw-chat.test.ts
npm test
```

Resultado:

- Tests enfocados Webdock: 9/9 OK.
- Tests enfocados chat/SSH: 7/7 OK.
- Suite completa: 221/221 OK.

Gateway local:

- URL: `http://127.0.0.1:3000`
- Estado: corriendo con el codigo nuevo tras reinicio local.
