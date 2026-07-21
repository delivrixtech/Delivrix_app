# BRIEF CODEX — Telemetría real: persistir el snapshot 5.9 y leerlo en los 5 GET (sin cruzar la línea gateada)

Fecha: 2026-06-23 · Ejecuta: **Codex** (backend/infra) · Coordina: Juanes (CTO) · Frontend de honestidad: **Claude** (lista al final) · Después: **deploy local + Hostinger para review, NO merge sin OK**

## Contexto (verificado en código, 2026-06-23)

El Hito 5.9 (ingesta manual auditada) ya está construido: contrato completo en `packages/domain/src/collector-snapshot-ingestion.ts` (35 campos aceptados, redacción de secretos, parser a `physicalHost` + `telemetry`), endpoint `POST /v1/devops/collector/manual-snapshots/ingest` gateado por aprobación humana, y flags de health `manualSnapshotIngestionEnabled: true`.

**El problema:** el POST parsea y **descarta** el resultado — no persiste. Y los 5 GET que el panel renderiza reconstruyen desde vacío, por eso Hardware/Recolector/Onboarding/Aprendizaje salen mock/vacíos:

- `main.ts:3340` `/v1/hardware/telemetry/latest` -> `buildHardwareTelemetrySnapshot()` (sin input -> null + `mockSource`)
- `main.ts:3346` `/v1/hardware/telemetry/history` -> `buildHardwareTelemetryHistory()` (sin input)
- `main.ts:3352` `/v1/openclaw/onboarding/state` -> `evaluateOpenClawOnboarding({actorId})` (sin capacidad -> 26 bloqueos)
- `main.ts:3372` `/v1/openclaw/readiness-signals` -> `buildPhysicalHostSnapshot({now})` + `buildHardwareTelemetrySnapshot({now})` (vacíos; alimentan KPIs de Aprendizaje)
- `main.ts:3392` `/v1/devops/collector/supervised-plan` -> `buildSupervisedCollectorPlan({now})` (4 fuentes hardcodeadas)

**El eslabón faltante es UNO:** persistir el último snapshot aceptado y que esos 5 GET lo lean. La ingesta (`main.ts:3408-3438`) ya produce `ingestion.parsed.physicalHost` y `ingestion.parsed.telemetry` (objetos ya construidos). No hay colector nuevo que escribir.

## INVARIANTES — no cruzar la línea, no romper nada

1. **NO se habilita Proxmox live / SSH / node_exporter scrape.** La única fuente de dato real nueva es el **snapshot manual ya gateado** (`evaluateOperatingActionGate("ingest_manual_collector_snapshot")` + `humanApproved:true`). Las acciones live siguen `future_live_requires_new_phase`. Este brief NO toca esa frontera.
2. **El panel sigue GET-only.** No se agrega botón de POST ni upload en la UI (regla dura del Hito 5.9). El POST lo hace el operador fuera del panel (script más abajo).
3. **Redacción intacta:** `storesRawPayload:false`. El store guarda SOLO el `parsed` (ya redactado, sin secretos) + el hash + metadata. NUNCA el payload crudo. El password/secreto nunca entra al store ni al audit (ya lo garantiza la redacción 5.9; mantenerlo).
4. **Serie acotada con eviction** (no repetir la fuga de Canvas Live): el history es un ring buffer de tamaño fijo (p.ej. últimos 240 puntos) con borde por tiempo; nada de arrays sin tope.
5. **Los 8 SMTPs y produ no se tocan** — esto es telemetría del control-plane, ortogonal al envío.
6. **Tests existentes verdes** + el de 5.9 extendido.

## Los 4 cambios

1. **Store de snapshot aceptado** (`packages/domain` + capa de persistencia del gateway, siguiendo el patrón de los stores existentes: en memoria + disco bajo el dir de datos/`.audit`, lectura al boot). Guarda: `latest` = `{ physicalHost, telemetry, snapshotId, snapshotHash, status, acceptedAt }` del último `status !== "rejected"`, y `history` = ring buffer acotado de puntos de telemetría (timestamp + métricas clave). Sin secretos, sin payload crudo.

