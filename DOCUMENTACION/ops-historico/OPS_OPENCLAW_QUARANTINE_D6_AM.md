# OPS · D+6 AM — Runbook quarantine + business hours quorum

> Cronograma: D+6 AM del `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`.
> Pre-requisitos: D+5 PM cerrado (3 runbooks + execute/revert + multi-approver).
> Construye sobre:
> - `DOCUMENTACION/runbooks/incident-quarantine-runbook.md`
> - Pipeline de runbooks de D+5 PM
> - Permissions Matrix Doc 2 §3.3
>
> Decisión heredada: Notion side-effect skipped per `.audit/decision-skip-notion-side-effect.md`.
> El runbook ejecuta el flujo local + audita `oc.quarantine.notion_skipped` paralelo a alert-ops/report-ops.

## Objetivo

Cabear el **cuarto y último runbook** del Hito 5.11.B: `incident-quarantine`.
Es el más severo del catálogo — severity `critical`, status terminal
`quarantined`, rollback explícito con target status decidido por el
operador (active / retired / quarantine).

Una pieza nueva no presente en D+5 PM: **quorum dinámico por horario**.
En business hours (08:00–20:00 UTC-5 Colombia) basta 1 firma; en off-hours
se requieren 2 firmas distintas. La lógica vive en el endpoint `/approve`
y consulta el horario server-side antes de decidir cuántos approvers pedir.

Después de D+6 AM el agente está **feature-complete** para Hito 5.11.B —
queda solo D+6 PM (smoke E2E) y D+7 (cierre formal).

## Entregables verificables

- [ ] `packages/domain/src/runbooks/quarantine.ts` con
      `executeQuarantineRunbook(input, ctx) → RunbookResult`
- [ ] Helper `resolveBusinessHoursQuorum(now, runbookId, runbookSpec)` que
      retorna `{ requiredApprovals: 1 | 2, mode: 'business_hours' | 'off_hours' }`
- [ ] Nuevo status `quarantined` en el enum de `SenderNode.status` (si no existe)
- [ ] `revertRunbook` extendido para aceptar `metadata.targetStatus` cuando el
      runbookId es `incident-quarantine` (default `active`; aceptados `active`,
      `retired`, `quarantined`)
- [ ] `/v1/agent/proposals/:id/approve` modificado para consultar
      `resolveBusinessHoursQuorum` cuando `runbookId === 'incident-quarantine'`
- [ ] Audit eventos:
  - `oc.runbook.quarantine.executed`
  - `oc.runbook.quarantine.failed_partial`
  - `oc.runbook.quarantine.reverted` con `metadata.newStatus`
  - `oc.quarantine.notion_skipped` (parallel al pattern de report-ops)
  - `oc.approval.quorum_resolved` con `mode`, `requiredApprovals`, `serverTime`
- [ ] Smoke real: 2 escenarios (business hours 1 firma + off-hours 2 firmas)
      sobre `svc-mvp-test-02` y `svc-mvp-test-03`
- [ ] `verify-chain.ts` post-smokes → exit 0

## Paso 1 — Domain logic `quarantine.ts`

```typescript
import { approvalLocks } from '../security/locks.js';
import { senderNodeRegistry } from '../sender-nodes/registry.js';
import { persistRollbackSnapshot } from '../audit/rollback.js';
import type { RunbookContext, RunbookResult } from './types.js';

export interface QuarantineInput {
  nodeId: string;
  reason: string;
  evidenceRefs: string[];
}

export async function executeQuarantineRunbook(
  input: QuarantineInput,
  ctx: RunbookContext
): Promise<RunbookResult> {
  if (ctx.killSwitchState === 'active') return { ok: false, rejectReason: 'kill_switch_armed', detail: '' };

  const node = await senderNodeRegistry.get(input.nodeId);
  if (!node) return { ok: false, rejectReason: 'state_inconsistent', detail: 'Node not found' };

  // Preconditions: status debe ser active, warming, o paused (no quarantined ni retired)
  if (!['active', 'warming', 'paused'].includes(node.status)) {
    return { ok: false, rejectReason: 'preconditions_failed', detail: `Cannot quarantine node in status ${node.status}` };
  }

  const lock = approvalLocks.tryAcquire('sender_node', input.nodeId);
  if (!lock) return { ok: false, rejectReason: 'race_condition', detail: '' };

  try {
    const prevState = { status: node.status, dailyLimit: node.dailyLimit };
    const rollbackToken = persistRollbackSnapshot({
      runbookId: 'incident-quarantine',
      targetType: 'sender_node',
      targetId: input.nodeId,
      prevStateJson: JSON.stringify(prevState)
    });

    await senderNodeRegistry.updateStatus(input.nodeId, 'quarantined');

    return {
      ok: true,
      rollbackToken,
      newState: { status: 'quarantined', reason: input.reason, evidenceRefs: input.evidenceRefs },
      prevState,
      auditAction: 'oc.runbook.quarantine.executed'
    };
  } finally {
    approvalLocks.release(lock);
  }
}
```

