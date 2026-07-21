# RUNBOOK — Día /26: enchufar las IPs y poner el Cool a entregar

Fecha: 2026-06-29 · Para ejecutar **cuando llegue el bloque /26 (A1)**. Todo lo de A2 ya está montado (Proxmox + template + token + firewall); esto es el **enchufe final** + el warmup. Ejecuta: Codex (server) + Juanes (panel/compras/PTR).

> Regla de oro: con **Console de myVelocity abierta** durante cualquier cambio de red (break-glass anti-lockout).

---

## 0. Prereq — hacer YA (no espera al /26)
- **Agregar la IP de egress ESTABLE del gateway** (Hostinger) al ipset `gw_egress` del firewall PVE. Sin esto el adapter (A3) no alcanza el API ni puede SSH a los clones. Hoy `gw_egress` solo tiene la IP del operador (`186.117.161.125`, dinámica).
- Tener el adapter A3 construido + probado contra el lifecycle (clone→start→destroy).

## 1. A1 — conseguir + verificar el /26  *(Juanes)*
- myVelocity → device **#26390** → **Request More IP Addresses** → pedir el **/26** (62 IPs usables).
- Al asignarse: **verificar la IP base limpia** en MXToolbox / Spamhaus (0 blacklists) **antes** de usar el rango.
- **Ticket Hivelocity (confirmar):** que el /26 quede **routed-to-IP** a `107.155.106.38` (sin gateway propio del /26, **sin** registro de MAC por IP). Si pidieran MAC por IP, cambia el plan de red.

## 2. Host — rutear el /26  *(Codex, Console abierta)*
- `/etc/network/interfaces` (vmbr0): `up ip route add <NET>/26 dev vmbr0` (+ `down ... del`). Recargar con `ifupdown2` (deadman `( sleep 120 && reboot )&` por las dudas).
- `net.ipv4.ip_forward=1` (ya seteado en A2 — verificar `sysctl net.ipv4.ip_forward`).
- Cargar **`PROXMOX_IP_POOL = gw=107.155.106.38;cidr=26;range=<1ra>-<última>`** en el env del gateway (el único valor que faltaba de A2).

## 3. Por cada SMTP — clonar + asignar IP  *(A3 adapter, o manual)*
- El adapter ya hace: `clone 9000 --full 1` → `net0 ip=<IP del /26>/26, gw=107.155.106.38, hwaddr única` → identity reset (machine-id, host keys, pubkey gateway) → `start`.
- Manual de respaldo: `pct clone 9000 <VMID> --full 1`; `pct set <VMID> -net0 name=eth0,bridge=vmbr0,ip=<IP>/26,gw=107.155.106.38,hwaddr=auto`; `pct start <VMID>`.
- Verificar salida a internet del clon (`ping 1.1.1.1`, `apt update`) — ya con IP pública ruteada debería salir directo.

## 4. PTR / rDNS — manual por IP  *(Juanes, A5)*
- Por **cada IP** del /26 en myVelocity → setear **PTR = el hostname de envío** (p.ej. `smtp.<dominio>` o el FQDN del sender de esa IP).
- **Gate FCrDNS (obligatorio antes de enviar):** forward (A: host→IP) y reverse (PTR: IP→host) deben **coincidir**. Sin FCrDNS, los grandes (Gmail/Outlook) bouncean o mandan a spam.

## 5. DNS por dominio — lo hace el flujo  *(automático)*
- **SPF** (include del sender), **DKIM** selector `s2026a` (el flujo genera la key por dominio), **DMARC** (registro). El flujo `configure_complete_smtp` ya cablea esto en cada provisión.

## 6. Verificación SEGURA — sin quemar reputación
> Regla de oro: **NUNCA se valida deliverability "mandando y viendo qué pasa"** — eso es lo que quema la IP. Se verifica la plomería sin tocar usuarios reales, y la reputación se **construye** con warmup (§7). Ladder de menor a mayor riesgo:

