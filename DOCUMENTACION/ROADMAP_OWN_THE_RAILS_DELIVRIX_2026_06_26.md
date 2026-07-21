# Roadmap maestro — Delivrix "Own the Rails" (semana 26-jun → 2-jul 2026)

> Documento que abrís todos los días esta semana. Guía táctica + zona de tareas que queda.
> Complementa la tesis `Delivrix_Own_the_Rails_Thesis.pdf` y los planes/guías ya escritos
> (`PLAN_COOL_HIVELOCITY_DIVIDIR_BESTION`, `PROMPT_CODEX_ADAPTER_PROXMOX_HIVELOCITY`,
> `GUIA_CONFIG_MAC_STUDIO_INFERENCIA_LOCAL`, `WARMUP_IA_DELIVRIX`, `PLAN_RESETEO_DOMINIOS_CONTABO`).

**Inicio:** 2026-06-26 (vie) · **Cierre objetivo:** 2026-07-02 (jue) · 6 días hábiles (sin domingo)
**Cliente cero:** NFC · **Operador:** Juanes · **Desarrollo:** módulo nuevo (privado) · **Agente del producto:** OpenClaw

---

## 0. North Star de la semana

**Que OpenClaw cree SMTPs 100% automáticos en TU propia infra (Cool/Hivelocity), los caliente con IA, y todo corra en producción bajo dominio propio.**

Si eso funciona, queda validada la tesis "Own the Rails": los rieles son tuyos (IP, dominio, metal, engine), nadie te puede deplatformar, y la reputación vive en TUS IPs.

---

## 1. La visión, en una página (encuadre corregido)

**Delivrix NO es la app de outreach. Delivrix es los RIELES.** La app tipo Instantly (campañas, secuencias, leads, unibox de prospección, tracking de engagement, multi-tenant, el front comercial) **ya la construye otro SaaS de la empresa** y se integrará a Delivrix a futuro. No se recrea aquí.

Pensalo así: **Delivrix es "nuestro propio SES/SendGrid"** — la infraestructura de envío con IPs y SMTPs propios, warmup con IA, deliverability y una API de envío. **El otro SaaS es "nuestro propio Instantly"** — la app que arma las campañas y **envía a través de Delivrix**.

**El moat:** la empresa controla la infra (Delivrix) Y la app (el otro SaaS) al mismo tiempo. Ningún competidor que alquila rieles puede copiar eso.

### La frontera (quién hace qué)

| Lo hace DELIVRIX (rieles + entrega) | Lo hace el OTRO SaaS (la app) |
|---|---|
| Provisionar SMTPs/IPs/dominios en infra propia (OpenClaw) | Campañas y secuencias (qué, a quién, cuándo) |
| Warmup con IA (acondicionar IPs/dominios) | Leads / listas / CRM de prospectos |
| Deliverability + compliance técnico (SPF/DKIM/DMARC, unsubscribe, suppression) | Tracking de opens/clicks/replies de engagement |
| API de envío: recibe los correos y los entrega a escala por la infra propia (rotación, throttling, IP correcta) | Multi-tenant comercial (clientes, RBAC, planes) |
| Reportes de entrega (delivered/bounce/spam-placement) + unibox de respuestas a los SMTPs propios | Front de outreach (la cara comercial) |
| Panel de operación de la infra (Canvas, Blacklist, Infraestructura, Sender Pool) | — |

> Analogía exacta: el otro SaaS le pasa a Delivrix "manda estos correos"; Delivrix los entrega óptimamente por su infra propia y reporta el resultado. Como usar SES, pero el SES es tuyo.

---

## 2. Estado actual — auditoría (16 frentes, 2026-06-26)

