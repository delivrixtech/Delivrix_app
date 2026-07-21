# Runbook operativo — verificación live + reautenticación de cuentas (2026-06-24)

Para correr en tu Mac (el gateway corre local en `127.0.0.1:3000`). Cierra las 3 incógnitas que el sandbox no alcanza y reactiva las 2 cuentas en 401. Todo es lectura salvo la Parte C (editar env + restart). Los comandos leen el token/credenciales del env y **no los imprimen**.

Prerrequisitos:

```bash
cd "/Users/juanescanar/Documents/delivrix app"
# carga el token de lectura en una variable de shell (no se imprime)
TOKEN=$(grep -E '^DELIVRIX_READ_BOUNDARY_TOKEN=' .env.local | head -1 | cut -d= -f2- | tr -d '"'"'"'" ')
[ -n "$TOKEN" ] && echo "token cargado OK" || echo "FALLO: token vacio"
# verifica que el gateway responde
curl -s -o /dev/null -w "gateway health: %{http_code}\n" http://127.0.0.1:3000/health
```

---

## Parte A — Memoria episódica: ¿503 (esquema) o 200 (Postgres)?

```bash
# 1) codigo HTTP del endpoint que usa OpenClaw para memoria
curl -s -o /dev/null -w "scratch HTTP: %{http_code}\n" \
  -H "x-delivrix-token: $TOKEN" \
  "http://127.0.0.1:3000/v1/openclaw/scratch?grounded=true&query=smtp"

# 2) cuerpo (primeros 400 chars) para ver el reason
curl -s -H "x-delivrix-token: $TOKEN" \
  "http://127.0.0.1:3000/v1/openclaw/scratch?grounded=true&query=smtp" | head -c 400; echo
```

Interpretación:

- **200** con lista vacía o `reason` de conexión → Postgres está caído o no conectado. La memoria NO es el problema de esquema; arranca Postgres: `docker compose -f infra/docker-compose.yml up -d` y reintenta.
- **503** (`episodic_scratch_unavailable`) → es **esquema**, no conexión. Sigue a la consulta de Postgres:

```bash
# revisa que exista la tabla y sus columnas
PGURL=$(grep -E '^POSTGRES_URL=' .env.local | head -1 | cut -d= -f2- | tr -d '"'"'"'" ')
psql "$PGURL" -c '\d openclaw_episodic_scratch'
```

- Error **"did not find any relation"** → la tabla no existe (`42P01`): falta correr la migración del store episódico.
- Tabla existe pero **faltan columnas** `reliability` / `plane` / `invalid_at` / `ttl_expires_at` → migración a medias (`42703`).

En ambos casos el arreglo es correr/completar las migraciones de `openclaw_episodic_scratch` en esta base. Si no encuentras un script de migración en el repo, es señal de que el esquema nunca se creó en esta DB → ese es el item para Codex (crear/aplicar la migración). Pégame el output de los dos comandos y te confirmo cuál de los dos casos es.

---

## Parte B — Cuentas en 401 + ¿Contabo se está quedando fuera?

```bash
# inventario MULTI-cuenta (lo que ve el panel). Estado e items por cuenta:
curl -s -H "x-delivrix-token: $TOKEN" \
  "http://127.0.0.1:3000/v1/infrastructure/inventory" \
  | jq '.providers[] | select(.kind=="compute") | {id, displayName, status, itemCount, fetchSourceKind, errorReason}'
```

Esperado (segun lo visto en el panel): Dep Infraestructura `active`, InfraVPS `paused`, Contabo `active`, y **pep.prz001 + Host Latam con `status:"error"` y `errorReason` con 401**. Si esas dos siguen en error → van a la Parte C.

```bash
# inventario MONO-cuenta (lo que la tool de OpenClaw consulta hoy). Cuenta servers:
curl -s -H "x-delivrix-token: $TOKEN" \
  "http://127.0.0.1:3000/v1/webdock/inventory" \
  | jq '{summary: .inventory.summary, servers: (.inventory.servers | length)}'
```

Comparación que confirma la inanición de Contabo: suma `itemCount` de los providers Webdock del primer comando; si ya supera ~12-20, los 8 de Contabo se están cayendo del recorte del contexto de OpenClaw (lo que arregla el brief de código P0.2).

---

## Parte C — Reautenticar pep.prz001 (SECONDARY) y Host Latam (TERTIARY)

El botón "Reautenticar" del panel es decorativo; esto se hace por env + restart. **Primero confirma que la cuenta esté viva** (no suspendida por abuso): entra a `https://app.webdock.io` con cada cuenta y mira Billing/estado. Si Webdock la suspendió, rotar el token no sirve — hay que resolver con ellos primero.

Si la cuenta está viva, en su dashboard: **Account → API Keys → Add API Token**, con los 4 scopes en **Read/Write** (Provisioning, Servers, Account, Billing).

Luego (haz backup del env antes — recuerda el clobber de Vercel del 9-jun):

```bash
cp .env.local ".env.local.bak-reauth-$(date +%Y%m%d%H%M)"
cp config/gateway.env "config/gateway.env.bak-reauth-$(date +%Y%m%d%H%M)"
```

Actualiza el **mismo token nuevo en las 3 variables del slot**, en `config/gateway.env` Y en `.env.local`:

- pep.prz001 → `WEBDOCK_API_KEY_SECONDARY`, `WEBDOCK_API_KEY_SECONDARY_WRITE`, `WEBDOCK_API_KEY_SECONDARY_ACCOUNT`
- Host Latam → `WEBDOCK_API_KEY_TERTIARY`, `WEBDOCK_API_KEY_TERTIARY_WRITE`, `WEBDOCK_API_KEY_TERTIARY_ACCOUNT`

Reinicia y re-verifica:

```bash
./restart-gateway.sh
# re-corre el primer comando de la Parte B; las 2 cuentas deberian pasar de "error" a "active"/"paused"
```

Nota: si una cuenta vuelve pero sus VPS aparecen detenidos (`paused`), es normal — los servidores existen, solo están stopped. Si Webdock confirma que la cuenta está baneada y no recuperable, esa es la señal para la decisión de producto (baja de cuenta del brief).

---

## Qué reportarme para cerrar el diagnóstico

Pégame: (1) el HTTP del scratch (Parte A) + el `\d` si fue 503; (2) el JSON de providers de la Parte B; (3) si tras la Parte C las dos cuentas volvieron. Con eso confirmo las 3 incógnitas y ajusto el brief de Codex si hace falta.
