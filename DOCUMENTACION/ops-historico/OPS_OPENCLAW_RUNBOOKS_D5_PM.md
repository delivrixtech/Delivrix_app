# OPS · D+5 PM — Runbooks 1-3 cabled (register → warming → pause)

> Cronograma: D+5 PM del `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`.
> Pre-requisitos: D+5 AM cerrado (hash chain SHA-256 funcionando).
> Construye sobre:
> - `DOCUMENTACION/runbooks/register-sender-node-local-runbook.md`
> - `DOCUMENTACION/runbooks/warming-step-runbook.md`
> - `DOCUMENTACION/runbooks/pause-ip-runbook.md`
> - HMAC + ApprovalToken (D+4 AM)
> - Hash chain audit (D+5 AM)
>
> Decisiones del operador (chat 2026-05-19):
> 1. **Smoke con 2 identidades** `op-juanes-a` y `op-juanes-b` (placeholders).
>    2-approver de warming-step queda funcional per spec.
> 2. **Orden secuencial** `register → warming → pause` sobre el mismo nodo
>    `svc-mvp-test-01`. Simula un ciclo de vida MVP completo.

## Objetivo

Cerrar el **primer ciclo end-to-end del agente**. Hasta D+5 AM teníamos:

- Agente propone (`POST /v1/agent/proposals` con HMAC)
- Operador firma (`POST /v1/agent/proposals/:id/approve` → ApprovalToken)
- Audit chain encadenado

Lo que falta y D+5 PM cierra: **la ejecución real del runbook que consume el
ApprovalToken y muta estado local**, con su correspondiente rollback de
emergencia.

Tres piezas técnicas:

1. **Domain logic** en `packages/domain/src/runbooks/` para los 3 runbooks.
   Cada función: valida preconditions, snapshot estado previo, aplica mutación,
   retorna `rollbackToken`. Tests unitarios obligatorios.
2. **Endpoints** `POST /v1/agent/runbook/execute` + `POST /v1/agent/runbook/revert`
   en Gateway. Execute valida 1 o 2 ApprovalTokens según `required_approvals`
   del runbook, despacha al domain, audita resultado. Revert resuelve por
   `rollbackToken` y restaura.
3. **SQLite migration 0008** `rollback_snapshots` (TTL 7d) + extensión de
   `/approve` para soportar multi-approver (queries existing tokens, marca
   proposal `resolved` solo cuando se alcanza `required_approvals`).

## Entregables verificables

- [ ] `packages/domain/src/runbooks/register-sender-node.ts` con
      `executeRegisterSenderNodeRunbook(input, ctx) → RunbookResult`
- [ ] `packages/domain/src/runbooks/warming-step.ts` con
      `executeWarmingStepRunbook(input, ctx) → RunbookResult`
- [ ] `packages/domain/src/runbooks/pause-ip.ts` con
      `executePauseIpRunbook(input, ctx) → RunbookResult`
- [ ] `packages/domain/src/runbooks/revert.ts` con `revertRunbook(rollbackToken)`
- [ ] Tests unitarios por runbook: precondition pass/fail, mutation correcta,
      rollback restaura, idempotencia (segundo run con mismo proposalId rechaza)
- [ ] Migration `0008_rollback_snapshots.sql`
- [ ] Endpoint `/v1/agent/runbook/execute` con HMAC + matrix pipeline
      `humanApproved=true` + dispatch por `runbookId`
- [ ] Endpoint `/v1/agent/runbook/revert` con auth operador (placeholder
      header) + validación rollback_token vivo + restauración + audit
- [ ] `/v1/agent/proposals/:id/approve` extendido para multi-approver:
      cuenta tokens issued vs `required_approvals`, mantiene proposal
      pending hasta alcanzar quorum
- [ ] Frontend admin panel: PromptStrip muestra estado "1/2 firmas
      requeridas" cuando `requiredApprovals: 2` y solo 1 emitido
