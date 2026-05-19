# OpenClaw — Skills Catalog

Fecha: 2026-05-18.
Hito rector: `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md`.
Permisos referenciados: `OPENCLAW_PERMISSIONS_MATRIX.md`.

## 1. Propósito

Catálogo de las skills que el agente OpenClaw expone en el container Hostinger.
Cada skill es un módulo cargable (formato `SKILL.md` o plugin TypeScript) que el
agente decide invocar cuando aplica. Toda skill que llame al Gateway Delivrix
debe declarar las **acciones de la permissions matrix** que va a usar — y se
rechaza en ejecución si pide acciones fuera de su declaración.

## 2. Formato canónico

OpenClaw soporta 2 formatos. Para Hito 5.11.B usamos ambos según el tipo:

| Formato | Cuándo | Dónde vive |
| --- | --- | --- |
| `SKILL.md` (Markdown + YAML frontmatter) | Skills naturales que el LLM ejecuta razonando | `/openclaw/skills/<slug>/SKILL.md` |
| Plugin TypeScript | Skills determinísticas con lógica compleja, validación o cache | `/openclaw/plugins/<slug>/index.ts` |

Frontmatter mínimo de un `SKILL.md`:

```yaml
---
slug: delivrix-fleet-ops
version: 1.0.0
trigger: "estado de la flota | clusters | sender nodes | qué hay corriendo"
delivrix_actions:
  - read_admin_clusters
  - read_sender_nodes
  - read_canvas
returns: structured-markdown
audit_id_prefix: oc.skill.fleet_ops
fallback: rules-engine-local
---
```

`delivrix_actions` se valida contra la permissions matrix antes de cargar la skill.
Si declara una acción inexistente o `prohibited`, OpenClaw rechaza el load.

## 3. Skills iniciales (6)

Mínimo viable para cerrar Hito 5.11.B. Cubren las skills conceptuales del Hito 4.4
(`fleet-ops`, `alert-ops`, `report-ops`) más las dos del rules engine local
(`webdock-inventory-sync`, `drift-monitor`) y el publisher HMAC genérico de
propuestas (`delivrix-publish-proposal`).

### 3.1 `delivrix-fleet-ops`

| Campo | Valor |
| --- | --- |
| Trigger natural | "estado de la flota", "qué clústeres tenemos", "cuántos sender nodes", "qué nodos activos" |
| Acciones matrix | `read_admin_clusters`, `read_sender_nodes`, `read_canvas`, `read_webdock_inventory` |
| Endpoints | `GET /v1/admin/clusters`, `GET /v1/sender-nodes`, `GET /v1/openclaw/live-canvas`, `GET /v1/webdock/inventory` |
| Retorna | Markdown estructurado con secciones: clústeres (count, status), nodos por cluster, estado canvas, inventario Webdock |
| Errores | Si un endpoint falla, sigue con los demás y reporta cuál falló |
| Fallback | Rules engine local `evaluateWebdockDrift` cuando OpenClaw no puede llegar al Gateway |
| Audit | `oc.skill.fleet_ops.invoke` con `evidenceRefs` a cada endpoint consultado |

### 3.2 `delivrix-alert-ops`

| Campo | Valor |
| --- | --- |
| Trigger natural | "qué alertas hay", "qué gates están abiertos", "qué requiere mi atención", "está bien todo" |
| Acciones matrix | `read_admin_overview`, `read_audit_events`, `read_kill_switch`, `read_operating_north`, `read_canvas` |
| Endpoints | `GET /v1/admin/overview`, `GET /v1/audit-events`, `GET /v1/kill-switch`, `GET /v1/operating-north`, `GET /v1/openclaw/live-canvas` |
| Retorna | Markdown: kill switch state, gates abiertos, alertas críticas, drift Webdock, propuestas pendientes |
| Errores | Si kill switch no responde, escalar severidad a critical |
| Fallback | Sin fallback: si no hay datos, retorna estado "unknown" honesto |
| Audit | `oc.skill.alert_ops.invoke` |

### 3.3 `delivrix-report-ops`

| Campo | Valor |
| --- | --- |
| Trigger natural | "reporte diario", "resumen del día", "qué pasó hoy", scheduled cron `0 23 * * *` |
| Acciones matrix | `read_operational_summary`, `read_audit_events`, `read_send_results`, `read_ip_reputation`, `generate_daily_report` |
| Endpoints | `GET /v1/operational-summary`, `GET /v1/audit-events?since=24h`, `GET /v1/send-results?since=24h`, `GET /v1/ip-reputation/reports` |
| Retorna | Markdown reporte ejecutivo: KPIs del día, eventos críticos, propuestas aprobadas/rechazadas, próximos pasos |
| Errores | Sin datos suficientes → reporta "datos insuficientes para reporte completo" y lista qué faltó |
| Fallback | Generar reporte parcial con los datos disponibles |
| Audit | `oc.skill.report_ops.invoke` + `oc.dry.daily_report` |
| Side-effect permitido | POST del reporte a Notion Daily Standup DB (vía Agent Integration Guide, Doc 8) |

### 3.4 `webdock-inventory-sync`

