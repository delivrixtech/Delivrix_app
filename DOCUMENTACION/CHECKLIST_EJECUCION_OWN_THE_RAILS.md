# Checklist de Ejecución — Own the Rails (Delivrix)

> Documento accionable, marcable. Espejo del roadmap (`ROADMAP_OWN_THE_RAILS_DELIVRIX_2026_06_26.md`, sección 3) y del artifact `delivrix-own-the-rails-checklist`.

**North Star:** OpenClaw crea SMTPs 100% automáticos en infra propia (Cool), los calienta con IA, y todo corre en producción bajo dominio propio.
**Sprint:** vie 26-jun → jue 2-jul · **Marcas:** `[S]` sprint · `[F2+]` fase posterior.
**Última actualización:** 2026-06-28 (sesión: O1 memoria semántica + O2 estado en vivo + O3 read_delivery_reason cableado y testeado + O4 motor de reachability arrancado).

---

## 0. Encuadre (no se re-discute)

**Delivrix = los rieles** (el SES/SendGrid propio: infra de envío + warmup IA + deliverability + API de envío + unibox de respuestas + panel de operación).
**La app de outreach** (campañas, secuencias, leads, tracking de engagement, multi-tenant, front comercial) **la hace otro SaaS** de la empresa y se integra a futuro. **No se construye en Delivrix.**

Decisiones tomadas: infra puente = Cool (Proxmox+LXC) · IPs = /26 · panel de infra se queda y se pule · leads/campañas = otro SaaS · warmup = placement-driven con IA local, NO malla recíproca.

---

## 1. Track A — Rieles propios (Cool)
- [ ] **A1 [S]** (Juanes) Comprar /26 (62 IPs) + verificar IP base limpia. **DoD:** IPs asignadas; base 0/blacklists.
- [ ] **A2 [S]** (Juanes+Dev) Proxmox VE + plantilla LXC (Postfix+OpenDKIM+DMARC+TLS). **DoD:** clono y levanta LXC sano.
- [ ] **A3 [S]** (Dev) Adapter Proxmox real (clonar LXC vía API; multi-host). **DoD:** OpenClaw crea un SMTP en Cool con run firmado.
- [ ] **A4 [S]** (Dev) Cablear adapter hermano de Contabo; todos los pasos provider-aware. **DoD:** provider "proxmox" explícito; E2E lo respeta.
- [ ] **A5 [S]** (Juanes) PTR/rDNS manual por IP (FCrDNS). **DoD:** PTR resuelve, FCrDNS pasa.
- [ ] **A6 [F2+]** (Dev) Onboarding 2º bestión (add-node multi-host). **DoD:** nodo nuevo sin tocar el código del primero.

## 2. Track E — Cerebro IA local (Mac Studio, Miami)
- [ ] **E1 [S]** (Juanes) Acceso remoto (SSH+Tailscale). **DoD:** entro por SSH desde fuera.
- [ ] **E2 [S]** (Juanes+Dev) Runtime local (LM Studio + gpt-oss-20b). **DoD:** el modelo responde local.
- [ ] **E3 [S]** (Dev) Endpoint para Delivrix (OpenAI-compatible sobre Tailscale). **DoD:** el gateway lo llama y recibe.
- [ ] **E6 [S]** (Juanes) Decidir si aloja el control plane. **DoD:** decisión tomada.

## 3. Track W — Warmup con IA (placement-driven)
> No replicar la malla recíproca de Instantly (peor caso con infra propia). Modelo = volumen real guiado por placement + IA local. Detalle: `WARMUP_IA_DELIVRIX`.
- [ ] **W1 [S]** (Dev) Generador de contenido de warmup con IA local; tag por dominio; randomización. **DoD:** correos variados, no plantilla.
- [ ] **W2 [S]** (Dev) Rampa adaptativa guiada por placement (techo 30-50/buzón/día). **DoD:** la pendiente cambia según placement.
- [x] **W3 [S]** (Dev) Circuit-breaker por spam-rate (umbral ~0.30%); enforce delivery floor. **DoD:** auto-pausa por placement/spam, no solo bounce. [HECHO + committeado `d645807`. `warmup-breaker.ts` — `evaluateWarmupBreaker` pesa bounce + spam-complaint (~0.30%) + placement (piso inbox 80%) → continue/throttle/pause con razón (`auto_bounce_rate`/`auto_spam_rate`/`auto_placement`). 10/10 verde.]
- [x] **W4 [S]** (Dev) Wire-up placement-check → scheduler (cerrar el lazo). **DoD:** las dos rutas quedan realimentadas. [HECHO end-to-end + testeado. Seam: el scheduler corre el breaker tras cada batch y auto-pausa con `auto_spam_rate`/`auto_placement` (no solo bounce); sin señales = cero regresión. Feed de producción: `warmup-signals-source.ts` lee el último `oc.placement.checked` del audit por `rampId` → seedInbox/seedSpam, cableado en `main.ts` (sin IMAP en el hot path). +2 tests de integración del scheduler + 5 del reader; suite completa 1306 pass. (Complaints/FBL como señal extra = follow-up.)]
- [ ] **W5 [F2+]** (Dev) Seed-list multi-ESP + ingesta Postmaster/SNDS. **DoD:** placement medido contra varios proveedores.
- [ ] **W6 [F2+]** (Dev) Motor recíproco interno acotado (solo calentar stack; topado/auditado). **DoD:** existe y está topado.
- [ ] **W7 [F2+]** (Dev) Health-score compuesto + UI. **DoD:** score 0-100 con bandas en el panel.

