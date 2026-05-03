# Hito 4.0: Alineacion control plane

Fecha: 2026-05-02

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.

## Objetivo

Alinear el codigo y la documentacion al nuevo contexto operativo:

- Delivrix gobierna infraestructura, capacidad, reputacion, compliance y auditoria.
- OpenClaw sera la IA operativa para onboarding inteligente, clusters y preparacion de infraestructura propia.
- OpenClaw empieza como read-only/supervised.
- Ningun componente Delivrix debe parecer un sender paralelo en esta fase.
- NFC queda como integracion futura opcional, apagada o mock.

## Cambios implementados

### 1. Contrato de norte operativo en dominio

Archivo:

- `packages/domain/src/operating-north.ts`

Expone:

- `getOperatingNorthSnapshot`
- `evaluateOperatingActionGate`

Este contrato fue ampliado en Hito 4.1 y actualmente declara:

- `delivrixRole = control_plane`
- `openClawRole = intelligent_onboarding_topology_provisioning_then_supervised_operator`
- `nfcRole = future_optional_external_integration`
- `delivrixSendsRealEmail = false`
- `nfcSendsRealEmail = false`
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

### 2. Bridge externo mock

Archivo:

- `packages/domain/src/nfc-bridge.ts`

Expone:

- `buildNfcBridgeCapacityPlan`
- `evaluateNfcBridgeReadiness`

Este modulo usa NFC como referencia tecnica porque ya existia un sistema externo revisado, pero en el MVP funciona solo como puerta futura apagada/mock. No es dependencia operativa.

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
- genera un plan mock de referencia para una futura integracion NFC.
- audita `nfc_bridge.capacity_plan_generated`.
- no ejecuta llamadas externas.
- no crea providers reales.

`GET /health` ahora declara:

- rol `delivrix-control-plane`.
- fase actual del norte operativo.
- Delivrix no envia correo real.
- bridge externo/NFC en modo `mock` como integracion futura opcional.

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
- el bridge externo mock genera payloads dry-run/inactivos;
- el worker local se identifica como worker operativo/control plane;
- las pruebas nuevas validan que Delivrix no envia correo real ni escribe en NFC;
- la documentacion principal apunta a este hito.

## Hito 4.1 posterior

El Hito 4.1 queda documentado en `HITO_4_1_OPENCLAW_ONBOARDING.md`.

Ese hito construye:

- schema de onboarding inteligente para servidor fisico, Proxmox, IPs, dominios, DNS, limites y permisos;
- preguntas guiadas y validadores de datos criticos;
- snapshot auditable de infraestructura;
- reporte de faltantes y decision Go/No-Go;
- integraciones externas apagadas o mock.
