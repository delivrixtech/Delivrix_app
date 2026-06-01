# OpenClaw — Permissions Matrix

Fecha: 2026-05-18 (v2.0 expansión 2026-05-18).
Hito rector: `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md`.
Categorías y método de evaluación heredados de `HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md`.

## Changelog

- **v1.0** (2026-05-18) — 5 categorías + ~40 acciones por familia.
- **v2.0** (2026-05-18) — 29 acciones de lectura una a una (todo el read-boundary literal), pseudocódigo formal del pipeline en TypeScript, manejo de race conditions en approvals concurrentes, código de error tipado por rejection reason.
- **v2.1** (2026-05-27) — Camino B CTO: `register_domain` pasa de doble firma a modelo wallet con `requiredApprovals: 1` y firmante único `juanescanar-cto`; sigue requiriendo presupuesto, flag explícita, audit y cleanup DNS/VPS.

## 1. Propósito

Definir qué puede y qué no puede hacer el agente OpenClaw en cada momento. Esta matriz
es el **gate duro** que se evalúa **antes** de cualquier llamada del agente al Gateway
de Delivrix o a un proveedor externo. Si una acción no aparece aquí o aparece como
`prohibited`, no se ejecuta.

## 2. Categorías canónicas

| Categoría | Significado |
| --- | --- |
| `allowed_read_only` | Lectura pura. Sin efectos. No requiere aprobación. |
| `allowed_dry_run` | Genera plan o payload sin tocar nada real. No requiere aprobación. |
| `supervised_local_state` | Modifica estado **local** de Delivrix (registry, metadata, audit). Requiere aprobación humana + kill switch armado. |
| `supervised_live_wallet` | Ejecuta una acción live acotada con costo bajo bajo modelo wallet CTO. Requiere aprobación humana única, presupuesto, flags explícitas, audit y cleanup. |
| `future_live_requires_new_phase` | Acción contra infraestructura real. Bloqueada en Hito 5.11.B. Sólo se habilita con hito posterior + actualización del norte. |
| `prohibited` | Nunca se permite, ni siquiera con aprobación. Vulneraría norte, compliance o seguridad. |

## 3. Matriz literal

### 3.1 Lectura (`allowed_read_only`)

OpenClaw puede llamar cualquier endpoint del **read-boundary** del Gateway Delivrix
(fuente canónica: `apps/admin-panel/src/shared/api/read-boundary.ts`). Las acciones
de lectura quedan enumeradas literal a continuación. Cualquier endpoint nuevo que se
agregue al read-boundary debe agregarse acá en el mismo commit.