**6.0 — Usá PRIMERO las herramientas que YA están en producción** (read-only, gated, auditadas — el operador IA/OpenClaw las corre solo, sin enviar correo):
- `read_dkim_status` → estado DKIM del dominio/selector (reemplaza el `opendkim-testkey` manual).
- `read_smtp_reachability` → probe de salida :25 (es una conexión de prueba, **NO** un envío → reputación intacta).
- `read_mxtoolbox_health` (lookup **blacklist** por defecto) → **EL guardrail de reputación**: avisa si la IP cae en una blacklist. Tiene reporte diario con alertas críticas → correrlo antes y durante cada ola de warmup.
- `read_delivery_reason` → lee `/var/log/mail.log` y explica bounces/deferrals **sin mandar nada** (analiza intentos existentes).

**6.1 — Checks de DNS que NO envían un solo correo (riesgo CERO, complemento manual de 6.0).**
```bash
DOM=<dominio>; SEL=s2026a; IP=<IP del clon /26>
# DNS auth (desde cualquier lado, no toca el server):
dig +short TXT $DOM | grep -i spf                 # SPF presente
dig +short TXT ${SEL}._domainkey.$DOM             # DKIM (selector s2026a)
dig +short TXT _dmarc.$DOM                         # DMARC
# FCrDNS (lo que exigen Gmail/Outlook): reverse y forward deben CERRAR
dig +short -x $IP                                  # PTR -> debe dar smtp.$DOM (o el FQDN del sender)
dig +short "$(dig +short -x $IP)"                  # forward del PTR -> debe ser == $IP
```
En el clon (sin enviar nada):
```bash
opendkim-testkey -d $DOM -s $SEL -vvv             # "key OK"
postconf -n | grep -E 'myhostname|inet_protocols|smtpd_milters|mynetworks'
ss -ltnp | grep -E ':25|:587|:8891'              # postfix + opendkim escuchando
```

**6.2 — UN diagnóstico controlado (riesgo DESPRECIABLE).** Un solo mensaje a una casilla de test, nunca a usuarios/listas.
```bash
# Opción A — mail-tester.com: 1 mensaje a la dirección única que te da la web
swaks --to test-XXXXXX@srv1.mail-tester.com --from noreply@$DOM \
      --server localhost --h-Subject "delivrix check" --body "ping"
#   → abrir mail-tester.com y leer el score (SPF/DKIM/DMARC/SpamAssassin/blacklists)
# Opción B — a una casilla TUYA (Gmail/Outlook propia) → "Mostrar original":
#   Authentication-Results: dkim=pass  spf=pass  dmarc=pass  + que NO caiga en spam
```
Un mensaje a una dirección de test **NO** es quemar reputación — es el método estándar de la industria.

## 7. Warmup — CONSTRUIR reputación, gradual (anti-snowshoe)
- **Primera ola chiquita**, a direcciones **tuyas / enganchadas** primero. Subir volumen escalonado por días, nunca de golpe.
- **NO** prender muchas IPs/dominios a la vez (snowshoe = flag inmediato de spam).
- **Antes y durante cada ola: `read_mxtoolbox_health` (blacklist)** sobre las IPs en uso → si aparece un listing, frenar esa IP y revisar antes de seguir. Es el chequeo de reputación más barato y temprano.
- Los breakers **W3/W4 (ya en producción)** pausan solos si el spam-rate o el placement se disparan → el sistema te protege de un error. `read_delivery_reason` para entender cualquier bounce/deferral sin enviar nada.
- Monitorear `/var/log/mail.log` en el clon (rsyslog ya bakeado): sin deferrals/rechazos.
- Recién cuando 6.0–6.2 están OK y el warmup avanza **sin alertas ni listings**, el Cool **entrega de verdad** → North Star cumplido.

---
### Estado de dependencias
`A2 ✅ (Proxmox/template/token/firewall)` → falta **`/26` (A1)** + **IP gateway en `gw_egress`** + **A3 (adapter)**. Con esos tres, este runbook se ejecuta de corrido.