### Lo que YA tenés (los rieles — reutilizable)
- **Provisioning SMTP E2E autónomo** (`configure_complete_smtp`, 14 pasos firmados). Webdock + Contabo live.
- **OpenClaw:** agente SRE, ~30 tools, planes firmados (HMAC), modo autónomo bajo aprobación, kill-switch, governor, selección de cuenta/proveedor first-class.
- **Gobierno y audit:** cadena inmutable real (hash-chain + ancla HMAC), rate-limit, suppression list.
- **Warmup a medio construir:** rampa + persistencia + breaker-por-bounce + medición de placement por IMAP — **pero desconectados entre sí** (ver Track W).
- **Abstracción `VpsProvider`** lista para sumar Proxmox.
- **Panel de infra** (React 19 + Vite 8 + Tailwind 4 + Canvas v5): Canvas live + Blacklist + Infraestructura con dato real.

### Lo que falta — y de quién es
**De DELIVRIX (construir aquí):**
- **Infra propia real:** el adapter Proxmox es solo stub → implementarlo (Track A). Es el North Star.
- **Warmup con IA:** conectar lo que existe + generador de contenido IA local + rampa guiada por placement + breaker por spam-rate (Track W).
- **API de envío + compliance técnico:** que el otro SaaS pueda enviar a través de Delivrix; one-click unsubscribe + suppression enforcement (Track S).
- **Producción:** hoy corre local en la Mac (screen/loopback); falta host always-on, conectividad OpenClaw↔gateway, TLS, auth (Track D).
- **Cerebro IA local:** Mac Studio en Miami (Track E).

**Del OTRO SaaS (NO se construye en Delivrix):**
- Campañas / secuencias · Leads / listas · Tracking de opens/replies de engagement · Multi-tenant comercial · Front de outreach.

### Auditoría complementaria (6 frentes de readiness)
- **Deploy:** control plane local; runbook `RUNBOOK_DEPLOY_ETAPA1` escrito sin ejecutar; bloqueante #1 = OpenClaw no alcanza al gateway.
- **QA:** núcleo bien testeado (163 tests); QA Auditor construido pero sin mergear (quick win); adapter Proxmox es stub.
- **Front:** el panel de infra **se queda y se pule** (no se rehace hacia una app de outreach — eso es del otro SaaS).
- **Costos:** fase puente ~$1.000-1.050/mes (fijo infra $748-791; variable IA+seeds).
- **Compliance técnico:** falta one-click unsubscribe (RFC 8058) + suppression enforcement en el send-path (Track S).
- **Escala/entrega:** el envío hoy es 1 correo/request sobre SSH (tope 5/servidor/hora); para ser "el SES propio" falta el ejecutor a escala (cola + workers + throttling) en la API de envío (Track S).

> Detalle accionable con DoD: `CHECKLIST_EJECUCION_OWN_THE_RAILS.md`. Checklist en vivo: artifact `delivrix-own-the-rails-checklist`.

---

## 3. Tracks de la semana (con tareas específicas)

> Marca de alcance: **[S]** objetivo del sprint de 6 días · **[F2+]** fase posterior. Responsable entre paréntesis.

### Track A — Rieles propios (infra Cool)
El corazón del North Star. Bestión Hivelocity → Proxmox + LXC → adapter en Delivrix → OpenClaw crea SMTPs solo.
- **A1 [S]** (Juanes) Comprar el /26 (62 IPs) + verificar IP base limpia (0/blacklists). **DoD:** IPs asignadas; IP base sigue limpia.
- **A2 [S]** (Juanes+Dev) Instalar Proxmox VE + plantilla LXC (Postfix+OpenDKIM+OpenDMARC+TLS). **DoD:** clono la plantilla y levanta un LXC sano.
- **A3 [S]** (Dev) Adapter Proxmox real: `createServer`=clonar LXC vía API Proxmox; `list/get/delete`; diseñado **multi-host** desde ya. **DoD:** OpenClaw crea un SMTP en Cool con un run firmado.
- **A4 [S]** (Dev) Cablear el adapter como **hermano de Contabo**: canal `providerId`/`serverAccountId`, enum, y **todos** los pasos post-create provider-aware (lección del bug de bind). **DoD:** el provider "proxmox" se elige explícito y el E2E lo respeta.
- **A5 [S]** (Juanes) PTR/rDNS manual por IP en el panel Hivelocity (gate FCrDNS). **DoD:** PTR resuelve y FCrDNS pasa.
- **A6 [F2+]** (Dev) Onboarding del 2º bestión como evento add-node (multi-host). **DoD:** un nodo nuevo entra sin tocar el código del primero.

