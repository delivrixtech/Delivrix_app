# PLAN — Dividir el bestión Hivelocity ("Cool") en clusters para SMTPs propios

Fecha: 2026-06-26 · Servidor: Hivelocity Tampa, device #26390, EPYC 7443P 24-core/128GB/1TB NVMe, IP base 107.155.106.38 (limpia, 0/60 blacklists). **Puerto 25 egress ABIERTO** (confirmado). Bloque de IPs adicional en compra.

## Por qué infra propia (Cool) vs proveedores
Webdock baneó ops+quaternary y Contabo tiene rangos sucios (217.216.x). En tu propio bare-metal: **nadie te banea**, la reputación está en **tus IPs**, y el cómputo se puede mover sin re-warm (la reputación vive en la IP, no en la VM). Es la tesis de infra propia, ahora concreta.

## CÓMO DIVIDIR EL BESTIÓN — Proxmox VE + LXC

**Hypervisor: Proxmox VE** (gratis, Debian, API REST). Sobre el bare-metal.

**Unidad: 1 contenedor LXC por SMTP** (no VM completa). Por qué LXC y no KVM:
- Mucho más liviano (comparten kernel) → 5-10x más densidad.
- Postfix/OpenDKIM son procesos chicos; no necesitan un kernel propio.
- Arranque/clonado en segundos.

**Recursos por SMTP (LXC):** ~1 vCPU, 1 GB RAM, 8-10 GB disco. Cada uno corre Postfix + OpenDKIM + OpenDMARC.

## Dimensionamiento (la clave: el límite son las IPs, no el cómputo)
- 128 GB RAM / ~1 GB por SMTP ≈ **capacidad para ~80-100 SMTPs**. 24 cores van holgados (SMTP es I/O-bound).
- **El cuello de botella son las IPs:** 1 IP por SMTP (reputación independiente). Si comprás un **/28 = 14 IPs usables**, son 14 SMTPs; un **/27 = 30 IPs**, 30 SMTPs. El bestión aguanta mucho más que cualquier bloque razonable.
- **Regla:** comprá solo las IPs que vas a **calentar** — mejor 10 IPs bien warmeadas que 30 frías.

## Red e IPs (tu "actualizar IPs simétricamente")
- El bloque (ej. /28) se rutea al server por Hivelocity.
- En Proxmox: un bridge `vmbr0`; cada LXC recibe **1 IP estática** del bloque.
- **PTR/rDNS por cada IP** en el panel Hivelocity → que `IP → smtp.<dominio>` y `smtp.<dominio> → IP` coincidan (**FCrDNS**). Sin esto, Gmail/Outlook = spam directo.
- Hostname por SMTP: `smtp.<dominio>` o `mail.<dominio>`.

## Plantilla + clonado (montaje repetible/simétrico)
1. Construí **1 LXC "template"** con Postfix + OpenDKIM + OpenDMARC ya instalados y parametrizados.
2. **Cloná** el template N veces. Por cada clon, solo cambia: IP, hostname, dominio, clave DKIM (selector), PTR.
3. Automatizalo con **Ansible** (o bash) → provisioning idéntico y repetible. Un playbook que recibe (dominio, IP) y deja el SMTP listo.

## REGLAS DE ORO (no romper — son lo que separa "entregar" de "spam")
1. **WARMUP gradual por IP.** Aunque las IPs sean propias y limpias, levantar 14-30 SMTPs enviando volumen de golpe = patrón *snowshoe* → quemás tus propias IPs. Cada IP arranca con poco (decenas/día) y sube en semanas.
2. **FCrDNS + SPF + DKIM + DMARC** por cada dominio/IP. Los 4, siempre.
3. **Monitoreá blacklist** de cada IP (el panel ya tiene el checker; o `read_mxtoolbox_health`).
4. **Un /28-/27 es un rango contiguo** = mismo "vecindario" de reputación. Si una IP spamea, mancha a las vecinas. Cuidá todas.
5. **No re-uses una IP quemada.** Si una cae en Spamhaus, sácala de rotación y delistá (o pedí otra a Hivelocity).

## INTEGRACIÓN CON DELIVRIX (el punto a decidir)
Hivelocity bare-metal **no tiene API de "crear VPS"** como Webdock/Contabo. Dos caminos:

- **A) Adapter Proxmox en Delivrix (vía Codex):** Proxmox expone API REST → se construye un `VpsProvider` "proxmox" (hermano de Webdock/Contabo) que crea LXC en tu bestión y los configura E2E. **Automatizado** (OpenClaw lo opera como cualquier proveedor), pero es **desarrollo** (un brief para Codex, similar al de Contabo).
- **B) Setup manual + sender pool:** vos/yo configuramos los SMTPs por SSH (Proxmox + LXC + Postfix), y Delivrix solo los **registra** como sender pool existente (las IPs/credenciales). **Rápido para arrancar**, sin esperar desarrollo, pero no automatizado.

## ARRANQUE RECOMENDADO (gradual, validar antes de escalar)
1. Comprá un bloque **pequeño primero** (/29 ≈ 5-6 IPs, o /28 = 14) — no /27 de una.
2. Proxmox en el bare-metal + **3-5 LXC manuales** → validá el flujo: 1 SMTP entregando a **inbox** desde tu IP propia (FCrDNS + DKIM + warmup).
3. **Calentá** esas IPs.
4. En paralelo: decidir el camino de integración (A adapter Proxmox para escalar automatizado, o B seguir manual).
5. Recién con el flujo validado + IPs calientes, escalá al resto de los dominios.

## QUÉ NECESITO PARA AYUDARTE A EJECUTAR
- **Acceso:** SSH al server (o credenciales Proxmox cuando lo instales) → puedo guiarte/configurar Proxmox, el template LXC, Postfix, el provisioning.
- **Tamaño del bloque de IPs** que te dé Hivelocity (define cuántos SMTPs).
- Decisión de integración: **A (adapter Proxmox, te escribo el brief para Codex)** o **B (manual + sender pool)**.
