# Brief de construccion — Agente Warmup Senior (Delivrix)

> Prompt accionable para el agente de desarrollo (VS Code / bash). Pegar tal cual y ejecutar por fases.
> Fecha: 2026-07-06 · Sprint: Own the Rails · Track W (warmup) + Fase 2 (multi-agente).
> Referencia de diseno: `DOCUMENTACION/WARMUP_IA_DELIVRIX_2026_06_26.md` (secciones 6.0 a 6.7 y 7).
> Referencia de arquitectura: `DOCUMENTACION/ARQUITECTURA_MULTI_AGENT_RUNTIME_2026_05_29.md`.

---

## 0. Objetivo (North Star de este brief)

Construir el **Warmup Senior**: el agente que calienta bandejas de forma autonoma, al estilo del
agente de warmup de Instantly, PERO sobre infraestructura propia y con el modelo correcto:
**rampa de volumen real guiada por placement**, no malla reciproca artificial. Debe quedar
cableado como uno de los 5 agentes del runtime multi-agente (Fase 2), reemplazando el mock por
tools reales que operan el sustrato de warmup que ya existe.

**No se parte de cero.** Delivrix ya tiene seed + scheduler + placement-check + breaker (W3/W4 hechos).
Este brief cierra el cerebro (W1 contenido IA + W2 decisor adaptativo) y las 8 tools del agente.

---

## 1. Encuadre y restriccion dura (no se re-discute)

- Modelo legitimo = **rampa gradual de volumen real hacia una seed-list de buzones reales y diversos**,
  midiendo placement real y dejando que la IA decida la pendiente.
- **PROHIBIDO**: malla reciproca pura entre buzones propios como sustituto del engagement real; inflar
  open/reply artificiales; cualquier via Gmail API para el warmup (viola ToS de Google). El plano
  reciproco interno (W6) es F2+, acotado y auditado, y NO es parte de este brief.
- Umbral duro Gmail: complaint rate objetivo **< 0.10%**, pausa dura al acercarse a **0.30%**
  (el breaker ya usa `spamRate: 0.003`). Techo por buzon **30-50/dia**; se escala con mas buzones,
  no con mas volumen por buzon. Enforce `DELIVERY_RATE_FLOOR = 0.85` (hoy definido, sin aplicar).
- Tag de filtro **por dominio** (no global): no crear una firma compartida entre dominios.

---

## 2. Estado actual — ground truth (LEER estos archivos ANTES de tocar nada)

Regla: no adivinar. Abrir y leer cada archivo real antes de escribir. No mutar el working tree de
otras ramas; para leer la rama de Fase 2 usar `git show feat/fase2-multi-agent:<ruta>`.

Sustrato de warmup existente (en produ):
- `apps/gateway-api/src/routes/warmup.ts` — seed: `handleWarmupStartHttp` (3 correos desde `hello@<dominio>` por SSH, firmado, idempotente, auditado).
- `apps/gateway-api/src/routes/warmup-ramp.ts` — `RampScheduler` (clase), `StartRampInput`, `WarmupExternalSignals`, `RampSchedulerDependencies`, handlers `handleRampStartHttp` / `handleRampGetHttp` / `handleRampPauseHttp` / `handleRampResumeHttp`.
- `apps/gateway-api/src/routes/warmup-sender.ts` — `WARMUP_FROM_LOCALPART`, `warmupFromAddress(domain)`.
- `apps/gateway-api/src/routes/placement-check.ts` + `apps/gateway-api/src/email-imap/gmail-adapter.ts` — placement via IMAP a seed Gmail (X-GM-LABELS -> inbox/spam). W4: hoy read-only.
- `apps/gateway-api/src/warmup-signals-source.ts` — `createWarmupSignalsReader` (lee el ultimo `oc.placement.checked` del audit por rampId; feed del W4).
- `packages/domain/src/warmup/ramp-plan.ts` — `getWarmupRampPlan`, `materializeRampBatches`, `WarmupRampSchedule` ("demo-fast"|"production-14d"), `WarmupRampPauseReason`, `BOUNCE_RATE_AUTO_PAUSE = 0.05`, `DELIVERY_RATE_FLOOR = 0.85`.
- `packages/domain/src/warmup/warmup-breaker.ts` — `evaluateWarmupBreaker` (W3), `WarmupBreakerDecision`, `DEFAULT_WARMUP_BREAKER_THRESHOLDS = { bounceRate: 0.05, spamRate: 0.003, placementFloor: 0.8, placementWarnBand: 0.1, minPlacementSamples: 5 }`. Acciones: continue / throttle / pause. Orden de severidad: bounce -> spam -> placement.
- `apps/gateway-api/src/auto-rollback.ts` — breaker por bounce (existente).

