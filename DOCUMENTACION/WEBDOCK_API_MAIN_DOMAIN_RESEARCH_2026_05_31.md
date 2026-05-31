# Webdock API Main Domain Research

Fecha de verificacion: 2026-05-31.
Alcance: confirmar si la API publica de Webdock expone endpoints para cambiar Server Identity/Main Domain y PTR/rDNS antes de implementar `bind_webdock_main_domain`.

## Fuentes verificadas

- Webdock API docs: `https://webdock.io/en/docs/webdock-api/api-documentation`.
- Webdock API Quick Start: `https://webdock.io/en/docs/webdock-api/api-quick-start-guide`.
- Webdock API Callback Events: `https://webdock.io/en/docs/webdock-api/api-callback-events`.
- Webdock Server Identity docs: `https://webdock.io/en/docs/webdock-control-panel/getting-started/managing-your-server-identity`.
- Webdock FAQ rDNS: `https://webdock.io/en/docs/faq/how-do-i-set-reverse-dns-for-my-server`.

## Resultado

La documentacion oficial disponible no publica un endpoint REST confirmado para cambiar Main Domain/Server Identity ni un endpoint PTR dedicado.

Hallazgos:

- La API publica esta disponible en `https://api.webdock.io/v1` y la guia oficial muestra autenticacion `Authorization: Bearer <api-key>` y endpoint de prueba `GET /v1/ping`.
- La documentacion de Server Identity confirma que el panel de Webdock permite definir un dominio primario y alias. Esa herramienta configura tres cosas: virtual host web, hostname del sistema y PTR/rDNS del IP usando el dominio primario.
- La FAQ de rDNS confirma que lo definido como main domain bajo Server Identity se usa automaticamente como PTR del IP.
- La lista oficial de callback events incluye `set-hostnames`, descrito como evento disparado cuando se modifica la identidad del servidor. Esto confirma que existe una capacidad de plataforma, pero no documenta el request schema ni el endpoint REST para invocarla.
- No se encontro en las fuentes oficiales una ruta documentada como `PATCH /v1/servers/{slug}`, `POST /v1/servers/{slug}/main-domain`, `POST /v1/servers/{slug}/hostname`, `GET/POST /v1/servers/{slug}/ptr` ni un schema de body equivalente.

## Decision de implementacion

Ruta elegida: SSH fallback explicito.

- Main Domain/hostname: usar SSH contra el VPS y ejecutar `hostnamectl set-hostname <domain>` mas actualizacion de `/etc/hosts` para `127.0.1.1`.
- PTR: `not_supported_by_api`. No se inventa endpoint Webdock. La API del adapter retorna `{ ok: false, supported: false }` para `setServerPtr`.
- Seguridad: el dominio se valida en gateway y nuevamente en adapter con regex DNS estricta y bloqueo de prefijos (`mail`, `email`, `notify`, `noreply`, `alert`, `smtp`, `sender`, `inbox`, `bulk`, `blast`) antes de interpolarlo en cualquier comando. El comando SSH usa argumento shell single-quoted despues de validacion para evitar injection.
- Rollback: si PTR falla con error hard, el handler intenta restaurar el hostname anterior. Si ese rollback falla, emite `oc.webdock.bind_inconsistent_state` con `riskLevel: "critical"` para intervencion manual.

## Limitaciones

No se ejecuto llamada live con `WEBDOCK_API_KEY_PRIMARY` desde shell porque la red del sandbox local no resolvio PyPI/API durante la extraccion de PDF y no se debe bloquear el slice. Esta investigacion se basa en fuentes oficiales publicas verificadas por navegador el 2026-05-31.