## 4. Track B — Limpieza y sender pool real
- [ ] **B1 [S]** (Juanes) Verificar las 22 clasificaciones antes de tocar. **DoD:** nada sobre un dominio en uso.
- [ ] **B2 [S]** (Juanes+OpenClaw) Resetear huérfanos AWS (filing-ops, corpfiling-ops). **DoD:** DNS limpio, sin binding viejo.
- [ ] **B3 [S]** (OpenClaw) Reconfigurar sobre infra sana en olas 2-3/día. **DoD:** cada dominio entrega a inbox.
- [ ] **B4 [F2+]** (Dev) Tool de poda del sender-pool. **DoD:** baja idempotente y auditada.

## 5. Track S — API de envío + entrega responsable (el SES propio)
> Reemplaza el "motor de campañas". Delivrix NO arma campañas; recibe órdenes y entrega.
- [ ] **S3 [S]** (Dev) Compliance técnico: List-Unsubscribe one-click (RFC 8058) + endpoint POST + enforcement de suppression antes de cada envío + dirección física. **DoD:** ningún correo sale a un suprimido; Gmail muestra el botón nativo.
- [ ] **S1 [F2+]** (Dev) API de envío: recibe del otro SaaS los correos y los encola. **DoD:** el SaaS manda un correo por API y Delivrix lo acepta.
- [ ] **S2 [F2+]** (Dev) Ejecutor a escala: cola durable + workers + persistencia (reemplaza 1-correo-por-request-SSH). **DoD:** N workers entregando concurrente.
- [ ] **S4 [F2+]** (Dev) Rotación + throttling por IP/SMTP, warmup-aware. **DoD:** respeta round-robin y topes de calentamiento.
- [ ] **S5 [F2+]** (Dev) Reportes de entrega + unibox de respuestas, expuestos al SaaS. **DoD:** el SaaS consulta entregas y respuestas.

## 6. Track D — Plataforma y deploy
- [ ] **D1 [S]** (Juanes+Dev) Host always-on. **DoD:** sigue arriba con la Mac apagada.
- [ ] **D2 [S]** (Dev) Conectividad OpenClaw→gateway (túnel/bridge). **DoD:** OpenClaw lee el gateway desde Hostinger.
- [ ] **D3 [S]** (Dev) Reverse proxy + TLS + DNS dominio propio. **DoD:** panel por HTTPS bajo el dominio.
- [ ] **D4 [S]** (Dev) Auth/SSO + IP allowlist del panel. **DoD:** nadie entra sin autenticarse.
- [ ] **D5 [S]** (Dev) Process manager (systemd) + Postgres/Redis prod. **DoD:** reinicio automático; estado durable.
- [ ] **D6 [F2+]** (Dev) Imagen de producción + compose prod. **DoD:** deploy reproducible por imagen.

## 7. Track T — Transversal QA/CI
- [ ] **T1 [S]** (Dev) Mergear QA Auditor + workflow. **DoD:** cada PR recibe reporte.
- [ ] **T2 [S]** (Dev) CI typecheck + suite (163 tests). **DoD:** PR rojo no mergea.
- [ ] **T3 [F2+]** (Dev) Tests de UI + E2E SMTP automatizado. **DoD:** smoke E2E en CI.