Asegurar que `SenderNode.status` permita `'quarantined'` y `'retired_pending_approval'`
(esto último puede que ya esté del D+5 PM). Si el enum vive en
`packages/domain/src/sender-nodes/types.ts`, agregar.

## Paso 2 — Helper `resolveBusinessHoursQuorum`

`apps/gateway-api/src/security/business-hours.ts`:

```typescript
const OPERATOR_TZ = process.env.DELIVRIX_OPERATOR_TZ ?? 'America/Bogota'; // UTC-5
const BH_START = 8;   // 08:00 local
const BH_END = 20;    // 20:00 local

export interface QuorumResolution {
  requiredApprovals: 1 | 2;
  mode: 'business_hours' | 'off_hours';
  serverTime: string;        // ISO
  operatorLocalHour: number; // 0-23
}

export function resolveBusinessHoursQuorum(now: Date, runbookId: string): QuorumResolution {
  // Solo incident-quarantine usa este resolver dinámico. Otros runbooks
  // siguen leyendo required_approvals del YAML cabeado al boot.
  if (runbookId !== 'incident-quarantine') {
    throw new Error('resolveBusinessHoursQuorum only applies to incident-quarantine');
  }

  // Convertir UTC a hora local del operador
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: OPERATOR_TZ,
    hour: 'numeric',
    hour12: false
  });
  const localHourStr = fmt.format(now).replace(/[^0-9]/g, '');
  const localHour = Number(localHourStr);

  const isBusinessHours = localHour >= BH_START && localHour < BH_END;

  return {
    requiredApprovals: isBusinessHours ? 1 : 2,
    mode: isBusinessHours ? 'business_hours' : 'off_hours',
    serverTime: now.toISOString(),
    operatorLocalHour: localHour
  };
}
```

Tests obligatorios (`business-hours.test.ts`):

```typescript
describe('resolveBusinessHoursQuorum', () => {
  it('returns 1 firma at 10:00 Bogota (business hours)', () => {
    const now = new Date('2026-05-20T15:00:00Z'); // 10:00 Bogota (UTC-5)
    const q = resolveBusinessHoursQuorum(now, 'incident-quarantine');
    expect(q.requiredApprovals).toBe(1);
    expect(q.mode).toBe('business_hours');
  });

  it('returns 2 firmas at 02:00 Bogota (off-hours)', () => {
    const now = new Date('2026-05-20T07:00:00Z'); // 02:00 Bogota
    const q = resolveBusinessHoursQuorum(now, 'incident-quarantine');
    expect(q.requiredApprovals).toBe(2);
    expect(q.mode).toBe('off_hours');
  });

  it('returns 2 firmas at 22:00 Bogota (off-hours)', () => {
    const now = new Date('2026-05-21T03:00:00Z'); // 22:00 Bogota previo día
    const q = resolveBusinessHoursQuorum(now, 'incident-quarantine');
    expect(q.requiredApprovals).toBe(2);
  });

  it('throws if runbookId is not incident-quarantine', () => {
    expect(() => resolveBusinessHoursQuorum(new Date(), 'warming-step')).toThrow();
  });
});
```

## Paso 3 — Modificar `/approve` para quarantine

Reemplazar la lectura estática `getRequiredApprovalsFromRunbookSpec(runbookId)`
por un wrapper:

```typescript
function getRequiredApprovalsForProposal(proposal: StoredProposal, now: Date): QuorumResolution | { requiredApprovals: number; mode: 'static' } {
  const runbookId = resolveRunbookIdFromProposal(proposal);

  if (runbookId === 'incident-quarantine') {
    return resolveBusinessHoursQuorum(now, runbookId);
  }

  return {
    requiredApprovals: getRequiredApprovalsFromRunbookSpec(runbookId),
    mode: 'static'
  };
}
```

En el handler de `/approve`, después de issue del token y antes del check
de quorum, auditar la resolución:

```typescript
const quorumRes = getRequiredApprovalsForProposal(proposal, new Date());

if ('mode' in quorumRes && quorumRes.mode !== 'static') {
  // Solo audita para quarantine
  await auditLog.append({
    actorType: 'gateway', actorId: 'gateway-api',
    action: 'oc.approval.quorum_resolved',
    targetType: 'proposal', targetId: proposal.id,
    decision: 'n/a',
    metadata: {
      runbookId: 'incident-quarantine',
      mode: quorumRes.mode,
      requiredApprovals: quorumRes.requiredApprovals,
      serverTime: quorumRes.serverTime,
      operatorLocalHour: quorumRes.operatorLocalHour
    }
  });
}

// Resto del flujo de quorum del D+5 PM, usando quorumRes.requiredApprovals
```

