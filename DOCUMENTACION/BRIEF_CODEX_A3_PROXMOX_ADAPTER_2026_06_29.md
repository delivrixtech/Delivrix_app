# BRIEF CODEX — A3: ProxmoxAdapter (OpenClaw provisiona un SMTP en el Cool)

Fecha: 2026-06-29 (con datos **as-built** de A2) · **Ejecuta: Codex** · Supersede el draft `PROMPT_CODEX_ADAPTER_PROXMOX_HIVELOCITY_2026_06_26.md`.
**Objetivo:** nuevo `VpsProvider` **"proxmox"** para que el flujo `configure_complete_smtp` pueda targetear `vpsProviderId="proxmox"` y montar un SMTP en el bare-metal propio (Hivelocity + Proxmox VE 9), **igual que hoy con Webdock/Contabo**. Es infra propia (sin ban de proveedor).
**Se puede construir y PROBAR ya** contra el Proxmox real (Codex testea desde el Mac, que está en `gw_egress`). Sin el `/26` se prueba el **lifecycle** (clone→start→destroy), no deliverability.

---

## 0. A2 ya está (prerequisito hecho + auditado — NO re-ejecutar)
```
PROXMOX_API_URL       = https://107.155.106.38:8006/api2/json
PROXMOX_TOKEN_ID      = delivrix@pve!provisioner
PROXMOX_TOKEN_SECRET  = <macOS Keychain: delivrix-proxmox-cool-pve1-token — nunca literal>
PROXMOX_NODE          = cool-pve1
PROXMOX_TEMPLATE_VMID = 9000
PROXMOX_STORAGE       = local        # directory → clones SOLO --full 1 (linked NO disponible)
PROXMOX_IP_POOL       =              # vacío hasta el /26 (A1); formato gw=107.155.106.38;cidr=26;range=<1ra>-<última>
```
- Token: `privsep=1`, ACL scoped (`/vms` + `/vms/9000` + `/storage/local` + `/sdn/zones/localnetwork`), rol con `SDN.Use` (red en clones funciona), **expiry ~2026-12-25** (rotar antes).
- Template **9000**: Debian 12, unprivileged, **sin net0**, **sin host keys**, machine-id limpio. Stack del flujo ya bakeado (postfix/opendkim/dovecot/rsyslog, mail.log, milter 8891).
- **Firewall default-deny:** la **IP de egress del gateway debe estar en `gw_egress`** para que el adapter alcance el API/SSH (hoy solo está la IP del operador). Prereq de deploy, no de código.

## 1. ProxmoxAdapter (nuevo `packages/adapters/src/proxmox-real-adapter.ts` — NO tocar el mock `proxmox-adapter.ts`, que es dry-run y NO implementa VpsProvider)
`implements VpsProvider` (de `./vps-provider.ts`) **reusando los tipos `Webdock*`** (`WebdockCreateServerInput`/`WebdockCreateServerResult`/`WebdockServer`/`WebdockInventoryResult`/`WebdockDeleteServerResult`/`WebdockEnsureSshAccessResult`) — exactamente como `ContaboAdapter`, el espejo (no-Webdock + PTR manual). El input llega en vocabulario Webdock; el adapter lo **traduce** a Proxmox por dentro (params del step 4 byte-idénticos):
- **`createServer(spec)`**:
  1. `VMID = GET /cluster/nextid` (libre, multi-host-safe).
  2. clone: `POST /nodes/cool-pve1/lxc/9000/clone` con `newid=VMID`, **`full=1`** (obligatorio en directory storage), `hostname`, `storage=local`.
  3. `PUT .../lxc/VMID/config`: `net0=name=eth0,bridge=vmbr0,ip=<IP del pool>/26,gw=107.155.106.38` — ⚠️ **OMITIR `hwaddr`** (Proxmox genera un MAC único por clon solo; **NO** `hwaddr=auto` → es inválido y el config PUT devuelve **400**); **`description="delivrix-created=<ISO8601>"`** (← stampar `creationDate`: la API de Proxmox NO da timestamp de creación).
  4. **identity reset por clon** (el `clone` NO lo hace): regenerar `/etc/machine-id` + `ssh_host_*` keys; inyectar la **pubkey del gateway** en `/root/.ssh/authorized_keys` (cloud-init `--sshkeys` o `pct push`/exec).
  5. `POST .../status/start`.
  6. return `{ slug: "proxmox-<VMID>", ipv4, ... }` (forma que consume el orquestador).