| Acción | Endpoint | Audit ID | Target type |
| --- | --- | --- | --- |
| `read_health` | `GET /health` | `oc.read.health` | `gateway` |
| `read_admin_clusters` | `GET /v1/admin/clusters` | `oc.read.admin_clusters` | `cluster_overview` |
| `read_admin_overview` | `GET /v1/admin/overview` | `oc.read.admin_overview` | `admin_overview` |
| `read_admin_workflow` | `GET /v1/admin/workflow` | `oc.read.admin_workflow` | `workflow` |
| `read_collector_snapshot_ingestion` | `GET /v1/devops/collector/snapshot-ingestion` | `oc.read.collector_snapshot` | `collector_ingestion` |
| `read_collector_status` | `GET /v1/devops/collector/status` | `oc.read.collector_status` | `collector_status` |
| `read_collector_supervised_plan` | `GET /v1/devops/collector/supervised-plan` | `oc.read.collector_plan` | `collector_plan` |
| `read_hardware_physical_host` | `GET /v1/hardware/physical-host` | `oc.read.physical_host` | `physical_host` |
| `read_hardware_telemetry_history` | `GET /v1/hardware/telemetry/history` | `oc.read.telemetry_history` | `telemetry_history` |
| `read_hardware_telemetry_latest` | `GET /v1/hardware/telemetry/latest` | `oc.read.telemetry_latest` | `telemetry_latest` |
| `read_openclaw_learning_plan` | `GET /v1/openclaw/learning-plan` | `oc.read.learning_plan` | `learning_plan` |
| `read_openclaw_live_canvas` | `GET /v1/openclaw/live-canvas` | `oc.read.canvas` | `canvas` |
| `read_openclaw_onboarding_state` | `GET /v1/openclaw/onboarding/state` | `oc.read.onboarding` | `onboarding_state` |
| `read_openclaw_provisioning_state` | `GET /v1/openclaw/provisioning/state` | `oc.read.provisioning` | `provisioning_state` |
| `read_openclaw_readiness_signals` | `GET /v1/openclaw/readiness-signals` | `oc.read.readiness` | `readiness_signals` |
| `read_openclaw_workspace_tree` | `GET /v1/openclaw/workspace/tree` | `oc.workspace.read_tree` | `openclaw_workspace_path` |
| `read_openclaw_workspace_file` | `GET /v1/openclaw/workspace/file` | `oc.workspace.read_file` | `openclaw_workspace_path` |
| `read_operating_north` | `GET /v1/operating-north` | `oc.read.north` | `operating_north` |
| `read_kill_switch` | `GET /v1/kill-switch` | `oc.read.kill_switch` | `kill_switch` |
| `read_audit_events` | `GET /v1/audit-events` | `oc.read.audit` | `audit_log` |
| `read_sender_nodes` | `GET /v1/sender-nodes` | `oc.read.sender_nodes` | `sender_node_registry` |
| `read_ip_reputation_reports` | `GET /v1/ip-reputation/reports` | `oc.read.ip_reputation` | `ip_reputation` |
| `read_send_results` | `GET /v1/send-results` | `oc.read.send_results` | `send_results` |
| `read_stuck_jobs` | `GET /v1/stuck-jobs` | `oc.read.stuck_jobs` | `stuck_jobs` |
| `read_operational_summary` | `GET /v1/operational-summary` | `oc.read.operational_summary` | `operational_summary` |
| `read_iam_roles` | `GET /v1/iam/roles` | `oc.read.iam_roles` | `iam_roles` |
| `read_iam_sessions` | `GET /v1/iam/sessions` | `oc.read.iam_sessions` | `iam_sessions` |
| `read_compliance_status` | `GET /v1/compliance/status` | `oc.read.compliance` | `compliance` |
| `read_openclaw_skills_audit` | `GET /v1/openclaw/skills/audit` | `oc.read.skills_audit` | `skills_audit` |
| `read_openclaw_evidence` | `GET /v1/openclaw/evidence` | `oc.read.evidence` | `evidence` |
| `read_webdock_inventory` | `GET /v1/webdock/inventory` | `oc.read.webdock` | `webdock_inventory` |

**Regla de sincronización:** cualquier PR que agregue un endpoint al
`read-boundary.ts` debe agregar una fila a esta tabla en el mismo commit, o el
CI lo rechaza (test guard en `client.test.ts`).

### 3.2 Dry-run (`allowed_dry_run`)

| Acción | Descripción | Audit ID |
| --- | --- | --- |
| `propose_warming_step` | Genera plan dry-run de subir warming N→N+1 | `oc.dry.warming_step` |
| `propose_pause_ip` | Genera plan dry-run de pausar IP con reputación tensionada | `oc.dry.pause_ip` |
| `propose_quarantine` | Genera plan dry-run de quarantine local por incidente simulado | `oc.dry.quarantine` |
| `propose_rotate_dns` | Genera plan dry-run de cambio DNS (SPF/DKIM/DMARC/PTR) | `oc.dry.rotate_dns` |
| `propose_register_sender_node` | Genera payload para registrar nodo nuevo en registry | `oc.dry.register_node` |
| `propose_postfix_config` | Genera config Postfix sin aplicarla | `oc.dry.postfix` |
| `propose_topology_plan` | Llama `buildOpenClawTopologyPlan` con onboarding actual | `oc.dry.topology` |
| `propose_provisioning_plan` | Llama `buildOpenClawProvisioningDryRun` | `oc.dry.provisioning` |
| `generate_daily_report` | Construye reporte ejecutivo del día | `oc.dry.daily_report` |
| `evaluate_webdock_drift` | Cruza inventario Webdock vs registry local | `oc.dry.drift` |

