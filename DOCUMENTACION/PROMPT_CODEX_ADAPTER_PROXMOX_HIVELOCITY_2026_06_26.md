# PROMPT CODEX — Adapter Proxmox: traer el bestión Hivelocity ("Cool") a Delivrix

Fecha: 2026-06-26 · Ejecuta: Codex · Objetivo: nuevo `VpsProvider` "proxmox" para que OpenClaw/Delivrix monte SMTPs en el bare-metal PROPIO (Hivelocity + Proxmox VE), igual que hoy lo hace con Webdock/Contabo. Es infra propia (sin ban de proveedor); el flujo `configure_complete_smtp` debe poder targetear `vpsProviderId="proxmox"`.

## CONTEXTO INFRA (lo que monta el operador, prerequisito)
- Dedicado Hivelocity (EPYC 24c/128GB), **Proxmox VE** instalado. API REST en `https://<host>:8006/api2/json/` con **API token** (token-id + secret).
- **1 LXC por SMTP.** Hay un **template LXC** (Postfix + OpenDKIM + OpenDMARC preconfigurado) que se clona por cada SMTP.
- Las IPs (bloque /26+) se asignan a cada LXC por bridge (`vmbr0`), IP estática.
- **PTR/rDNS es MANUAL en el panel Hivelocity** (igual que Contabo) → el flujo lo trata como Contabo: paso manual + audit + FCrDNS gate, no por API.

## ALCANCE (referencia exacta: `ContaboAdapter`, es el caso más cercano — no-Webdock + PTR manual)

1. **`ProxmoxAdapter`** (packages/adapters/src/proxmox-adapter.ts) implementando la interfaz `VpsProvider` (packages/adapters/src/vps-provider.ts — mirar la que implementa Contabo):
   - `createServer(spec)` → clonar el template LXC (`POST /nodes/<node>/lxc/<template-vmid>/clone`), setear hostname, IP estática (net0), arrancar (`POST .../status/start`). Devolver `{slug, ipv4, ...}` con el formato que espera el orquestador.
   - `listServers()` → `GET /nodes/<node>/lxc` → mapear a la forma que el governor consume (incl. `creationDate` parseable por `Date.parse`).
   - `getServer(slug)` → estado del LXC.
   - `deleteServer(slug)` → `DELETE /nodes/<node>/lxc/<vmid>` (rollback).
   - `canCreate()` → token Proxmox presente.
2. **`createProxmoxAdaptersFromEnv`**: lee `PROXMOX_API_URL`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET`, `PROXMOX_NODE`, `PROXMOX_TEMPLATE_VMID` (y el pool de IPs disponibles, ver abajo). `accountId="proxmox"` (single-host por ahora; multi-host = futuro).
3. **Cableado (sibling de Contabo, NO romper nada):**
   - `vpsProviderAdapters.set("proxmox", adapter)` en el registry (main.ts, donde se registra Contabo).
   - `assertKnownNonWebdockVpsProviderId` (orchestrator-smtp.ts ~4180) → aceptar `"proxmox"` además de `"contabo"`.
   - `vpsProviderId` enum en skill-schemas (~781) y openclaw-tools-builder (~945) → añadir `"proxmox"`.
   - El canal `providerId` ya existe end-to-end (sibling de params); proxmox viaja igual que contabo.
4. **Flujo `configure_complete_smtp` con `vpsProviderId="proxmox"`:** el step de create resuelve el ProxmoxAdapter (en `resolveWebdockCreateAdapter`/dispatch, donde providerId!=webdock rutea a `vpsProviderAdapters`), crea el LXC, el resto del flujo igual (SSH config Postfix, DKIM/SPF/DMARC). **PTR = manual Hivelocity** (mismo gate que Contabo).

## CONSIDERACIONES CLAVE
- **GOVERNOR/BUDGET:** crear un LXC **NO cuesta dinero** (es tu hardware) → el budget gate (USD por VPS) NO aplica. PERO el **rate anti-snowshoe SÍ** aplica conceptualmente (no crear+encender muchos de golpe). Recomendación: NO meter proxmox bajo el budget gate; el control del encendido/warmup es **manual del operador** (gradual, por olas). Si se quiere un rate de creación, que sea suave y configurable, no el 4/24h de Webdock.
- **ASIGNACIÓN DE IP:** el adapter asigna 1 IP del **pool del /26** a cada LXC. El pool disponible se configura (env `PROXMOX_IP_POOL` o se lee de Proxmox/IPAM). Llevar registro de IP→LXC para no duplicar. IP → hostname → PTR manual.
- **AISLAMIENTO:** providerId="proxmox" es un canal NUEVO. Webdock y Contabo deben quedar **byte-idénticos** (sin regresión). El governor de Webdock no toca proxmox.
- **SEGURIDAD:** el token Proxmox en env (como las keys Webdock/Contabo), nunca en params/audit/logs.

## DoD / TESTS
- `createServer` con provider proxmox clona el template y arranca el LXC; `listServers` lo ve; `deleteServer` lo borra (rollback account-aware — recordar el fix del bind: TODOS los pasos que operan sobre el server deben ser provider/account-aware).
- `configure_complete_smtp` con `vpsProviderId="proxmox"` corre E2E contra un Proxmox de test (o mock del API).
- Webdock + Contabo SIN regresión (tests targeted verdes, byte-idéntico).
- PTR: el flujo pausa para el operador (gate manual, como Contabo).
- tsc no sube el baseline.

## PREREQUISITO DEL OPERADOR (runbook aparte, en paralelo)
1. Instalar **Proxmox VE** en el bestión Hivelocity.
2. Crear el **template LXC** (Debian/Ubuntu + Postfix + OpenDKIM + OpenDMARC).
3. Generar un **API token** de Proxmox (con permisos sobre LXC).
4. Configurar el bridge `vmbr0` y el pool de IPs (cuando lleguen).
→ Con eso, el adapter tiene contra qué correr.

## NOTA DE ARQUITECTURA (futuro)
Para alta disponibilidad real (objetivo del operador: "sin interrupción"), esto escala a **multi-host**: varios Proxmox (varios servers/DC), el adapter con `accountId` = host/cluster, IPs en rangos distintos. Diseñar el adapter pensando en multi-host desde ya (accountId parametrizable) aunque arranque con 1.
