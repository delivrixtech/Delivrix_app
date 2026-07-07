# Fase 2 — Multi-agente seniors orquestados · Plan de implementación (7 días)

**Fecha:** 2026-07-06
**Branch:** `feat/fase2-multi-agent` (worktree desde `origin/produ`)
**Spec base:** `DOCUMENTACION/ARQUITECTURA_MULTI_AGENT_RUNTIME_2026_05_29.md`
**Contrato canvas-live:** `DOCUMENTACION/OPS_CODEX_BLOQUE_8_OPENCLAW_EMIT_CANVAS_LIVE_2026_05_25.md` + su RESULT

## Objetivo

5 agentes seniors (Orchestrator + DNS + SMTP + Warmup + QA/Security) como **sesiones lógicas del
gateway único** (single daemon), cada uno con su sesión Bedrock, su system prompt y su tool set
acotado (16+9+10+8+12 = 55 tools). Eventos `agent.*` streameados por WSS al Canvas Live.

## Qué se reusa del runtime actual

| Pieza existente | Dónde | Uso en Fase 2 |
|---|---|---|
| `OpenClawBedrockBridge` | `apps/gateway-api/src/openclaw-bedrock-bridge.ts` | Patrón de invocación streaming a Bedrock (timeouts, abort, retries, token accounting). El cliente multi-agente reusa el mismo shape `BedrockRuntimeClientLike` y `InvokeModelWithResponseStream`. |
| `CanvasLiveEventService` | `apps/gateway-api/src/services/canvas-live-events.ts` | Broadcast WSS + persistencia JSONL + snapshot. Los eventos `agent.*` se mapean a eventos `oc.*` existentes (el panel actual ya los pinta) y se broadcast por el mismo canal. |
| Contrato `CanvasLiveEvent` | `packages/domain/src/canvas-live.ts` | `oc.task.declare/update`, `oc.action.now`, `oc.artifact.*` — sin romper el schema `2026-05-25.canvas-live.v1`. |
| Audit chain | `apps/gateway-api/src/audit-chain.ts` + `packages/domain/src/audit-log.ts` | Todos los eventos de agentes se auditan (`oc.agent.*`) por el mismo sink. |
| Tools builder | `apps/gateway-api/src/openclaw-tools-builder.ts` | Los 41 tools ya cableados a endpoints reales son la base del dispatch de DNS/SMTP/Warmup seniors (día 4). |
| Approval / firma | `approval-guard.ts`, `plan-approval-audit.ts`, rutas `proposals-sign.ts` | `request_signature` del orquestador se apoya en el gate existente. |
| Kill switch | `live-action-kill-switch.ts` | `pause_all_agents()` y hard-cap de tokens se integran ahí. |
| WSS upgrade router | `gateway-upgrade-router.ts` | Mismo endpoint `/v1/canvas/live/stream`; no se abre un WSS nuevo. |

## Plan por días

### Día 1 (hoy) — Cimientos ✅
- Contratos de dominio en `packages/domain/src/multi-agent.ts`: roles, estados de sesión,
  eventos `agent.*` (observabilidad de la spec), input de invocación, tool lists por rol
  (16+9+10+8+12) y matriz rol→tool.
- `apps/gateway-api/src/agents/agent-registry.ts`: los 5 agentes declarados (system prompt path,
  tools, flags `canDelegate` / `readOnly`, hard cap de tokens).
- `apps/gateway-api/src/agents/agent-event-bus.ts`: bus interno de eventos `agent.*` con
  forward fail-soft al emisor canvas-live (mapping `agent.*` → `oc.*`) y al audit sink.
- `apps/gateway-api/src/agents/bedrock-agent-session.ts`: abstracción de sesión Bedrock
  multi-agente — ciclo de vida (starting → thinking → tool_use → … → completed/failed/paused),
  `AgentModelClient` como interfaz con `MockAgentModelClient` (dry-run, sin red), token
  accounting + costo estimado + hard cap 50K tokens → auto-pausa.
- `apps/gateway-api/src/agents/agent-session-manager.ts`: registry de sesiones vivas,
  reglas de delegación (solo el orquestador delega, QA no es invocable por especialistas),
  detección de ciclos por cadena `parentTaskId` + max depth.
- `apps/gateway-api/src/agents/orchestrator.ts`: esqueleto del Orchestrator — recibe la
  instrucción del operador, declara task, ejecuta tools locales `delegate_to_*` /
  `register_task` / `escalate_to_operator`, especialistas corren como stubs en modo mock.
- Tests unit por módulo (`node --test`, sin dependencias de red).

### Día 2 — Superficie HTTP + WSS
- `apps/gateway-api/src/routes/openclaw-agents-invoke.ts`: `POST /v1/openclaw/agents/{role}/invoke`
  (roles canónicos `dns|smtp|warmup|qa-security|orchestrator`), auth por token gateway.
- Wiring en `main.ts` (cuidado: archivo de 6.800 líneas — tocar solo el router).
- Broadcast en vivo: los `agent.*` viajan por el WSS existente vía el mapping del bus.
- Endpoint `GET /v1/openclaw/agents/state` (sesiones vivas, tokens, costo) para el panel.
- Smoke script `scripts/smoke-multi-agent-invoke.sh` (modo mock end-to-end).