### 3.3 Estado local supervisado (`supervised_local_state`)

Requiere `humanApproved: true` + `killSwitch.enabled: false`. Si falla cualquiera, se rechaza.

| Acción | Descripción | Audit ID |
| --- | --- | --- |
| `register_sender_node_local` | Inserta nodo en registry local (no toca el VPS) | `oc.local.register_node` |
| `update_sender_node_metadata` | Modifica label, dailyLimit, warmupDay en registry | `oc.local.update_node` |
| `mark_evidence_curated` | Etiqueta un snapshot como evidencia curada | `oc.local.curate_evidence` |
| `snooze_proposal` | Pospone una propuesta del agente en la UI | `oc.local.snooze` |
| `record_human_decision` | Registra decisión humana (aprobado/rechazado) sobre una propuesta | `oc.local.decision` |

### 3.4 Live (`future_live_requires_new_phase`)

**Cambio post-demo 2026-05-29:** la regla de 2 personas se reemplazó por 1 firma del operador + audit chain SHA-256 + broadcast al equipo + auto-rollback. Esto **movió 9 skills críticas a `supervised_local_state`** y las habilitó via flags operativos. Las skills destructivas siguen bloqueadas. Detalle completo: `CAMBIO_NORTE_QUITAR_2_PERSONAS_2026_05_29.md`.

#### Skills movidas a `supervised_local_state` (habilitadas con flag + 1 firma)

| Acción | Audit ID | Flag operativo | Firmante |
| --- | --- | --- | --- |
| `register_domain_route53` | `oc.route53.domain_registered` | `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true` | operador autorizado |
| `route53_dns_upsert` | `oc.route53.dns_upserted` | `AWS_ROUTE53_DNS_ENABLE_WRITES=true` | operador autorizado |
| `ionos_dns_upsert` | `oc.ionos.dns_upserted` | `IONOS_DNS_ENABLE_WRITES=true` (NUEVO) | operador autorizado |
| `provision_webdock_vps` | `oc.webdock.server_created` | `WEBDOCK_SERVERS_ENABLE_CREATE=true` | operador autorizado |
| `install_smtp_stack` | `oc.smtp.stack_installed` | `SMTP_PROVISIONING_ENABLE_SSH=true` | operador autorizado |
| `start_warmup_seed` | `oc.warmup.seed_sent` | `WARMUP_ENABLE_SEND=true` | operador autorizado |
| `start_warmup_ramp` | `oc.warmup.ramp_started` | `WARMUP_RAMP_ENABLE=true` (NUEVO) | operador autorizado |
| `bind_domain_to_server` | `oc.domain.bound` | `DOMAIN_BIND_ENABLE=true` (NUEVO) | operador autorizado |
| `configure_email_auth` | `oc.email.auth_configured` | `EMAIL_AUTH_ENABLE_WRITES=true` (NUEVO) | operador autorizado |

#### Skills que SIGUEN bloqueadas en `future_live_requires_new_phase`

Habilitar requiere nuevo hito + actualización adicional del norte.

| Acción | Razón del bloqueo |
| --- | --- |
| `proxmox_live_create_vps` | Crea VM real. Requiere fase posterior. |
| `proxmox_live_destroy_vps` | Destruye VM real. Irreversible sin snapshot. |
| `webdock_destroy_server` | Destruye VPS. Pérdida de datos. |
| `webdock_snapshot_restore` | Rollback de snapshot. Sobreescribe estado. |
| `dns_record_delete` | Borra registro DNS. Riesgo de downtime. |
| `delete_domain_route53` | Borra dominio. Destructivo irreversible. |
| `mass_dns_change` (>10 dominios simultáneos) | Riesgo sistémico. |
| `ssh_root_access` | Acceso SSH root sin scope acotado. |
| `tls_cert_renew_live` | Renueva certificado. Riesgo de mismatch. Habilitar con flag dedicado cuando exista runbook. |

