# OPS Codex Hotfix — Webdock adapter sin log de body en errores 4xx

**Fecha:** 2026-05-30 sábado ~18:50 COT.
**Severidad:** P1 — bloquea smoke E2E paso 3 (create_webdock_server).
**Owner:** Codex backend senior.
**PM:** Claude.

---

## Síntoma

Smoke E2E paso 3 (`create_webdock_server`) responde HTTP 502 con:

```json
{
  "outcome": {
    "error": "webdock_server_create_failed",
    "message": "Webdock API returned 400 Bad Request"
  }
}
```

Sin más detalle. El body real del 400 de Webdock NO se captura en el workspace file (`runtime/openclaw-workspace/executions/2026-05-30/234519-provision_webdock_vps-mail.delivrix-notify.com-failed.md`).

## Reproducción

```bash
cd "/Users/juanescanar/Documents/delivrix app"
bash scripts/smoke-paso-3-submit.sh
bash scripts/smoke-paso-3-firmar.sh
# → execution_failed + workspace file sin body de Webdock
```

## Diagnóstico parcial encontrado

Curl directo a Webdock (sin pasar por adapter) reveló:

```bash
curl -X POST https://api.webdock.io/v1/servers \
  -H "Authorization: Bearer $WEBDOCK_API_KEY_OPS" \
  -d '{"name":"...","locationId":"dk","profileSlug":"vps-xeon-essential-2025","imageSlug":"ubuntu-2404","publicKeys":[]}'

# Response:
# {"id":0,"message":"Selected image is not valid."}
```

El image slug **real** vigente en Webdock 2026 es `webdock-ubuntu-noble-cloud`. El adapter (`packages/adapters/src/webdock-real-adapter.ts` línea 864-870) **YA tiene el mapeo correcto**:

```typescript
function resolveImageSlug(imageSlug: WebdockProvisionImageSlug): string {
  const map: Record<WebdockProvisionImageSlug, string> = {
    "ubuntu-2404": "webdock-ubuntu-noble-cloud",
    "debian-12": "webdock-debian-bookworm-cloud"
  };
  return map[imageSlug];
}
```

**Pero el smoke vía /sign sigue fallando con 400 de Webdock.** Hipótesis:
- El handler del gateway NO está usando este adapter real (posible mock o adapter alterno)
- El gateway tiene cache del módulo viejo
- El error no es por imageSlug sino por OTRO campo (profileSlug, publicKeys array, locationId)

## Tareas

### 1. Modificar `webdock-real-adapter.ts` para loggear body 4xx

Línea 306-308 actual:
```typescript
if (!response.ok) {
  throw new Error(`Webdock API returned ${response.status} ${response.statusText}`);
}
```

Cambiar a:
```typescript
if (!response.ok) {
  const body = await response.text().catch(() => "");
  throw new Error(
    `Webdock API returned ${response.status} ${response.statusText}: ${body.slice(0, 500)}`
  );
}
```

Aplicar el mismo patrón a las demás llamadas HTTP del adapter (ensureServerSshAccess, etc).

### 2. Verificar qué adapter usa el handler en main.ts

Buscar la instanciación del adapter de Webdock pasada a `handleWebdockServerCreate`. Asegurar que:
- Es `WebdockRealAdapter` (no mock)
- `resolveImageSlug` se invoca antes del HTTP POST
- `WEBDOCK_API_KEY_OPS` y `WEBDOCK_API_KEY_ACCOUNT` están cargadas del env

### 3. Capturar body en workspace file

El handler `apps/gateway-api/src/routes/webdock-servers.ts` debería incluir el body completo del error en el workspace file de evidence, no solo el message.

### 4. Smoke E2E paso 3 post-hotfix

```bash
git pull origin main
lsof -ti :3000 | xargs kill -9
screen -dmS delivrix-gateway bash -lc '...'
sleep 6
curl http://127.0.0.1:3000/health
bash scripts/smoke-paso-3-submit.sh
bash scripts/smoke-paso-3-firmar.sh
```

Esperado: `status: executed` + outcome con server slug + ipv4 + status `provisioning`.

## Estado del repo

- SHA actual main: `c895559` (Codex hotfix Redis/gateway hung) + 5631310 PM
- Scripts smoke listos: `scripts/smoke-paso-{1,3}-{submit,firmar}.sh`
- Server fantasma del 27/05 sigue stopped + scheduled deletion 2026-06-01 (NO usar)
- Dominio `delivrix-notify.com` registrado en Route53 paso 1 sábado ($15 cobrados)
- `runtime/last-proposal-id-paso3.txt` contiene última proposal expirada

## Pre-requisito antes de cerrar OPS

- Tests verdes adapter + handler
- Push hotfix a main + reportar PM con SHA
- PM Claude re-ejecuta smoke paso 3 con el fix

---

— Claude PM