- [ ] Audit events:
  - `oc.runbook.register_sender_node.executed` / `.failed_partial` / `.reverted`
  - `oc.runbook.warming_step.executed` / `.failed_partial` / `.reverted`
  - `oc.runbook.pause_ip.executed` / `.failed_partial` / `.reverted`
  - `oc.runbook.preconditions_failed` (genérico, con `runbookId` en metadata)
  - `oc.approval.quorum_reached` cuando se cumple el N de firmas
- [ ] Smoke real: ciclo completo register → warming → pause sobre
      `svc-mvp-test-01`, 15+ eventos audit nuevos, chain íntegra al final

## Paso 1 — Domain logic + tests

Tipo común en `packages/domain/src/runbooks/types.ts`:

```typescript
export type RunbookId = 'register-sender-node-local' | 'warming-step' | 'pause-ip';

export interface RunbookContext {
  proposalId: string;
  approverIds: string[];          // ya validados por endpoint antes de llegar acá
  killSwitchState: 'armed' | 'active';
  occurredAt: string;             // ISO server-side
}

export interface RunbookResult {
  ok: true;
  rollbackToken: string;
  newState: unknown;
  prevState: unknown;
  auditAction: string;             // ej "oc.runbook.warming_step.executed"
} | {
  ok: false;
  rejectReason: 'preconditions_failed' | 'kill_switch_armed' | 'race_condition' | 'state_inconsistent';
  detail: string;
}
```

### 1.1 — `register-sender-node.ts`

```typescript
export async function executeRegisterSenderNodeRunbook(
  input: RegisterSenderNodeInput,
  ctx: RunbookContext
): Promise<RunbookResult> {
  // Preconditions per runbook spec
  if (ctx.killSwitchState === 'active') return { ok: false, rejectReason: 'kill_switch_armed', detail: '' };
  if (await senderNodeRegistry.exists(input.id)) return { ok: false, rejectReason: 'state_inconsistent', detail: `Node ${input.id} already registered` };
  if (await senderNodeRegistry.existsByIp(input.ipAddress)) return { ok: false, rejectReason: 'state_inconsistent', detail: `IP ${input.ipAddress} already registered` };
  // Webdock running + IP not in suppression + reputation not critical:
  // validar contra reads cuando hay data; en MVP loggear como assumption
  // si el read está mocked.

  // Lock por (sender_node, id) — reutilizar approvalLocks del D+4 AM
  const lock = approvalLocks.tryAcquire('sender_node', input.id);
  if (!lock) return { ok: false, rejectReason: 'race_condition', detail: '' };

  try {
    // Snapshot prev: el nodo NO existe → snapshot { existed: false }
    const prevState = { existed: false };
    const rollbackToken = persistRollbackSnapshot({
      runbookId: 'register-sender-node-local',
      targetType: 'sender_node',
      targetId: input.id,
      prevStateJson: JSON.stringify(prevState)
    });

    // Mutación
    await senderNodeRegistry.register(input);

    // Verificación post-step (per runbook spec)
    const verifyList = await senderNodeRegistry.list();
    const found = verifyList.find((n) => n.id === input.id);
    if (!found) {
      // Failed partial → revert inmediato
      await senderNodeRegistry.delete(input.id).catch(() => {});
      return { ok: false, rejectReason: 'state_inconsistent', detail: 'Node not found post-register' };
    }

    return {
      ok: true,
      rollbackToken,
      newState: found,
      prevState,
      auditAction: 'oc.runbook.register_sender_node.executed'
    };
  } finally {
    approvalLocks.release(lock);
  }
}
```

### 1.2 — `warming-step.ts`