## Paso 4 — Endpoint `/runbook/execute` despachando quarantine

Agregar al switch del D+5 PM:

```typescript
case 'incident-quarantine':
  result = await executeQuarantineRunbook(body.input, ctx);
  break;
```

Después del audit success, también auditar el Notion skip:

```typescript
if (runbookId === 'incident-quarantine' && !process.env.NOTION_API_KEY) {
  await auditLog.append({
    actorType: 'gateway', actorId: 'gateway-api',
    action: 'oc.quarantine.notion_skipped',
    targetType: 'runbook', targetId: 'incident-quarantine',
    decision: 'n/a',
    metadata: {
      reason: 'NOTION_API_KEY no presente; tarjeta crítica Notion + Daily Standup omitidos. Decisión audited en .audit/decision-skip-notion-side-effect.md',
      proposalId: proposal.id,
      nodeId: body.input.nodeId
    }
  });
}
```

## Paso 5 — Extender `revertRunbook` para quarantine

En `revert.ts` del D+5 PM, agregar el caso:

```typescript
case 'incident-quarantine': {
  // Quarantine no auto-revierte. Operador decide target status.
  const targetStatus = metadata?.targetStatus ?? 'active';
  const VALID_TARGETS = ['active', 'retired', 'quarantined'];
  if (!VALID_TARGETS.includes(targetStatus)) {
    return { ok: false, rejectReason: 'invalid_target_status', detail: `targetStatus must be one of ${VALID_TARGETS.join(', ')}` };
  }

  // Verificar que el target tenga sentido: si targetStatus===quarantined, no-op (raro pero permitido para audit)
  await senderNodeRegistry.updateStatus(snapshot.target_id, targetStatus);
  break;
}
```

La firma de `revertRunbook` cambia para aceptar metadata opcional:

```typescript
export async function revertRunbook(
  rollbackToken: string,
  approverId: string,
  reason: string,
  metadata?: { targetStatus?: 'active' | 'retired' | 'quarantined' }
): Promise<RevertResult>
```

Endpoint `/v1/agent/runbook/revert` acepta `body.metadata.targetStatus`
opcional. Si el runbook es quarantine y no se provee, default `active`
con audit warning `oc.runbook.quarantine.reverted` con
`metadata.defaultedTargetStatus: true`.

## Paso 6 — Frontend admin panel

En PromptStrip cuando el proposal es severity `critical` y
`runbookRef === 'incident-quarantine-runbook.md'`:

- Mostrar badge rojo "🚨 Crítico" en lugar del strip amber habitual.
- Mostrar texto explicativo del horario: "Modo: business_hours (1 firma)"
  o "Modo: off_hours (2 firmas)" leyendo de
  `proposal.quorumResolution` (campo nuevo que el `/approve` agrega al
  StoredProposal después de la primera firma).
- Botón "Cuarentena urgente" (primary rojo) reemplaza el "Aprobar" estándar.
- Después de ejecución, botón secundario "Decidir destino" que abre modal
  con 3 opciones: Reactivar (active), Retirar (retired), Mantener
  cuarentena (quarantined). Dispara `/revert` con `targetStatus`.

## Paso 7 — Smoke real (2 escenarios)

