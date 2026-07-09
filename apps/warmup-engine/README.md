# @delivrix/warmup-engine

Servicio **standalone** de calentamiento (warmup) de inboxes. **v1 = Postfix-only, Track A
(transaccional).**

> **Source of truth:** `Delivrix-Warmup-Diseno-v1.md`. Leerlo ante cualquier duda.
> El borrador `Delivrix-Warmup-Sistema-AI.md` (versión sin refinar) y el `ADR-WARMUP-01` (flota
> hosted GWS/M365 + pools + vendor + Gmail API) están **SUPERADOS**. No sacar decisiones de ahí.

## Qué es (y qué NO es)

- **Es (v1):** warmup de buzones **Postfix/Dovecot propios**, en IPs/ASN propios, que se calientan
  con **tráfico transaccional real a destinatarios engaged + medición de placement** — gateado por
  auth. El núcleo irreducible (§6): **auth (gate) → IP warmup → placement contra seeds → rampa
  lenta + auto-pause.**
- **No es:** envío cold/diario, filtro anti-spam de inbound, ni creación/auth de dominios — esos son
  otros servicios y aquí son dependencias externas.
- **NO hay mesh sintético, ni AI, ni pool.** Un mesh interno Postfix↔Postfix construye ~cero
  reputación ante Gmail (§4): lo que calienta de verdad en Track A es la IP + el tráfico real. El
  mesh, el Pair Matcher, el banco de contenido AI y el controlador AIMD son **v2** (diferidos, y solo
  si entra cold outreach de agencia — §6/§11).

## El principio que no se negocia: placement real > score interno

El número interno de "heat" miente (lección DFY: heat 90 con placement real 30–40 % spam). El gate de
todo el sistema es la **colocación real medida contra seed inboxes reales** (Gmail/Workspace/Outlook/
M365/Yahoo + EU). Un lector IMAP mide dónde cayó cada seed (§9):

- **`tabs` cuenta como inbox**; **`missing` ≠ `spam`** (bucket propio).
- Se gatea sobre el **lower bound de Wilson** (no la proporción cruda) + **EWMA** para no oscilar.
- Ese % —no el health— promueve `FRESH → WARM` y dispara el `auto-pause`.

Prerrequisito ya resuelto por el gateway: lectura de entrega real (DSN vía `read_delivery_reason`).

## Estructura del módulo

```
apps/warmup-engine/
  migrations/        Esquema Postgres (§12, bloque v1): warmup_nodes, warmup_sends, warmup_signals,
                     warmup_seed_accounts, warmup_placement_tests/results/rollups. (SIN pairings/
                     threads/variant_bank/tenants — eso es v2.)
  src/
    domain/          NÚCLEO DETERMINISTA PURO (sin I/O, 100 % testeado) — el corazón:
      types.ts         tipos + política (umbrales §9/§10) + contrato de auth. Contrato compartido.
      ramp.ts          rampa LINEAL: cupo diario + clamps duros (<3×/48h, Gmail <50, techo del contrato)
      placement.ts     rollup desde seeds: Wilson-LB + EWMA (tabs=inbox, missing≠spam) — §9
      node-state.ts    FSM: blocked/fresh/warm/paused/quarantined + auth-gate + auto-pause — §8/§9
      auth-checks.ts   contrato de los checks de auth (§8): ids canónicos + sets common/self-hosted
    checks/          CHECKS de auth de Fase 1 (§8) — puros, con resolvers/probes INYECTABLES:
      dns-auth-checks.ts   SPF / DKIM / DMARC / MX (DnsResolver inyectable)
      ip-network-checks.ts PTR-FCrDNS / RBL (Spamhaus/Barracuda/SpamCop) / TLS / HELO / dedicated-IP
      liveness-checks.ts   SMTP_AUTH / IMAP_AUTH (probes; credenciales por REFERENCIA, nunca en claro)
                           / TRACKING_DOMAIN_CLEAN (DBL/SURBL/URIBL) / ONECLICK_UNSUB_CAP (RFC 8058)
    reader/          Inbox Reader de placement (§9):
      imap-placement-reader.ts  lee los seed inboxes EXTERNOS por IMAP, clasifica LandedIn
                                (Gmail labels: tabs=inbox, spam gana; missing≠spam) + grace window t+2m…t+6h
    live/            ADAPTERS de I/O REAL (el único código que toca la red) + composition root:
      dns-adapters.ts  DNS/RBL/DBL/TLS reales (node:dns/tls); DI para tests sin red; NXDOMAIN≠error
      mail-adapters.ts SMTP (nodemailer) + IMAP (imapflow) reales; credenciales por SecretResolver
                       (por referencia, nunca en claro; scrub de secretos en el detail)
      compose.ts       ata los adapters reales a checkers/reader/transporte, GUARDED por el flag:
                       con WARMUP_ENGINE_ENABLE OFF lanza — nada real se construye ni conecta
    store/           PERSISTENCIA (§12) — puertos + implementación Postgres:
      ports.ts         interfaces de los 5 repos (nodes/sends/signals/seeds/placement) — contrato
      pg-stores.ts     implementación sobre PgClient inyectable; idempotencia por slot (ON CONFLICT),
                       todo parametrizado (anti-inyección); tests con cliente fake (sin DB real)
    scheduler/       ORQUESTACIÓN (§7/§9/§10) — ticks puros que componen dominio + stores:
      scheduler.ts     planNodeDay (cupo del día + auth-gate + seeds ≤10%, idempotente por slot) ·
                       processQueuedSends (send-worker + estados + signals) · reconcilePlacement
                       (reader → rollup Wilson/EWMA → transición FSM)
    service/         SERVICIO:
      service.ts       runWarmupTick (una iteración, GUARDED por el flag) + getWarmupStatusSnapshot
                       (read-only, base para "verlo en delivrix" en el panel)
      main.ts          entrypoint/daemon INERTE por default (flag OFF ⇒ loguea y sale; no autoarranca
                       al importarse) — el deployment cablea las deps reales y llama startWarmupDaemon
    runtime/         RUNTIME (§7/§8/§13) — la costura hacia el mundo real:
      auth-gate.ts             gate FAIL-CLOSED (§8): "ningún nodo envía sin contrato `ready`".
      auth-contract-builder.ts corre los checkers → agrega verdicts → firma el AuthReadinessContract
                               con TTL. Los checks aún sin checker quedan `unknown` (fail-closed).
      transport.ts             transporte PLUGGABLE (§7): WarmupTransport + PostfixTransport (SMTP por
                               cliente inyectado) + MockTransport.
      send-worker.ts           Send Worker (§7): gate ANTES del transporte + idempotencia + bounce/DLQ.
      config.ts                FEATURE FLAG WARMUP_ENGINE_ENABLE (default OFF): el engine no arranca ni
                               envía en deploy sin activarlo explícitamente.
    index.ts         superficie pública (núcleo + checks + runtime)
```