### Día 3 — Bedrock real detrás de la interfaz
- `BedrockAgentModelClient` implementando `AgentModelClient` con
  `InvokeModelWithResponseStream` (mismo patrón/timeouts del bridge actual), 1 sesión por agente.
- `agent-cost-tracker.ts`: tokens + USD por sesión/rol/día; presupuesto mensual por agente;
  integración con kill switch suave (pausa a 50K tokens por sesión).
- Selección por env: `MULTI_AGENT_MODE=mock|bedrock` (default mock). Sin credenciales
  inventadas: si no hay creds en modo bedrock, error explícito al arrancar.
- Prompt caching flag preparado (optimización de la spec, no bloqueante).

### Día 4 — Tool dispatch real por rol
- Mapeo de los tools de DNS/SMTP/Warmup seniors a los endpoints ya existentes
  (`register_domain_route53`, `upsert_dns_*`, `provision_smtp_postfix`, `warmup-ramp`, …)
  reutilizando `openclaw-tools-builder` con scoping por rol.
- Validación JSON Schema de cada tool_use (dispatcher rechaza tools fuera del scope del rol).
- Tools nuevos sin backend actual (p.ej. `dns_rollback`, `placement_check_gmail` ya existe como
  ruta) quedan como dry-run declarado con TODO explícito.
- `request_signature` cableado al flujo approve/reject de artifacts del Canvas.

### Día 5 — System prompts + gates de seguridad
- `DOCUMENTACION/OPENCLAW_AGENT_{DNS,SMTP,WARMUP,QA_SECURITY}_SENIOR.md` +
  `OPENCLAW_ORCHESTRATOR_DELEGATION_PROTOCOL.md`.
- Gate QA: el gateway exige `qa.signed_off=true` antes de emitir `request_signature`.
- Locks optimistas por recurso (dos agentes sobre el mismo `domainId` → 409 al segundo).
- Rate limit / presupuesto por rol; `pause_all_agents` cableado al kill switch real.

### Día 6 — Frontend Canvas Live multi-agente
- `apps/admin-panel/src/v5/components/AgentSwarmPanel.tsx` + `AgentCard.tsx`
  (1 card por rol: idle/thinking/tool_use/awaiting_signature/failed, tokens y costo running).
- Vista `CanvasLiveMultiAgent.tsx` con feed color-codeado por rol; botones "Pausar agente X"
  y "Pausar todos"; reuso de `ApprovalGate`.
- Estados vacíos/toasts consistentes con el design system actual.

### Día 7 — Integración E2E + carga + cierre
- Test integration: orquestador delega → DNS Senior ejecuta (mock provider) → QA audita →
  operador firma → resultado vuelve al orquestador → `oc.task.update completed`.
- Prueba de carga: 5 sesiones paralelas 10 min sin OOM ni rate-limit (modo mock + modo bedrock
  con presupuesto capado si hay creds reales).
- Smoke E2E documentado + `DOCUMENTACION/FASE2_RESULT_*.md` con SHAs y evidencia.

## Riesgos y mitigaciones

1. **`main.ts` monolítico (6.8K líneas).** Wiring del día 2 se hace en módulos nuevos con un
   solo punto de enganche en el router. Nada de lógica inline en main.
2. **Doble contrato de eventos (`agent.*` de la spec vs `oc.*` del panel).** Decisión: el bus
   interno habla `agent.*` (contrato de la spec) y el adaptador los proyecta a `oc.*` para no
   romper el Canvas Live actual. El panel multi-agente del día 6 puede consumir los `oc.action.now
   kind=audit` con `action: "agent.*"` sin migración del WSS.
3. **Costo Bedrock.** Hard cap 50K tokens/sesión implementado desde el día 1 en la abstracción
   de sesión (auto-pausa + evento), presupuesto mensual en el cost tracker (día 3).
4. **Node type-stripping (los .ts corren con `node --test` sin build).** Prohibido enum/namespace/
   parameter-properties en el código nuevo; solo TS borrable — igual que el resto del repo.
5. **Tools de la spec sin backend todavía.** Se declaran igual (registry completo desde hoy) y el
   dispatcher los responde con `tool_result` de error explícito o dry-run hasta el día 4.
6. **Un solo daemon = SPOF.** Igual que hoy; heartbeats `agent.heartbeat` + restart script ya
   existente (`restart-gateway.sh`). No cambia en esta fase.

## Decisiones tomadas hoy

- Los 55 tools viven como **contrato de dominio** (`packages/domain/src/multi-agent.ts`), no
  hardcodeados en el gateway, para que panel y gateway compartan la matriz rol→tool.
- `AgentModelClient` es la única frontera con Bedrock. `MockAgentModelClient` es el default;
  no existe camino de código que invente credenciales.
- El QA/Security senior queda declarado `readOnly: true`: el session manager rechaza cualquier
  tool de escritura y cualquier intento de delegación hacia/desde él fuera del orquestador.