### Track E — Cerebro IA local (Mac Studio M4 Max, Miami)
Inferencia IA local barata y de alta frecuencia para no depender de Bedrock. Detalle en `GUIA_CONFIG_MAC_STUDIO_INFERENCIA_LOCAL`.
- **E1 [S]** (Juanes) Acceso remoto a la Mac (SSH + Tailscale). **DoD:** entro por SSH desde fuera de la red local.
- **E2 [S]** (Juanes+Dev) Runtime de inferencia local (LM Studio headless + gpt-oss-20b). **DoD:** el modelo responde local a un prompt de prueba.
- **E3 [S]** (Dev) Exponer un endpoint que Delivrix consuma (OpenAI-compatible sobre Tailscale). **DoD:** el gateway llama a la inferencia local y recibe respuesta.
- **E6 [S]** (Juanes) Decidir si la Mac aloja también el control plane (resolvería el host del Track D). **DoD:** decisión tomada.

### Track W — Warmup con IA (sobre infra propia) · NUEVO
Acondicionar IPs/dominios con IA, guiado por placement real. Investigación y diseño en `WARMUP_IA_DELIVRIX`. **Clave honesta:** no es la malla recíproca de Instantly (eso es el peor caso de detección con infra propia) — es rampa de volumen real guiada por placement, con IA local para contenido y decisión.
- **W1 [S]** (Dev) Generador de contenido de warmup con IA local (Mac Studio/gpt-oss-20b): reemplaza el render plantilla de `warmup.ts`; tag de filtro **por dominio**; randomización de longitud/jitter. **DoD:** los correos de warmup salen variados, no plantilla.
- **W2 [S]** (Dev) Decisor de rampa **adaptativo guiado por placement**: reemplaza la curva fija de `ramp-plan.ts`; techo ~30-50/buzón/día; sube/mantiene/reduce según placement. **DoD:** la rampa cambia de pendiente según el placement medido.
- **W3 [S]** (Dev) Circuit-breaker **por spam-rate** (además del de bounce): umbral duro cerca de 0.30% (objetivo <0.10%); nuevo pause-reason; enforcar el `DELIVERY_RATE_FLOOR=0.85` ya definido. **DoD:** el warmup se auto-pausa si el placement/spam se degrada, no solo por bounce.
- **W4 [S]** (Dev) Wire-up `placement-check` → `RampScheduler`: que `runBatch` dispare el placement-check tras enviar y realimente el decisor (W2) y el breaker (W3). **DoD:** las dos rutas, hoy desconectadas, quedan en un lazo cerrado.
- **W5 [F2+]** (Dev) Seed-list diversa multi-ESP (Gmail/Outlook/Yahoo + aliados que opten) + ingesta read-only de Google Postmaster v2 y Microsoft SNDS. **DoD:** el placement se mide contra varios proveedores + señales reales del proveedor.
- **W6 [F2+]** (Dev) Motor recíproco interno **acotado**: intercambio entre buzones propios SOLO para calentar el stack SMTP/IMAP/DKIM, con tope estricto, marcado y auditado — nunca como engagement falso. **DoD:** existe y está topado/auditado.
- **W7 [F2+]** (Dev) Health-score compuesto (deliverability + Postmaster + DNS) + UI en el panel. **DoD:** score 0-100 con bandas color en Infraestructura.