Hecho (no rehacer): **W3** (circuit-breaker por spam-rate + placement) y **W4** (feed placement -> scheduler).

Andamiaje Fase 2 (rama `feat/fase2-multi-agent`, hoy detras de mock):
- `packages/domain/src/multi-agent.ts` — contratos. Fuente de verdad de tools: `WARMUP_SENIOR_TOOL_NAMES` (rol `"warmup"`, la orquesta delega con `delegate_to_warmup`).
- `apps/gateway-api/src/agents/agent-registry.ts` — registry de los 5 agentes seniors.
- `apps/gateway-api/src/agents/multi-agent-runtime.ts` — composicion del runtime.
- `apps/gateway-api/src/agents/agent-session-manager.ts` + `bedrock-agent-session.ts` — sesiones Bedrock con caps de tokens, modo mock.
- `apps/gateway-api/src/agents/agent-event-bus.ts` — bus `agent.*` -> canvas-live.
- `apps/gateway-api/src/agents/orchestrator.ts` — orquestador.

Falta (lo que construye este brief): el bridge real del Warmup Senior + W1 + W2, cableando las 8 tools
al sustrato y registrando el agente vivo en el runtime.

---

## 3. Alcance — que construir

### T1. `warmup-senior-bridge.ts` (las 8 tools cableadas al sustrato)
Crear `apps/gateway-api/src/agents/warmup-senior-bridge.ts`. Implementar exactamente los nombres de
`WARMUP_SENIOR_TOOL_NAMES` (verificar la constante; el set esperado es):

| Tool | Cablea a | Notas |
|---|---|---|
| `start_warmup_seed` | `handleWarmupStartHttp` (routes/warmup.ts) | write; firmado + audit |
| `start_warmup_ramp` | `RampScheduler` / `handleRampStartHttp` (StartRampInput) | write; firmado |
| `pause_warmup_ramp` | `handleRampPauseHttp` -> pauseRamp({ reason }) | write; reason tipado |
| `resume_warmup_ramp` | `handleRampResumeHttp` | write |
| `placement_check_gmail` | routes/placement-check.ts + gmail-adapter.ts | read |
| `read_warmup_progress` | `handleRampGetHttp` / rampSnapshot / by-domain | read |
| `read_bounce_complaint_rates` | `createWarmupSignalsReader` + metrics del breaker | read |
| `auto_pause_if_threshold` | `evaluateWarmupBreaker` -> pauseRamp si action=pause | write condicional |

Cada tool: param-schema, dispatch (read-only vs write), ruta con auth read-boundary + audit, y entrada
en la matriz de tools. Seguir el patron de wiring en 5 puntos que ya usa OpenClaw (schema, catalogo
Bedrock, dispatch, ruta con auth+audit, matriz). Emitir eventos `agent.*` al bus para el Canvas Live.

### T2. W1 — Generador de contenido de warmup con IA local
- Servicio nuevo que genera asunto+cuerpo humano-realista (variacion lexica, hilos 1-2 respuestas),
  reemplazando el render plantilla del seed/ramp.
- Corre contra el **modelo local** (Mac Studio, endpoint OpenAI-compatible = E3). E3 aun no existe:
  **poner detras de una interfaz** (`WarmupContentGenerator`) con impl mock por defecto y una impl real
  seleccionable por env cuando E3 este listo. No bloquear T1/T2 por E3.
- Randomizar longitud, hora (jitter), remitente/destinatario. Tag de filtro por dominio. No clavar
  open/reply fijos.