```bash
WORKTREE="/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
cd "${WORKTREE}"

# 7.1 — Build + reload
npm --workspace @delivrix/gateway-api run build
npm test -- --filter=quarantine,business-hours
# Esperado: ~10 nuevos tests OK
bash restart-gateway.sh

# 7.2 — Pre-seed 2 nodos test (similar al svc-mvp-test-01 del D+5 PM)
# Codex puede reusar el runbook register para crear svc-mvp-test-02 y -03

# 7.3 — Smoke #1 BUSINESS HOURS (1 firma)
# Usar fecha mockeada server-side a 10:00 Bogota — vía endpoint debug o
# variable de entorno DELIVRIX_NOW_OVERRIDE=2026-05-20T15:00:00Z
DELIVRIX_NOW_OVERRIDE="2026-05-20T15:00:00Z" bash restart-gateway.sh

# Propose quarantine svc-mvp-test-02
BODY='{"proposal":{"id":"smoke-quarantine-bh","category":"node_quarantine_proposed","severity":"critical","headline":"🚨 Cuarentena svc-mvp-test-02","body":"Spamhaus SBL hit detectado","evidenceRefs":["sha:abc123"],"runbookRef":"incident-quarantine-runbook.md","targetRef":"svc-mvp-test-02","delivrix_actions_required":["propose_quarantine","update_sender_node_metadata"]},"audit":{"skillSlug":"smoke","modelVersion":"manual","promptVersion":"v1"},"schemaVersion":"2026-05-18.v1"}'
# ... HMAC + POST /v1/agent/proposals ...

# Operador firma (1 firma alcanza BH)
curl -s -X POST http://127.0.0.1:3000/v1/agent/proposals/smoke-quarantine-bh/approve -H "X-Operator-Id: op-juanes-a"
# Esperado: {"approvalToken":...,"quorum":{"current":1,"required":1,"reached":true,"mode":"business_hours"}}

# Execute quarantine
BODY='{"proposalId":"smoke-quarantine-bh","runbookId":"incident-quarantine","input":{"nodeId":"svc-mvp-test-02","reason":"Spamhaus SBL hit","evidenceRefs":["sha:abc123"]}}'
# ... HMAC + POST /v1/agent/runbook/execute ...
# Esperado: {"runbookId":"incident-quarantine","rollbackToken":"...","newState":{"status":"quarantined",...}}

# Verificar: nodo status=quarantined
curl -s http://127.0.0.1:3000/v1/sender-nodes -H "Authorization: Bearer ${DELIVRIX_OPENCLAW_TOKEN}" | jq '.[] | select(.id=="svc-mvp-test-02")'

# Audit oc.quarantine.notion_skipped emitido
tail -20 .audit/audit-events.jsonl | grep notion_skipped

# Decisión rollback: pasar a "retired"
curl -s -X POST http://127.0.0.1:3000/v1/agent/runbook/revert -H "X-Operator-Id: op-juanes-a" -H "Content-Type: application/json" -d '{"rollbackToken":"<token-7.3>","reason":"Investigado, IP descartada","metadata":{"targetStatus":"retired"}}'
# Esperado: {"reverted":true,"restoredState":{"status":"retired"}}

# 7.4 — Smoke #2 OFF-HOURS (2 firmas)
DELIVRIX_NOW_OVERRIDE="2026-05-21T03:00:00Z" bash restart-gateway.sh # 22:00 Bogota

# Propose quarantine svc-mvp-test-03 (mismo patrón)
# Operador A firma → quorum 1/2 reached=false
# Operador B firma → quorum 2/2 reached=true,mode=off_hours
# Execute → status=quarantined
# Rollback a "active" (default)

# 7.5 — verify-chain post-smokes
node --import tsx scripts/audit/verify-chain.ts
# Esperado: exit 0, events_total += ~20

# 7.6 — Limpiar override y validar tests
unset DELIVRIX_NOW_OVERRIDE
bash restart-gateway.sh
npm test
# Esperado: 189+ tests OK
```

**Nota sobre `DELIVRIX_NOW_OVERRIDE`:** este env var debe leerse en
`business-hours.ts` como override de `new Date()` solo en modo dev/test.
En producción se ignora con check `process.env.NODE_ENV === 'development'`.
Codex agrega el switch al helper.

## Paso 8 — Validación final

- [ ] `npm test`: 179 + ~10 (quarantine + business-hours) = 189+ pass
- [ ] `npm --workspace @delivrix/admin-panel run check`: 15/15 + build OK
- [ ] Smoke BH: status=quarantined → revert con targetStatus=retired
- [ ] Smoke OH: 2 firmas distintas → status=quarantined → revert con default targetStatus=active
- [ ] Audit `oc.approval.quorum_resolved` aparece 2 veces (1 por scenario)
      con `mode: business_hours` y `mode: off_hours`
- [ ] Audit `oc.quarantine.notion_skipped` aparece 2 veces
- [ ] Chain íntegra: `verify-chain.ts` exit 0
- [ ] Tabla `rollback_snapshots`: 2 nuevos consumed (1 quarantine→retired,
      1 quarantine→active)

## Cuándo cerrar D+6 AM

Verde cuando los 5 puntos de §8 están green. A partir de este momento,
**el agente está feature-complete para Hito 5.11.B**. Quedan solo:

- **D+6 PM** — Smoke E2E completo (Juanes hace un ciclo full él solo
  para verificar que el sistema entero funciona, no piezas sueltas).
- **D+7** — Cierre formal del hito.

## Lo que NO entra en D+6 AM

- **Tarjeta Notion crítica + Daily Standup entry** — diferido a Hito 5.12.
  El skip queda audited con cada quarantine. Plugin ready para reactivarse
  con cero código nuevo cuando se inyecte `NOTION_API_KEY`.
- **Email/SMS sponsor on-call** — del runbook spec §6: "futuro Hito 6+".
- **Detección automática de horario por operador individual** — MVP asume
  un único operador con TZ fija (`America/Bogota`). Multi-operador con TZ
  individual es post-MVP.
- **Workflow real de root cause analysis** — el runbook spec §rollback
  pide "Análisis de causa raíz documentado + plan de remediación firmado"
  antes del revert. En MVP, el rollback acepta cualquier reason + targetStatus
  sin gate adicional. Documentación del proceso es post-MVP.
