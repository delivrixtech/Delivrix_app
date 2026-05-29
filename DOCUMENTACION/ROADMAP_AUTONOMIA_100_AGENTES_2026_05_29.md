# Roadmap Autonomía 100% — Multi-agente E2E

**Para:** Juanes (CTO), Codex, sub-agentes seniors futuros.
**De:** Claude (PM).
**Fecha:** 2026-05-29 viernes post-demo.
**Status:** **diseño aprobado por CTO**, ejecución en fases.

## Norte real (cita textual del CTO 2026-05-29)

> "Buscamos autonomía 100% que lo pueda ejecutar en la configuración inicial de un dominio, hasta configuración de un VPS, hasta que se convierta en un SMTP y se caliente las bandejas. Y todo ese proceso lo necesita ver mi jefe. Buscamos multiagentes haciéndolo en tiempo real, trabajando fuertemente e inteligentemente."

**Traducción a hitos:**

1. Autonomía 100% E2E del flow: **compra dominio → DNS → VPS → SMTP install → warmup ramp**.
2. Multi-agente coordinado (no un solo agente).
3. Visualización en Canvas Live del trabajo en vivo (el jefe del CTO debe ver el proceso).
4. 1 firma del operador donde corresponda (cambio de norte ya documentado).
5. Resultado: Codex ejecuta el flow E2E sin que Juanes toque botones intermedios — solo aprueba el inicio y el final.

## Estado actual vs estado objetivo

| Capacidad | Hoy (2026-05-29) | Objetivo (Hito 5.13) |
|---|---|---|
| Tool calling Bedrock | ❌ describe skills, no las invoca | ✅ invoca skills via tools API de Bedrock |
| Multi-agente | ❌ Codex solo | ✅ 5 agentes seniors orquestados |
| Visualización tiempo real | 🟡 Canvas Live tiene feed pero no muestra "who is doing what NOW" | ✅ Cada agente tiene avatar + estado + acción en curso visible |
| Firma operador | 🟡 dry-run + esperando 2da firma | ✅ 1 firma + audit chain robusta |
| Ejecución E2E real | ❌ todo dry-run | ✅ compra dominio + DNS + VPS + SMTP + warmup con 1 firma |
| Audit chain criptográfica | 🟡 events firmados pero sin SHA-256 chain | ✅ SHA-256 prevHash linked, integridad verificable |

## Fases del roadmap

### Fase 0 — Pre-requisitos (cierre semana actual)

**Duración:** 5 días laborales.
**Bloquea:** todo lo siguiente.

1. **Commit firmado del cambio de norte** (`NORTE_OPERATIVO_DELIVRIX.md` actualizado, ver `CAMBIO_NORTE_QUITAR_2_PERSONAS_2026_05_29.md`).
2. **Reclasificación de skills** en `OPENCLAW_PERMISSIONS_MATRIX.md` (9 skills pasan a `supervised_local_state`).
3. **Audit chain SHA-256 linked** implementado en gateway.
4. **Webhook broadcast** al equipo Delivrix (Slack/Discord).
5. **Auto-rollback DNS + SMTP** implementado.
6. **`ApprovalGate.tsx` frontend** con 1 firma.
7. **Smoke real E2E con 1 firma:** compra dominio descartable + DNS + VPS + SMTP install + warmup seed funcionando sin "esperar 2da firma".

**Criterio de aceptación Fase 0:** Juanes firma UN solo botón en el panel, el sistema ejecuta el flow completo en <15 min sin intervención humana adicional, audit chain SHA-256 íntegra al final.

### Fase 1 — Tool calling Bedrock

**Duración:** 5 días laborales.
**Bloquea:** multi-agente real.

**Objetivo:** el agente OpenClaw invoca skills del gateway en lugar de solo describirlas.

**Tareas:**

1. **Definir tools en Bedrock InvokeModel** — cada skill del gateway expone su schema JSON como `tools[]` en el payload Bedrock.
   ```typescript
   {
     anthropic_version: "bedrock-2023-05-31",
     tools: [
       {
         name: "register_domain_route53",
         description: "Compra un dominio en AWS Route53 Domains...",
         input_schema: { /* JSON Schema con domain, contact, etc. */ }
       },
       // ... 8 skills más
     ],
     messages: [...]
   }
   ```

2. **Implementar tool dispatcher** en `apps/gateway-api/src/openclaw-bedrock-bridge.ts`:
   - Cuando Bedrock devuelve un `tool_use` block, el bridge lo dispatcha al endpoint HTTP correspondiente.
   - El resultado se devuelve a Bedrock como `tool_result` para que continúe el razonamiento.
   - Si la skill requiere firma (categoría `supervised_local_state` o superior), el bridge **pausa** la ejecución y emite evento `oc.tool.awaiting_signature` al Canvas Live.

