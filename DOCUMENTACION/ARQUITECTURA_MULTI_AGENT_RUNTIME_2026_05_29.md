# Arquitectura Multi-Agent Runtime — Delivrix

**Para:** Codex (implementador), Juanes (CTO), futuros operadores.
**De:** Claude (PM + arquitectura).
**Fecha:** 2026-05-29 viernes post-demo.
**Status:** **diseño técnico para Fase 2 del roadmap autonomía 100%.**
**Pre-requisitos:** Fase 0 (cambio de norte + 1 firma) + Fase 1 (tool calling Bedrock) cerradas.

## Pregunta que responde este doc

> Si en producción 5 agentes IA tienen que trabajar en paralelo (orquestador + DNS senior + SMTP senior + Warmup senior + QA/Security senior), ¿cómo se comunican, dónde corren, cuánto cuesta, cuánto tarda, y cómo el operador los ve?

## Modelo mental — "Un equipo senior de email transaccional virtual"

Cada agente IA actúa como un ingeniero senior especializado:

| Agente | Rol humano equivalente | Personalidad |
|---|---|---|
| **OpenClaw Orquestador** | Tech lead / Engineering Manager | Decide qué hace cada uno, sin ego, planifica |
| **DNS Senior** | DNS engineer con 10 años en Route53/IONOS | Pedante con SPF/DKIM/DMARC, conoce TTL/cache |
| **SMTP Senior** | Email infra engineer con experiencia Postfix/OpenDKIM | Cita audit SMTP del CTO Juanes, paranoico con milter |
| **Warmup Senior** | Deliverability specialist con experiencia Gmail/Outlook | Aplica ramps graduales, monitorea bounce/complaint |
| **QA + Security Senior** | Senior QA + AppSec | Audita TODO antes de pedir firma, paranoico con secrets/gates |

**El operador humano (Juanes) interactúa solo con el Orquestador.** El Orquestador despacha. El resto trabaja entre ellos via gateway.

## Topología del runtime

```
┌──────────────────────────────────────────────────────────────────────┐
│                    MAC del operador (Juanes)                         │
│                                                                      │
│  ┌────────────────────────────┐    ┌──────────────────────────────┐ │
│  │  Chrome — panel Delivrix    │    │  Terminal (background)       │ │
│  │  localhost:5173/canvas      │    │  daemon gateway-api          │ │
│  │  WSS persistente            │◄───┤  localhost:3000              │ │
│  └────────────────────────────┘    └──────────┬───────────────────┘ │
│                                                │                    │
└────────────────────────────────────────────────┼────────────────────┘
                                                 │
                                                 │ HTTPS
                                                 ▼
                            ┌─────────────────────────────────────────┐
                            │      AWS Bedrock us-east-1              │
                            │  ┌─────────────────────────────────┐   │
                            │  │  Sonnet 4.6 (multiple sessions) │   │
                            │  └─────────────────────────────────┘   │
                            └─────────────────────────────────────────┘
                                                 │
                                                 │ HTTPS (callbacks)
                                                 ▼
                            ┌─────────────────────────────────────────┐
                            │  Proveedores externos:                  │
                            │  • AWS Route53 (DNS + Domains)         │
                            │  • Webdock (VPS)                       │
                            │  • IONOS DNS                           │
                            │  • Container Hostinger (legacy)        │
                            └─────────────────────────────────────────┘
```

**Decisión clave:** todos los agentes corren como **sesiones lógicas del gateway local**, NO como procesos separados. El gateway hace los `InvokeModelWithResponseStream` a Bedrock por cada sesión con system prompt distinto.

**Ventaja:** un solo daemon que gestionar, audit chain unificada, cero overhead de coordinación entre procesos.

**Trade-off:** si el daemon cae, todos los agentes caen. Mitigación: Codex tiene script `start.sh` con restart automático.

## Comunicación inter-agente

**Patrón:** ningún agente llama a otro directamente. Toda comunicación pasa por el **gateway local** como bus de mensajes.

```
┌──────────────────────┐
│ OpenClaw Orquestador │
│ (sesión Bedrock A)   │
└──────────┬───────────┘
           │ tool_use: "delegate_to(role='dns', task='register dominio X')"
           ▼
┌──────────────────────────────────────────────────────────┐
│  Gateway local: POST /v1/openclaw/agents/dns/invoke      │
│  • Audit append: oc.agent.delegated                      │
│  • Verifica autoridad del orquestador                    │
│  • Inicia nueva sesión Bedrock con system prompt DNS     │
└──────────┬───────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────┐
│ DNS Senior           │
│ (sesión Bedrock B,   │
│  system prompt       │
│  acotado a DNS)      │
└──────────┬───────────┘
           │ tool_use: "register_domain_route53(domain=X)"
           ▼
┌──────────────────────────────────────────────────────────┐
│  Gateway local: POST /v1/domains/route53/register        │
│  • Audit append: oc.dns.register_proposed                │
│  • Si requiere firma: emit WSS canvas.live.signature_pending │
└──────────┬───────────────────────────────────────────────┘
           │ (espera firma del operador)
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│  Operador firma en panel · 1 click                       │
│  • Audit append: oc.signature.applied                    │
│  • Gateway dispatcha al adapter Route53 real             │
│  • Resultado: { domainId, registrationOperationId }      │
└──────────┬───────────────────────────────────────────────┘
           │ tool_result al DNS Senior
           ▼
┌──────────────────────┐
│ DNS Senior           │
│ Continúa con DNS upsert │
└──────────────────────┘
```

