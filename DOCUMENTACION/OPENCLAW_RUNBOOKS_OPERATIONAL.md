# OpenClaw — Runbooks Operativos

Fecha: 2026-05-18.
Hito rector: `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md`.
Permisos: `OPENCLAW_PERMISSIONS_MATRIX.md`. Skills: `OPENCLAW_SKILLS_CATALOG.md`.

## 1. Propósito

Procedimientos paso a paso que OpenClaw puede **proponer** y que un operador
humano **ejecuta o aprueba** según corresponda. Los runbooks aterrizan los
`runbookRef` que se citan en propuestas y en el `prompt` del Canvas.

Regla: cada runbook tiene preconditions, steps, postconditions, rollback,
aprobaciones requeridas y audit IDs. Si no tiene los 6, no es runbook,
es nota.

## 2. Anatomía de un runbook

Cada runbook se escribe como archivo `.md` en `DOCUMENTACION/runbooks/`
siguiendo esta plantilla rígida:

```markdown
---
id: <kebab-case>
version: <semver>
matrix_category: allowed_dry_run | supervised_local_state | future_live_requires_new_phase
delivrix_actions: [<acciones de la matriz>]
required_approvals: [<lista de personas o roles>]
estimated_minutes: <int>
reversible: true | false
---
# Nombre humano

## Propósito
## Preconditions (qué tiene que ser cierto antes)
## Steps (orden estricto)
## Postconditions (cómo confirmamos éxito)
## Rollback (si algo falla)
## Audit IDs (eventos que se emiten)
## Quién puede invocar
## Quién aprueba
```

## 3. Runbooks iniciales (6)

### 3.1 `warming-step-runbook.md`

| Campo | Valor |
| --- | --- |
| Categoría matrix | `allowed_dry_run` (la propuesta) + `supervised_local_state` (registro de la decisión) |
| Acciones | `propose_warming_step`, `record_human_decision` |
| Reversible | Sí (estado local) |
| Aprobaciones | 2 operadores firmados |
| ETA | 10 min |

Preconditions:
- IP del sender_node con reputación verde por 48h continuas.
- Quejas < 0.2% en últimos 7 días.
- Bounces < 2% en últimos 7 días.
- Kill switch armado pero no activo.

Steps:
1. OpenClaw ejecuta `delivrix-fleet-ops` y `delivrix-alert-ops` y publica
   resumen en la propuesta.
2. Operador 1 revisa evidencia (3 dashboards: reputación, bounces, audit log).
3. Operador 1 firma `humanApproved` en el panel afuera.
4. Operador 2 (independiente) firma confirmación dual.
5. Gateway Delivrix marca `warming_day = N+1` en registry local.
6. Audit `oc.local.warming_step_executed` con ambas firmas.

Postconditions:
- `senderNode.warmupDay` incrementó en 1.
- Audit log tiene evento con `evidenceRefs` y dos `approverId`.

Rollback:
- Gateway hace `update sender_node set warmup_day = N` y audita
  `oc.local.warming_step_reverted`.

### 3.2 `pause-ip-runbook.md`

| Campo | Valor |
| --- | --- |
| Categoría matrix | `supervised_local_state` |
| Acciones | `propose_pause_ip`, `update_sender_node_metadata` |
| Reversible | Sí |
| Aprobaciones | 1 operador (acción defensiva, no escalada) |
| ETA | 3 min |

Preconditions:
- Detección automática del rules engine o alert manual.
- Kill switch no armado.

Steps:
1. OpenClaw publica propuesta con evidencia (bounces, complaints, blacklist).
2. Operador firma aprobación.
3. Gateway marca `senderNode.status = "paused"` en registry local.
4. Audit `oc.local.ip_paused` con razón y evidencia.

Postconditions:
- El nodo no recibe nuevos jobs del worker (mail-policy-engine respeta el status).
- Notion Bugs & Blockers tiene tarjeta auto-creada (severity High, category Flagged Server).

Rollback:
- Operador hace `update sender_node set status = "active"` (manual o vía
  `delivrix-fleet-ops` con segundo runbook).

### 3.3 `register-sender-node-local-runbook.md`

| Campo | Valor |
| --- | --- |
| Categoría matrix | `supervised_local_state` |
| Acciones | `propose_register_sender_node`, `register_sender_node_local` |
| Reversible | Sí (eliminar del registry) |
| Aprobaciones | 1 operador |
| ETA | 5 min |

Preconditions:
- Server existe en Webdock con status `running` (confirmado por `webdock-inventory-sync`).
- IP no aparece en suppression list.
- Reputación inicial estimada (vía IP reputation service) no es `critical`.

Steps:
1. OpenClaw construye payload con `slug`, `name`, `ipv4`, `dailyLimit: 50`, `warmupDay: 1`.
2. Operador revisa y firma.
3. Gateway llama `senderNodeRegistry.register(input)`.
4. Audit `oc.local.sender_node_registered`.

Postconditions:
- Nodo aparece en `GET /v1/sender-nodes`.
- Drift monitor deja de proponer registro para este slug.

Rollback:
- `senderNodeRegistry` no soporta delete directo. Marcar `status = "retired"` y
  audit `oc.local.sender_node_retired`.

### 3.4 `rotate-dns-record-runbook.md`