| Campo | Valor |
| --- | --- |
| Trigger natural | "qué servidores tengo en Webdock", "cuántos VPS están corriendo", "muéstrame el inventario" |
| Acciones matrix | `read_webdock_inventory` |
| Endpoints | `GET /v1/webdock/inventory` (gateway local, no Webdock API directo) |
| Retorna | Lista tabular: slug, name, status, ipv4, location, profileSlug, lastDataReceived |
| Errores | Si gateway retorna `source.kind: mock`, lo advierte en la respuesta |
| Fallback | Mock canónico de 3 servers (`svc-warmup-01/02`, `svc-prod-eu-01`) |
| Audit | `oc.skill.webdock_sync.invoke` |

### 3.5 `drift-monitor`

| Campo | Valor |
| --- | --- |
| Trigger natural | scheduled cada 5 min, o "hay algo desalineado", "qué propone OpenClaw" |
| Acciones matrix | `read_webdock_inventory`, `read_sender_nodes`, `evaluate_webdock_drift`, `propose_register_sender_node`, `propose_pause_ip` |
| Endpoints | `GET /v1/webdock/inventory` (incluye `drift.proposals[]` con propuestas tipadas del rules engine) |
| Retorna | Lista de propuestas con severidad (high/medium/low), nodo afectado, runbookRef, evidencia |
| Errores | Si drift engine falla, escalar a alert-ops |
| Fallback | Rules engine local de `openclaw-rules.ts` siempre disponible |
| Audit | `oc.skill.drift.invoke` + `oc.dry.drift` |
| Side-effect permitido | Inyectar propuestas al `prompt` del Canvas Delivrix vía Doc 4 (API contract) |

### 3.6 `delivrix-publish-proposal`

| Campo | Valor |
| --- | --- |
| Trigger natural | "publicar propuesta", "enviar propuesta al gateway", "proponer pausa", "proponer warming", "proponer quarantine" |
| Acciones matrix | `propose_register_sender_node`, `propose_warming_step`, `propose_pause_ip`, `propose_quarantine`, `update_sender_node_metadata`, `record_human_decision` |
| Endpoints | `POST /v1/agent/proposals` |
| Auth | HMAC `X-OpenClaw-Signature` + `X-OpenClaw-Timestamp`; nunca Bearer para submit |
| Retorna | Salida corta para el LLM: `status`, `httpStatus`, `proposalId`, `requiredApprovals`, `injectedIntoCanvas` |
| Errores | Si el Gateway devuelve `401`/`403`, reporta `httpStatus` + `rejectReason` y no cambia headers ni acciones para forzar bypass |
| Fallback | Ninguno: si no puede publicar, el agente informa que no llegó al Gateway |
| Audit | `oc.skill.publish_proposal.invoke` + `oc.skill.publish_proposal.completed` + `oc.skill.publish_proposal.failed` |
| Side-effect permitido | Crear un `StoredProposal` en Gateway si la permissions matrix acepta la propuesta |

## 4. Anatomía estándar de una skill

Cada `SKILL.md` que vive en el container OpenClaw debe seguir esta plantilla:

```markdown
---
slug: <kebab-case>
version: <semver>
trigger: <texto natural | cron string | event tag>
delivrix_actions: [<lista de acciones de la permissions matrix>]
returns: structured-markdown | json | mixed
audit_id_prefix: oc.skill.<slug>
fallback: <rules-engine-local | mock | none>
---

# <Nombre humano>

## Propósito (1 párrafo)

## Cuándo se invoca

## Endpoints que consume

## Formato de la respuesta

## Errores y fallback

## Ejemplo de prompt del operador
> "¿cómo va la flota?"

## Ejemplo de respuesta esperada
```

El plugin TypeScript equivalente exporta el mismo metadata vía un objeto
`SkillDescriptor` que el container valida al cargar.

## 5. Cómo se agregan skills nuevas

1. Operador o Codex escribe el `SKILL.md` o plugin TypeScript siguiendo §4.
2. Las `delivrix_actions` declaradas se validan contra `OPENCLAW_PERMISSIONS_MATRIX.md`.
3. Si alguna acción no existe o es `prohibited`, el load falla con error claro.
4. Si todas las acciones son válidas, se crea entrada en este catálogo (Sección 3) y
   tarjeta Notion hija del Hito 5.11.B.
5. Smoke supervisado con caso real antes de marcar como activa.

## 6. Gates duros

- Skill no puede ejecutar acciones fuera de las declaradas en su frontmatter.
- Skill no puede ejecutar acción `prohibited` aunque sea con aprobación humana.
- Skill `supervised_local_state` requiere `humanApproved` token explícito por
  invocación, nunca persistente.
- Skill no puede leer/escribir secretos. Si necesita auth contra Gateway Delivrix,
  el token vive en env del container, nunca dentro del SKILL.md.
- Skill nueva no se activa sin entrada en este catálogo + tarjeta Notion firmada.

## 7. Referencias

- `OPENCLAW_PERMISSIONS_MATRIX.md` (qué acciones puede declarar una skill)
- `OPENCLAW_DELIVRIX_API_CONTRACT.md` (Doc 4 — endpoints que las skills llaman)
- `OPENCLAW_SYSTEM_PROMPT.md` (Doc 5 — cómo el agente decide qué skill invocar)
- `OPENCLAW_AUDIT_INTEGRATION.md` (Doc 8 — formato de audit por skill invoke)
- `DOCUMENTACION/HITO_4_4_OPENCLAW_SCHEDULER_SKILLS.md` (`fleet-ops`/`alert-ops`/`report-ops` conceptuales)
- `packages/domain/src/openclaw-rules.ts` (rules engine para fallback de drift-monitor)