**Importante**: la firma del operador NO se pide al DNS Senior. Se pide al **gateway**, que la presenta visualmente en el panel. El DNS Senior se queda esperando el tool_result.

## API de agentes especialistas

Cada sub-agente expone 1 endpoint en el gateway:

```
POST /v1/openclaw/agents/{role}/invoke
Body: {
  "taskId": "task-uuid",
  "delegatedBy": "openclaw-orchestrator",
  "instructions": "register dominio delivrix-prod-001.com con DNS completo",
  "context": {
    "approvalToken": "...",
    "parentTaskId": "...",
    "deadline": "2026-05-29T18:00:00Z"
  }
}
Response (streaming via WSS): eventos
  agent.started
  agent.thinking
  agent.tool_use
  agent.tool_result
  agent.proposing { dryRun, auditId }
  agent.awaiting_signature
  agent.completed { result, auditChainHashes }
  agent.failed { reason, evidenceRefs }
```

**Roles canónicos:** `dns`, `smtp`, `warmup`, `qa-security`, `orchestrator`.

**Constraint:** un sub-agente NO puede invocar a otro sub-agente. Solo el Orquestador puede invocar especialistas. Esto evita ciclos infinitos y mantiene la auditabilidad simple.

**Excepción:** QA+Security puede LEER el resultado de cualquier otro agente (para auditarlo) pero no puede invocar a ninguno. Solo puede emitir `qa.alert.severity_X` que llega al Orquestador y al operador.

## Tool definitions por rol

Cada rol tiene tools acotados. NO le damos a todos todas las skills — eso seríamos sloppy.

### Orquestador (16 tools)

- `delegate_to_dns(task, context)`
- `delegate_to_smtp(task, context)`
- `delegate_to_warmup(task, context)`
- `delegate_to_qa_security(target_audit_id, context)`
- `request_signature(auditId, summary, gates[])`
- `read_admin_overview()`
- `read_kill_switch()`
- `read_canvas_state()`
- `read_audit_events(limit, filter)`
- `read_workspace_executions(date, filter)`
- `summarize_for_operator(content)`
- `ask_operator_clarification(question)`
- `register_task(title, priority, dependencies[])`
- `update_task_status(taskId, status, note)`
- `pause_all_agents()`
- `escalate_to_operator(severity, message, evidenceRefs[])`

### DNS Senior (9 tools)

- `register_domain_route53(domain, contact, durationYears)`
- `register_domain_porkbun(domain, contact, durationYears)` (futuro)
- `dns_zone_create(domain, provider)`
- `dns_records_upsert(zoneId, records[])`
- `dns_records_delete(zoneId, recordIds[])`
- `dns_propagation_verify(domain, recordTypes[])`
- `dns_rollback(auditId)`
- `ptr_request_provider(ip, hostname, provider)`
- `read_dns_inventory(provider)`

### SMTP Senior (10 tools)

- `install_smtp_stack(serverSlug, domain, modes)`
- `verify_smtp_stack(serverSlug)`
- `configure_postfix(serverSlug, configDelta)`
- `configure_opendkim(serverSlug, domain, selector)`
- `configure_dovecot(serverSlug, domain)`
- `obtain_tls_cert(serverSlug, hostname)`
- `bind_domain_to_server(domain, serverSlug)`
- `read_postfix_queue(serverSlug)`
- `read_mail_logs(serverSlug, since, filter)`
- `restart_postfix(serverSlug)`

### Warmup Senior (8 tools)

- `start_warmup_seed(domain, serverSlug, seedAddresses[])`
- `start_warmup_ramp(domain, serverSlug, schedule, recipientPool[])`
- `pause_warmup_ramp(rampId, reason)`
- `resume_warmup_ramp(rampId)`
- `placement_check_gmail(subjectMatcher, windowMinutes)`
- `read_warmup_progress(domain)`
- `read_bounce_complaint_rates(domain, since)`
- `auto_pause_if_threshold(rampId, bounceMax, complaintMax)`

### QA + Security Senior (12 tools, todas read-only)

