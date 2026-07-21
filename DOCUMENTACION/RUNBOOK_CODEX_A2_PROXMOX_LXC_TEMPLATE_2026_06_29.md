# BRIEF CODEX — A2: Proxmox VE 9 + plantilla LXC de correo (Hivelocity "Cool")

Fecha: 2026-06-29 · **Ejecuta: Codex** (credenciales Hivelocity + SSH/Console) · Spec: Claude (Cowork) + revisión de 4 subagentes senior (SRE/Proxmox, deliverability/Postfix, seguridad, arquitectura de integración Delivrix). Auditado en vivo en myVelocity.
**Scope:** A2 produce SOLO artefactos del operador (Proxmox VE + template + token + bridge/IP pool). **No escribe código del repo.** Su único job: dejarle a A3 una API que funcione + los env exactos, y **probar cada llamada contra el host real** antes de dar A2 por cerrado.

---

## 0. Server (auditado en vivo · myVelocity #26390)

| Campo | Valor |
|---|---|
| Device | **#26390** `eloquent-khorana.hivelocitydns.com` · Tampa 2 (TPA2) · **ON** |
| IP / transit | **107.155.106.38** · `107.155.106.36/30` (gw `.37`) · **el /26 NO está asignado aún (A1)** |
| Hardware | EPYC 7443P 24c@4.0GHz · 128 GB RAM · 1 TB NVMe · 20 TB @10Gbps |
| OS | Ubuntu 24.04 → **recargado a Debian 13 Trixie** (base de PVE 9; stable actual **9.2**, mayo 2026). Reload ejecutado 2026-06-29, **EN CURSO** |
| Acceso | key `delivrix-ops` **desplegada en el reload** → key-only desde boot, sin password temporal · **Console** como salvavidas |

> ⚠️ **Bloqueante parcial (A1):** sin el /26 los clones arrancan pero **NO entregan** (sin IP pública + PTR). Construir A2 ahora; el smoke de A2 valida **servicios arriba, NO deliverability**.

---

## 1. OS → Debian 13 (Reload) — YA EJECUTADO
- **Hecho vía panel (2026-06-29, Cowork/Chrome):** Power Off → **Reload → Debian 13 (Trixie) 64-bit** con **Customize SSH Key Access → key `delivrix-ops` desplegada**. Reinstall en curso (~30 min, email a admin@delivrix.com). Reload **wipea** el disco (server fresco, OK).
- **Acceso (Codex):** key-only desde el primer boot → `ssh -i ~/.ssh/delivrix-ops root@107.155.106.38`. **No hay que usar password temporal**; si Hivelocity igual emitió uno, retirarlo tras confirmar la key. Mantener **Console** abierta como salvavidas antes de tocar red. Anotar NIC primaria (`ip a`) y gateway (`ip r`, ~`.37`).

## 2. Instalar Proxmox VE 9 (sobre Debian 13 Trixie · orden importa)
```bash
# (a) FQDN + /etc/hosts ANTES que nada (PVE exige que el hostname resuelva a la IP real, NO 127.0.1.1)
hostnamectl set-hostname cool-pve1
# /etc/hosts:  107.155.106.38  cool-pve1.<dominio-interno>  cool-pve1   (borrar línea 127.0.1.1 del hostname)
hostname --ip-address    # debe imprimir 107.155.106.38

# (b) repo no-subscription + key (TRIXIE, no bookworm)
echo "deb [arch=amd64] http://download.proxmox.com/debian/pve trixie pve-no-subscription" > /etc/apt/sources.list.d/pve-install-repo.list
wget https://enterprise.proxmox.com/debian/proxmox-release-trixie.gpg -O /etc/apt/trusted.gpg.d/proxmox-release-trixie.gpg
apt update && apt full-upgrade -y

# (c) kernel PVE PRIMERO, reboot, recién después el metapaquete
apt install -y proxmox-default-kernel && reboot
# (post-reboot, uname -r con -pve):
apt install -y proxmox-ve postfix open-iscsi chrony   # Postfix -> elegir "Local only"
```
Post-install: quitar kernel Debian stock — el que **no** sea `-pve` (verificar `dpkg -l 'linux-image*'`, p.ej. `apt remove -y linux-image-amd64 'linux-image-6.12*'`; `update-grub`); deshabilitar enterprise/ceph repos (401); matar el nag de subscription (`sed -i.bak "s/data.status !== 'Active'/false/g" /usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js; systemctl restart pveproxy`). **No instalar `resolvconf`/`rdnssd`.** Si apt falla por `pve-firmware` vs `firmware-linux*`, quitar el firmware de Debian y reintentar. Verificar `pveversion -v` + `https://107.155.106.38:8006`.