### 3.5 Prohibidas (`prohibited`)

**Nunca se permiten**, ni siquiera con aprobación humana.

| Acción | Razón |
| --- | --- |
| `smtp_send_to_unconfirmed_recipient` | Viola CAN-SPAM / consentimiento. |
| `nfc_production_write` | Norte: NFC es integración futura opcional, no dependencia. |
| `nfc_activate_bridge` | Mismo gate de norte. |
| `ip_rotation_to_sustain_volume_after_reputation_event` | Vulnera reputación. |
| `plaintext_smtp_credentials_in_production` | Compliance + seguridad. |
| `write_secrets_to_repo` | Seguridad. Secretos nunca en git. |
| `bypass_kill_switch` | El kill switch es gate último. No tiene override. |
| `export_pii_outside_audit` | Compliance GDPR. |
| `auto_self_promote_ml_model` | Norte: ML supervisado, sin auto-promoción. |
| `purge_remote_queue` | Borra evidencia. Irreversible. |

## 4. Pipeline de evaluación

### 4.1 Pseudocódigo formal (TypeScript)

Cada vez que el agente quiere actuar, el Gateway Delivrix corre este pipeline **antes**
de la ejecución. El código real vive en `packages/domain/src/openclaw-runbook.ts`
función `evaluateOpenClawActionPermission`.

```typescript
type RejectReason =
  | "unknown_action"
  | "prohibited_action"
  | "live_blocked_hito_5_11_b"
  | "human_approval_missing"
  | "kill_switch_armed"
  | "approval_token_expired"
  | "approval_replay_detected"
  | "race_condition_detected"
  | "schema_mismatch"
  | "rate_limit_exceeded";

interface EvaluationContext {
  actionId: string;
  actorId: string;          // "openclaw-hostinger-prod" típicamente
  humanApproved: boolean;
  approverIds: string[];    // mínimo 2 si la acción requiere doble firma
  approvalTokens: ApprovalToken[];   // tokens firmados HMAC, ver §4.3
  killSwitchState: "armed" | "active";
  targetType: string;
  targetId: string;
  occurredAt: string;       // ISO server-side, no del agente
  schemaVersion: string;
}

interface EvaluationDecision {
  decision: "allow" | "reject";
  rejectReason?: RejectReason;
  rollbackToken?: string;   // sólo si supervised_local_state y allow
  auditEvent: AuditEvent;   // siempre se emite, allow o reject
}

function evaluateOpenClawActionPermission(
  ctx: EvaluationContext
): EvaluationDecision {
  // Paso 1: resolver acción contra la matriz
  const entry = MATRIX.get(ctx.actionId);
  if (!entry) {
    return reject(ctx, "unknown_action");
  }

  // Paso 2: validar schema del request (defensa contra payload malformado)
  if (ctx.schemaVersion !== "2026-05-18.v1") {
    return reject(ctx, "schema_mismatch");
  }

  // Paso 3: rate limit por (actorId, actionId)
  if (rateLimiter.exceeded(ctx.actorId, ctx.actionId)) {
    return reject(ctx, "rate_limit_exceeded");
  }

  // Paso 4: categoría
  switch (entry.category) {
    case "prohibited":
      // Nunca, ni con aprobación
      return reject(ctx, "prohibited_action");

    case "future_live_requires_new_phase":
      // Bloqueada por fase actual
      return reject(ctx, "live_blocked_hito_5_11_b");

    case "allowed_read_only":
      // OK sin más validación
      return allow(ctx);

    case "allowed_dry_run":
      // OK, no muta estado
      return allow(ctx);

    case "supervised_local_state":
      return evaluateSupervised(ctx, entry);
  }
}

function evaluateSupervised(
  ctx: EvaluationContext,
  entry: MatrixEntry
): EvaluationDecision {
  // Paso 5a: kill switch
  if (ctx.killSwitchState === "active") {
    return reject(ctx, "kill_switch_armed");
  }

  // Paso 5b: aprobación humana
  if (!ctx.humanApproved) {
    return reject(ctx, "human_approval_missing");
  }

  // Paso 5c: número mínimo de approvers
  const minApprovers = entry.requiredApprovals ?? 1;
  if (ctx.approverIds.length < minApprovers) {
    return reject(ctx, "human_approval_missing");
  }

  // Paso 5d: validar tokens HMAC (defensa contra replay y race)
  for (const token of ctx.approvalTokens) {
    const validation = validateApprovalToken(token, ctx);
    if (!validation.ok) {
      return reject(ctx, validation.reason);
    }
  }

  // Paso 5e: serialización contra race conditions (ver §4.4)
  const lock = approvalLocks.tryAcquire(ctx.targetType, ctx.targetId);
  if (!lock) {
    return reject(ctx, "race_condition_detected");
  }

  try {
    const rollbackToken = persistRollbackSnapshot(ctx);
    return allow(ctx, rollbackToken);
  } finally {
    approvalLocks.release(lock);
  }
}
```

