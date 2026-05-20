# Hito 5.11.B — OpenClaw Hostinger Agent

Fecha: 2026-05-18 (v2.0 expansión 2026-05-18).
Propiedad: Delivrix LLC. Desarrollado por JECT.
Documento rector del hito. Conciso por diseño — los detalles operativos viven en
los 7 docs subordinados de esta familia (`OPENCLAW_*.md`).

## Changelog

- **v1.0** — Scope, criterio de cierre cualitativo, reparto.
- **v2.0** — Cronograma con milestones por día, métricas de éxito cuantitativas con umbrales.
- **v3.0 (2026-05-19)** — Reformulación del criterio §4.2. La versión anterior pedía "OpenClaw responde listando los 31 gates correctos del norte" pero la lista canónica de 31 nunca existió en ningún doc fuente (`NORTE_OPERATIVO_DELIVRIX.md` §Gates no negociables tiene 9 bullets, `OPENCLAW_SYSTEM_PROMPT.md` §[2] tiene 5, `OPENCLAW_PERMISSIONS_MATRIX.md` tiene 5 categorías + ~40 acciones). Sin ground truth, el criterio era inverificable. El nuevo §4.2 enumera explícitamente las fuentes y exige citación. Decisión tomada durante el cierre D+7 (2026-05-19) por el operador. No afecta otros criterios ni el cronograma ya ejecutado.

## 1. Por qué este hito existe

La documentación de Fase 4 (`FASE_4_OPENCLAW_INFRAESTRUCTURA.md` y `HITO_4_1`–`HITO_4_5`)
definió a OpenClaw como un agente operativo conceptual: scheduler, skills, LLM router,
action executor, audit log, dry-run y rollback. Hasta hoy esos componentes viven como
**builders puros** en `packages/domain/src/openclaw-*.ts` — funciones determinísticas
sin instancia real corriendo.

Existe ya **un servicio OpenClaw real desplegado** en una VPS Hostinger:

- Host: `2.24.223.240:61175`
- Imagen: `ghcr.io/hostinger/hvps-openclaw:latest` (producto comercial OpenClaw vía
  Hostinger 1-Click + AI credits)
- Plataforma extensible: skills (SKILL.md), plugins TypeScript, function calling, webhooks.

Este hito **aterriza el agente conceptual del Hito 4.x sobre el servicio real**.
OpenClaw deja de ser un grupo de builders y pasa a ser un agente vivo con system prompt,
knowledge base de Delivrix, skills tipadas y conexión al Gateway de Delivrix.

## 2. Qué cambia, qué se conserva

| Componente Hito 4.x | Aterrizaje en Hito 5.11.B |
| --- | --- |
| `runOpenClawScheduler` (builder puro) | Loop interno de OpenClaw Hostinger (su scheduler nativo) |
| Skills `fleet-ops` / `alert-ops` / `report-ops` (builder) | Skills custom `delivrix-fleet-ops` / `delivrix-alert-ops` / `delivrix-report-ops` instaladas en OpenClaw |
| Matriz de permisos `evaluateOpenClawActionPermission` | Matriz operativa en `OPENCLAW_PERMISSIONS_MATRIX.md` aplicada como gates duros |
| `buildOpenClawOperationalRunbook` | Runbooks markdown en `OPENCLAW_RUNBOOKS_OPERATIONAL.md` |
| Audit log local de Delivrix | Cruce bidireccional con audit del agente remoto (`OPENCLAW_AUDIT_INTEGRATION.md`) |
| Norte operativo (31 gates) | Codificado en system prompt + permissions matrix |

Los builders de dominio **no se borran**. Se mantienen como fuente de verdad de los
contratos y como fallback si el agente remoto cae.

## 3. Alcance

**Dentro del hito:**

- Convertir el OpenClaw de Hostinger en agente Delivrix vía system prompt + knowledge base + skills.
- Conectar OpenClaw ↔ Gateway Delivrix por HTTP (auth Bearer, GET-only en sentido Delivrix → OpenClaw para Canvas; OpenClaw → Delivrix sólo lee endpoints del read-boundary).
- Hacer que las propuestas de OpenClaw aterricen en el `prompt` del Canvas y en Notion Bugs & Blockers.
- Cerrar los 8 docs quirúrgicos antes de cualquier código.

**Fuera del hito:**