## 3. Storage — AS-BUILT: `local` (directory), NO `local-lvm`
> ⚠️ **Desviación necesaria (verificada en ejecución):** el Reload de Debian 13 dejó el disco **ext4-root sin VG/LVM** → no había espacio libre para crear un thin pool, así que `local-lvm` **no existe**. A2 usa **`local` (directory storage)** con **full clones** (validados). Codex NO hizo cirugía de partición en vivo (correcto / seguro).
> - **Impacto:** funcional; ~80-100 full clones de ~10 GB en 1 TB NVMe (de sobra para el horizonte). Se pierde densidad + linked clones, **no** funcionalidad.
> - **Para A3:** clones **`--full 1`** obligatorio (linked `--full 0` NO disponible en directory storage); `PROXMOX_STORAGE=local`.
> - **Si más adelante se quiere thin pool/ZFS real (no urgente):** reprovisionar con el **instalador ISO de Proxmox** (arma LVM-thin/ZFS solo) o un layout LVM custom — el Reload de Hivelocity no deja customizar particiones (disco entero → ext4).

## 4. Red — CRÍTICO: el /26 es **routed-to-IP**, no bridged
**Modelo Hivelocity (confirmado): el /26 se rutea con nextHop = la IP primaria `107.155.106.38`. ⇒ NO hay gateway propio del /26, NO hay registro de MAC por IP. El gateway de cada LXC = la IP del bridge del host (`107.155.106.38`).** (Esto corrige el draft, que asumía "gateway del /26".)

**Ticket/confirmar con Hivelocity antes de asignar IPs:** (1) ¿el /26 queda routed a `.38` (64 IPs usables detrás del host)? (2) ¿confirmado que **no** requiere MAC por IP? (3) ¿la primaria sigue `.38/30` gw `.37`?

Host `/etc/network/interfaces` (con **Console abierta**, probar antes de confiar en SSH):
```
auto lo
iface lo inet loopback
auto <NIC>
iface <NIC> inet manual
auto vmbr0
iface vmbr0 inet static
    address 107.155.106.38/30
    gateway 107.155.106.37
    bridge-ports <NIC>
    bridge-stp off
    bridge-fd 0
    up   ip route add <NET_/26>/26 dev vmbr0      # cuando llegue el /26 (A1)
    down ip route del <NET_/26>/26 dev vmbr0
```
```bash
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-pve-routing.conf && sysctl --system
apt install -y ifupdown2     # permite recargar red sin cortar; usar deadman ( sleep 120 && reboot )& al migrar
```
**`net0` de cada LXC** (lo setea A3 al clonar): `ip=<IP_/26>/26, gw=107.155.106.38` (Gateway = host, **no** "/26 gw"). ⚠️ **OMITIR `hwaddr`** → Proxmox genera un MAC único; `hwaddr=auto` es **inválido** (config PUT da 400).

## 5. Plantilla LXC golden (guest Debian 12) — el flujo SSH es la autoridad
> **Nota de versión:** host = Debian 13/PVE 9, pero el **guest del template se mantiene en Debian 12** para igualar el entorno de sender ya probado (Webdock/Contabo); PVE 9 corre guests Debian 12 sin problema. Si los senders actuales corren otra distro, alinear. El bake set y la config de abajo son independientes de versión.
>
> El flujo existente `configure_complete_smtp` (`smtp-provisioning.ts:buildSmtpProvisionPlan`) **apt-installa el stack y SOBREESCRIBE `main.cf`/`opendkim.conf` por dominio**. La plantilla NO trae config final: trae **binarios, usuarios, dirs, sockets/puertos y el log path** que el flujo asume, idéntico a un box Webdock/Contabo. Lo por-dominio (DKIM key selector `s2026a`, certbot, `myhostname=smtp.<dominio>`, DNS) lo hace el flujo — **no bakear nada de eso**.