3. **Frontend Canvas Live**: mostrar `tool_use` y `tool_result` en el feed con avatar del agente + JSON colapsable.

4. **Tests**: cada tool dispatcher con mocks + integration con gateway local.

5. **Smoke E2E**: prompt "comprá `delivrix-smoke-{timestamp}.click` y configurale DNS" → agente decide invocar `register_domain_route53` → bridge pide firma → operador firma → ejecuta → resultado vuelve al agente → agente continúa con `route53_dns_upsert`.

**Criterio de aceptación Fase 1:** prompt único en chat dispara cadena de 3+ skills ejecutadas con firma única del operador.

### Fase 2 — Multi-agente seniors orquestados

**Duración:** 7 días laborales.
**Pre-requisitos:** Fase 1 cerrada.

**Objetivo:** 5 agentes especializados trabajando en paralelo, OpenClaw como orquestador.

**Roles:**

| Agente | Modelo | Scope | System prompt |
|---|---|---|---|
| **OpenClaw Orquestador** | Sonnet 4.6 | Decide qué sub-agente hace qué, secuencia las tareas, gestiona dependencias | `OPENCLAW_SYSTEM_PROMPT.md` + sección "orquestación" |
| **DNS Senior** | Sonnet 4.6 (o Haiku 4.5 si scope acotado) | Solo DNS: register, upsert, verify, propose | `OPENCLAW_AGENT_DNS_SENIOR.md` (crear) |
| **SMTP Senior** | Sonnet 4.6 | Solo SMTP: install_smtp_stack, configurar postfix/opendkim/dovecot, verificar | `OPENCLAW_AGENT_SMTP_SENIOR.md` (crear) |
| **Warmup Senior** | Sonnet 4.6 | Solo warmup: ramp scheduling, placement check, decisiones de pausa | `OPENCLAW_AGENT_WARMUP_SENIOR.md` (crear) |
| **QA + Security Senior** | Sonnet 4.6 | Audita propuestas de los otros antes de pedir firma. Detecta gates faltantes, secrets en respuestas, hallucinations. | `OPENCLAW_AGENT_QA_SECURITY_SENIOR.md` (crear) |

**Arquitectura:**

```
┌──────────────────────────────────────────────────────────────┐
│  OPERADOR (humano) — 1 firma                                 │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  OpenClaw Orquestador (Sonnet 4.6 via Bedrock)               │
│  • Recibe el prompt del operador                             │
│  • Decompone en sub-tareas                                   │
│  • Asigna a sub-agentes                                      │
│  • Espera resultados                                         │
│  • Consolida y reporta al operador                           │
└────────────────────────────┬─────────────────────────────────┘
                             │
            ┌────────────────┼────────────────────┐
            ▼                ▼                    ▼
   ┌──────────────┐  ┌──────────────┐    ┌──────────────┐
   │  DNS Senior  │  │ SMTP Senior  │    │Warmup Senior │
   │ (Sonnet 4.6) │  │ (Sonnet 4.6) │    │ (Sonnet 4.6) │
   └──────┬───────┘  └──────┬───────┘    └──────┬───────┘
          │                 │                    │
          └─────────────────┼────────────────────┘
                            │
                            ▼
                   ┌──────────────────┐
                   │ QA + Security    │
                   │ (Sonnet 4.6)     │
                   │ — Audita ANTES   │
                   │ de pedir firma   │
                   └────────┬─────────┘
                            │
                            ▼
                  ┌──────────────────┐
                  │  Audit Chain     │
                  │  SHA-256 linked  │
                  └──────────────────┘
```

**Comunicación entre agentes:** A través del **gateway local Delivrix**, no directo agente-a-agente. Cada sub-agente expone su API via `POST /v1/openclaw/agents/{rol}/invoke`. El orquestador llama a esos endpoints. El gateway logea cada llamada en audit chain.

**Tasks específicas:**

1. **5 archivos de system prompts** (uno por agente especialista).
2. **Backend gateway**: 5 endpoints nuevos para invocar a cada agente especialista. Cada uno hace su propio call a Bedrock con su system prompt + tools acotados.
3. **OpenClaw Orquestador** aprende a decidir qué agente invocar según el intent del operador.
4. **Tests E2E**: prompt complejo (ej. "configurá un dominio nuevo y haceme warmup") → orquestador decompone → DNS Senior compra dominio + DNS → SMTP Senior install postfix → Warmup Senior arranca ramp → QA+Security audita cada paso.
5. **Audit chain consolidada**: cada acción de cada agente queda en el audit chain con `agentRole`, `actorModelVersion`, `parentTaskId` (cuál orquestador lo invocó).