2. **Persistir en el POST** (`main.ts:3408-3438`): cuando `ingestion.status` es `accepted` o `needs_review`, escribir `ingestion.parsed` al store y hacer append del punto de telemetría al ring buffer. Si `rejected`, no persistir (igual que hoy). Mantener el 202/422 y el audit append tal cual.

3. **Leer el store en los 5 GET:**
   - `telemetry/latest`: devolver `store.latest.telemetry` si existe; si no, el `buildHardwareTelemetrySnapshot()` vacío de hoy (estado honesto "sin snapshot").
   - `telemetry/history`: devolver el ring buffer real; vacío si no hay.
   - `readiness-signals`: pasar `store.latest.physicalHost` + `store.latest.telemetry` a `buildOpenClawReadinessSignals` (fallback a vacío).
   - `onboarding/state`: mapear `store.latest.physicalHost` -> input de `evaluateOpenClawOnboarding` (identity.model->server.model, capacity.cpuCores->server.cpuCores, capacity.memoryGb->server.memoryGb, capacity.storageUsableGb->server.storageGb, capacity.networkInterfaces->network.interfaces, etc.; Codex liga los nombres exactos contra los tipos). Los bloqueos bajan a medida que llegan campos reales.
   - `supervised-plan`: cuando hay snapshot aceptado, la fuente `local_hardware_snapshot` pasa de `needs_review`/`manual_snapshot_not_uploaded` a `accepted` con `lastIngestedAt`/`snapshotHash`. Las otras 3 (Proxmox/Prometheus/IPMI) siguen `blocked` (honesto: no cableadas).

4. **Recolector "Captura manual"**: que el contrato GET refleje el último snapshot ingerido (timestamp + hash + status), para que la pestaña deje de decir "sin datos" tras la primera ingesta. Sin permitir POST desde UI.

## DoD

- POST de un snapshot real (via script) -> `telemetry/latest`, `/history`, `onboarding/state`, `readiness-signals`, `supervised-plan` devuelven **dato real y persistente** (sobrevive restart del gateway).
- Sin snapshot -> los 5 devuelven vacío/unknown honesto (NO mock, NO barras demo).
- El password/secreto sigue sin aparecer en store/audit/log (redacción 5.9 verde).
- Ring buffer acotado (sin crecimiento ilimitado).
- `npm test` + `npm run test:admin` verdes; test 5.9 extendido cubre persistencia + read-back en los 5 GET.
- Relay de los 8 (puerto 25) sin cambios.

## Deploy para review (NO destructivo)

- Codex: commit en branch propia + **deploy a gateway local Y Hostinger** (regla: nunca dejar el remoto congelado) + rebuild del system-context si aplica. NO merge a produ hasta review de operador + Claude.
- Operador (Juanes): correr el script read-only en el box control-plane (recomendado: el Proxmox real; el snapshot tiene campos `proxmoxVersion`) y hacer 1 POST con `humanApproved:true`. El script NO recoge secretos.

## Anclas (verificadas 2026-06-23)

- `apps/gateway-api/src/main.ts:3340,3346,3352,3372,3392,3400,3408` (los 5 GET + el GET de contrato + el POST de ingesta).
- `packages/domain/src/collector-snapshot-ingestion.ts:22` (schema version), `:128-164` (campos aceptados host.*/capacity.*/telemetry.*), `ingestManualCollectorSnapshot` (devuelve `parsed.physicalHost` + `parsed.telemetry` + `status` + `snapshotHash`).
- `packages/domain/src/hardware-telemetry.ts:138` `buildHardwareTelemetrySnapshot(input)`, `buildHardwareTelemetryHistory`.
- `packages/domain/src/hardware-inventory.ts` `buildPhysicalHostSnapshot(input)`, tipo `PhysicalHostSnapshot`.
- `packages/domain/src/openclaw-onboarding.ts:232` `evaluateOpenClawOnboarding(input)`.
- `packages/domain/src/supervised-collector-plan.ts` `buildSupervisedCollectorPlan({sources})` + `buildDefaultCollectorSources()`.
- Doc rector: `DOCUMENTACION/HITO_5_9_INGESTA_MANUAL_SNAPSHOT_UX.md` ("Que sigue": historial de telemetría + empty-states + UX sobre contratos reales).
