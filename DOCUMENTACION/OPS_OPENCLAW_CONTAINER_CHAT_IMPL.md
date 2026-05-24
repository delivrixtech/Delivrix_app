# OPS — Verificacion OpenClaw container chat endpoints

Fecha: 2026-05-24  
Estado: bloqueado por credenciales locales faltantes  
Scope: verificar que el container Hostinger expone `POST /api/chat.send` y `WSS /api/chat.stream`.

## Resultado ejecutivo

No se pudo completar la verificacion interna por SSH porque la llave esperada no existe en esta maquina:

```txt
~/.ssh/openclaw-hostinger: no existe
```

Tambien falta el token requerido para probar el flujo autenticado:

```txt
OPENCLAW_GATEWAY_TOKEN: no encontrado en .env.local de raiz
```

Se encontro un `.env.local` dentro de `.claude/worktrees/youthful-mirzakhani-c517de/`, pero solo contiene variables `DELIVRIX_OPENCLAW_TOKEN` y `OPENCLAW_HMAC_SECRET`; no contiene `OPENCLAW_GATEWAY_TOKEN` ni ruta SSH.

## Evidencia obtenida sin SSH

### Servicio publico OpenClaw

`http://2.24.223.240:61175/` responde `200 OK` con la UI HTML de login de OpenClaw.

### POST `/api/chat.send`

Comando probado sin token:

```bash
curl -i -s --max-time 10 http://2.24.223.240:61175/api/chat.send \
  -H 'Content-Type: application/json' \
  -d '{"sessionKey":"agent:main:operator","msgId":"test","message":{"role":"user","content":"ping"}}'
```

Resultado:

```txt
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
```

El body recibido fue la pagina HTML de login. Esto confirma que el servicio publico responde, pero no confirma que `chat.send` este implementado detras de autenticacion. No es el JSON esperado `{ msgId, queued: true }`.

### WSS `/api/chat.stream`

Comando probado sin token real:

```bash
curl --max-time 3 -i --no-buffer --http1.1 \
  'http://2.24.223.240:61175/api/chat.stream?token=missing' \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Sec-WebSocket-Version: 13'
```

Resultado:

```txt
HTTP/1.1 101 Switching Protocols
{"type":"event","event":"connect.challenge","payload":{"nonce":"...","ts":...}}
```

Esto indica que la ruta WebSocket existe y acepta upgrade, pero queda pendiente validar el flujo autenticado con `OPENCLAW_GATEWAY_TOKEN`.

## Bloqueo

No se puede ejecutar la verificacion solicitada dentro del container:

```bash
ssh -i ~/.ssh/openclaw-hostinger root@2.24.223.240
docker ps | grep openclaw
docker exec openclaw curl -s http://localhost:61175/api/chat.send ...
wscat -c ws://localhost:61175/api/chat.stream?token=$OPENCLAW_GATEWAY_TOKEN
```

Intento alternativo con la llave local `~/.ssh/delivrix_app_github`:

```txt
root@2.24.223.240: Permission denied (publickey,password).
```

## Criterio de cierre

La tarea queda cerrada cuando un operador provea una de estas dos opciones:

1. Llave SSH valida en `~/.ssh/openclaw-hostinger` o ruta alternativa aprobada.
2. `OPENCLAW_GATEWAY_TOKEN` local para probar los endpoints publicos autenticados.

Con acceso disponible, ejecutar:

```bash
ssh -i ~/.ssh/openclaw-hostinger root@2.24.223.240 'docker ps'
ssh -i ~/.ssh/openclaw-hostinger root@2.24.223.240 'docker exec openclaw-dtsf-openclaw-1 curl -i -s http://localhost:61175/api/chat.send -H "Content-Type: application/json" -d "{\"sessionKey\":\"agent:main:operator\",\"msgId\":\"test\",\"message\":{\"role\":\"user\",\"content\":\"ping\"}}"'
ssh -i ~/.ssh/openclaw-hostinger root@2.24.223.240 'docker exec openclaw-dtsf-openclaw-1 sh -lc "wscat -c ws://localhost:61175/api/chat.stream?token=$OPENCLAW_GATEWAY_TOKEN"'
```

Si `POST /api/chat.send` devuelve `404` o HTML de login tambien desde dentro del container, implementar el endpoint en el container antes de usar el ChatWidget del panel.

