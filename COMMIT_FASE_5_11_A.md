# COMMIT FASE 5.11.A — Webdock READ live + OpenClaw rules-based drift

## Resumen

Primer paso para romper la dependencia de mocks: conectamos Webdock en modo
**lectura real** (`GET /v1/servers` con Bearer auth) y damos a OpenClaw un
primer cerebro real, un **rules engine** que compara el inventario vivo
contra el registry local de sender_nodes y emite propuestas tipadas.

El bundle frontend sigue **GET-only** (28 endpoints en read-boundary, 0
mutaciones). Las propuestas de drift se cuelgan del Canvas como antes y se
aprueban afuera del panel con el runbook + regla de dos personas firmada.

Norte operativo intacto.

## Cambios

### Adapter (`packages/adapters/src/`)

- **`webdock-real-adapter.ts`** (nuevo): cliente HTTP nativo a
  `https://api.webdock.io/v1/servers`. Bearer auth desde `process.env.WEBDOCK_API_KEY`.
  Cache TTL 60s. Fallback silencioso a mock (3 servers canónicos) cuando la
  env var no existe — permite dev local sin tocar la cuenta real.
  - `WebdockRealAdapter#listServers()` devuelve `{ servers, source }` con
    `source.kind === "live" | "mock"` y `responseOk` para que el frontend
    distinga.

### Domain (`packages/domain/src/`)

- **`webdock-inventory.ts`** (nuevo): `buildWebdockInventoryContract({ servers,
  source })` devuelve `WebdockInventoryContract` con `schemaVersion`,
  `summary {total, running, stopped, suspended, other}` y la lista canónica
  de servers normalizada.
- **`openclaw-rules.ts`** (nuevo): el primer cerebro real de OpenClaw —
  rules engine sin LLM. `evaluateWebdockDrift({webdockServers, senderNodes})`
  cruza ambos lados y emite `OpenClawDriftProposal[]` ordenadas por severidad:
  - `webdock running` + `sender paused/retired` → `node_resume_proposed` (medium)
  - `webdock stopped/suspended/error` + `sender active/warming` → `node_pause_proposed` (high)
  - Webdock server sin sender registrado → `node_register_proposed` (low)
  - sender provider=webdock sin server real → `node_orphan_warning` (medium)
  - Cada propuesta lleva `runbookRef` apuntando al .md correspondiente.

Tests nuevos: `webdock-inventory.test.ts` (3) + `openclaw-rules.test.ts` (7).
**Total domain: 148/148 ok.**

### Gateway (`apps/gateway-api/src/main.ts`)

- Nuevo handler `GET /v1/webdock/inventory` que:
  1. Llama al `WebdockRealAdapter.listServers()`.
  2. Lee `senderNodeRegistry.list()` local.
  3. Aplica `evaluateWebdockDrift(...)`.
  4. Devuelve `{ inventory: WebdockInventoryContract, drift: { proposals, ... } }`.
  5. Append al audit log de cada llamada con `serverCount`, `driftProposals`,
     `sourceKind`, `responseOk`, `errorMessage`.

### Admin panel (`apps/admin-panel/src/`)

- **`shared/api/read-boundary.ts`** + **`client.test.ts`**: agrega
  `/v1/webdock/inventory`. Total **28 endpoints**.
- **`shared/api/client.ts`**: tipos `WebdockInventoryServer`,
  `WebdockInventoryContract`, `OpenClawDriftProposal`, `WebdockInventoryPayload` +
  campos `webdockInventory` y `webdockDrift` en `DashboardData` + extensión del
  parallel fetch.
- **`features/canvas/index.tsx`**:
  - Hero ahora muestra un chip "Webdock vivo" o "Webdock mock" según el
    `source.kind` del contrato.
  - Nuevo componente **`WebdockLiveBanner`** entre Hero y el banner "Empieza
    aquí": cuando el collector está en mock (sin env var) lo dice claramente
    con instrucciones; cuando está en live, anuncia cuántos drifts detectó
    OpenClaw y resume el conteo (corriendo / apagados / suspendidos).
  - Cuando todo está alineado (live + 0 drifts), el banner se oculta.