El transporte queda **pluggable desde el día 1** para enchufar M365 en v2 sin refactor. El núcleo
`domain/` no toca red ni disco — solo decide, y por eso se testea entero.

## Fases v1 (§13 del doc — Postfix-only)

| Fase | Entrega | Gate de salida |
|---|---|---|
| **0** | Servicio base + Send Worker Postfix (pluggable) + auth-gate fail-closed | ningún nodo envía sin contrato `ready` |
| **1** | Auth completa Track A: SPF/DKIM/DMARC + PTR/FCrDNS + TLS + HELO + RBL | nodo pasa precondiciones self-hosted |
| **2** | IP warmup: rampa lineal sobre la IP fría, a destinatarios reales engaged | volumen sube sin degradar placement |
| **3** | Panel de seeds + harness de placement (Wilson-LB, IMAP, thresholds) | placement medible y gateando estados |
| **4** | Rampa lenta + auto-pause por placement + observabilidad | FRESH→WARM por placement; auto-pausa a <0.70 |
| **5** | Endurecimiento: RBL/ASN monitoring, bounce handling, runbooks | Track A autosuficiente y monitoreado |

**Estado actual:** Fase 0 completa + **Fase 1 auth completa sobre mocks**. Los **13 checks del §8**
están implementados como funciones puras con resolvers/probes inyectables (DNS: SPF/DKIM/DMARC/MX ·
IP/red: PTR-FCrDNS/RBL/TLS/HELO/dedicated-IP · liveness: SMTP_AUTH/IMAP_AUTH/TRACKING_DOMAIN_CLEAN/
ONECLICK_UNSUB_CAP). El `auth-contract-builder` los agrega en un `AuthReadinessContract` firmado que
el gate fail-closed consume (`PENDING_V1_CHECKS` ya está vacío). El **Inbox Reader IMAP** clasifica el
placement desde los seed inboxes externos. Los **adapters de I/O real** (`live/`) implementan cada
interfaz sobre `node:dns`/`node:tls` + nodemailer/imapflow. La **persistencia Postgres** (`store/`,
§12), el **scheduler** (`scheduler/`) y el **servicio** (`service/`: tick + snapshot + daemon) cierran
el runtime v1. **Todo detrás de `WARMUP_ENGINE_ENABLE`** (default OFF): `compose.ts` y `runWarmupTick`
lanzan si el flag no está activo, y el daemon es inerte por default. Todos los tests corren con fakes
inyectados: **ninguno toca la red, la DB ni manda correo**. Falta solo el cableado de deployment
(Postgres/secretos reales) + exponer el snapshot en el panel de Delivrix; nada corre ni envía en
deploy hasta activar el flag.

## v2 — diferido (solo si entra cold outreach de agencia)

Enchufable sin refactor sobre v1: 2º transporte **M365** (nunca la Gmail/Graph API para warmup — ToS
ban), **mesh sparse/anclado/rotativo** + Pair Matcher (seed core reducido a **~5–15** buzones, NO
100–150 — un core grande es el fingerprint a evitar), **banco de contenido AI en batch** off-hotpath,
**aislamiento por tenant**, y el **controlador AIMD** en vez de la rampa lineal. El LLM nunca entra al
camino de envío/decisión, tampoco en v2.

## No-negociables (§14)

- **v1 = Postfix-only, Track A.** GWS/M365, mesh y AI diferidos a v2; transporte pluggable.
- **Placement real gatea todo**, no el health interno (lección DFY).
- **Auth es un gate fail-closed:** ningún nodo envía sin contrato `ready`.
- **Dos tracks, la reputación no transfiere**, scoreboards separados.
- **Track B nunca usa la Gmail/Graph API para warmup** (ToS ban); SMTP + IMAP only.
- **Rampa lenta con clamps** (<3×/48h, Gmail <50/día nueva).
- **Mantenimiento nunca a 0** (5–10 % permanente, cuando exista mesh en v2).
- **Nos volvemos postmasters:** alguien vigila Spamhaus/PTR/bounces/IP-warmup, o esto no funciona.