- **`listServers()`**: `GET /nodes/cool-pve1/lxc` → map; **`creationDate` parseado desde el `description`** (`delivrix-created=...`), `Date.parse`-able.
- **`getServer(slug)`** → `WebdockServer` (mapear status + **`creationDate`** parseado del `description`; el governor cuenta por creationDate). **`deleteServer(slug)`** (`DELETE .../lxc/VMID` = destroy inmediato = rollback limpio; mejor que el cancel fin-de-término de Contabo). **`canCreate()`/`isLive()`** (token presente).
- **`ensureServerSshAccess`**: inyectar la pubkey del gateway por clon (pct push/exec a `/root/.ssh/authorized_keys`).
- **`setReverseDns`: NO implementar** (es opcional en `VpsProvider`). Hivelocity **no tiene API de PTR** → PTR queda **manual** por panel (a diferencia de Contabo que sí lo hace por API). El flujo gatea FCrDNS igual que con Contabo.

## 2. `createProxmoxAdaptersFromEnv`
Lee los env de §0. `accountId="proxmox"` (default; **parametrizable** para multi-host futuro A6). IP pool por **estado vivo** (leer los `net0` existentes vía API, **no** un contador) para no duplicar IPs.

## 3. Cableado (sibling de Contabo — Webdock/Contabo quedan **byte-idénticos**) — VERIFICADO vs código 2026-06-29
- **Registry (`main.ts:419-422`):** hoy es `const vpsProviderEntries = createContaboAdaptersFromEnv(); const vpsProviderAdapters = new Map(entries → [id, adapter])`. Agregar `createProxmoxAdaptersFromEnv()` y **mergear** sus `VpsProviderEntry[]` en ESE mismo Map (no un `.set` manual). Sin creds proxmox → `[]` → camino Webdock/Contabo byte-idéntico.
- **Allowlist (`orchestrator-smtp.ts:4594` `assertKnownNonWebdockVpsProviderId`):** HOY es `if (value === undefined || value === "contabo") return;` → agregar `|| value === "proxmox"`. (Se llama en 637/678/869; `isNonWebdockProviderId` ya rutea genérico ≠ webdock, no hace falta tocarlo.)
- **Validador `vpsProviderId`** (`skill-schemas.ts`, ~594) + **enum** en `openclaw-tools-builder.ts`: agregar `"proxmox"` **dondequiera que hoy figure `"contabo"`**.
- El flujo `configure_complete_smtp` con `vpsProviderId="proxmox"`: el step de create resuelve el ProxmoxAdapter; el resto igual (SSH config Postfix/DKIM/SPF/DMARC). **PTR = manual Hivelocity** (mismo gate que Contabo).

## 4. Claves
- **BUDGET (verificado vs código):** crear un LXC **NO cuesta** → para proxmox poner **`estimatedCostUsd: 0`** en el create. ⚠️ HOY el create **hardcodea** `estimatedCostUsd: 4.30/30` (`orchestrator-smtp.ts:894` y `:946`) y `minEstimatedCostUsd = 15 + 4.30/30` (`:364`) → hay que hacerlo **condicional al provider** (0 si proxmox), o el E2E necesita `budgetUsdMax` alto. Anti-snowshoe: encendido/warmup **manual por olas**.
- **TLS `:8006` self-signed** → verificar/pinear CA, **NO** `rejectUnauthorized:false` en prod.
- **Aislamiento:** Webdock + Contabo SIN regresión. El governor de Webdock no toca proxmox.
- **Secreto:** el token sale del Keychain, **nunca** a params/audit/logs.

## 5. DoD
- `createServer` (proxmox) clona vía **REST API** + arranca; `listServers` lo ve; `deleteServer` lo borra. **Rollback provider/account-aware** (lección del bug de bind: TODOS los pasos post-create deben ser provider/account-aware).
- `configure_complete_smtp` con `vpsProviderId="proxmox"` corre E2E contra el Proxmox real. Sin `/26`: probar el lifecycle (clone→set net0 dhcp/privada→start→destroy), **no** deliverability.
- Webdock + Contabo **sin regresión** (targeted verdes, byte-idéntico). `tsc` no sube baseline.
- PTR: el flujo **pausa** para el operador (gate manual, como Contabo).

## 6. Nota multi-host (futuro A6)
Diseñar con `accountId` parametrizable desde ya (aunque arranque con 1 host). 2º bestión = otro `PROXMOX_*` set / otro `accountId` = alta disponibilidad real.
