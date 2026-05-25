# OPS Codex Bloque 3 — distribución Hostinger + Hito 5.12 backend

**Fecha:** 2026-05-24
**Worktree:** `/Users/juanescanar/Documents/delivrix app`
**Branch base:** `main` (HEAD `5f8c217`)
**Trabajo paralelo:** Claude está en el mismo worktree arreglando bugs visuales del panel (no toca backend ni docs ops).

## Tareas

### T1 — Coordinar envío del OPS Hostinger Bridge HTTP

**Status:** doc redactado por Claude en `DOCUMENTACION/OPS_HOSTINGER_BRIDGE_HTTP_DELIVRIX_2026_05_24.md` (commit en 5f8c217). Falta hacer llegar el contrato al equipo que mantiene `ghcr.io/hostinger/hvps-openclaw`.

**Objetivo:** que ese equipo implemente y despliegue persistentemente en la imagen los 3 endpoints:
- `GET /health`
- `POST /api/chat.send` con ACK estricto `{ msgId, queued: true }`
- `WSS /api/chat.stream` con evento `ASSISTANT_DONE`

**Acciones que pedimos a Codex:**
1. Revisar si tenemos canal directo con el equipo de la imagen Hostinger (Slack workspace compartido / email / GitHub repo). Si lo hay, abrir un ticket apuntando al doc y a este OPS.
2. Si NO hay canal directo: abrir issue en el repo público de hvps-openclaw (si existe) o levantar el contacto vía soporte Hostinger comercial citando el doc.
3. Registrar el touchpoint en `DOCUMENTACION/OPS_CODEX_BLOQUE_3_RESULT_2026_05_24.md` con fecha, canal, ID de ticket si lo hay.

**Lo que NO debe hacer Codex:**
- Parchear el bundle `/hostinger/server.mjs` manualmente dentro del container corriendo. Ese fix se pierde en redeploy.
- Tocar `apps/gateway-api/` para "evitar el 502". El 502 actual es correcto y debe quedarse hasta que el bridge real exista.

### T2 — Backend `GET /v1/infrastructure/inventory` (Hito 5.12)

**Status:** frontend Infrastructure feature ya está en main (commit en 5f8c217, archivo `apps/admin-panel/src/features/infrastructure/index.tsx`). Consume `GET /v1/infrastructure/inventory` con auto-poll cada 30s y muestra error state explícito cuando el endpoint no existe (sin mock fallback).

**Contrato que el front espera (lo que Codex debe implementar en `apps/gateway-api/`):**

```http
GET /v1/infrastructure/inventory HTTP/1.1
Host: localhost:3000

HTTP/1.1 200 OK
Content-Type: application/json

{
  "generatedAt": "2026-05-24T18:00:00Z",
  "providers": [
    {
      "id": "webdock-fra-01",
      "name": "Webdock Frankfurt 01",
      "kind": "compute",
      "status": "active",
      "itemCount": 3,
      "source": "live",
      "lastSyncAt": "2026-05-24T17:59:30Z",
      "items": [
        { "id": "vm-001", "name": "smtp-out-01", "region": "fra1", "ip": "x.x.x.x", "status": "active" }
      ]
    },
    {
      "id": "aws-us-east-1",
      "name": "AWS Bedrock us-east-1",
      "kind": "compute",
      "status": "active",
      "itemCount": 1,
      "source": "live",
      "lastSyncAt": "2026-05-24T17:59:30Z",
      "items": [...]
    },
    {
      "id": "ionos-cloud-dns",
      "name": "IONOS Cloud DNS",
      "kind": "dns",
      "status": "active",
      "itemCount": 5,
      "source": "live",
      "lastSyncAt": "2026-05-24T17:59:30Z",
      "items": [...]
    }
  ]
}
```

**KIND_META válidos** (definidos en el front): `compute`, `dns`, `domain-registrar`, `physical`.
**STATUS_META válidos** (definidos en el front): `active`, `paused`, `error`, `planned`.

**Trabajo concreto:**
1. Definir contract types en `packages/domain/src/infrastructure-inventory.ts` (exportar `InfrastructureInventoryResponse`, `Provider`, `ProviderKind`, `ProviderStatus`).
2. Implementar handler en `apps/gateway-api/src/routes/infrastructure.ts` que agregue:
   - Webdock × 3 vía `GET /v1/webdock/inventory` (ya existe, ojo con el fix de #21 audit pollution).
   - AWS Bedrock vía AWS SDK o cache local del setup `ops/openclaw-bedrock-aws-setup.sh`.
   - IONOS Cloud DNS vía API o cache (si la cuenta IONOS ya está activa).
   - Servidor físico Medellín como `kind: "physical"`, `status: "planned"` (no online aún, ver `delivrix_servidor_fisico` memoria).
3. Audit append-only en `oc.infrastructure.inventory.fetch` con resumen `{ providerCount, itemTotal }`. NO loguear IPs ni hostnames específicos.
4. Tests en `apps/gateway-api/src/routes/infrastructure.test.ts` cubriendo:
   - 200 con providers vacío si no hay nada conectado.
   - 200 con providers parciales si AWS responde pero IONOS falla (graceful degradation con `status: "error"` + `errorReason`).
   - Audit chain mantiene SHA-256 íntegro tras N polls de 5min.
5. Mientras AWS/IONOS aún no estén integrados con creds reales, devolver `source: "mock"` en esos providers y `status: "planned"` con `errorReason: "creds_not_configured"`. El front ya pinta esos estados.

**Done criteria:**
- `node --test apps/gateway-api/src/routes/infrastructure.test.ts` pasa.
- `npm test` sigue OK 209+ tests.
- `curl -fsS http://localhost:3000/v1/infrastructure/inventory` devuelve JSON con al menos 1 provider activo (Webdock).
- Audit JSONL no pollutes (igual que webdock fix #21).

## Coordinación con Claude

Claude trabaja en paralelo arreglando bugs visuales del admin panel (`apps/admin-panel/src/`). NO toca:
- `apps/gateway-api/`
- `packages/domain/src/infrastructure-inventory.ts` (Codex lo crea)
- `DOCUMENTACION/OPS_HOSTINGER_BRIDGE_HTTP_DELIVRIX_2026_05_24.md` (ya commiteado)
- Audit chain.

Si Codex necesita tocar algo del front (improbable), avisar para evitar conflict.

## Verificación final esperada

Codex publica `DOCUMENTACION/OPS_CODEX_BLOQUE_3_RESULT_2026_05_24.md` con:
- T1: canal usado + ID ticket Hostinger o "sin canal directo, pendiente decisión humana".
- T2: SHA commit con backend infrastructure inventory + ejemplo curl real.
