# Hito 4.0: Alineacion control plane

Fecha: 2026-05-02

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.

## Objetivo

Alinear el codigo y la documentacion al nuevo contexto operativo:

- Delivrix gobierna infraestructura, capacidad, reputacion, compliance y auditoria.
- NFC conserva campanas, colas y envio real.
- OpenClaw empieza como read-only/supervised.
- Ningun componente Delivrix debe parecer un sender paralelo en esta fase.

## Cambios implementados

### 1. Contrato de norte operativo en dominio

Archivo:

- `packages/domain/src/operating-north.ts`

Expone:

- `getOperatingNorthSnapshot`
- `evaluateOperatingActionGate`

Este contrato declara:

- `delivrixRole = control_plane`
- `nfcRole = campaign_and_real_send_pipeline`
- `delivrixSendsRealEmail = false`
- `nfcSendsRealEmail = true`
- `nfcProductionWritesEnabled = false`
- `liveInfrastructureWritesEnabled = false`

Tambien bloquea acciones fuera de fase:

- envio real.
- escritura en NFC produccion.
- SSH real.
- cambios DNS reales.
- mutaciones reales en Proxmox.
- purga de colas remotas.
- activacion de providers NFC.

### 2. Bridge NFC mock

Archivo:

- `packages/domain/src/nfc-bridge.ts`

Expone:

- `buildNfcBridgeCapacityPlan`
- `evaluateNfcBridgeReadiness`

El bridge:

- genera payloads compatibles para `email_providers`.
- genera payloads compatibles para `smtp_servers`.
- deja todos los providers como `isActive: false`.
- no incluye passwords ni secretos.
- no escribe en NFC.
- no activa SMTP.
- no envia emails.
- reporta nodos bloqueados o que requieren revision.

### 3. Gateway expone la frontera

Endpoints nuevos:

```bash
curl -s http://127.0.0.1:3000/v1/operating-north
```

```bash
curl -s -X POST http://127.0.0.1:3000/v1/nfc/bridge/capacity-plan \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local"}'
```

El endpoint `capacity-plan`:

- lee sender nodes locales.
- genera un plan mock para NFC.
- audita `nfc_bridge.capacity_plan_generated`.
- no ejecuta llamadas externas.
- no crea providers reales.

`GET /health` ahora declara:

- rol `delivrix-control-plane`.
- Fase `4.0-control-plane-alignment`.
- Delivrix no envia correo real.
- NFC es el pipeline de envio real.
- NFC bridge en modo `mock`.

### 4. Worker reencuadrado

El worker local queda explicitamente identificado como:

- `control-worker`.
- `delivrix-internal-ops-worker`.
- `control-plane-safe-no-smtp`.

Esto no cambia el comportamiento seguro actual: sigue simulando resultados y no abre SMTP.

## Criterio de salida

Hito 4.0 queda cerrado si:

- el norte operativo existe como contrato de dominio;
- el gateway lo expone por API;
- el bridge NFC genera payloads dry-run/inactivos;
- el worker local se identifica como worker operativo/control plane;
- las pruebas nuevas validan que Delivrix no envia correo real ni escribe en NFC;
- la documentacion principal apunta a este hito.

## Que queda para Hito 4.1

- Inventario mas profundo de tablas/endpoints NFC.
- Resolver o documentar el mismatch `workerInstanceId`.
- Definir contrato versionado Delivrix -> NFC.
- Preparar adapter `NfcBridge` para usar API real solo en modo supervised futuro.