```typescript
export async function executeWarmingStepRunbook(
  input: WarmingStepInput,    // { nodeId }
  ctx: RunbookContext
): Promise<RunbookResult> {
  if (ctx.killSwitchState === 'active') return { ok: false, rejectReason: 'kill_switch_armed', detail: '' };
  if (ctx.approverIds.length < 2) return { ok: false, rejectReason: 'preconditions_failed', detail: 'warming-step requires 2 distinct approvers' };
  if (new Set(ctx.approverIds).size !== 2) return { ok: false, rejectReason: 'preconditions_failed', detail: 'approvers must be distinct' };

  const node = await senderNodeRegistry.get(input.nodeId);
  if (!node) return { ok: false, rejectReason: 'state_inconsistent', detail: 'Node not found' };
  if (node.status !== 'warming') return { ok: false, rejectReason: 'preconditions_failed', detail: `Node status is ${node.status}, expected warming` };

  const MAX_WARMUP_DAY = 30;
  if (node.warmupDay >= MAX_WARMUP_DAY) return { ok: false, rejectReason: 'preconditions_failed', detail: 'warmupDay at max' };

  // Reputación verde 48h, bounces<2%, complaints<0.2% → validar contra reads cuando hay data
  // En MVP con mocks, loggear assumption y continuar

  const lock = approvalLocks.tryAcquire('sender_node', input.nodeId);
  if (!lock) return { ok: false, rejectReason: 'race_condition', detail: '' };

  try {
    const prevState = { warmupDay: node.warmupDay, dailyLimit: node.dailyLimit };
    const newWarmupDay = node.warmupDay + 1;
    const newDailyLimit = computeDailyLimitForDay(newWarmupDay);

    const rollbackToken = persistRollbackSnapshot({
      runbookId: 'warming-step',
      targetType: 'sender_node',
      targetId: input.nodeId,
      prevStateJson: JSON.stringify(prevState)
    });

    await senderNodeRegistry.updateMetadata(input.nodeId, {
      warmupDay: newWarmupDay,
      dailyLimit: newDailyLimit
    });

    return {
      ok: true,
      rollbackToken,
      newState: { warmupDay: newWarmupDay, dailyLimit: newDailyLimit },
      prevState,
      auditAction: 'oc.runbook.warming_step.executed'
    };
  } finally {
    approvalLocks.release(lock);
  }
}
```

### 1.3 — `pause-ip.ts`

```typescript
export async function executePauseIpRunbook(
  input: PauseIpInput,   // { nodeId, reason }
  ctx: RunbookContext
): Promise<RunbookResult> {
  if (ctx.killSwitchState === 'active') return { ok: false, rejectReason: 'kill_switch_armed', detail: '' };

  const node = await senderNodeRegistry.get(input.nodeId);
  if (!node) return { ok: false, rejectReason: 'state_inconsistent', detail: 'Node not found' };
  if (node.status !== 'active' && node.status !== 'warming') {
    return { ok: false, rejectReason: 'preconditions_failed', detail: `Cannot pause node in status ${node.status}` };
  }

  const lock = approvalLocks.tryAcquire('sender_node', input.nodeId);
  if (!lock) return { ok: false, rejectReason: 'race_condition', detail: '' };

  try {
    const prevState = { status: node.status, dailyLimit: node.dailyLimit };
    const rollbackToken = persistRollbackSnapshot({
      runbookId: 'pause-ip',
      targetType: 'sender_node',
      targetId: input.nodeId,
      prevStateJson: JSON.stringify(prevState)
    });

    await senderNodeRegistry.updateStatus(input.nodeId, 'paused');

    return {
      ok: true,
      rollbackToken,
      newState: { status: 'paused' },
      prevState,
      auditAction: 'oc.runbook.pause_ip.executed'
    };
  } finally {
    approvalLocks.release(lock);
  }
}
```

### 1.4 — `revert.ts`