### Track B — Limpieza y sender pool real
Recuperar dominios atrapados en cuentas baneadas. Detalle en `PLAN_RESETEO_DOMINIOS_CONTABO`.
- **B1 [S]** (Juanes) Verificar las 22 clasificaciones de dominios antes de tocar nada. **DoD:** ninguna acción sobre un dominio "en uso".
- **B2 [S]** (Juanes+OpenClaw) Resetear los huérfanos de AWS (filing-ops, corpfiling-ops). **DoD:** DNS limpio, sin binding viejo.
- **B3 [S]** (OpenClaw) Reconfigurar sobre infra sana en olas de 2-3/día (anti-snowshoe). **DoD:** cada dominio con SMTP nuevo entregando a inbox.
- **B4 [F2+]** (Dev) Tool de poda del sender-pool (baja idempotente de SMTPs muertos). **DoD:** baja auditada sin romper inventario.

### Track S — API de envío + entrega responsable (el "SES propio") · re-scope
Lo que convierte los rieles en un servicio que el otro SaaS consume. **Reemplaza el viejo "motor de campañas"** — Delivrix NO arma campañas; recibe órdenes de envío y las entrega.
- **S1 [F2+]** (Dev) **API de envío**: endpoint que recibe del otro SaaS los correos a enviar (individual/batch) y los encola. **DoD:** el SaaS manda un correo por API y Delivrix lo acepta.
- **S2 [F2+]** (Dev) **Ejecutor a escala**: cola durable (BullMQ/Redis o Postgres SKIP LOCKED) + pool de workers + persistencia relacional (jobs/results) — reemplaza el 1-correo-por-request-sobre-SSH. **DoD:** N workers entregando concurrente desde la infra propia.
- **S3 [S]** (Dev) **Compliance técnico de entrega**: `List-Unsubscribe` + one-click RFC 8058 + endpoint POST; **enforcement de suppression antes de cada envío**; dirección física + identificación del remitente por plantilla. **DoD:** ningún correo sale a un suprimido; Gmail muestra el botón nativo de baja.
- **S4 [F2+]** (Dev) **Rotación + throttling** por IP/SMTP, warmup-aware (respeta los topes del Track W). **DoD:** el envío respeta rotación round-robin y los límites de calentamiento.
- **S5 [F2+]** (Dev) **Reportes de entrega** (delivered/bounce/spam-placement) + unibox de respuestas a los SMTPs propios, expuestos al otro SaaS. **DoD:** el SaaS consulta el estado de entrega y las respuestas.

### Track D — Plataforma y deploy
Sacar el sistema de la Mac y ponerlo en producción. Runbook `RUNBOOK_DEPLOY_ETAPA1` (escrito, sin ejecutar).
- **D1 [S]** (Juanes+Dev) Host always-on (sale de la Mac del CTO). **DoD:** sigue arriba con la Mac apagada.
- **D2 [S]** (Dev) Conectividad OpenClaw→gateway (túnel Cloudflare/WireGuard o bridge; hoy `gateway.delivrix.local` inalcanzable). **DoD:** OpenClaw lee el read-boundary del gateway desde Hostinger.
- **D3 [S]** (Dev) Reverse proxy + TLS + DNS del dominio propio. **DoD:** el panel carga por HTTPS bajo el dominio propio.
- **D4 [S]** (Dev) Auth/SSO + IP allowlist del panel (hoy GET-only sin login). **DoD:** nadie entra al control plane sin autenticarse.
- **D5 [S]** (Dev) Process manager (systemd) + Postgres/Redis productivos. **DoD:** reinicio automático tras reboot; estado durable.
- **D6 [F2+]** (Dev) Imagen de producción (multi-stage, no-root) + compose prod. **DoD:** deploy reproducible por imagen.