```bash
pveam update && pveam download local debian-12-standard_12.*_amd64.tar.zst
pct create 9000 local:vztmpl/debian-12-standard_12.*_amd64.tar.zst \
  --hostname mail-template --cores 1 --memory 1024 --swap 512 \
  --rootfs local:10 --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --features nesting=1 --onboot 0 --start 1
```
Dentro (`pct enter 9000`) — **bake set corregido** (DROP `opendmarc`; ADD `dovecot-core` + `rsyslog`):
```bash
apt update && apt install -y postfix opendkim opendkim-tools certbot dovecot-core ca-certificates swaks rsyslog
systemctl enable postfix opendkim dovecot rsyslog     # NO opendmarc
printf 'd /run/opendkim 0750 opendkim opendkim -\n' > /etc/tmpfiles.d/opendkim.conf
```
Baseline **cerrado y sin dominio** (el flujo lo sobreescribe; esto evita open-relay/leak si un clon arranca antes de provisionar):
- `/etc/postfix/main.cf`: `myhostname = localhost.localdomain` (placeholder, **no** `mail-template`), `inet_interfaces = all`, **`inet_protocols = ipv4`** (igual que el flujo; evita FCrDNS fail por IPv6), `smtpd_tls_security_level = may`, `smtpd_milters = inet:localhost:8891` + `non_smtpd_milters = inet:localhost:8891` (**solo 8891**, sin 8893), `milter_default_action = accept`, `milter_protocol = 6`, `smtpd_recipient_restrictions = permit_mynetworks,permit_sasl_authenticated,reject_unauth_destination`, `mynetworks` = **solo loopback**.
- `master.cf`: **stock** (el flujo agrega submission/smtps con `postconf -M`; no pre-habilitar o colisiona).
- OpenDKIM baseline: `Socket inet:8891@localhost`, `Mode sv`; KeyTable/SigningTable/TrustedHosts **vacíos** (los llena el flujo).
- **SSH:** el flujo entra como **root por key** (slug proxmox → user `root`, `BatchMode=yes`). La plantilla quita host keys; **A3 debe inyectar la pubkey del gateway por clon** (cloud-init `--sshkeys` o `pct push` a `/root/.ssh/authorized_keys`).

Reset de identidad + template:
```bash
truncate -s0 /etc/machine-id; rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_*
apt clean; rm -rf /var/lib/apt/lists/* /var/lib/dhcp/* ; exit
pct stop 9000 && pct template 9000        # -> PROXMOX_TEMPLATE_VMID=9000
```
> ⚠️ `pct clone` **no** regenera machine-id ni SSH host keys ni DKIM → **A3 los re-asegura por clon** (machine-id, ssh host keys, `hwaddr` único, y la DKIM key la genera el flujo por dominio).

## 6. API token (least-privilege)
```bash
pveum role add DelivrixProvisioner -privs "VM.Audit VM.Allocate VM.Clone VM.Config.Network VM.Config.Options VM.Config.Disk VM.PowerMgmt Datastore.AllocateSpace Datastore.Audit SDN.Use"   # SDN.Use = necesario p/ VM.Config.Network en los clones
pveum user add delivrix@pve                                  # realm pve (sin shell), sin password PAM
pveum user token add delivrix@pve provisioner --privsep 1 --expire <+180d>   # privsep ON
pveum acl modify /vms               -token 'delivrix@pve!provisioner' -role DelivrixProvisioner
pveum acl modify /storage/local     -token 'delivrix@pve!provisioner' -role DelivrixProvisioner   # storage as-built = local
```
- **privsep 1** (no 0), privs exactos (incluye `VM.Config.Disk` para clone --full; **sin `Sys.*`, `VM.Console`, `VM.Migrate`, `VM.Backup`**). Token con expiry + rotación (`token remove`+`add`, 60s, sin downtime). El secret **se muestra una sola vez** → directo al secret store (as-built: macOS Keychain).
- ✅ **ACL CONFIRMADO (auditoría read-only 2026-06-29):** scoped a `/vms` + `/vms/9000` + `/storage/local` + `/sdn/zones/localnetwork` — **NO en `/`**. `privsep=1`, **expiry ≈ 2026-12-25 (~180d)**. Rol least-privilege + `SDN.Use`; sin `Sys.*`/`VM.Console`/`VM.Migrate`/`VM.Backup`. Impecable.
- ⚠️ **Rotación:** el token **expira ~2026-12-25**. Rotar antes (`token remove`+`add`, 60s, sin downtime) o el adapter deja de provisionar.