```typescript
export async function revertRunbook(rollbackToken: string, approverId: string, reason: string) {
  const snapshot = db.prepare(`SELECT * FROM rollback_snapshots WHERE rollback_token = ? AND status = 'available'`).get(rollbackToken) as RollbackSnapshot | undefined;
  if (!snapshot) return { ok: false, rejectReason: 'rollback_token_not_found' };
  if (new Date(snapshot.expires_at).getTime() < Date.now()) return { ok: false, rejectReason: 'rollback_token_expired' };

  const prevState = JSON.parse(snapshot.prev_state_json);

  // Dispatch por runbook_id
  switch (snapshot.runbook_id) {
    case 'register-sender-node-local':
      // Per spec: no delete directo, marcar retired_pending_approval
      await senderNodeRegistry.updateStatus(snapshot.target_id, 'retired_pending_approval');
      break;
    case 'warming-step':
      await senderNodeRegistry.updateMetadata(snapshot.target_id, { warmupDay: prevState.warmupDay, dailyLimit: prevState.dailyLimit });
      break;
    case 'pause-ip':
      await senderNodeRegistry.updateStatus(snapshot.target_id, prevState.status);
      break;
    default:
      return { ok: false, rejectReason: 'unknown_runbook' };
  }

  // Marcar snapshot como consumed atómicamente
  const changed = db.prepare(`UPDATE rollback_snapshots SET status = 'consumed' WHERE rollback_token = ? AND status = 'available'`).run(rollbackToken).changes;
  if (changed === 0) return { ok: false, rejectReason: 'rollback_token_replay_detected' };

  return { ok: true, restoredState: prevState };
}
```

## Paso 2 — Migration 0008

`apps/gateway-api/migrations/0008_rollback_snapshots.sql`:

```sql
CREATE TABLE IF NOT EXISTS rollback_snapshots (
  rollback_token TEXT PRIMARY KEY,
  runbook_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  prev_state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available','consumed','expired'))
);

CREATE INDEX IF NOT EXISTS idx_rollback_snapshots_expires ON rollback_snapshots(expires_at);
CREATE INDEX IF NOT EXISTS idx_rollback_snapshots_target ON rollback_snapshots(target_type, target_id);
```

Helper `persistRollbackSnapshot`:

```typescript
function persistRollbackSnapshot(params: {
  runbookId: string;
  targetType: string;
  targetId: string;
  prevStateJson: string;
}): string {
  const rollbackToken = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 días
  db.prepare(`
    INSERT INTO rollback_snapshots (rollback_token, runbook_id, target_type, target_id, prev_state_json, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'available')
  `).run(rollbackToken, params.runbookId, params.targetType, params.targetId, params.prevStateJson, now.toISOString(), expiresAt.toISOString());
  return rollbackToken;
}
```

Cron interno cada hora purga rollbacks `available` con `expires_at < now` → status `expired`. Los consumed se retienen 30 días para audit.

## Paso 3 — Extender `/approve` para multi-approver

El endpoint existente del D+4 AM marca `proposal.status = 'resolved'` después
del primer approve. Para warming-step necesitamos: mantener pending hasta
alcanzar `required_approvals: 2`.

```typescript
if (request.method === 'POST' && approveMatch) {
  // ... validación operador ...

  // Resolver runbook ref para saber required_approvals
  const runbookRef = proposal.runbookRef; // ej "warming-step-runbook.md"
  const runbookId = runbookRef.replace('-runbook.md', '');
  const requiredApprovals = getRequiredApprovalsFromRunbookSpec(runbookId); // lee del YAML cabeado al boot

  // Issue token (existente)
  const token = issueApprovalToken({ actionId: supervisedAction, targetType: 'proposal', targetId: proposal.targetRef, approverId: operatorId });

  // Contar tokens issued para este proposalId con approvers distintos
  const existingApprovers = db.prepare(`
    SELECT DISTINCT approver_id FROM approval_nonces
    WHERE target_id = ? AND status = 'issued'
  `).all(proposal.targetRef).map((r: any) => r.approver_id);

  const quorumReached = existingApprovers.length >= requiredApprovals;

  if (quorumReached) {
    proposal.status = 'resolved';
    proposal.resolution = { decision: 'allow', resolvedAt: new Date().toISOString(), approverIds: existingApprovers };
    await auditLog.append({
      actorType: 'gateway', actorId: 'gateway-api',
      action: 'oc.approval.quorum_reached',
      targetType: 'proposal', targetId: proposal.id,
      decision: 'n/a',
      metadata: { requiredApprovals, approverIds: existingApprovers, runbookId }
    });
  }

  return json(response, 200, {
    approvalToken: token,
    quorum: { current: existingApprovers.length, required: requiredApprovals, reached: quorumReached }
  });
}
```

