# OpenClaw — Skills Catalog

Fecha: 2026-06-23.
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

## 3. Skills iniciales (8)

MVP Hito 5.11.B: fleet/report/alert, drift Webdock, publisher HMAC y MXToolbox read-only.

### 3.1 `delivrix-fleet-ops`

| Campo | Valor |
| --- | --- |
| Trigger natural | "estado de la flota", "clústeres", "sender nodes", "nodos activos" |
| Acciones matrix | `read_admin_clusters`, `read_sender_nodes`, `read_canvas`, `read_webdock_inventory` |
| Endpoints | `GET /v1/admin/clusters`, `GET /v1/sender-nodes`, `GET /v1/openclaw/live-canvas`, `GET /v1/webdock/inventory` |
| Retorna | Markdown: clusters, nodos, canvas, Webdock inventory |
| Errores | Sigue con endpoints sanos y reporta fallas |
| Fallback | `evaluateWebdockDrift` local si no llega al Gateway |
| Audit | `oc.skill.fleet_ops.invoke` + `evidenceRefs` |

### 3.2 `delivrix-alert-ops`

| Campo | Valor |
| --- | --- |
| Trigger natural | "alertas", "gates abiertos", "qué requiere atención", "está bien todo" |
| Acciones matrix | `read_admin_overview`, `read_audit_events`, `read_kill_switch`, `read_operating_north`, `read_canvas` |
| Endpoints | `GET /v1/admin/overview`, `GET /v1/audit-events`, `GET /v1/kill-switch`, `GET /v1/operating-north`, `GET /v1/openclaw/live-canvas` |
| Retorna | Markdown: kill switch, gates, alertas, drift, propuestas |
| Errores | Kill switch sin respuesta = critical |
| Fallback | Ninguno: datos faltantes => `unknown` honesto |
| Audit | `oc.skill.alert_ops.invoke` |

### 3.3 `delivrix-report-ops`

| Campo | Valor |
| --- | --- |
| Trigger natural | "reporte diario", "resumen del día", "qué pasó hoy", cron `0 23 * * *` |
| Acciones matrix | `read_operational_summary`, `read_audit_events`, `read_send_results`, `read_ip_reputation`, `generate_daily_report` |
| Endpoints | `GET /v1/operational-summary`, `GET /v1/audit-events?since=24h`, `GET /v1/send-results?since=24h`, `GET /v1/ip-reputation/reports` |
| Retorna | Markdown ejecutivo: KPIs, eventos, propuestas, próximos pasos |
| Errores | Datos insuficientes => lista faltantes |
| Fallback | Reporte parcial |
| Audit | `oc.skill.report_ops.invoke` + `oc.dry.daily_report` |
| Side-effect permitido | POST a Notion Daily Standup DB (Doc 8) |

### 3.4 `webdock-inventory-sync`

| Campo | Valor |
| --- | --- |
| Trigger natural | "servidores Webdock", "VPS corriendo", "inventario" |
| Acciones matrix | `read_webdock_inventory` |
| Endpoints | `GET /v1/webdock/inventory` (gateway local) |
| Retorna | Lista tabular: slug, name, status, ipv4, location, profileSlug, lastDataReceived |
| Errores | Si `source.kind: mock`, lo advierte |
| Fallback | Mock canónico de 3 servers (`svc-warmup-01/02`, `svc-prod-eu-01`) |
| Audit | `oc.skill.webdock_sync.invoke` |

### 3.5 `drift-monitor`

| Campo | Valor |
| --- | --- |
| Trigger natural | cron 5 min, "desalineado", "qué propone OpenClaw" |
| Acciones matrix | `read_webdock_inventory`, `read_sender_nodes`, `evaluate_webdock_drift`, `propose_register_sender_node`, `propose_pause_ip` |
| Endpoints | `GET /v1/webdock/inventory` (`drift.proposals[]`) |
| Retorna | Propuestas: severidad, nodo, runbookRef, evidencia |
| Errores | Drift engine falla => alert-ops |
| Fallback | Rules engine local `openclaw-rules.ts` |
| Audit | `oc.skill.drift.invoke` + `oc.dry.drift` |
| Side-effect permitido | Inyectar propuestas al Canvas vía Doc 4 |

### 3.6 `delivrix-publish-proposal`

| Campo | Valor |
| --- | --- |
| Trigger natural | "publicar propuesta", "enviar al gateway", "proponer pausa/warming/quarantine" |
| Acciones matrix | `propose_register_sender_node`, `propose_warming_step`, `propose_pause_ip`, `propose_quarantine`, `update_sender_node_metadata`, `record_human_decision` |
| Endpoints | `POST /v1/agent/proposals` |
| Auth | HMAC `X-OpenClaw-Signature` + `X-OpenClaw-Timestamp`; nunca Bearer |
| Retorna | Salida corta para el LLM: `status`, `httpStatus`, `proposalId`, `requiredApprovals`, `injectedIntoCanvas` |
| Errores | `401`/`403`: reporta `httpStatus` + `rejectReason`; no fuerza bypass |
| Fallback | Ninguno: informa que no llegó al Gateway |
| Audit | `oc.skill.publish_proposal.invoke` + `oc.skill.publish_proposal.completed` + `oc.skill.publish_proposal.failed` |
| Side-effect permitido | Crear `StoredProposal` si la matriz acepta |

### 3.7 `mxtoolbox-health-check`

| Campo | Valor |
| --- | --- |
| Trigger natural | "blacklist", "salud SMTP", "MXToolbox dominio/IP" |
| Acciones matrix | `read_mxtoolbox_health` |
| Endpoint | `GET /v1/mxtoolbox/health` |
| Retorna | `status`, checks resumidos, `rawRef`; nunca raw completo |
| Fallback | `mxtoolbox_not_configured`/`status:error`; no inventar reputación |
| Audit | `oc.mxtoolbox.lookup`; listed diario -> `oc.mxtoolbox.blacklist_detected` |
| Side-effect | Ninguno |

### 3.8 `enable-smtp-auth`

| Campo | Valor |
| --- | --- |
| Trigger natural | "generar credencial SMTP", "crear password SMTP AUTH", "habilitar credencial del dominio" |
| Acciones matrix | `enable_smtp_auth` |
| Endpoint interno | Dispatcher canónico `enable_smtp_auth` -> handler interno `handleEnableSmtpAuthHttp`; no expone password ni markdown |
| Parámetros | `{ domain: string }`, un solo dominio verificado contra inventario/provisioning |
| Retorna | JSON de estado: `ok`, `domain`, `status`, `hasCredential`; nunca `password`, markdown, ciphertext ni authTag |
| Errores | `credential_encryption_key_missing`, `ambiguous_domain`, `no_candidate`, `pending_ssh`, `install_failed`, `failed`; no reintenta otros dominios |
| Fallback | Ninguno. Si falta `CREDENTIAL_ENCRYPTION_KEY`, falla cerrado y pide al operador setearla por canal seguro |
| Audit | `oc.smtp_auth.enabled` con `status`, `hasCredential`, `candidateCount` y `credentialFingerprint` si quedó configurada |
| Side-effect permitido | Instala SASL 587/465 para el dominio elegido; puerto 25 y `permit_mynetworks` permanecen intactos |

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