- Acciones live (SSH real, DNS live, Proxmox mutation, SMTP real). Quedan en categoría `future_live_requires_new_phase` o `prohibited` (ver Doc 2).
- Fine-tuning del modelo. Hostinger usa Claude/OpenAI vía AI credits — no entrenamos modelo propio.
- Integración con NFC u otros sistemas externos.

## 4. Criterio de cierre

Hito 5.11.B queda cerrado si:

1. Los 8 documentos `OPENCLAW_*.md` están firmados por el operador.
2. OpenClaw responde a "¿qué gates tiene el MVP?" enumerando (a) los 9 gates no negociables del norte literalmente (`NORTE_OPERATIVO_DELIVRIX.md` §"Gates no negociables"), (b) las 5 categorías de la permissions matrix (`OPENCLAW_PERMISSIONS_MATRIX.md`), y (c) citando archivo fuente para cada gate. Cero hallucinations verificadas con grep contra los docs. Ver Changelog v3.0 para historia.
3. Las 3 skills mínimas (`delivrix-fleet-ops`, `delivrix-alert-ops`, `delivrix-report-ops`) están instaladas y testeadas con caso real.
4. El contrato HTTP entre Delivrix Gateway y OpenClaw está cableado y auditado.
5. El audit log del agente remoto se replica al de Delivrix con hash chain verificable.
6. Una propuesta de OpenClaw aterriza en el `prompt` del Canvas y un operador la rechaza/aprueba afuera del panel con regla de 2 personas firmada.
7. Notion Task Board tiene la tarjeta master y las 8 hijas en estado correcto.

## 5. Documentos subordinados (orden de escritura)

| # | Documento | Propósito |
| --- | --- | --- |
| 2 | `OPENCLAW_PERMISSIONS_MATRIX.md` | Matriz literal de acciones y categorías. Pieza más quirúrgica. |
| 3 | `OPENCLAW_SKILLS_CATALOG.md` | Catálogo de las skills, trigger, endpoints, schema. |
| 4 | `OPENCLAW_DELIVRIX_API_CONTRACT.md` | Contrato HTTP entre Gateway Delivrix y agente OpenClaw. |
| 5 | `OPENCLAW_SYSTEM_PROMPT.md` | Personalidad del agente, principios, prohibiciones. |
| 6 | `OPENCLAW_KNOWLEDGE_BASE_INDEX.md` | Qué docs entran al contexto y cómo. |
| 7 | `OPENCLAW_RUNBOOKS_OPERATIONAL.md` | Runbooks accionables con preconditions y rollback. |
| 8 | `OPENCLAW_AUDIT_INTEGRATION.md` | Cómo se cruza el audit log remoto con el de Delivrix. |

Cada doc se escribe en este orden porque los siguientes dependen de los anteriores
(p. ej. el system prompt necesita la matriz de permisos cerrada para citarla).

## 6. Dependencias técnicas

- **AI provider activo en OpenClaw Hostinger**: bloqueador #1 para Fase 1 del despliegue
  (ver `OPS_OPENCLAW_DIAGNOSE_AGENT_FAILED.md`). Sin esto el agente no responde.
- **Gateway token del agente**: necesario para que Delivrix le hable. Vive en env var
  local del operador, nunca en el repo.
- **Gateway Delivrix corriendo**: el agente lee del read-boundary actual (28 endpoints
  GET, ver `apps/admin-panel/src/shared/api/read-boundary.ts`).
- **Webdock API key** (env var `WEBDOCK_API_KEY`): para que skills lean inventario real.

## 7. Reparto

- **Claude (este canal)**: 8 docs + tarjetas Notion + frontend admin panel cuando aplique.
- **Codex (host)**: backend del Gateway (cliente HTTP hacia OpenClaw, endpoints inversos
  si hace falta), skills TypeScript que viven en el container OpenClaw, operaciones SSH
  supervisadas.
- **Operador (humano)**: aprobaciones, credenciales, configuración hPanel, firma de
  regla de 2 personas.

## 8. Riesgos

- **Hallucination del LLM**: el agente propone algo que parece correcto pero rompe gates.
  Mitigación: skills tipadas que solo permiten formato estructurado + permissions matrix
  como gate duro pre-ejecución + dry-run obligatorio.
