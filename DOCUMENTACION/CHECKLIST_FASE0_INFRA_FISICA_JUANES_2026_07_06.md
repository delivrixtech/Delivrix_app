# Checklist Fase 0 — Cimientos físicos (Juanes)

> Para vos, no para el agente de dev. Esto desbloquea TODO lo de infra propia. Marcá cada casilla.
> Fecha: 2026-07-06 · Track A + E · Detalle técnico: `PLAN_COOL_HIVELOCITY_DIVIDIR_BESTION_2026_06_26.md`
> y `GUIA_CONFIG_MAC_STUDIO_INFERENCIA_LOCAL_2026_06_26.md`.

**Regla de oro:** el límite no es el cómputo, son las **IPs**. Se escala con más buzones/IPs limpias,
nunca con más volumen por buzón. Olas graduales, nunca de golpe.

---

## A1 · Comprar el bloque /26 (62 IPs) — Hivelocity (server Cool)
- [ ] Pedir a Hivelocity el add-on **/26** para el bestión Cool (Tampa).
- [ ] Confirmar que Hivelocity **delega PTR/rDNS** de ese bloque (imprescindible para FCrDNS).
- [ ] Verificar reputación de cada IP en blacklists ANTES de cargar (objetivo: 0/N).
- **Listo cuando:** el /26 está asignado al server, PTR es delegable, y la base sale limpia.

## A2 · Proxmox VE + template LXC — sobre el server Cool
- [ ] Instalar **Proxmox VE** en el bestión.
- [ ] Crear un **template LXC** con: Postfix + OpenDKIM + DMARC + TLS (el stack de envío).
- [ ] Clonar el template una vez y validar que el LXC levanta sano y **envía** un correo de prueba a inbox.
- **Listo cuando:** clonás el template y el LXC nuevo entrega a inbox, repetible/simétrico.

## A5 · PTR / rDNS por IP (FCrDNS)
- [ ] En el panel Hivelocity, setear el **PTR** de cada IP a `mail.<dominio>` (o el hostname del SMTP).
- [ ] Verificar **FCrDNS** (forward-confirmed): A -> IP y PTR -> hostname coinciden.
- **Listo cuando:** el PTR resuelve y FCrDNS pasa en las IPs que vas a usar primero.

## E1 · Mac Studio accesible (cerebro IA local, Miami)
- [ ] Dejar el **Mac Studio** encendido y accesible por **SSH + Tailscale** (guía: `GUIA_CONFIG_MAC_STUDIO_INFERENCIA_LOCAL`).
- [ ] Probar que entrás por SSH **desde fuera** de la red local.
- **Listo cuando:** hay sesión SSH estable al Mac Studio por Tailscale.

## Decisión pendiente (te toca a vos)
- [ ] **Dominio propio del sistema/panel** (bajo el que va a correr todo en producción). Definirlo desbloquea Fase 2 (TLS + DNS + auth).

---

## Qué me pasás cuando termines (para que el dev arranque el E2E de Fase 1)
1. Confirmación de que el **/26 está asignado** + rango exacto + que PTR es delegable.
2. **Acceso a Proxmox** (o credenciales/host) para cablear el adapter real contra el bestión.
3. Hostname/convención de PTR que usaste (para alinear el adapter).
4. Endpoint/estado del **Mac Studio** (para más adelante, Fase 4 warmup: modelo local).

## Orden sugerido de tu semana
A1 (comprar, tarda en asignar) -> en paralelo E1 (Mac Studio) -> A2 (Proxmox+LXC cuando tengas el server listo) -> A5 (PTR sobre las primeras IPs) -> decidir dominio.

> Mientras hacés esto, el dev cierra Fase 1 (mergear adapters A3/A4) y S3 (compliance) — no dependen de este hardware, solo el E2E real espera a que A2/A5 estén.
