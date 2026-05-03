# Hito 4.3: Provisioning dry-run executor

Fecha: 2026-05-02

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.  
Documento de fase: `FASE_4_OPENCLAW_INFRAESTRUCTURA.md`.  
Hito anterior: `HITO_4_2_CLUSTER_TOPOLOGY_PLANNER.md`.

## Objetivo

Convertir el topology plan de OpenClaw en planes tecnicos dry-run para preparar sender nodes propios.

Este hito no crea VPS reales, no abre SSH, no escribe DNS, no aplica Postfix, no genera llaves DKIM reales, no solicita certificados TLS reales y no envia correo. Solo produce planes auditables para revision humana.

## Cambios implementados

### 1. Dominio provisioning dry-run

Archivo:

- `packages/domain/src/openclaw-provisioning-dry-run.ts`

Expone:

- `buildOpenClawProvisioningDryRun`

El executor:

- acepta `topologyPlan` existente o `topologyInput`;
- reusa el topology planner cuando recibe `topologyInput`;
- bloquea si el topology plan esta `blocked`;
- genera dry-run si hay nodos planificados;
- marca `needs_review` si el topology plan venia con riesgos;
- genera planes por sender node.

### 2. Planes generados por nodo

Por cada sender node se genera:

- plan Proxmox;
- plan Postfix;
- plan OpenDKIM;
- plan TLS;
- plan DNS;
- plan warming.

Cada plan conserva:

- `dryRun: true`;
- `sideEffects: none`;
- acciones reales bloqueadas;
- aprobaciones requeridas;
- manejo de secretos via secret manager;
- SMTP apagado.

### 3. Gateway API

Endpoint nuevo:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/openclaw/provisioning/dry-run \
  -H 'content-type: application/json' \
  -d '{
    "actorId": "operator_local",
    "topologyInput": {
      "clusterName": "delivrix-pilot",
      "strategy": "conservative",
      "onboarding": {
        "server": {
          "model": "IBM System x3630 M4",
          "cpuCores": 24,
          "ramGb": 128,
          "storage": { "type": "ssd", "usableGb": 2000, "redundant": true },
          "network": { "provider": "business-isp", "uplinkMbps": 500, "staticIp": true },
          "upsReady": true,
          "coolingMonitored": true
        },
        "proxmox": { "status": "installed", "version": "8.x", "apiReachable": true },
        "ipPool": {
          "totalIps": 32,
          "type": "leased",
          "cidrs": ["203.0.113.0/27"],
          "providerApproval": true,
          "reputationChecked": true,
          "ptrDelegation": true
        },
        "domains": [{ "domain": "delivrix.example", "ownershipVerified": true }],
        "dns": {
          "provider": "route53",
          "apiAccess": true,
          "canManageSpfDkimDmarc": true,
          "canManagePtr": true
        },
        "compliance": {
          "physicalAddressReady": true,
          "optOutReady": true,
          "suppressionListReady": true,
          "consentProofAvailable": true,
          "trafficAuthorizedByProvider": true
        },
        "limits": {
          "targetDailyVolume": 250,
          "initialSenderNodes": 5,
          "maxSenderNodes": 30,
          "dailyLimitPerNode": 50,
          "warmupDays": 21
        },
        "security": {
          "secretsManagerReady": true,
          "sshKeyPolicyReady": true,
          "auditLogRequired": true,
          "killSwitchRequired": true
        },
        "autonomy": { "mode": "supervised", "humanApprovalRequired": true }
      }
    }
  }'
```

El endpoint:

- genera provisioning dry-run;
- audita `openclaw_provisioning.dry_run_created`;
- devuelve planes por nodo;
- no toca Proxmox real;
- no abre SSH;
- no escribe DNS;
- no activa SMTP;
- no escribe en NFC.

### 4. Norte operativo actualizado

`GET /v1/operating-north` ahora declara fase:

- `4.3-provisioning-dry-run-executor`

Accion permitida en dry-run:

- `build_provisioning_dry_run`

## Criterio de salida

Hito 4.3 queda cerrado si:

- acepta topology plan o topology input;
- bloquea topology `blocked`;
- genera planes Proxmox/Postfix/OpenDKIM/TLS/DNS/warming;
- no incluye secretos reales;
- no genera side effects externos;
- expone endpoint seguro en Gateway;
- audita la creacion del dry-run;
- las pruebas automatizadas pasan.

## Pruebas

Comando:

```bash
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
```

Resultado esperado al cierre del hito:

- 80 pruebas pasando.

## Hito posterior implementado

Hito 4.4 quedo documentado en `HITO_4_4_OPENCLAW_SCHEDULER_SKILLS.md`.

Incluye:

- Crear scheduler inicial de OpenClaw.
- Crear skills `fleet-ops`, `alert-ops`, `report-ops`.
- Agregar LLM router con modo degradado sin LLM.
- Generar reportes diarios.
- Mantener OpenClaw en modo observador/supervised.