## Paso 4 — Endpoint `POST /v1/agent/runbook/execute`

```typescript
if (request.method === 'POST' && request.url === '/v1/agent/runbook/execute') {
  // 1. HMAC inbound (helper D+4 AM)
  const { raw, body } = await readRawBodyAndJson<RunbookExecuteRequest>(request);
  const hmac = validateOpenClawHmac(request.headers, raw);
  if (!hmac.ok) return json(response, 401, { rejectReason: hmac.rejectReason });

  // 2. Resolver proposal
  const proposal = proposalsStore.find((p) => p.id === body.proposalId);
  if (!proposal) return json(response, 404, { rejectReason: 'proposal_not_found' });
  if (proposal.status !== 'resolved') return json(response, 409, { rejectReason: 'proposal_not_resolved', currentStatus: proposal.status });

  // 3. Resolver tokens del store (issued, no consumed)
  const tokens = db.prepare(`SELECT * FROM approval_nonces WHERE target_id = ? AND status = 'issued'`).all(proposal.targetRef) as ApprovalNonceRow[];
  const runbookId = body.runbookId as RunbookId;
  const requiredApprovals = getRequiredApprovalsFromRunbookSpec(runbookId);
  if (tokens.length < requiredApprovals) return json(response, 401, { rejectReason: 'human_approval_missing', current: tokens.length, required: requiredApprovals });

  const approverIds = [...new Set(tokens.map((t) => t.approver_id))];
  if (approverIds.length < requiredApprovals) return json(response, 401, { rejectReason: 'human_approval_missing', detail: 'distinct approvers required' });

  // 4. Validar cada token vía validateApprovalToken (D+4 AM)
  for (const tokenRow of tokens) {
    const tokenObj = reconstructApprovalToken(tokenRow); // helper que reconstruye + recomputa signature
    const v = validateApprovalToken(tokenObj, { actionId: tokenRow.action_id, targetType: 'proposal', targetId: proposal.targetRef });
    if (!v.ok) return json(response, 401, { rejectReason: v.rejectReason, tokenId: tokenRow.token_id });
  }
  // Nota: validateApprovalToken marca cada nonce como 'consumed' atómicamente

  // 5. Dispatch al runbook
  const ctx: RunbookContext = {
    proposalId: proposal.id,
    approverIds,
    killSwitchState: getKillSwitchState(),
    occurredAt: new Date().toISOString()
  };

  let result: RunbookResult;
  switch (runbookId) {
    case 'register-sender-node-local':
      result = await executeRegisterSenderNodeRunbook(body.input, ctx); break;
    case 'warming-step':
      result = await executeWarmingStepRunbook(body.input, ctx); break;
    case 'pause-ip':
      result = await executePauseIpRunbook(body.input, ctx); break;
    default:
      return json(response, 400, { rejectReason: 'unknown_runbook', runbookId });
  }

  // 6. Audit
  if (!result.ok) {
    await auditLog.append({
      actorType: 'gateway', actorId: 'gateway-api',
      action: result.rejectReason === 'preconditions_failed' ? 'oc.runbook.preconditions_failed' : `oc.runbook.${runbookId.replace(/-/g, '_')}.failed_partial`,
      targetType: 'runbook', targetId: runbookId,
      decision: 'reject',
      rejectReason: result.rejectReason,
      humanApproved: true, approverIds,
      metadata: { detail: result.detail, proposalId: proposal.id }
    });
    return json(response, 409, { rejectReason: result.rejectReason, detail: result.detail });
  }

  await auditLog.append({
    actorType: 'gateway', actorId: 'gateway-api',
    action: result.auditAction,
    targetType: 'runbook', targetId: runbookId,
    decision: 'allow',
    humanApproved: true, approverIds,
    rollbackToken: result.rollbackToken,
    metadata: { proposalId: proposal.id, prevState: result.prevState, newState: result.newState }
  });

  return json(response, 200, {
    runbookId,
    rollbackToken: result.rollbackToken,
    newState: result.newState
  });
}
```