### Track T — Transversal (QA / CI)
- **T1 [S]** (Dev) Mergear el QA Auditor (rama `feature/qa-auditor`, sin mergear) + activar su workflow. **DoD:** cada PR recibe el reporte automático.
- **T2 [S]** (Dev) CI con typecheck (tsc strict) + la suite existente (163 tests). **DoD:** un PR rojo no se puede mergear.
- **T3 [F2+]** (Dev) Tests de UI del panel + E2E SMTP automatizado. **DoD:** smoke E2E corre en CI.

---

## 4. Cronograma día a día (6 días)

| Día | A · Rieles | W · Warmup IA | B · Limpieza | E/D · Cerebro + Deploy |
|---|---|---|---|---|
| **Vie 26** | Comprar /26; brief adapter a desarrollo | Diseño cerrado (doc `WARMUP_IA`) | Resetear huérfanos AWS; verificar IPs | Habilitar acceso remoto Mac (E1) |
| **Sáb 27** | Proxmox + template LXC | W4: wire-up placement→scheduler | Reusar 2-3 dominios | Runtime + modelo en la Mac (E2) |
| **Lun 29** | Primer SMTP propio E2E → inbox; adapter (dev) | W1: generador de contenido IA local | Sender pool con dato real | Endpoint Mac (E3); Postgres/Redis prod (D5) |
| **Mar 30** | OpenClaw crea LXC **100% auto** | W2: rampa adaptativa por placement | Olas 2-3/día | Conectividad OpenClaw↔gateway (D2); QA Auditor merge (T1) |
| **Mié 1-jul** | Warmup en olas (6-8 IPs) | W3: breaker por spam-rate | Monitoreo blacklist | Host always-on + TLS + dominio (D1/D3/D4); CI (T2) |
| **Jue 2-jul** | — | Validar lazo cerrado de warmup | — | **Deploy a producción** bajo dominio propio; S3 (one-click unsubscribe + suppression) |

> El cronograma es agresivo a propósito. Track A (rieles) + Track W (warmup) son **fundacionales y alcanzables**. La API de envío (Track S, salvo S3) es **fase 2** — arranca cuando el otro SaaS esté listo para integrarse. No se promete "todo en 6 días".

---

## 5. Criterios de aceptación (gate — binario)

- [ ] OpenClaw crea un SMTP completo en el bestión propio (Cool) **100% automático** y entrega a **inbox** (FCrDNS + DKIM + warmup).
- [ ] Adapter Proxmox implementado contra la API real (o, mínimo, camino manual + registrado en sender pool).
- [ ] Warmup con IA en **lazo cerrado**: rampa guiada por placement + breaker por spam-rate (Track W, W1-W4).
- [ ] Mac Studio (Miami) con inferencia local respondiendo a Delivrix por un endpoint propio.
- [ ] Dominios huérfanos de AWS reseteados / reusados.
- [ ] El sistema corre en **producción bajo dominio propio**, con pipeline local→prod probado.
- [ ] Compliance técnico mínimo: one-click unsubscribe + enforcement de suppression (S3).
- [ ] QA Auditor mergeado + CI corriendo typecheck y suite.

---

## 6. Tus tareas, Juanes

- **Comprar** el /26 (62 IPs) + confirmar el servidor.
- **Configurar Proxmox** con guía (vos por SSH) o dándome acceso por key.
- **PTR/rDNS manual** en Hivelocity por cada IP (FCrDNS).
- **Habilitar el acceso remoto** a la Mac Studio (SSH + Tailscale).
- **Firmar los planes** que gastan dinero (aprobaciones de OpenClaw — solo tuyo).
- **Pasar los briefs** al desarrollo.
- **Verificar IPs** en blacklist antes de cargar volumen.
- **Decidir el dominio propio** del sistema/panel.

---

## 7. Riesgos y mitigaciones

| Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|
| Puerto 25 / IP Hivelocity sucia | Baja | Alto | Ya confirmado: puerto 25 abierto, IP base 0/60 |
| Adapter Proxmox tarda > 1-2 días | Media | Medio | Camino B: SMTPs manual + registrar en sender pool |
| **Warmup artificial mal hecho (malla interna) quema reputación** | Media | Alto | Modelo de placement real, NO malla recíproca pura (ver `WARMUP_IA` §6.1) |
| Snowshoe al encender muchas IPs | Media | Alto | Warmup en olas obligatorio (6-8 → 30), nunca todas de golpe |
| Postgres/Redis local apagados | Media | Medio | Levantarlos el lunes; necesarios para entrega durable |
| Exponer el control plane sin auth | Media | Alto | D4 (auth/SSO) bloqueante antes de cualquier bind público |

---

## 8. Lo que NO hace Delivrix (es del otro SaaS o fase futura)

**Del otro SaaS (la app, NO se construye en Delivrix):** campañas / secuencias, leads / listas / CRM, tracking de opens/clicks/replies de engagement, multi-tenant comercial, front de outreach. Delivrix expone la **API de envío** y el otro SaaS la consume.

**Fase futura de Delivrix (post-sprint):** API de envío completa a escala (Track S salvo S3), seed-list multi-ESP + ingesta Postmaster/SNDS (W5), motor recíproco interno (W6), health-score UI (W7), 2º bestión (A6), imagen de producción (D6), tests de UI/E2E (T3).

**Tesis completa "Own the Rails" (lejana):** ASN propio + BGP + BYOIP (~6 /24s), ~4.500 dominios, ~13.500 mailboxes, 2× Dell PowerEdge en office-as-datacenter (FL), meta enero 2027. El Cool/Hivelocity de esta semana es el **puente** que valida el modelo.

---

## 9. Zona de tareas persistente — onboarding del 2º bestión

Cuando entre el segundo bestión, **no se rehace nada** — es un evento "add-node" (el adapter Proxmox se diseña multi-host desde ya). Checklist replicable:
1. Servidor con OS base + puerto 25 confirmado abierto.
2. Verificar reputación del rango (MXToolbox) antes de cargar.
3. Proxmox + clonar el template LXC (mismo Ansible).
4. Registrar el host en Delivrix (nuevo `accountId` Proxmox) → OpenClaw lo usa automático.
5. PTR/FCrDNS por IP en el panel del proveedor.
6. Warmup en olas, monitoreo de blacklist, round-robin entre IPs calentadas.
7. **Diversificación:** que esté en otro datacenter/rango → alta disponibilidad real.

---

## 10. Documentos de referencia
- `TESIS_2_DELIVRIX_RIELES_PROPIOS_2026_06_26.md` — **EL NORTE** (Delivrix = los rieles, no la app). Leer primero.
- `Tesis_Delivrix_v3.4_BUSINESS_PLAN_MVP.pdf` (Tesis #1) + `NORTE_OPERATIVO_DELIVRIX.md` — visión y norte previos.
- `CHECKLIST_EJECUCION_OWN_THE_RAILS.md` — checklist accionable (tareas con DoD).
- Checklist en vivo: artifact `delivrix-own-the-rails-checklist` (interactivo).
- `SPRINT_OWN_THE_RAILS_STATUS.md` — progreso diario.
- `WARMUP_IA_DELIVRIX_2026_06_26.md` — investigación + diseño del warmup con IA (Track W).
- `GUIA_CONFIG_MAC_STUDIO_INFERENCIA_LOCAL_2026_06_26.md` — Track E (Mac Studio).
- `PLAN_COOL_HIVELOCITY_DIVIDIR_BESTION_2026_06_26.md` — cómo se divide el bestión.
- `PROMPT_CODEX_ADAPTER_PROXMOX_HIVELOCITY_2026_06_26.md` — el adapter Proxmox.
- `PLAN_RESETEO_DOMINIOS_CONTABO_2026_06_26.md` — reusar dominios + reglas anti-ban.
- `OPENCLAW_SYSTEM_PROMPT.md` (v2.14) — capacidades del agente.
