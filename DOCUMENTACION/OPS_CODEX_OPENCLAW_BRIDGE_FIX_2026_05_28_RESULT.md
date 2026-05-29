# RESULT — OPS Codex OpenClaw bridge ack mismatch

**Fecha:** 2026-05-28 / 2026-05-29 UTC  
**OPS origen:** `OPS_CODEX_OPENCLAW_BRIDGE_FIX_2026_05_28.md`  
**Owner ejecución:** Codex  
**Veredicto:** **Escenario C — upstream no devuelve contrato JSON; demo debe ir en modo skills-directas.**

## Escenario identificado

Escenario C.

El bridge conversacional no está listo para el Acto 3 por dos señales
independientes:

1. SSH directo al host OpenClaw con la key configurada en `.env.local` no
   autentica.
2. El upstream HTTP `chat.send` responde `HTTP/1.1 200 OK`, pero el body es la
   página HTML de login de OpenClaw, no el contrato JSON esperado por Delivrix.

Esto explica el error local:

```json
{
  "error": "openclaw_chat_send_invalid_response",
  "message": "OpenClaw chat.send returned an invalid acknowledgement."
}
```

## ACK crudo del intento SSH

Archivo local: `/tmp/openclaw-ack-raw.txt`  
SHA-256: `6d25b94e7fc9974435c74702b9e5af00c5f4257166ab7305b2d58420c13fa4ff`  
Bytes: `60`

```text
root@2.24.223.240: Permission denied (publickey,password).
```

No se pudo obtener el ACK del container por SSH porque la key local
`OPENCLAW_SSH_KEY_PATH` no autentica contra `root@2.24.223.240`.

## ACK HTTP crudo

Archivo local: `/tmp/openclaw-http-ack-raw.txt`  
SHA-256: `e4a993781ce236191dd0f7a980376995b9956d7e54726c5f4bf7d992e5ea0580`  
Bytes: `8215`

Extracto suficiente para clasificar el escenario:

```http
HTTP/1.1 200 OK
X-Powered-By: Express
Cache-Control: no-store, no-cache, must-revalidate
Content-Type: text/html; charset=utf-8
Content-Length: 7931
```

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>OpenClaw</title>
</head>
<body>
...
<form method="POST" action="/login">
    <input type="password" name="token" placeholder="Enter your OpenClaw gateway token" autofocus />
    <button type="submit">Login</button>
</form>
...
</body>
</html>
```

No se copia el HTML completo en este repo porque es una página de login
renderizada, no un ACK de contrato; el hash y byte size quedan arriba para
verificación local.

## Fix aplicado

No se aplicó cambio de gateway.

Motivo: no es Escenario A. No hay un `status` alternativo tipo `sent`,
`queued`, `ok` o `accepted` que convenga aceptar. El upstream está devolviendo
HTML/login y el SSH directo no autentica, así que ampliar el parser del gateway
ocultaría un problema real de configuración/contrato.

## Diagnóstico

El gateway actual espera uno de estos caminos:

- SSH: `docker exec openclaw-dtsf-openclaw-1 openclaw gateway call chat.send ...`
- HTTP: `POST /api/chat.send` con bearer token y respuesta JSON con
  `{ "queued": true, "msgId": ... }`

Lo observado:

- El historial audit local muestra fallos SSH previos con
  `SSH command failed with exit 255`.
- Al degradar a HTTP, OpenClaw responde status 200 con HTML de login.
- El endpoint local rechaza correctamente ese body como
  `openclaw_chat_send_invalid_response`.

Hipótesis más probable: el servicio OpenClaw accesible en el puerto HTTP es la
UI/login genérica o una imagen/config anterior que no expone el contrato
Delivrix `chat.send` autenticado para gateway. También hay una brecha de acceso
SSH: la key local no permite inspeccionar el container desde Codex.

## Veredicto demo

Para el demo viernes 11h COT:

- **No usar Acto 3 conversacional como camino principal.**
- Usar **skills directas vía panel** como plan principal/plan B narrativo.
- No redeployar Hostinger pre-demo sin ventana coordinada con Juanes.

## Secret handling

No se imprimió `OPENCLAW_GATEWAY_TOKEN` ni contenido de private keys. No se
detectaron secrets en los outputs guardados.

## Checks ejecutados

- `curl http://127.0.0.1:3000/v1/openclaw/chat/send`: reproduce
  `openclaw_chat_send_invalid_response`.
- `ssh -i /Users/juanescanar/.ssh/delivrix-ops ...`: falla con
  `Permission denied (publickey,password)`.
- `curl` externo a `http://2.24.223.240:61175/api/chat.send`: devuelve
  `HTTP/1.1 200 OK` con HTML de login.