- **Caída del agente remoto**: si Hostinger tiene incidente, Delivrix se queda sin senior SRE.
  Mitigación: el rules engine local (`packages/domain/src/openclaw-rules.ts`) sigue
  funcionando como fallback degradado.
- **Costo del LLM**: AI credits de Hostinger se agotan o se exceden.
  Mitigación: presupuesto diario configurable (Doc 5 lo aterriza en system prompt) +
  cache de respuestas + skills que evitan llamadas redundantes.
- **Credentials leak**: la VPS de Hostinger es pública, está expuesto el puerto 61175.
  Mitigación: allowlist de IP a nivel de OpenClaw gateway + Bearer auth obligatorio +
  rotación de tokens documentada en Doc 8.

## 9. Gates duros (no negociables)

- Ningún doc se cierra sin firma del operador.
- Ningún despliegue empieza sin los 8 docs cerrados.
- Ninguna acción supervisada se ejecuta sin aprobación humana + kill switch armado.
- Credenciales nunca en chat ni en repo. Solo en env vars locales + hPanel.
- El panel Delivrix sigue GET-only. OpenClaw nunca POSTea al panel desde el bundle.

## 10. Cronograma con milestones (v2.0)

Calendario tentativo asumiendo arranque el día siguiente a la firma de los
8 docs. Cada milestone es un día calendario (8h trabajo). Reparto Claude
(este chat) / Codex (host) / Operador.

| Día | Hito | Responsable | Entregable verificable |
| --- | --- | --- | --- |
| **D+1 AM** | OpenClaw responde básico | Operador + Codex | Sesión `agent:main:main` responde a "hola" no vacío. Audit `oc.prompt.loaded`. |
| **D+1 PM** | System prompt v1.0 cargado | Codex | `docker exec` muestra `/openclaw/context/system.txt` con 7K tokens. Pregunta "qué gates tiene el MVP" lista los 31 correctos. |
| **D+2 AM** | Build script Capa 1 + KB Capa 2 (ChromaDB) | Codex | `scripts/openclaw/build-system-context.sh` corre clean. ChromaDB tiene 1000+ chunks indexados. `recall@5 >= 80%` en eval set. |
| **D+2 PM** | Skills `webdock-inventory-sync` + `delivrix-fleet-ops` cargadas | Codex | Prompt "qué hay en Webdock?" responde con datos vivos. Skill audit `oc.skill.webdock_sync.invoke` emitido. |
| **D+3 AM** | Skill `delivrix-alert-ops` + integración Notion Bugs & Blockers | Codex | Spike simulado → tarjeta automática creada en Notion DB con audit `oc.notion.bug_created`. |
| **D+3 PM** | Skill `drift-monitor` + endpoint `/v1/agent/proposals` | Codex | Drift detectado → propuesta llega a `canvas.prompt` del panel. Rechazos auditados con `rejectReason`. |
| **D+4 AM** | Permissions pipeline en Gateway + tokens HMAC | Codex | Test E2E: acción supervisada sin firma → 401. Con firma single → 401. Con doble firma válida → 200 + rollback token. |
| **D+4 PM** | Skill `delivrix-report-ops` + cron diario | Codex | Cron `0 23 * * *` corre, postea Daily Standup a Notion, audit OK. |
| **D+5 AM** | Audit batch endpoint + hash chain | Codex | `POST /v1/agent/audit/batch` con 50 eventos válidos → 200. Mezcla con 1 inválido → solo se rechaza ese. `verify-chain.ts` OK. |
| **D+5 PM** | Runbooks 1-3 cableados (warming-step, pause-ip, register) | Codex + Operador | Cada runbook ejecutado al menos una vez con datos reales bajo supervisión. |
| **D+6 AM** | Runbook quarantine + Notion crítica | Codex | Quarantine simulada → tarjeta crítica en Notion + replicado a Daily Standup. |
| **D+6 PM** | Smoke E2E completo | Operador | Operador hace una pregunta natural en sesión OpenClaw → agente lee fleet → detecta drift → propone → operador firma 2× → ejecuta → revierte. Todo auditado. |
| **D+7** | Cierre Hito 5.11.B | Operador | 7 criterios de §4 verificados. Tarjeta master Notion pasa a Done. |

**Si surgen blockers durante el trayecto**, cada día tiene buffer de 1h
para investigación + escalación. Si el blocker supera 4h, se reagenda el
milestone afectado al día siguiente y se notifica al operador.

