# Hito 4.2: Cluster topology planner

Fecha: 2026-05-02

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.  
Documento de fase: `FASE_4_OPENCLAW_INFRAESTRUCTURA.md`.  
Hito anterior: `HITO_4_1_OPENCLAW_ONBOARDING.md`.

## Objetivo

Convertir el onboarding inteligente de OpenClaw en un plan tecnico de clusters/VPS/LXC para infraestructura propia de mailing.

Este hito no provisiona servidores. Su funcion es disenar la topologia segura: cuantos sender nodes iniciar, que recursos usar, como asignar dominios/IPs/hostnames, que limites aplicar y que riesgos revisar antes del provisioning dry-run.

## Cambios implementados

### 1. Dominio topology planner

Archivo:

- `packages/domain/src/openclaw-topology-planner.ts`

Expone:

- `buildOpenClawTopologyPlan`

El planner:

- revalida el onboarding antes de planear;
- bloquea planes si el onboarding esta en `no_go`;
- genera plan si el onboarding esta `go` o `needs_review`;
- calcula presupuesto seguro de CPU, RAM, storage e IPs;
- produce nodos LXC con sizing conservador o balanceado;
- asigna hostname por sender node;
- asigna IP como reserva de pool, no como cambio real;
- define limites iniciales por nodo;
- produce riesgos y recomendaciones;
- mantiene todo en dry-run.

### 2. Decision del plan

Estados:

- `blocked`: no se puede planear por onboarding incompleto o presupuesto cero.
- `needs_review`: hay plan, pero requiere revision humana antes de pasar a 4.3.
- `plan_ready`: plan listo para provisioning dry-run.

El planner no promete volumen. La capacidad calculada es una estimacion inicial condicionada por warming, reputacion, DNS, PTR, compliance y aprobacion humana.

### 3. Gateway API

Endpoint nuevo:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/openclaw/topology/plan \
  -H 'content-type: application/json' \
  -d '{
    "actorId": "operator_local",
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
  }'
```

El endpoint:

- genera topology plan;
- audita `openclaw_topology.plan_created`;
- devuelve summary, resource budget, clusters, nodos, riesgos, gates y safety;
- no toca Proxmox;
- no abre SSH;
- no cambia DNS;
- no activa SMTP;
- no escribe en NFC.

### 4. Norte operativo actualizado

`GET /v1/operating-north` ahora declara fase:

- `4.2-cluster-topology-planner`

Accion permitida en dry-run:

- `build_cluster_topology_plan`

## Criterio de salida

Hito 4.2 queda cerrado si:

- el planner consume onboarding;
- bloquea onboarding `no_go`;
- genera plan para onboarding `go` o `needs_review`;
- calcula presupuesto de recursos;
- define nodos LXC, hostnames, asignacion de pool IP y limites;
- lista riesgos y recomendaciones;
- expone endpoint seguro en Gateway;
- audita la creacion del plan;
- no tiene side effects externos;
- las pruebas automatizadas pasan.

## Pruebas

Comando:

```bash
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
```

Resultado esperado al cierre del hito:

- 75 pruebas pasando.

## Hito 4.3 posterior

El Hito 4.3 queda documentado en `HITO_4_3_PROVISIONING_DRY_RUN.md`.

Ese hito construye:

- conversion de topology plan en provisioning dry-run;
- planes Proxmox por sender node;
- planes Postfix, OpenDKIM, TLS, DNS y warming;
- SSH, DNS live changes, SMTP y Proxmox API real apagados;
- aprobacion humana antes de cualquier accion real.