### 4.2 Códigos de rejection con HTTP status

| `rejectReason` | HTTP status | Significado |
| --- | --- | --- |
| `unknown_action` | 400 | La acción no existe en la matriz. Probable bug del agente o versión obsoleta. |
| `prohibited_action` | 403 | Acción prohibida. No reintentar. |
| `live_blocked_hito_5_11_b` | 403 | Acción contra infra real, bloqueada por fase actual. |
| `human_approval_missing` | 401 | Falta firma humana o no llega el quorum mínimo. |
| `kill_switch_armed` | 423 | Kill switch activo. Solo lecturas permitidas. |
| `approval_token_expired` | 401 | Token de aprobación venció (TTL 15 min). Re-firmar. |
| `approval_replay_detected` | 409 | Mismo token usado dos veces. Posible ataque o bug. |
| `race_condition_detected` | 409 | Otra acción está modificando el mismo target. Reintentar después. |
| `schema_mismatch` | 400 | Payload no cumple el contrato. |
| `rate_limit_exceeded` | 429 | Demasiadas requests del mismo actor para la misma acción. |

### 4.3 Tokens de aprobación (HMAC)

Cuando un operador firma una acción supervisada fuera del panel (vía el runbook
correspondiente), el Gateway emite un `ApprovalToken` con esta estructura:

```typescript
interface ApprovalToken {
  tokenId: string;            // uuid v4
  actionId: string;           // debe coincidir con ctx.actionId al evaluar
  targetType: string;
  targetId: string;
  approverId: string;         // id del firmante humano
  issuedAt: string;           // ISO
  expiresAt: string;          // issuedAt + 15min
  nonce: string;              // random 32 bytes hex, único
  signature: string;          // HMAC-SHA256(secret, canonicalJSON(token sin signature))
}
```

`validateApprovalToken` verifica:

1. `signature` es HMAC válido contra el secret del Gateway.
2. `expiresAt > now()`.
3. `actionId`, `targetType`, `targetId` coinciden con el contexto.
4. `tokenId` no aparece en el `usedTokens` cache (defensa contra replay; TTL 24h).
5. Si `requiredApprovals > 1`: los tokens deben tener `approverId` distintos.

### 4.4 Race conditions en approvals concurrentes

Dos operadores pueden firmar la misma acción al mismo tiempo desde dispositivos
distintos. Sin serialización, ambos llegarían al Gateway y se persistirían dos
veces, dejando estado inconsistente.

**Solución: `approvalLocks` por `(targetType, targetId)`.**

```typescript
class ApprovalLockRegistry {
  private locks = new Map<string, NodeJS.Timeout>();
  private readonly LOCK_TTL_MS = 30_000;  // 30s, suficiente para persistir + audit

  tryAcquire(targetType: string, targetId: string): string | null {
    const key = `${targetType}:${targetId}`;
    if (this.locks.has(key)) return null;

    const lockId = crypto.randomUUID();
    this.locks.set(key, setTimeout(() => this.release(lockId), this.LOCK_TTL_MS));
    return lockId;
  }

  release(lockId: string): void {
    for (const [key, timeout] of this.locks.entries()) {
      // implementación real maneja lockId; aquí ilustrativo
    }
  }
}
```

