# @delivrix/warmup-engine

Servicio **standalone** de calentamiento (warmup) de inboxes por **mesh propio**.

> **Source of truth:** `Delivrix-Warmup-Sistema-AI.md` (2026-07-07). Leerlo ante cualquier duda.
> El `ADR-Delivrix-Warmup-Agent.md` (ADR-WARMUP-01) está **SUPERADO** — era para flota hosted
> (Gmail Workspace/M365 + pools + vendor + Gmail API). No sacar decisiones de ahí.

## Qué es (y qué NO es)

- **Es:** warmup de inboxes sobre buzones **Postfix/Dovecot propios**, en IPs/ASN propios. Cada
  buzón es un **nodo** de un mesh que manda **y** recibe warmup contra otros nodos del mesh.
- **No es:** envío cold/diario (otro servicio), filtro anti-spam (otro servicio), ni pool comprado /
  vendor / Gmail API. El tráfico de warmup nunca va a destinatarios reales — solo entre nodos.

## Las 3 señales de reputación (lo que medimos y fabricamos en el mesh)

1. **open** — el correo se abre y se "lee".
2. **reply** — se responde con un hilo conversacional real (2–4 turnos).
3. **not-spam** — si cae en spam, se rescata a inbox (+ mark important).

## Regla dura: el placement real gatea TODO

El número de warmup **no es** placement real (lección DFY: heat 90 con placement 30–40 % spam).
La verdad se mide contra **seed inboxes reales** (Gmail/Outlook/Yahoo + 1–2 EU) que reportan dónde
cayó cada correo (Primary / Promotions / Spam) por IMAP. Ese % gatea `FRESH→WARM` y dispara
`auto-pause`. Prerrequisito ya resuelto por el gateway: lectura de entrega real (DSN vía
`read_delivery_reason`).

## Estructura del módulo

```
apps/warmup-engine/
  migrations/        Esquema Postgres (§7 del doc): nodes, pairings, seed_checks, threads
  src/
    domain/          NÚCLEO DETERMINISTA PURO (sin I/O, 100 % testeado) — el corazón:
      types.ts         tipos y constantes de política (defaults del §2)
      ramp.ts          cupo diario por nodo (increase_by_day → daily_limit, weekdays_only)
      pair-matcher.ts  quién escribe a quién (no repetir par, frescos ≤ 40 %, frescos ← warm)
      node-state.ts    máquina de estados FRESH→WARMING→WARM + auto-pause por placement
      placement.ts     score de colocación desde seed_checks + gates
    index.ts         superficie pública del núcleo
```

Los **adapters de I/O** (Send Worker SMTP, Inbox Reader IMAP), el **AI Engine** (Claude Haiku/Fable)
y el **runtime** (scheduler + colas + control API) se agregan sobre este núcleo en fases siguientes;
el núcleo determinista no toca red, disco ni modelos — solo decide, y por eso se testea entero.

## Fases (§8 del doc)

| Fase | Entrega | Gate |
|---|---|---|
| **0** | Buzones + IMAP/SMTP, scheduler+rampa, envío entre 2 nodos | 2 nodos intercambian y se leen |
| **1** | Seed core 100–150 dominios + seed inboxes midiendo placement | placement real medible |
| **2** | AI Engine: bodies + replies + señales dinámicas | hilos coherentes, contenido único |
| **3** | Cohortes contra el core, cap 30–40 % frescos, health + auto-pause | cohorte llega a WARM en 3–4 sem |
| **4** | Mantenimiento permanente 5–10 % + auto-pause por placement | mesh autosuficiente |

**Estado actual:** Fase 0 — andamiaje del módulo + núcleo determinista con tests. Los workers de
SMTP/IMAP y el runtime se cablean cuando existan los buzones (infra).

## No-negociables (§9)

- **Seed core primero** — sin él el mesh arranca frío contra frío.
- **Placement real gatea todo**, no el score interno.
- **Frescos ≤ 30–40 % del mesh** siempre.
- **Rampa lenta** — subir rápido quema el buzón haga lo que haga la AI.
- **Mesh 100 % propio** sobre IPs/ASN propios.
- **Mantenimiento nunca a 0** (5–10 % permanente).