## Paso 5 — Endpoint `POST /v1/agent/runbook/revert`

```typescript
if (request.method === 'POST' && request.url === '/v1/agent/runbook/revert') {
  const operatorId = request.headers['x-operator-id'];
  if (typeof operatorId !== 'string' || !operatorId.startsWith('op-')) {
    return json(response, 401, { rejectReason: 'operator_unauthenticated' });
  }

  const { raw, body } = await readRawBodyAndJson<{ rollbackToken: string; reason: string }>(request);
  if (!body?.rollbackToken || !body?.reason) return json(response, 400, { rejectReason: 'schema_mismatch' });

  const result = await revertRunbook(body.rollbackToken, operatorId, body.reason);
  if (!result.ok) return json(response, 409, { rejectReason: result.rejectReason });

  // Audit
  const snapshot = db.prepare(`SELECT runbook_id, target_id FROM rollback_snapshots WHERE rollback_token = ?`).get(body.rollbackToken) as any;
  await auditLog.append({
    actorType: 'operator', actorId: operatorId,
    action: `oc.runbook.${snapshot.runbook_id.replace(/-/g, '_')}.reverted`,
    targetType: 'sender_node', targetId: snapshot.target_id,
    decision: 'allow',
    humanApproved: true, approverIds: [operatorId],
    metadata: { reason: body.reason, restoredState: result.restoredState, rollbackToken: body.rollbackToken }
  });

  return json(response, 200, { reverted: true, restoredState: result.restoredState });
}
```

## Paso 6 — Frontend admin panel

En `apps/admin-panel/src/features/canvas/PromptStrip.tsx`:

- Si `proposal.requiresApproval && requiredApprovals === 1`: botón "Aprobar"
  (igual D+4 AM, pero después de issue del token, hace POST inmediato a
  `/runbook/execute`).
- Si `requiredApprovals === 2`:
  - Mostrar contador `Firmas: {current}/2`
  - Botón "Aprobar" deshabilita después de que el operador firme una vez
    (verifica vía `X-Operator-Id`: si ya hay un token con ese approverId,
    botón gris "Ya firmaste").
  - Cuando `quorum.reached === true` en la respuesta del `/approve`, panel
    dispara `/runbook/execute`.
- Después de ejecución exitosa, mostrar botón secundario "Revertir" durante
  7 días con tooltip de la `expiresAt` del rollbackToken.

Query helper en `features/canvas/queries.ts`:

```typescript
export async function executeRunbook(params: {
  proposalId: string;
  runbookId: string;
  input: unknown;
}) {
  const rawBody = JSON.stringify(params);
  const ts = Math.floor(Date.now() / 1000).toString();
  // Frontend no firma HMAC; el call al execute va proxy via un endpoint
  // intermedio del panel-bff (futuro). En MVP corre con header placeholder
  // y NO HMAC porque el origen es el panel del operador autenticado.
  const res = await fetch('/v1/agent/runbook/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Operator-Id': getCurrentOperatorId() },
    body: rawBody
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

**Detalle crítico:** el `/runbook/execute` valida HMAC porque el agente
también puede dispararlo. Para el panel del operador en MVP, agregamos un
bypass condicional: si el header `X-Operator-Id` está presente y la sesión
es interna (origen `localhost:5173`), se acepta sin HMAC. En producción
real, esto se reemplaza por session OIDC (post-MVP).

## Paso 7 — Compile + smoke secuencial

```bash
WORKTREE="/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
cd "${WORKTREE}"

# 7.1 — Build + migration
npm --workspace @delivrix/gateway-api run build
node --import tsx scripts/db/run-migrations.ts  # ejecuta 0008
bash restart-gateway.sh