## 8. Track O — OpenClaw confiable y observable (memoria · estado · deliverability)
> Confiabilidad del agente: que recuerde entre turnos, vea la flota completa y sepa por qué rebota un correo sin SSH. Detectado y arreglado en sesión 2026-06-28 (root-cause en código, no supuestos).
- [x] **O1 [S]** (Dev) Memoria de OpenClaw arreglada + reforzada: causa raíz del 503 era Postgres apagado; el 400 ya estaba fixeado. Motor de memoria semántica nuevo (pgvector + FTS español + fusión RRF) con servicio de embeddings Bedrock y tools `semantic_remember`/`semantic_recall` wireadas y gated. **DoD:** insert+recall en vivo contra Postgres (smoke verde; 101 tests). ✅ 2026-06-28
- [x] **O2 [S]** (Dev) Estado en vivo confiable: eliminada la truncación del live-context del agente (`active_smtp_runs` 12→50, `liveContextItemLimit` 20→50, budgets de chars). **DoD:** el agente ve la flota completa (`count: 23, truncated: false`, 50 runs). ✅ 2026-06-28
- [x] **O2a [S]** (Dev) Hardening PR #33 QA: memoria semántica con gate HMAC específico (`OPENCLAW_MEMORY_ALLOW_UNSIGNED_LOCAL=false` en producción), circuit-breaker anti tool-loop, parser Postfix con límite de línea y `visibility` centralizada. **DoD:** QA follow-up aplicado; tests enfocados y suite completa verdes. ✅ 2026-06-28
- [ ] **O3 [S]** (Dev) Captura de bounces/DSN sin SSH del agente: colector que lee `mail.log` por SSH (gateway, 2 etapas: message-id → queue-id → línea `status=`) → parser → motivo estructurado → read-tool del agente. **DoD:** el agente ve el motivo de rebote por mensaje. [Hecho end-to-end y testeado: motor colector (2 etapas, best-effort que nunca lanza, path-guard anti-inyección) + tool `read_delivery_reason` del agente cableado en sus 5 puntos (param-schema, catálogo Bedrock, dispatch read-only, ruta `/v1/openclaw/delivery-reason` con auth read-boundary + audit, matriz C2). Suite completa verde (1249 pass) salvo las 17 fallas ambientales de sandbox ya conocidas (SQLite→/tmp). Hallazgo: el rebote es asíncrono (llega al log min después del envío) → se expone como read-tool on-demand, no en el path de envío. Pendiente: gate (PR #34) + verificación en vivo contra un server real. Store en DB de histórico = F2+.]
- [ ] **O4 [S]** (Dev) Endurecer diagnóstico de OpenClaw (inbound vs outbound 25, DKIM/selectores, no marcar rojo lo que funciona). **DoD:** no repite las falsas alarmas auditadas. [Cableado end-to-end + testeado (suite completa verde salvo la falla ambiental conocida de `approval-token`; sin commitear). 2 root-causes → 2 motores + 2 read-tools del agente: (a) `read_smtp_reachability` separa inbound vs OUTBOUND :25 y devuelve `unknown` (nunca un `blocked` falso); (b) `read_dkim_status` prueba la convención real `s<year>a`/`s2026a` + comunes y distingue valid/revoked/absent/unknown (nunca un `absent` falso). Cableados en los 5 puntos (schema, catálogo, dispatch read-only, ruta con auth read-boundary + audit, matriz C2). Pendiente: gate (PR) + verificación en vivo.]
- [x] **O5 [F2+]** (Dev) Robustez de provisioning / completitud de run-state: todo server con run registrado (annualcorpfilings envió 10/10 sin run) + limpieza de runs fallidos. **DoD:** no hay servers que envían sin run. [HECHO end-to-end + testeado. `run-state-integrity.ts` cruza dominios-que-envían (audit `oc.smtp.real_email_sent`) contra los runs (`inventory/smtp-runs/*.json` por `chosenDomain`) → `domainsWithoutRun` (caso annualcorpfilings) + `failedRuns`/`cancelledRuns` + veredicto `ok`. Cableado como read-tool del agente `read_run_state_integrity` en los 5 puntos + ruta con auth read-boundary + audit. +3 tests handler + 7 del motor; suite completa 1316 pass.]

---

## 9. Presupuesto (fase puente, mensual aprox.)

| Componente | Tipo | USD/mes |
|---|---|---|
| Servidor Cool (Hivelocity) | Fijo | 563 |
| Bloque /26 (62 IPs @ $2.50) | Fijo | 155 |
| Dominios sending (20-50 .com) | Fijo | 18-46 |
| AWS Route53 + Bedrock (residual, baja con Mac Studio) | Variable | 33-100 |
| Hostinger (OpenClaw) | Fijo | 9-22 |
| Seeds de warmup (buzones de control) | Variable | 10-40 |
| **Total** | | **~790-930** |

> Baja vs. la estimación previa (~$1.000-1.050): sin Apollo/Clay (leads = otro SaaS) y con Bedrock reducido por la Mac Studio. El moat sigue siendo server + /26 ($718).

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| Puerto 25 / IP sucia | Ya confirmado: puerto 25 abierto, IP base 0/60 |
| Adapter Proxmox tarda | Camino B: manual + registrar en sender pool |
| Warmup mal hecho (malla interna) quema reputación | Placement-driven, NO malla recíproca (ver WARMUP_IA §6.1) |
| Snowshoe | Olas obligatorias (6-8 → 30), nunca de golpe |
| Control plane sin auth | D4 bloqueante antes de bind público |

## 10. Lo que NO hace Delivrix
Del otro SaaS: campañas/secuencias, leads/listas, tracking de engagement, multi-tenant comercial, front de outreach. Delivrix expone la API de envío; el SaaS la consume.
Fase futura de Delivrix: API de envío a escala (Track S salvo S3), warmup avanzado (W5-W7), 2º bestión (A6), imagen prod (D6), tests UI/E2E (T3).