- `audit_dry_run_proposal(auditId)` → checklist + severity
- `verify_audit_chain_integrity(from, to)`
- `scan_for_secrets(content)`
- `detect_hallucination(claim, evidence)`
- `verify_gates_coverage(action)`
- `read_permissions_matrix()`
- `read_norte_operativo()`
- `compare_action_to_runbook(action, runbookRef)`
- `read_security_alerts(since)`
- `read_rate_limit_state(actorId)`
- `flag_for_human_review(reason, evidenceRefs[])`
- `produce_qa_report(taskId)` → resumen + sign-off

## Costos estimados

Asumiendo **Sonnet 4.6 vía Bedrock us-east-1** con precios actuales (input $3/M, output $15/M):

### Por acción E2E completa (compra dominio → DNS → VPS → SMTP → warmup seed)

| Agente | Input tokens (avg) | Output tokens (avg) | Costo |
|---|---|---|---|
| Orquestador | 12K (system prompt + live context + instructions + tool_results) | 4K (decisiones + delegations) | $0.10 |
| DNS Senior | 8K | 3K | $0.07 |
| SMTP Senior | 10K | 4K | $0.09 |
| Warmup Senior | 6K | 2K | $0.05 |
| QA + Security | 15K (lee artefactos de los otros) | 3K | $0.09 |
| **Total por acción E2E** | | | **~$0.40 USD** |

### Por mes (asumiendo 1000 acciones E2E al mes)

**~$400 USD/mes de Bedrock**. Dentro de presupuesto razonable de SaaS B2B.

### Optimizaciones futuras

1. **Cache de system prompts** — Bedrock soporta prompt caching, ahorro estimado 60-70%.
2. **Haiku 4.5 para QA+Security** — modelo más barato suficiente para checklists, ahorro ~50% en ese agente.
3. **Batch processing** para QA cuando hay muchas propuestas — un solo prompt audita 5 dry-runs.

## Latencias estimadas

| Operación | Latencia (p50) | Latencia (p99) |
|---|---|---|
| Orquestador → recibir prompt + decidir delegación | 3s | 8s |
| DNS Senior → register_domain_route53 (con Route53 real) | 12s | 45s (Route53 a veces es lento) |
| SMTP Senior → install_smtp_stack | 60s (cloud-init) | 240s (retry con backoff) |
| Warmup Senior → start_warmup_ramp + primer batch | 30s | 90s |
| QA + Security → audit_dry_run_proposal | 5s | 15s |
| Operador → ve dry-run + firma | depende del humano | depende del humano |

**Tiempo total E2E (compra → warmup primer email):** **~3-5 min** si el operador firma rápido, **~10 min** con margen.

## Observabilidad

**Cada agente emite estos eventos al gateway (que los broadcast vía WSS al Canvas Live):**

```
agent.started   { agentRole, taskId, modelId, sessionId }
agent.thinking  { agentRole, taskId, progressNote }
agent.tool_use  { agentRole, taskId, toolName, toolInput }
agent.tool_result { agentRole, taskId, toolName, success, durationMs, error? }
agent.proposing { agentRole, taskId, auditId, summary }
agent.awaiting_signature { agentRole, taskId, auditId, expiresAt }
agent.signature_received { agentRole, taskId, auditId, signedBy }
agent.completed { agentRole, taskId, resultSummary, auditChainHashes[] }
agent.failed    { agentRole, taskId, reason, evidenceRefs[] }
agent.heartbeat { agentRole, taskId, tokensUsedSoFar, estimatedCostSoFar }
```

**Frontend (Canvas Live AgentSwarmPanel):**

- 1 card por rol con avatar + estado actual (idle / thinking / tool_use / awaiting_signature / failed)
- Stream de eventos del feed unificado (color-codeado por rol)
- Botones "Pausar agente X" individuales + "Pausar todos" global
- Total tokens consumed + costo running por sesión

**Backend storage:**

- Eventos en `audit-events.jsonl` con SHA-256 chain
- Resúmenes por task en `workspace/orchestrations/{taskId}/summary.md`
- Logs verbose en `runtime/logs/agents/{agentRole}-{date}.log`

## Seguridad multi-agente

**Riesgos específicos del modelo multi-agente y mitigaciones:**