## 7. Firewall + hardening (default-deny) — APLICADO 2026-06-29
> ✅ **As-built (auditado):** PVE firewall **enabled/running**, default inbound DROP / outbound ACCEPT, aplicado con **deadman rollback** (sin lockout, acceso verificado). Host acepta `tcp/22` + `tcp/8006` solo desde el ipset `gw_egress`. `storage.cfg` ahora explícito; repo enterprise off.
> ⚠️ **`gw_egress` HOY = `186.117.161.125` = la IP pública ACTUAL del usuario (verificado en vivo), NO la del gateway.** Dos implicancias: (1) **A3 queda BLOQUEADO** hasta agregar la **IP de egress estable del gateway** (Hostinger) al ipset — sin eso el adapter no alcanza el API ni puede SSH a los clones; (2) **riesgo de lockout** si la IP del usuario cambia (residencial/dinámica). Break-glass = **myVelocity Console** → `pve-firewall stop` o agregar la IP nueva. Para admin, preferir IP estable (jump host/VPN), no depender de la dinámica.
- **Proxmox firewall**: datacenter+host `policy_in: DROP` (agregar las reglas de SSH/API en el MISMO cambio o te lockeás; Console = break-glass). IP set `gw_egress` = IP(s) de egress del gateway. ACCEPT `tcp/8006` y `tcp/22` **solo desde `+gw_egress`**; resto inbound DROP.
- **Por-LXC**: inbound solo `:22` desde `+gw_egress` (config del flujo); **NO** abrir `:25` inbound (no son MX → evita open-relay). Egress: permitir `25, 53, 123, 80, 443` y **default-deny el resto** (control clave anti-abuso).
- **Host**: SSH key-only (`PermitRootLogin prohibit-password`, `PasswordAuthentication no`) **después** de confirmar que entra la key `delivrix-ops` (ya desplegada en el reload; si Hivelocity emitió un password temporal, retirarlo); `unattended-upgrades` (security, reboot off-peak); `fail2ban` (sshd); **AppArmor enabled** (default LXC; NO unconfined); chrony (DKIM/TLS dependen de la hora).

## 8. DoD — probar contra la **REST API** (no solo `pct`)
```bash
NEWID=$(pvesh get /cluster/nextid)                          # VMID libre, multi-host-safe
pct clone 9000 $NEWID --hostname mail-smoke --full 1
pct set $NEWID -net0 name=eth0,bridge=vmbr0,ip=dhcp     # omitir hwaddr (Proxmox auto-MAC); hwaddr=auto es inválido
pct start $NEWID && sleep 6
pct exec $NEWID -- systemctl is-active postfix opendkim dovecot rsyslog   # todos active
pct exec $NEWID -- test -e /var/log/mail.log && echo MAILLOG_OK           # CRÍTICO p/ el flujo
# API con el token (sin filtrar el secret en history):
read -rs TOK; curl -ks -H "Authorization: PVEAPIToken=delivrix@pve!provisioner=$TOK" \
  https://107.155.106.38:8006/api2/json/nodes/<NODE>/lxc | head; unset TOK
pct stop $NEWID && pct destroy $NEWID
```
**DoD ✅:** clona vía API (nextid) → set net0 → start → `status=running` por API → list lo ve → destroy lo borra; los 4 servicios `active`; `/var/log/mail.log` existe. **NO** asertar envío real (sin /26+PTR todavía).

## 9. Entregables → secret store / env del gateway (única coupling con A3)
```
PROXMOX_API_URL       = https://107.155.106.38:8006/api2/json
PROXMOX_TOKEN_ID      = delivrix@pve!provisioner
PROXMOX_TOKEN_SECRET  = <macOS Keychain: delivrix-proxmox-cool-pve1-token — nunca literal aquí/logs/commits>
PROXMOX_NODE          = cool-pve1
PROXMOX_TEMPLATE_VMID = 9000
PROXMOX_STORAGE       = local        # directory storage → clones --full 1 (linked NO disponible)
PROXMOX_IP_POOL       =              # vacío hasta el /26 (A1) — formato gw=107.155.106.38;cidr=26;range=<1ra>-<última>
```
**Notas para A3 (código, no A2):** clone con **`--full 1`** sobre `PROXMOX_STORAGE=local` (linked NO disponible); slug = `proxmox-<vmid>`; **stampar `creationDate`** al clonar (`--description "delivrix-created=<ISO>"`, porque la API no da timestamp); VMID por `/cluster/nextid`; IP pool por **estado vivo** (leer net0 existentes, no contador); `accountId` parametrizable (default `proxmox`, futuro multi-host A6); **`estimatedCostUsd: 0`** en el create proxmox (hoy el path cobra 4.30/30 y `ensureBudgetForStep` lo enforce — sizear `budgetUsdMax` alto en el E2E); TLS `:8006` self-signed (pin/CA, no `rejectUnauthorized:false` en prod); **no tocar** el mock `proxmox-adapter.ts` (es otra clase).

## 10. Guardrails
- **PTR/rDNS = MANUAL** en myVelocity (como Contabo) + gate FCrDNS; A3 no implementa setReverseDns.
- **/26 (A1) pendiente** → clones no entregan hasta tenerlo + PTR. Aislamiento: canal `proxmox` aditivo, **Webdock/Contabo byte-idénticos** (A2 no toca código).
- **Anti-snowshoe:** encender/calentar por **olas, manual**; crear LXC no cuesta plata pero no prender muchos de golpe.
- **Secretos:** token secret y password temporal de Hivelocity **nunca** en brief/commits/logs/history (`read -rs` para curl). 