**Garantías:**

- Sólo una acción `supervised_local_state` se ejecuta a la vez sobre el mismo target.
- Si una acción tarda más de 30s, el lock expira y otra puede entrar — pero la primera
  ya debió haber commitado o fallar.
- El lock es por proceso del Gateway. Si hay réplicas del Gateway, usar Redis
  distributed lock (no necesario en MVP single-instance).

### 4.5 Garantías y no-garantías

**Garantizamos:**
- Toda acción pasa por este pipeline antes de ejecutarse.
- Toda evaluación emite un evento de audit (allow o reject).
- Las acciones supervisadas no se ejecutan concurrentemente sobre el mismo target.
- Tokens de aprobación no se pueden reusar.

**No garantizamos en Hito 5.11.B:**
- Distributed locking entre múltiples Gateways (single instance).
- Recuperación automática si el Gateway crashea entre `acquire lock` y `persist` —
  el lock expira a 30s y la próxima evaluación re-valida estado.
- Throughput sostenido > 100 requests/s del agente (rate limit lo previene).

## 5. Audit trail por acción

Cada decisión (ALLOW o REJECT) escribe un evento en el audit log de Delivrix con:

```json
{
  "actorType": "openclaw",
  "actorId": "openclaw-hostinger-prod",
  "action": "<audit ID de la matriz>",
  "targetType": "<tipo del recurso>",
  "targetId": "<id concreto>",
  "decision": "allow | reject",
  "rejectReason": "<código si reject>",
  "humanApproved": "<bool>",
  "killSwitchState": "<armed | inactive>",
  "rollbackToken": "<uuid si aplica>",
  "occurredAt": "<ISO>",
  "evidenceRefs": ["<hashes>"]
}
```

Este evento se replica al audit del agente remoto OpenClaw (ver Doc 8).

## 6. Rollback

Sólo las acciones de `supervised_local_state` pueden necesitar rollback. El Gateway
emite un `rollbackToken` al ejecutar y registra el snapshot previo. El operador puede
ejecutar `revert_supervised_action(rollbackToken)` que es a su vez una acción
`supervised_local_state` y requiere los mismos gates.

Las acciones `allowed_read_only` y `allowed_dry_run` no necesitan rollback porque no
modifican estado.

Las acciones `future_live_requires_new_phase` y `prohibited` nunca se ejecutan, no
aplica rollback.

## 7. Gates duros (no negociables)

- La matriz es **append-only**: se agregan acciones, nunca se relajan categorías
  existentes sin actualizar el norte operativo.
- `humanApproved == true` se establece sólo cuando 1 operador autorizado firma
  desde ApprovalGate o endpoint firmado equivalente. El frontend no puede marcar
  approval por sí solo: el Gateway escribe la firma en audit chain SHA-256,
  valida kill switch y emite webhook broadcast o buffer local.
- El kill switch es el último gate. Cuando está armado, el pipeline rechaza incluso
  acciones aprobadas humanamente. No hay bypass.
- Cambios en esta matriz se versionan en git con commit explícito tipo
  `feat(openclaw): permissions matrix vN`.

## 8. Referencias

- `DOCUMENTACION/HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md` (categorías originales)
- `DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md` (gates blindados)
- `packages/domain/src/openclaw-runbook.ts` (función `evaluateOpenClawActionPermission`)
- `packages/domain/src/kill-switch.ts` (estado kill switch consultado por el pipeline)
- `apps/admin-panel/src/shared/api/read-boundary.ts` (28 endpoints permitidos para read-only)
- Doc 5 (`OPENCLAW_SYSTEM_PROMPT.md`) cita esta matriz como gate duro en el prompt.
- Doc 8 (`OPENCLAW_AUDIT_INTEGRATION.md`) define el formato exacto del audit event.