**Ruta crítica:** D+1 AM (AI provider). Sin esto nada más arranca. Codex
debe priorizar diagnóstico siguiendo `OPS_OPENCLAW_DIAGNOSE_AGENT_FAILED.md`.

## 11. Métricas de éxito cuantitativas (v2.0)

Más allá del checklist del §4, estas métricas se monitorean continuamente
post-despliegue. Cada una tiene umbral aceptable y acción ante violación.

### 11.1 Latencia y disponibilidad

| Métrica | Umbral aceptable | Cómo se mide | Acción si viola |
| --- | --- | --- | --- |
| Tiempo de respuesta p95 del agente | < 6 s | Audit metadata `durationMs` skill invoke | Investigar skill lenta + cache |
| Disponibilidad WSS uptime mensual | > 99.0% | Heartbeat OK count / total esperado | Investigar Hostinger + reconnect loop |
| Tiempo de reconnect tras drop | < 30 s p99 | Audit `oc.transport.reconnected` deltas | Tunear backoff |
| Latencia retrieval RAG p95 | < 800 ms | Audit `oc.kb.search.duration_ms` | Reducir top-K o reranking |

### 11.2 Calidad operativa

| Métrica | Umbral aceptable | Cómo se mide | Acción si viola |
| --- | --- | --- | --- |
| Propuestas aprobadas / total propuestas | > 60% en 30d | Audit `oc.proposal.resolved` decision=allow vs reject | Tunear rules engine, refinar criterios |
| False positives propuestas (rechazadas por irrelevantes) | < 15% en 30d | Audit `oc.proposal.resolved` con reason `not_actionable` | Refinar prompt + rules |
| Confianza score promedio | > 7.5 / 10 | Audit metadata `confidenceScore` | Investigar gaps de datos del agente |
| Sesiones con `bypass_attempted` | 0 / mes | Audit `oc.prompt.bypass_attempted` | Investigación de seguridad inmediata |
| Chain integrity nightly | 100% | Script verify-chain.ts | Bloquear writes + investigar |

### 11.3 Costo

| Métrica | Umbral aceptable | Cómo se mide | Acción si viola |
| --- | --- | --- | --- |
| Tokens LLM consumidos / día | < 500K | Audit metadata `tokensUsed` suma | Tunear prompt, reducir KB Capa 1 |
| Costo Anthropic/Hostinger / mes | < USD 100 | Billing del provider | Cambiar de modelo a uno más barato (Haiku para queries simples) |
| Llamadas Notion / día | < 100 | Audit `oc.notion.*` count | Batch más, deduplicar tarjetas |

### 11.4 Confiabilidad

| Métrica | Umbral aceptable | Cómo se mide | Acción si viola |
| --- | --- | --- | --- |
| Skill invocations exitosas / total | > 95% | Audit decisión por skill | Investigar fallback, mejorar manejo errores |
| Webdock API success rate | > 99% (cuando hay key) | `oc.read.webdock` audit responseOk | Investigar provider + cache local |
| Audit batch retries promedio | < 1.2 | Audit `oc.audit.replication_*` count | Investigar conectividad Gateway↔OpenClaw |
| Rollbacks ejecutados / acciones ejecutadas | < 5% mensual | Conteo audit `oc.runbook.*.reverted` | Investigar causa de rollbacks repetidos |

### 11.5 Dashboard de métricas (futuro Hito 6+)

Hito 5.11.B no incluye dashboard de métricas visual. Las queries del Doc 8
§13 son suficientes para correr ad-hoc. Hito 6 puede incluir Grafana
o reporte semanal automático del operador.

## 12. Referencias

- `DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md`
- `DOCUMENTACION/FASE_4_OPENCLAW_INFRAESTRUCTURA.md`
- `DOCUMENTACION/HITO_4_4_OPENCLAW_SCHEDULER_SKILLS.md`
- `DOCUMENTACION/HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md`
- `DOCUMENTACION/RESUMEN_RUTA_PROYECTO.md` (línea 68: "OpenClaw en Hostinger")
- Tarjeta Notion master: [Hito 5.11.B — OpenClaw Hostinger Agent](https://www.notion.so/3647932c3b42817f8c95f084ea8ba1e4)