| Riesgo | Mitigación |
|---|---|
| Un sub-agente alucina y propone tool inválido | Tool dispatcher valida con JSON Schema. Si falla, devuelve `tool_result` con error explícito al agente. |
| Sub-agente intenta escalation de privilegios | Cada rol tiene tools acotados a su scope (matrix de permisos por rol). El gateway rechaza tools fuera del scope. |
| Sub-agentes en bucle infinito (delegate_to_X → delegate_to_Y → delegate_to_X) | Solo el Orquestador delega. Ciclos detectados por el gateway con `parentTaskId` chain + max depth. |
| Costo Bedrock explota | Presupuesto mensual por agente. Hard cap en tokens por sesión. Kill switch suave: si la sesión supera 50K tokens, pausa automática + alerta. |
| Audit chain inconsistente entre agentes | Todos los audit events pasan por el gateway. Audit chain centralizada single source of truth. |
| QA+Security agente puede ser bypaseado | No: el gateway requiere `qa.signed_off=true` antes de emitir `request_signature` al operador. |
| Sub-agente comprometido (model poisoning) | Cada agente usa la MISMA versión de Sonnet 4.6 vía Bedrock. Si AWS reporta compromise, todos los agentes paran. |
| Race conditions entre agentes en paralelo | Lock optimista en recursos: si dos agentes intentan tocar el mismo `domainId`, gateway reject al segundo con `409 conflict`. |

## Componentes a construir (lista para Codex)

**Backend:**

1. `apps/gateway-api/src/agents/orchestrator-bridge.ts`
2. `apps/gateway-api/src/agents/dns-senior-bridge.ts`
3. `apps/gateway-api/src/agents/smtp-senior-bridge.ts`
4. `apps/gateway-api/src/agents/warmup-senior-bridge.ts`
5. `apps/gateway-api/src/agents/qa-security-senior-bridge.ts`
6. `apps/gateway-api/src/agents/agent-router.ts` — dispatch entre agentes con audit + cycle detection.
7. `apps/gateway-api/src/agents/agent-cost-tracker.ts` — tokens + USD por sesión.
8. `apps/gateway-api/src/routes/openclaw-agents-invoke.ts` — handlers HTTP por rol.
9. `apps/gateway-api/src/canvas-live-agent-events.ts` — broadcaster WSS.

**System prompts:**

10. `DOCUMENTACION/OPENCLAW_AGENT_DNS_SENIOR.md`
11. `DOCUMENTACION/OPENCLAW_AGENT_SMTP_SENIOR.md`
12. `DOCUMENTACION/OPENCLAW_AGENT_WARMUP_SENIOR.md`
13. `DOCUMENTACION/OPENCLAW_AGENT_QA_SECURITY_SENIOR.md`
14. `DOCUMENTACION/OPENCLAW_ORCHESTRATOR_DELEGATION_PROTOCOL.md`

**Frontend:**

15. `apps/admin-panel/src/v5/views/CanvasLiveMultiAgent.tsx`
16. `apps/admin-panel/src/v5/components/AgentSwarmPanel.tsx`
17. `apps/admin-panel/src/v5/components/AgentCard.tsx`
18. `apps/admin-panel/src/v5/components/ApprovalGate.tsx` (reusado de Fase 0)

**Tests:**

19. Tests unit por bridge.
20. Tests integration: orquestador delega → DNS Senior ejecuta → QA audita → operador firma → resultado vuelve al orquestador.
21. Tests E2E con LocalStack (mocks de Route53 + Webdock).
22. Tests de carga: 5 agentes paralelos durante 10 min sin OOM ni rate limit.

## Comparación con alternativas

### ¿Por qué Bedrock direct y no Anthropic API directa?

- **AWS data residency** — los datos del CTO Juanes pueden quedar en AWS us-east-1 sin cross-cloud.
- **Cuotas más predecibles** — AWS soporta presupuesto por mes.
- **Integración con el resto del stack AWS** (Route53, S3, CloudWatch).

### ¿Por qué Sonnet 4.6 y no Opus/Haiku?

- **Opus**: demasiado caro para uso operacional (>3x). Solo si los agentes seniors muestran limitaciones de razonamiento.
- **Haiku 4.5**: suficiente para QA/Security (post-Fase 2 optimization). Insuficiente para Orquestador y especialistas senior.

### ¿Por qué un solo daemon y no 5 procesos?

- **Simplicidad operativa** — 1 demonio que gestionar.
- **Audit chain unificada** — eventos en un solo log.
- **Menos overhead de coordinación** — los agentes son sesiones lógicas, no procesos.
- **Trade-off**: si el demonio cae, todos caen. Mitigado por restart automático + health checks cada 5s.

### ¿Por qué tool calling de Bedrock y no LangGraph/CrewAI?

- **Nativo de Bedrock** — menos surface, menos versión hell.
- **Cero framework lock-in** — si mañana cambia, migramos sin reescribir.
- **Audit chain natural** — cada tool_use va al gateway, no a una librería externa.

## Próximo paso INMEDIATO post-demo

1. **Lunes:** revisar este doc con el equipo Delivrix completo.
2. **Martes:** Codex inicia Fase 0 (cambio de norte + 1 firma + audit chain SHA-256).
3. **Semana 2:** Codex inicia Fase 1 (tool calling Bedrock con Orquestador como único agente).
4. **Semana 3:** se incorporan los demás roles.

— Claude PM