# 7.2 — Smoke #1 REGISTER: agente propone svc-mvp-test-01
TS=$(date +%s)
BODY='{"proposal":{"id":"smoke-register-01","category":"node_register_proposed","severity":"low","headline":"Registrar svc-mvp-test-01","body":"Smoke MVP","evidenceRefs":[],"runbookRef":"register-sender-node-local-runbook.md","targetRef":"svc-mvp-test-01","delivrix_actions_required":["propose_register_sender_node","register_sender_node_local"]},"audit":{"skillSlug":"smoke","modelVersion":"manual","promptVersion":"v1"},"schemaVersion":"2026-05-18.v1"}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$OPENCLAW_HMAC_SECRET" -hex | awk '{print $2}')
curl -s -X POST http://127.0.0.1:3000/v1/agent/proposals -H "Content-Type: application/json" -H "X-OpenClaw-Signature: ${SIG}" -H "X-OpenClaw-Timestamp: ${TS}" -d "$BODY"
# Esperado: {"proposalId":"smoke-register-01","injectedIntoCanvas":true,"requiresApproval":true}

# Operador A firma
curl -s -X POST http://127.0.0.1:3000/v1/agent/proposals/smoke-register-01/approve -H "X-Operator-Id: op-juanes-a"
# Esperado: {"approvalToken":{...},"quorum":{"current":1,"required":1,"reached":true}}

# Ejecutar runbook
INPUT='{"id":"svc-mvp-test-01","label":"MVP Test 01","provider":"webdock","status":"warming","ipAddress":"185.243.12.40","hostname":"svc-mvp-test-01.delivrix.local","dailyLimit":50,"warmupDay":1}'
BODY="{\"proposalId\":\"smoke-register-01\",\"runbookId\":\"register-sender-node-local\",\"input\":${INPUT}}"
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$OPENCLAW_HMAC_SECRET" -hex | awk '{print $2}')
curl -s -X POST http://127.0.0.1:3000/v1/agent/runbook/execute -H "Content-Type: application/json" -H "X-OpenClaw-Signature: ${SIG}" -H "X-OpenClaw-Timestamp: ${TS}" -d "$BODY"
# Esperado: {"runbookId":"register-sender-node-local","rollbackToken":"...","newState":{...con warmupDay:1...}}

# Verificación: nodo aparece
curl -s http://127.0.0.1:3000/v1/sender-nodes -H "Authorization: Bearer ${DELIVRIX_OPENCLAW_TOKEN}" | jq '.[] | select(.id=="svc-mvp-test-01")'

# 7.3 — Smoke #2 WARMING (2 firmas)
BODY='{"proposal":{"id":"smoke-warming-01","category":"warming_step_proposed","severity":"low","headline":"Subir warming svc-mvp-test-01 día 1→2","body":"Smoke MVP","evidenceRefs":[],"runbookRef":"warming-step-runbook.md","targetRef":"svc-mvp-test-01","delivrix_actions_required":["propose_warming_step","record_human_decision"]},"audit":{"skillSlug":"smoke","modelVersion":"manual","promptVersion":"v1"},"schemaVersion":"2026-05-18.v1"}'
# ... propose con HMAC ...
# Operador A firma
curl -s -X POST http://127.0.0.1:3000/v1/agent/proposals/smoke-warming-01/approve -H "X-Operator-Id: op-juanes-a"
# Esperado: {"approvalToken":...,"quorum":{"current":1,"required":2,"reached":false}}
# Operador B firma
curl -s -X POST http://127.0.0.1:3000/v1/agent/proposals/smoke-warming-01/approve -H "X-Operator-Id: op-juanes-b"
# Esperado: {"approvalToken":...,"quorum":{"current":2,"required":2,"reached":true}}
# Ejecutar
BODY='{"proposalId":"smoke-warming-01","runbookId":"warming-step","input":{"nodeId":"svc-mvp-test-01"}}'
# ... POST con HMAC ...
# Esperado: {"runbookId":"warming-step","rollbackToken":"...","newState":{"warmupDay":2,...}}