| Campo | Valor |
| --- | --- |
| Categoría matrix | `future_live_requires_new_phase` |
| Acciones | `propose_rotate_dns`, eventualmente `dns_live_change` (bloqueada hoy) |
| Reversible | Sí (con snapshot previo) |
| Aprobaciones | 2 operadores + ventana de mantenimiento |
| ETA | 30 min (incluye TTL) |

**Bloqueado en Hito 5.11.B.** Documentado para hito futuro. Si OpenClaw propone
esta acción, el Gateway rechaza con `live_blocked_hito_5_11_b`.

Cuando se habilite, los steps serán:

1. Snapshot de zona DNS actual (export completo).
2. Generar diff propuesto.
3. Dos operadores firman.
4. Aplicar vía IONOS/Route 53 API.
5. Esperar propagación (TTL + buffer).
6. Validación: `dig` de cada record afectado desde 3 resolvers públicos.
7. Si OK → audit. Si KO → rollback con snapshot.

Postconditions y Rollback se aterrizan cuando se levante el gate.

### 3.5 `incident-quarantine-runbook.md`

| Campo | Valor |
| --- | --- |
| Categoría matrix | `supervised_local_state` (para el quarantine local) |
| Acciones | `propose_quarantine`, `update_sender_node_metadata` |
| Reversible | Sí |
| Aprobaciones | 1 operador en horario / 2 fuera de horario |
| ETA | 5 min |

Preconditions:
- Evento de reputación detectado: blacklist hit, spike de complaints (>1%), o
  bounce spike (>5%).

Steps:
1. OpenClaw consolida evidencia con `delivrix-alert-ops`.
2. Propone quarantine + reasoning.
3. Operador firma.
4. Gateway marca `senderNode.status = "quarantined"`.
5. Notion Bugs & Blockers crea tarjeta severity Critical.
6. Daily Standup del día siguiente lista el incidente automáticamente.
7. Audit `oc.local.quarantine_applied` + `oc.notion.bug_created`.

Postconditions:
- Nodo no recibe jobs.
- Hay tarjeta abierta en Notion con plan de remediación.

Rollback:
- Después de remediación + análisis, operador pasa `status = "active"` con
  segundo runbook (resume) o `status = "retired"`.

### 3.6 `daily-report-runbook.md`

| Campo | Valor |
| --- | --- |
| Categoría matrix | `allowed_dry_run` |
| Acciones | `generate_daily_report` |
| Reversible | N/A (no muta estado) |
| Aprobaciones | Ninguna (es reporte) |
| ETA | 2 min |

Preconditions:
- Cron `0 23 * * *` UTC dispara, o operador lo pide manualmente.

Steps:
1. OpenClaw invoca `delivrix-report-ops` (Doc 3 §3.3).
2. Skill construye el reporte con datos del Gateway.
3. Skill postea a Notion Daily Standup DB.
4. Audit `oc.skill.report_ops.invoke` + `oc.notion.standup_posted`.

Postconditions:
- Hay fila nueva en `📝 Daily Standup` con fecha de hoy.
- Audit log refleja el invoke.

Rollback:
- Borrar fila en Notion (manual, no automatizado por norte).

## 4. Cómo se agrega un runbook nuevo

1. Crear `DOCUMENTACION/runbooks/<id>-runbook.md` siguiendo la plantilla §2.
2. Validar que todas las `delivrix_actions` declaradas existen en la matriz.
3. Si el runbook es `supervised_local_state` o `future_live_requires_new_phase`,
   declarar explícitamente `required_approvals` con número y rol.
4. Agregar entrada en este catálogo §3 con la tabla resumen.
5. Crear tarjeta hija en Notion Task Board enlazando al runbook.
6. Smoke supervisado con caso real antes de marcar como activo.

## 5. Gates duros

- Ningún runbook se ejecuta sin pasar por el pipeline de evaluación de la
  matriz (Doc 2 §4).
- Las firmas de `required_approvals` se registran con ID, timestamp y hash;
  no se borran ni se editan retroactivamente.
- Runbook `future_live_requires_new_phase` nunca se ejecuta en Hito 5.11.B,
  aunque tenga aprobaciones. El gate de fase manda.
- Rollback debe estar definido o el runbook se rechaza al revisar.
- Si un step falla a la mitad, el runbook se pone en estado `failed_partial`
  y se requiere intervención humana — nunca avanza al siguiente step sin
  reconocer la falla.

## 6. Referencias

- `OPENCLAW_PERMISSIONS_MATRIX.md` (Doc 2 — categorías y validación)
- `OPENCLAW_SKILLS_CATALOG.md` (Doc 3 — skills que disparan o ejecutan runbooks)
- `OPENCLAW_DELIVRIX_API_CONTRACT.md` (Doc 4 — endpoints `propose` y `record_decision`)
- `OPENCLAW_AUDIT_INTEGRATION.md` (Doc 8 — formato de eventos `oc.local.*`)
- `DOCUMENTACION/HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md` (runbook conceptual original)
- Notion `🐛 Bugs & Blockers` DB (`75c53a45c1d94376910904ca03e5268e`) y `📝 Daily Standup`
  DB (`2ce92c3910bd4b8a8f2b1e031a36a749`) — destino de side-effects auditados.