**Criterio de aceptación Fase 2:** prompt "configurame `delivrix-fullauto-{timestamp}.click` desde cero hasta enviar 3 seeds" ejecutado completo por multi-agente, visible en Canvas Live con 4 avatares trabajando en paralelo donde aplique.

### Fase 3 — Visualización tiempo real Canvas Live

**Duración:** 5 días laborales.
**Pre-requisitos:** Fase 2 cerrada (multi-agente existe).

**Objetivo:** el jefe del CTO ve el trabajo de los agentes en vivo. Cada agente tiene avatar, estado actual, acción en curso, output streaming.

**Diseño visual:**

```
┌─────────────────────────────────────────────────────────────────┐
│  Canvas Live · Multi-agente                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │ 🧠 OpenClaw      │  │ 🌐 DNS Senior    │                    │
│  │ Orquestador      │  │                  │                    │
│  │                  │  │ ▶ Comprando      │                    │
│  │ ⏸ Esperando      │  │   delivrix-fa-..│                    │
│  │   resultados     │  │   en Route53     │                    │
│  │                  │  │                  │                    │
│  │ Tasks: 3 pendientes │  Tokens: 2.4K   │                    │
│  └──────────────────┘  └──────────────────┘                    │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │ 📮 SMTP Senior   │  │ 🔥 Warmup Senior │                    │
│  │                  │  │                  │                    │
│  │ 💤 Esperando     │  │ 💤 Esperando     │                    │
│  │   dominio listo  │  │   SMTP listo     │                    │
│  └──────────────────┘  └──────────────────┘                    │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 🛡️ QA + Security · monitoreando continuo                  │  │
│  │ Última auditoría: hace 4s · 0 alerts                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ─────────────────── feed ───────────────────                  │
│  [12:34:01] DNS Senior · register_domain_route53 → 200 OK      │
│  [12:34:08] DNS Senior · proposed dns_upsert (5 records)       │
│  [12:34:08] QA · audit ok → pase a operador                    │
│  [12:34:12] Operador · 1 firma → ejecutar                      │
│  [12:34:14] DNS Senior · route53_dns_upsert → 200 OK (5/5)     │
│  [12:34:20] OpenClaw Orquestador · DNS completo, despertando   │
│             SMTP Senior                                         │
│  [12:34:21] SMTP Senior · install_smtp_stack → en curso (1m)   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Tareas:**

1. **Backend**: cada agente publica heartbeat + estado actual via WSS a Canvas Live cada 1s. Eventos: `agent.heartbeat`, `agent.task_started`, `agent.tool_use`, `agent.tool_result`, `agent.idle`.
2. **Frontend**: nuevo componente `AgentSwarmPanel` en `apps/admin-panel/src/v5/views/Canvas Live`. Muestra 4-5 cards de agentes con estado en vivo.
3. **Feed unificado**: timeline con eventos de todos los agentes, color-codeado por rol.
4. **Pausa global**: botón "Pausar todos" que detiene cualquier acción en curso de cualquier agente (es como un kill switch suave).
5. **Tests E2E**: render visual + WSS streaming + latencia <1s entre evento backend y pintar en frontend.

**Criterio de aceptación Fase 3:** el CTO de Hostinger ve los 4-5 agentes trabajando en simultáneo, con avatares vivos, en una sola pantalla. El jefe del CTO Juanes lo entiende sin explicación.

### Fase 4 — Audit chain criptográfica al 100%

**Duración:** 3 días laborales.
**Paralelo a Fases 1-3.**

**Objetivo:** integridad criptográfica verificable + backup + reporte forense automatizado.

**Tareas:**

1. **SHA-256 chain con `prevHash` por evento** (ya documentado en cambio de norte).
2. **Backup nightly** a cold storage (S3 Glacier o equivalente).
3. **Verificación de integridad nightly**: cron job que recorre toda la chain y verifica que cada `event.hash === SHA256(prevHash + canonicalEvent)`. Si rompe, alerta inmediata.
4. **Reporte forense**: dado un `auditId`, devolver toda la cadena de eventos relacionados (causa raíz).
5. **Endpoint `/v1/audit-chain/verify`** que devuelve estado de integridad.

**Criterio de aceptación Fase 4:** corrompemos un evento → next nightly verify lo detecta → alerta llega al equipo.

### Fase 5 — Demo final al equipo Hostinger

**Duración:** 1 día.
**Pre-requisitos:** Fases 0-4 cerradas.

Demo de cierre del Hito 5.13 al CTO de Hostinger + su jefe + equipo, mostrando:

1. **Prompt único del CTO Juanes**: "Configurame `delivrix-prod-001.com` desde cero hasta warmup activo."
2. **OpenClaw Orquestador** decompone, asigna a 4 sub-agentes.
3. **Canvas Live multi-agente** muestra el trabajo en vivo, con 4 avatares activos.
4. **QA + Security** audita cada paso, marca con check verde.
5. **Operador (Juanes) firma 1 vez** después de la auditoría QA.
6. **Sistema ejecuta E2E** en <15 min real:
   - Compra dominio Route53.
   - Configura SPF/DKIM/DMARC.
   - Provisiona VPS Webdock.
   - Install SMTP stack.
   - Bind dominio.
   - Arranca warmup ramp con 3 seeds.
7. **3 emails llegan al Gmail del operador** con DKIM/SPF/DMARC verificados.
8. **Audit chain consolidada** se descarga como PDF con hashes y signatures.
9. **CTO + jefe + equipo aplauden.**

## Timeline consolidado

```
Semana 1 (cierre): Fase 0 — Pre-requisitos (cambio de norte + 1 firma)
Semana 2:          Fase 1 — Tool calling Bedrock
Semana 3:          Fase 2 — Multi-agente (parte A: DNS + SMTP)
Semana 4:          Fase 2 — Multi-agente (parte B: Warmup + QA/Security)
Semana 5:          Fase 3 — Visualización tiempo real Canvas Live
Semana 6:          Fase 4 — Audit chain criptográfica
Semana 7:          Fase 5 — Demo Hostinger + sign-off
```

**Total: 7 semanas** para llegar de "dry-run + firma" a "autonomía 100% E2E con multi-agente visible".

## Riesgos críticos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Tool calling Bedrock tiene latencia alta | Media | Medio | Cache de schemas + retry con timeout. Si supera 30s, caer a fallback. |
| Sub-agentes alucinan en paralelo | Media | Alto | QA + Security agente audita ANTES de pedir firma del operador. Si detecta hallucination, rechaza. |
| Multi-agent costo Bedrock explota | Media | Medio | Presupuesto mensual por agente. Si supera 80%, escala a humano. |
| Visualización Canvas Live no escala | Baja | Bajo | WSS con backpressure + cap a 50 eventos/segundo por agente. |
| Audit chain SHA-256 lenta en escritura | Baja | Bajo | Async append; verify integral solo en nightly. |
| Operador firma sin leer | Media | Alto | UI muestra dry-run completo + tiempo mínimo de visualización (5s) antes de habilitar botón |
| El producto se vuelve demasiado complejo de operar | Media | Crítico | Onboarding video + simulator mode para nuevos operadores |

## Métricas de éxito por fase

| Fase | Métrica | Target |
|---|---|---|
| 0 | Smoke E2E con 1 firma | <15 min total |
| 1 | Cadena de tools sin firma intermedia | 3+ tools en cadena |
| 2 | Agentes paralelos trabajando | 4 agentes simultáneos |
| 3 | Latencia evento backend → frontend | <1 segundo |
| 4 | Detección de corrupción audit chain | 100% en <24h |
| 5 | Tiempo total demo E2E | <15 min |
| 5 | Hallucinations detectadas en producción | 0 críticas |

## Dependencias externas

- **AWS Bedrock cuotas** suficientes para llamadas paralelas de 5 agentes. Confirmar con AWS soporte si superamos free tier de Sonnet 4.6.
- **Slack/Discord webhook** del equipo (URL operativa + auth).
- **S3 cold storage** para backup audit chain (opcional, podemos empezar con disco local + cron).
- **Postmaster Tools de Google** para Fase 6 (post-roadmap actual) — placement multi-señal real.

## Lo que NO entra en este roadmap (backlog futuro)

- **Multi-cuenta Gmail/Outlook/Yahoo** para placement IMAP — Hito 6.x.
- **Suppression list compliance** GDPR/CCPA — Hito 6.x.
- **MTA-STS / TLS-RPT** para recepción propia — Hito 7.x.
- **Mobile/iPad operativo** del panel — Hito 7.x.
- **Multi-tenant** (un panel Delivrix sirve N clientes finales) — Hito 8.x.
- **Tool calling con Claude Code en CI/CD** del propio Delivrix — Hito 7.x (meta-Delivrix).

## Próximo paso INMEDIATO post-demo viernes

1. **Lunes:** Juanes firma commit del cambio de norte aplicando diff de `CAMBIO_NORTE_QUITAR_2_PERSONAS_2026_05_29.md`.
2. **Martes-jueves:** Codex orquesta Fase 0 con sub-agentes seniors según `PROTOCOLO_CODEX_SUB_AGENTES_SENIORS.md`.
3. **Viernes próximo:** smoke E2E con 1 firma del operador.

Si llegamos limpio a viernes próximo con Fase 0 cerrada, **estamos en el camino correcto para tener Fase 5 (demo final Hostinger) en 6 semanas más**.

— Claude PM