### T3. W2 — Decisor de rampa adaptativo (placement-driven)
- Politica que reemplaza la curva fija de `getWarmupRampPlan`: consume `placementRate` (metrics del
  breaker / signals) despues de cada batch y elige la pendiente:
  placement >= 0.90 y spam bajo -> sube un escalon (techo 30-50/buzon/dia);
  placement < 0.80 -> mantiene; < 0.70 o spam sube -> reduce 30-50% y re-testea.
- La IA decide la pendiente; los guardrails determinísticos (techo por buzon, `DELIVERY_RATE_FLOOR`,
  breaker) la acotan. La IA NUNCA puede saltarse el tope por buzon ni el umbral de spam.

### T4. Registrar el Warmup Senior vivo en el runtime
- Reemplazar el mock del rol `"warmup"` en `agent-registry.ts` / `multi-agent-runtime.ts` por el bridge
  real de T1. Respetar caps de tokens del session-manager y el bus de eventos.
- La orquesta debe poder `delegate_to_warmup` a un E2E: "configura un dominio y hazle warmup".

---

## 4. Guardrails (obligatorios, reusar lo existente)

- **Gobierno**: toda tool de escritura = 1 firma + audit + kill-switch (mismo patron que las tools de
  inventario SMTP de OpenClaw). Read-tools con read-boundary.
- **Budget/scope**: caps de tokens del session-manager; scope por agente.
- **Determinismo por encima de la IA**: el breaker y los topes se aplican SIEMPRE, pasen lo que pasen
  las decisiones del modelo.

---

## 5. Definition of Done (DoD)

- Las 8 tools existen, tipadas, cableadas al sustrato real, con audit + firma donde corresponde.
- W1 detras de interfaz (mock por defecto; real por env cuando exista E3). W2 cambia la pendiente segun
  placement en pruebas (no curva fija).
- El rol `"warmup"` del runtime ya no es mock: la orquesta delega y el agente ejecuta seed -> ramp ->
  placement -> pausa por umbral, emitiendo `agent.*` al Canvas Live.
- Tests: unit por tool + integracion del decisor (W2) + del auto-pausa (T1.auto_pause_if_threshold).
  Suite completa verde (salvo las fallas ambientales de sandbox ya conocidas).
- Sin secretos hardcodeados. Sin emojis en codigo (ASCII: OK/FALLO/->).

---

## 6. Anti-patterns a evitar (de la seccion 7 del doc + incidentes previos)

- NO malla reciproca pura; NO open/reply artificiales; NO Gmail API para warmup.
- NO marcar rojo lo que funciona (falsas alarmas): reachability distingue inbound vs outbound :25;
  DKIM prueba la convencion real `s<year>a` antes de decir "absent".
- NO dejar el `DELIVERY_RATE_FLOOR` definido pero sin enforcar (aplicarlo).
- NO tag global de filtro (por dominio).

---

## 7. Entrega y deploy

- Rama: `feat/warmup-senior-agent`, partiendo de `feat/fase2-multi-agent` (ahi vive el andamiaje).
- No mutar `main`/`produ`; leer otras ramas con `git show`.
- PR con reporte del QA Auditor; CI (typecheck + suite) en verde antes de mergear.
- Deploy: local + Hostinger juntos; si toca el prompt del agente, correr `build-system-context.sh`.

---

## 8. Primeros pasos (arranque)

1. Leer `WARMUP_IA_DELIVRIX` (6.0-6.7 y 7) y los archivos del sustrato listados en la seccion 2.
2. `git show feat/fase2-multi-agent:packages/domain/src/multi-agent.ts` -> confirmar `WARMUP_SENIOR_TOOL_NAMES` y el contrato del rol `warmup`.
3. Crear la rama, scaffoldear `warmup-senior-bridge.ts` con las 8 tools apuntando al sustrato (T1).
4. W1 detras de interfaz (T2) y W2 decisor (T3); enforce topes + floor.
5. Registrar el agente vivo (T4), tests, PR, deploy.

## 9. Preguntas abiertas (bus factor — resolver o dejar registrado)

- Endpoint del modelo local (E3) aun no existe: hasta entonces W1 corre en mock. Confirmar cuando E3 este.
- Seed-list diversa multi-ESP (W5) es F2+: por ahora usar el seed Gmail existente (`GMAIL_IMAP_*`).
- Motor reciproco interno (W6) queda fuera de este brief.