## Validación local

```
npm test                                  # 148/148 ok
cd apps/admin-panel
npx tsc --noEmit                          # 0 errores
node --test src/shared/api/client.test.ts \
            src/shared/lib/formatters.test.ts \
            src/shared/lib/domain-state-copy.test.ts   # 15/15 ok

# Smoke (sin env var, fallback mock)
GATEWAY_PORT=3396 node apps/gateway-api/src/main.ts &
curl -s http://127.0.0.1:3396/v1/webdock/inventory | jq '.inventory.source.kind'
# → "mock"
curl -s http://127.0.0.1:3396/v1/webdock/inventory | jq '.inventory.summary'
# → {total: 3, running: 2, stopped: 1, ...}
curl -s http://127.0.0.1:3396/v1/webdock/inventory | jq '.drift.proposals | length'
# → 3 (los 3 servers mock sin sender_nodes registrados)
```

## Cómo activar lectura real de tu cuenta Webdock

```bash
# 1. En tu cuenta Webdock: Account → API & Integrations → Generate new API key
#    Permisos: solo lectura (server.read). NO le des write todavía.

# 2. Guarda la key en una env var local (NO en el repo):
echo 'WEBDOCK_API_KEY=tu_key_aqui' >> "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/.env.local"
echo '.env.local' >> "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/.gitignore"

# 3. Reinicia el gateway cargando la env var:
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
set -a; source .env.local; set +a
bash restart-gateway.sh

# 4. Recarga el admin panel. El chip pasa de "Webdock mock" a "Webdock vivo"
#    y el inventario refleja tu cuenta real.
```

## Comando de commit (Codex en host)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"

rm -rf apps/admin-panel/dist
npm test
npm --workspace @delivrix/admin-panel run check

git add \
  packages/adapters/src/webdock-real-adapter.ts \
  packages/adapters/src/index.ts \
  packages/domain/src/webdock-inventory.ts \
  packages/domain/src/webdock-inventory.test.ts \
  packages/domain/src/openclaw-rules.ts \
  packages/domain/src/openclaw-rules.test.ts \
  packages/domain/src/index.ts \
  apps/gateway-api/src/main.ts \
  apps/admin-panel/src/shared/api/read-boundary.ts \
  apps/admin-panel/src/shared/api/client.ts \
  apps/admin-panel/src/shared/api/client.test.ts \
  apps/admin-panel/src/features/canvas/index.tsx \
  COMMIT_FASE_5_11_A.md

git commit -m "feat(webdock): collector READ real + OpenClaw rules-based drift

Primer paso de Hito 5.11.A para romper dependencia de mocks. Conectamos
Webdock en modo lectura y damos a OpenClaw un primer cerebro real
(rules engine sin LLM) que compara el inventario vivo contra el
sender_node registry local y emite propuestas tipadas.

- WebdockRealAdapter: fetch nativo a https://api.webdock.io/v1/servers
  con Bearer auth desde WEBDOCK_API_KEY env var. Cache 60s. Fallback
  silencioso a mock canónico (3 servers) cuando la env var no existe.
- domain/webdock-inventory.ts: contrato GET-only con schemaVersion +
  summary {total, running, stopped, suspended, other} + servers[].
- domain/openclaw-rules.ts: evaluateWebdockDrift() con 4 reglas iniciales
  ordenadas por severidad. Cada propuesta lleva runbookRef.
- gateway: GET /v1/webdock/inventory con audit log de cada llamada.
- admin-panel: read-boundary +1 (total 28), client + parallel fetch +
  Hero con chip live/mock + WebdockLiveBanner que muestra drifts.

148/148 domain tests · 15/15 admin-panel tests · tsc clean. Bundle
frontend sigue GET-only, norte operativo intacto.

Refs: Hito 5.11.A · Webdock READ + OpenClaw rules-based.
"
```