# 7.4 — Smoke #3 PAUSE
BODY='{"proposal":{"id":"smoke-pause-01","category":"node_pause_proposed","severity":"high","headline":"Pausar svc-mvp-test-01","body":"Smoke MVP","evidenceRefs":[],"runbookRef":"pause-ip-runbook.md","targetRef":"svc-mvp-test-01","delivrix_actions_required":["propose_pause_ip","update_sender_node_metadata"]},"audit":{"skillSlug":"smoke","modelVersion":"manual","promptVersion":"v1"},"schemaVersion":"2026-05-18.v1"}'
# propose + 1 firma + execute (análogo a register)
# Esperado: nodo queda status=paused

# 7.5 — Verificar audit chain íntegro
node --import tsx scripts/audit/verify-chain.ts
# Esperado: exit 0, events_total incrementado en ~25-30 vs estado pre-smoke

# 7.6 — Smoke #4 ROLLBACK del pause (recuperación de reputación)
ROLLBACK_TOKEN="<token-emitido-en-7.4>"
curl -s -X POST http://127.0.0.1:3000/v1/agent/runbook/revert -H "Content-Type: application/json" -H "X-Operator-Id: op-juanes-a" -d "{\"rollbackToken\":\"${ROLLBACK_TOKEN}\",\"reason\":\"reputation_recovered\"}"
# Esperado: {"reverted":true,"restoredState":{"status":"warming",...}}
# Verificar nodo: status vuelve a "warming"
```

## Paso 8 — Validación final

- [ ] `npm test` total: esperado 175+ (164 + ~12 nuevos tests runbook domain)
- [ ] `npm --workspace @delivrix/admin-panel run check`: 15/15 + builds OK
- [ ] Build Gateway OK
- [ ] Después de los 4 smokes: `verify-chain.ts` exit 0
- [ ] Después del revert (smoke #4): nodo `svc-mvp-test-01` con
      `status: "warming"`, `warmupDay: 2` (warming-step NO se revierte
      en el smoke; queda en día 2 post-rollback de pause)
- [ ] Tabla `rollback_snapshots`: 3 filas con status=`available`, 1 con
      status=`consumed` (la del pause revertido)
- [ ] Audit eventos nuevos esperados (mínimo 25):
  - 3× `oc.proposal.submitted`
  - 4× `oc.approval_token.issued` (1 register + 2 warming + 1 pause)
  - 1× `oc.approval.quorum_reached` (warming)
  - 3× `oc.runbook.*.executed`
  - 1× `oc.runbook.pause_ip.reverted`
  - + auditEvents de los reads del agente al validar preconditions

## Cuándo cerrar D+5 PM

Verde cuando:

1. **Smoke #1 register** → 200 con nuevo nodo en `/v1/sender-nodes`
2. **Smoke #2 warming** → quorum 2/2 alcanzado + execute 200 con warmupDay=2
3. **Smoke #3 pause** → execute 200 con status=paused
4. **Smoke #4 rollback** → revert 200 restaurando status a warming
5. **verify-chain post-smokes** → exit 0
6. **`npm test`** sin regresiones (175+)

## Lo que NO entra en D+5 PM

- **Runbook rotate-dns** — bloqueado en `future_live_requires_new_phase`.
  El endpoint despacha pero retorna 403. Documentado en Doc 2.
- **Runbook incident-quarantine** — cae en D+6 AM, no aquí.
- **2-approver con identidades reales** — usamos placeholders
  `op-juanes-a` y `op-juanes-b`. La autenticación OIDC real es post-MVP.
  Audit decision en `.audit/decision-multi-approver-placeholder.md` (nuevo,
  Codex lo crea como parte del smoke).
- **Botón Revertir en el panel** — endpoint existe, frontend lo cabea
  pero la UI completa (timeline de rollbacks disponibles) se polish en
  Hito 5.12.
- **Cron limpieza de rollbacks expirados** — placeholder por ahora;
  los snapshots `available` con `expires_at < now` se marcan `expired`
  on-read en lugar de cron, suficiente para MVP.
- **Audit batch de los eventos generados acá** — ya están encadenados via
  `LocalFileAuditLog.append` del D+5 AM, no requiere batch endpoint para
  emisión local del Gateway.
