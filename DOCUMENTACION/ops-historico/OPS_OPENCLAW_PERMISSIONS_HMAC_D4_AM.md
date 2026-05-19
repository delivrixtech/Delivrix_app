# OPS · D+4 AM — Permissions pipeline + HMAC ApprovalToken

> Cronograma: D+4 AM del `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`.
> Pre-requisitos: D+3 PM cerrado (canvas.prompt visible con propuesta del agente).
> Construye sobre: `OPENCLAW_PERMISSIONS_MATRIX.md` §4, `OPENCLAW_DELIVRIX_API_CONTRACT.md` §4.3.
> Decisiones del operador (chat 2026-05-18):
> 1. HMAC solo en endpoints de escritura. Reads siguen con Bearer dev.
> 2. ApprovalToken TTL 5 min, nonce SQLite persistente en Gateway.
> 3. Toda propuesta `supervised_local_state` aparece con `requiresApproval: true` (cero auto-firma).

## Objetivo

Cerrar el **primer gate duro** entre el agente y el Gateway. Hasta D+3 PM el
contrato era confiar en un Bearer hardcodeado (dev-token). En D+4 AM
reemplazamos eso por HMAC firmado por request + pipeline completo de la
Permissions Matrix + emisión de `ApprovalToken` con TTL corto y anti-replay
persistente.

Tres piezas técnicas:

1. **HMAC inbound del agente** (`X-OpenClaw-Signature` + `X-OpenClaw-Timestamp`)
   en POST `/v1/agent/proposals` y POST `/v1/agent/audit` (batch viene en D+5
   AM, pero dejamos el helper listo). TTL de timestamp 60s contra replay
   trivial.
2. **Pipeline `evaluateOpenClawActionPermission`** cabeado al submission del
   Gateway. Rechazo tipado por `RejectReason` con HTTP status alineado a la
   tabla Doc 2 §4.2. Honra `prohibited`, `future_live_requires_new_phase`,
   `supervised_local_state` (marca `requiresApproval: true` pero NO ejecuta).
3. **ApprovalToken** emitido cuando el operador firma "Aprobar" en el panel.
   HMAC-SHA256, TTL 5 min, nonce persistido en SQLite (tabla
   `approval_nonces`). Anti-replay: dos consumos del mismo nonce → 409
   `approval_replay_detected`.

## Entregables verificables

- [ ] Helper `validateOpenClawHmac(req)` en `apps/gateway-api/src/security/hmac.ts`
- [ ] Helper `issueApprovalToken(...)` + `validateApprovalToken(token, ctx)`
      en `apps/gateway-api/src/security/approval-token.ts`
- [ ] Migration SQLite `0007_approval_nonces.sql` con índice por `expires_at`
- [ ] POST `/v1/agent/proposals` migrado de Bearer a HMAC + pipeline matrix
- [ ] POST `/v1/agent/proposals/:id/approve` nuevo (panel-facing, requiere
      session cookie operador; MVP usa header `X-Operator-Id` placeholder)
- [ ] Plugin TS `drift-monitor` firma requests con HMAC compartido
- [ ] Plugin TS `alert-ops` firma requests con HMAC compartido (cuando el
      side-effect Notion está skippeado, sigue auditando vía endpoint Gateway
      → HMAC requerido)
- [ ] Frontend admin panel: botón secundario "Aprobar" en PromptStrip cuando
      `proposal.requiresApproval === true`
- [ ] Tests unitarios en `apps/gateway-api/src/security/hmac.test.ts` (5+):
      sin firma, timestamp drift, body tamper, firma válida, replay nonce
- [ ] Tests unitarios en `packages/domain/src/openclaw-runbook.test.ts` que
      ejerciten `prohibited_action`, `live_blocked_hito_5_11_b`,
      `supervised_local_state → requiresApproval: true`
- [ ] Audit: `oc.hmac.validated.ok` / `oc.hmac.validated.fail`,
      `oc.permission.rejected`, `oc.proposal.approved`,
      `oc.approval_token.issued`, `oc.approval_token.consumed`

## Paso 1 — Generar `OPENCLAW_HMAC_SECRET`

Secret compartido Gateway ↔ container OpenClaw. Diferente del
`DELIVRIX_OPENCLAW_TOKEN` Bearer dev (que sigue usándose para reads).

```bash
# 1.1 — Generar
HMAC_SECRET=$(openssl rand -hex 64)

# 1.2 — Inyectar en Gateway local (.env.local del worktree)
WORKTREE="/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
echo "OPENCLAW_HMAC_SECRET=${HMAC_SECRET}" >> "${WORKTREE}/.env.local"

# 1.3 — Inyectar en container OpenClaw (mismo valor)
ssh root@2.24.223.240
 export OC_HMAC='<mismo-valor>'
docker exec openclaw-dtsf-openclaw-1 sh -c "
  if grep -q '^OPENCLAW_HMAC_SECRET=' /etc/openclaw/skills.env 2>/dev/null; then
    sed -i 's|^OPENCLAW_HMAC_SECRET=.*|OPENCLAW_HMAC_SECRET='\"\$OC_HMAC\"'|' /etc/openclaw/skills.env
  else
    echo \"OPENCLAW_HMAC_SECRET=\$OC_HMAC\" >> /etc/openclaw/skills.env
  fi
"
unset OC_HMAC
exit
```

**Norte:** el secret NO va al repo. Si Codex lo escribe a `.env.local` por error,
verificar que `.env.local` está en `.gitignore`.

## Paso 2 — Helper HMAC en Gateway

Crear `apps/gateway-api/src/security/hmac.ts`:

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.OPENCLAW_HMAC_SECRET ?? '';
const TIMESTAMP_TOLERANCE_SEC = 60;

export type HmacRejectReason =
  | 'hmac_missing'
  | 'hmac_timestamp_drift'
  | 'hmac_invalid'
  | 'hmac_secret_unconfigured';

export interface HmacValidation {
  ok: boolean;
  rejectReason?: HmacRejectReason;
}

/**
 * Valida X-OpenClaw-Signature contra el body raw + timestamp.
 * Canonical payload: `${timestamp}.${rawBody}`
 * Algoritmo: HMAC-SHA256(secret, canonical) → hex
 */
export function validateOpenClawHmac(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string
): HmacValidation {
  if (!SECRET) return { ok: false, rejectReason: 'hmac_secret_unconfigured' };

  const sig = headers['x-openclaw-signature'];
  const ts = headers['x-openclaw-timestamp'];
  if (typeof sig !== 'string' || typeof ts !== 'string') {
    return { ok: false, rejectReason: 'hmac_missing' };
  }

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, rejectReason: 'hmac_missing' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > TIMESTAMP_TOLERANCE_SEC) {
    return { ok: false, rejectReason: 'hmac_timestamp_drift' };
  }

  const canonical = `${ts}.${rawBody}`;
  const expected = createHmac('sha256', SECRET).update(canonical).digest('hex');

  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) {
    return { ok: false, rejectReason: 'hmac_invalid' };
  }
  if (!timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, rejectReason: 'hmac_invalid' };
  }

  return { ok: true };
}
```

**Detalle clave:** `readJson` actual del Gateway consume el stream. Hay que
capturar el `rawBody` antes de parsearlo. Codex va a tener que añadir un
wrapper:

```typescript
async function readRawBodyAndJson<T>(request): Promise<{ raw: string; body: T | null }> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return { raw, body: JSON.parse(raw) as T };
  } catch {
    return { raw, body: null };
  }
}
```

Reemplazar las 3 llamadas existentes a `readJson` por este wrapper.

## Paso 3 — Migration SQLite + tabla `approval_nonces`

Crear `apps/gateway-api/migrations/0007_approval_nonces.sql`:

```sql
CREATE TABLE IF NOT EXISTS approval_nonces (
  nonce TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued','consumed','expired')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_nonces_expires
  ON approval_nonces(expires_at);

CREATE INDEX IF NOT EXISTS idx_approval_nonces_action_target
  ON approval_nonces(action_id, target_type, target_id);
```

Cron interno del Gateway (cada 60s) borra filas con `expires_at < now` y
`status != 'consumed'` para mantener la tabla acotada. Las `consumed` se
retienen 24h para audit cross-reference.

## Paso 4 — Helper ApprovalToken

Crear `apps/gateway-api/src/security/approval-token.ts`:

```typescript
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { db } from '../db.js';

const SECRET = process.env.OPENCLAW_HMAC_SECRET ?? '';
const TTL_SEC = 5 * 60; // 5 min — decisión operador D+4 AM

export type TokenRejectReason =
  | 'token_signature_invalid'
  | 'token_expired'
  | 'token_nonce_unknown'
  | 'token_replay_detected'
  | 'token_target_mismatch';

export interface ApprovalToken {
  tokenId: string;
  actionId: string;
  targetType: string;
  targetId: string;
  approverId: string;
  issuedAt: string;   // ISO
  expiresAt: string;  // ISO
  nonce: string;      // 32 bytes hex
  signature: string;  // HMAC-SHA256(canonicalJSON(token sin signature))
}

function canonicalize(t: Omit<ApprovalToken, 'signature'>): string {
  // Orden alfabético deterministico
  return JSON.stringify({
    actionId: t.actionId,
    approverId: t.approverId,
    expiresAt: t.expiresAt,
    issuedAt: t.issuedAt,
    nonce: t.nonce,
    targetId: t.targetId,
    targetType: t.targetType,
    tokenId: t.tokenId
  });
}

export function issueApprovalToken(params: {
  actionId: string;
  targetType: string;
  targetId: string;
  approverId: string;
}): ApprovalToken {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + TTL_SEC * 1000);
  const base = {
    tokenId: randomUUID(),
    actionId: params.actionId,
    targetType: params.targetType,
    targetId: params.targetId,
    approverId: params.approverId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: randomBytes(32).toString('hex')
  };
  const signature = createHmac('sha256', SECRET).update(canonicalize(base)).digest('hex');

  // Persistir en SQLite con status='issued'
  db.prepare(`
    INSERT INTO approval_nonces (nonce, token_id, action_id, target_type, target_id, approver_id, status, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?)
  `).run(
    base.nonce, base.tokenId, base.actionId, base.targetType, base.targetId,
    base.approverId, base.issuedAt, base.expiresAt
  );

  return { ...base, signature };
}

export function validateApprovalToken(
  token: ApprovalToken,
  ctx: { actionId: string; targetType: string; targetId: string }
): { ok: true } | { ok: false; rejectReason: TokenRejectReason } {
  // 1. Firma
  const expected = createHmac('sha256', SECRET).update(canonicalize(token)).digest('hex');
  const sigBuf = Buffer.from(token.signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, rejectReason: 'token_signature_invalid' };
  }

  // 2. Target match (defensa contra usar token de otra acción)
  if (
    token.actionId !== ctx.actionId ||
    token.targetType !== ctx.targetType ||
    token.targetId !== ctx.targetId
  ) {
    return { ok: false, rejectReason: 'token_target_mismatch' };
  }

  // 3. Expiración
  if (new Date(token.expiresAt).getTime() < Date.now()) {
    return { ok: false, rejectReason: 'token_expired' };
  }

  // 4. Nonce existe y status='issued'
  const row = db.prepare(
    `SELECT status FROM approval_nonces WHERE nonce = ?`
  ).get(token.nonce) as { status: string } | undefined;

  if (!row) return { ok: false, rejectReason: 'token_nonce_unknown' };
  if (row.status === 'consumed') return { ok: false, rejectReason: 'token_replay_detected' };
  if (row.status === 'expired') return { ok: false, rejectReason: 'token_expired' };

  // 5. Marcar consumed (atómico)
  const changed = db.prepare(
    `UPDATE approval_nonces SET status = 'consumed' WHERE nonce = ? AND status = 'issued'`
  ).run(token.nonce).changes;
  if (changed === 0) return { ok: false, rejectReason: 'token_replay_detected' };

  return { ok: true };
}
```

## Paso 5 — Migrar POST `/v1/agent/proposals` a HMAC + pipeline matrix

Reemplazar el bloque Bearer del D+3 PM por:

```typescript
if (request.method === 'POST' && request.url === '/v1/agent/proposals') {
  // 1. HMAC inbound
  const { raw, body } = await readRawBodyAndJson<AgentProposalRequest>(request);
  const hmac = validateOpenClawHmac(request.headers, raw);
  if (!hmac.ok) {
    await auditLog.append({
      actorType: 'openclaw',
      actorId: 'openclaw-hostinger-prod',
      action: 'oc.hmac.validated.fail',
      targetType: 'agent_request',
      targetId: 'proposals',
      riskLevel: 'medium',
      metadata: { rejectReason: hmac.rejectReason }
    });
    return json(response, 401, { rejectReason: hmac.rejectReason });
  }

  // 2. Schema
  if (!body || !body.proposal || !body.audit) {
    return json(response, 400, { rejectReason: 'schema_mismatch' });
  }

  // 3. Pipeline matrix (por cada acción declarada)
  const declared = body.proposal.delivrix_actions_required ?? [];
  for (const actionId of declared) {
    const decision = evaluateOpenClawActionPermission({
      actionId,
      actorId: 'openclaw-hostinger-prod',
      humanApproved: false,         // submission solo propone; approval viene en /approve
      approverIds: [],
      approvalTokens: [],
      killSwitchState: getKillSwitchState(),
      targetType: 'proposal',
      targetId: body.proposal.targetRef,
      occurredAt: new Date().toISOString(),
      schemaVersion: body.schemaVersion
    });

    if (decision.decision === 'reject') {
      // supervised_local_state cae acá con human_approval_missing — eso NO es
      // un rechazo terminal, lo dejamos pasar marcando requiresApproval.
      if (decision.rejectReason === 'human_approval_missing') continue;

      await auditLog.append({
        actorType: 'openclaw',
        actorId: 'openclaw-hostinger-prod',
        action: 'oc.permission.rejected',
        targetType: 'proposal',
        targetId: body.proposal.id,
        riskLevel: 'high',
        metadata: { actionId, rejectReason: decision.rejectReason, skillSlug: body.audit.skillSlug }
      });
      return json(response, httpStatusFor(decision.rejectReason), {
        rejectReason: decision.rejectReason,
        details: `Action ${actionId} blocked by matrix`
      });
    }
  }

  // 4. Categoría → requiresApproval flag
  const needsApproval = declared.some(
    (a) => matrixCategoryOf(a) === 'supervised_local_state'
  );

  // 5. Dedupe (heredado D+3 PM)
  const hash = hashProposal(body.proposal);
  const existing = findPendingProposalByHash(hash);
  if (existing) {
    return json(response, 200, {
      proposalId: existing.id,
      injectedIntoCanvas: true,
      duplicate: true,
      requiresApproval: existing.requiresApproval
    });
  }

  // 6. Persistir
  const now = new Date();
  const stored: StoredProposal = {
    ...body.proposal,
    receivedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    status: 'pending',
    requiresApproval: needsApproval
  };
  proposalsStore.push(stored);
  pruneExpiredProposals(now);

  // 7. Audit submission OK
  await auditLog.append({
    actorType: 'openclaw',
    actorId: 'openclaw-hostinger-prod',
    action: 'oc.proposal.submitted',
    targetType: 'proposal',
    targetId: body.proposal.id,
    riskLevel: body.proposal.severity === 'critical' ? 'high' : 'low',
    metadata: {
      category: body.proposal.category,
      requiresApproval: needsApproval,
      skillSlug: body.audit.skillSlug,
      modelVersion: body.audit.modelVersion,
      promptVersion: body.audit.promptVersion
    }
  });

  return json(response, 200, {
    proposalId: body.proposal.id,
    injectedIntoCanvas: true,
    requiresApproval: needsApproval
  });
}
```

Helpers a añadir si no existen:

- `httpStatusFor(reason)` — map directo de la tabla Doc 2 §4.2.
- `matrixCategoryOf(actionId)` — lookup contra el `MATRIX.get(actionId).category`.
- `getKillSwitchState()` — lee del store del Gateway (ya existe en H.20).
- `StoredProposal.requiresApproval: boolean` — agregar al type.

## Paso 6 — Endpoint nuevo POST `/v1/agent/proposals/:id/approve`

Panel-facing. NO usa HMAC del agente; usa session cookie del operador. MVP:
header placeholder `X-Operator-Id`.

```typescript
const approveMatch = request.url?.match(/^\/v1\/agent\/proposals\/([^\/]+)\/approve$/);
if (request.method === 'POST' && approveMatch) {
  const proposalId = approveMatch[1]!;

  // 1. Auth panel (MVP: header placeholder; D+5 cabea session real)
  const operatorId = request.headers['x-operator-id'];
  if (typeof operatorId !== 'string' || !operatorId.startsWith('op-')) {
    return json(response, 401, { rejectReason: 'operator_unauthenticated' });
  }

  // 2. Resolver propuesta
  const proposal = proposalsStore.find((p) => p.id === proposalId);
  if (!proposal) return json(response, 404, { rejectReason: 'proposal_not_found' });
  if (proposal.status !== 'pending') {
    return json(response, 409, { rejectReason: 'proposal_not_pending', currentStatus: proposal.status });
  }
  if (!proposal.requiresApproval) {
    return json(response, 400, { rejectReason: 'proposal_does_not_require_approval' });
  }

  // 3. Pipeline matrix con humanApproved=true para validar que sigue siendo elegible
  const supervisedAction = proposal.delivrix_actions_required.find(
    (a) => matrixCategoryOf(a) === 'supervised_local_state'
  )!;

  // 4. Emitir ApprovalToken
  const token = issueApprovalToken({
    actionId: supervisedAction,
    targetType: 'proposal',
    targetId: proposal.targetRef,
    approverId: operatorId
  });

  // 5. Mark proposal as approved (no ejecuta runbook todavía; eso en D+5)
  proposal.status = 'resolved';
  proposal.resolution = {
    decision: 'allow',
    resolvedAt: new Date().toISOString(),
    approverIds: [operatorId]
  };

  // 6. Audit
  await auditLog.append({
    actorType: 'operator',
    actorId: operatorId,
    action: 'oc.proposal.approved',
    targetType: 'proposal',
    targetId: proposal.id,
    riskLevel: 'medium',
    metadata: {
      approvalTokenId: token.tokenId,
      actionId: supervisedAction,
      targetRef: proposal.targetRef
    }
  });
  await auditLog.append({
    actorType: 'gateway',
    actorId: 'gateway-api',
    action: 'oc.approval_token.issued',
    targetType: 'approval_token',
    targetId: token.tokenId,
    riskLevel: 'medium',
    metadata: {
      actionId: supervisedAction,
      approverId: operatorId,
      expiresAt: token.expiresAt
    }
  });

  return json(response, 200, { approvalToken: token });
}
```

## Paso 7 — Plugin TS: firmar HMAC en `drift-monitor` y `alert-ops`

En `services/openclaw-skills/src/lib/gateway-client.ts` (o el módulo equivalente
del repo del plugin), añadir helper:

```typescript
import { createHmac } from 'node:crypto';

const HMAC_SECRET = process.env.OPENCLAW_HMAC_SECRET ?? '';

function sign(rawBody: string): { timestamp: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const canonical = `${timestamp}.${rawBody}`;
  const signature = createHmac('sha256', HMAC_SECRET).update(canonical).digest('hex');
  return { timestamp, signature };
}

export async function submitProposal(payload: AgentProposalRequest, baseUrl: string) {
  const rawBody = JSON.stringify(payload);
  const { timestamp, signature } = sign(rawBody);
  const res = await fetch(`${baseUrl}/v1/agent/proposals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-OpenClaw-Signature': signature,
      'X-OpenClaw-Timestamp': timestamp
    },
    body: rawBody
  });
  return { status: res.status, body: await res.json() };
}
```

Reemplazar las llamadas existentes en `drift-monitor` y `alert-ops` que hoy
mandan `Authorization: Bearer ${DELIVRIX_OPENCLAW_TOKEN}` por
`submitProposal(...)`.

## Paso 8 — Frontend admin panel: botón "Aprobar"

En `apps/admin-panel/src/features/canvas/PromptStrip.tsx`:

```tsx
{proposal.requiresApproval ? (
  <div className="flex gap-2">
    <Button variant="secondary" onClick={() => openDryRunReview(proposal)}>
      Revisar plan dry-run
    </Button>
    <Button variant="primary" onClick={() => approveProposal(proposal.id)}>
      Aprobar
    </Button>
  </div>
) : (
  <Button variant="secondary" onClick={() => openDryRunReview(proposal)}>
    Revisar plan dry-run
  </Button>
)}
```

`approveProposal` queda en `features/canvas/queries.ts`:

```typescript
export async function approveProposal(proposalId: string) {
  const res = await fetch(`/v1/agent/proposals/${proposalId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Operator-Id': getCurrentOperatorId()  // placeholder MVP
    }
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  // Mostrar toast "Aprobado · token listo para runbook (TTL 5min)"
  return data.approvalToken;
}
```

**No ejecuta el runbook todavía.** El token se guarda en estado local hasta
D+5 cuando se cabean los 3 runbooks (warming-step, pause-ip,
register-sender-node-local).

## Paso 9 — Compile + reload + smoke

```bash
# 9.1 — Compilar Gateway
cd "${WORKTREE}"
npm --workspace @delivrix/gateway-api run build

# 9.2 — Reiniciar Gateway local cargando el nuevo HMAC_SECRET
bash "${WORKTREE}/restart-gateway.sh"

# 9.3 — Compilar plugin OpenClaw
cd services/openclaw-skills
npm run build
docker cp dist/ openclaw-dtsf-openclaw-1:/opt/openclaw/skills/
ssh root@2.24.223.240 'docker exec openclaw-dtsf-openclaw-1 kill -HUP 1'

# 9.4 — Smoke 1: sin firma → 401
curl -i -X POST http://127.0.0.1:3000/v1/agent/proposals \
  -H "Content-Type: application/json" \
  -d '{}'
# Esperado: HTTP/1.1 401 {"rejectReason":"hmac_missing"}

# 9.5 — Smoke 2: firma válida, acción dry-run → 200 sin requiresApproval
TS=$(date +%s)
BODY='{"proposal":{"id":"smoke-dry","category":"node_pause_proposed","severity":"low","headline":"t","body":"t","evidenceRefs":[],"runbookRef":"pause-ip-runbook.md","targetRef":"svc-test","delivrix_actions_required":["evaluate_webdock_drift"]},"audit":{"skillSlug":"drift-monitor","modelVersion":"sonnet-4-6","promptVersion":"v1"},"schemaVersion":"2026-05-18.v1"}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex | awk '{print $2}')
curl -i -X POST http://127.0.0.1:3000/v1/agent/proposals \
  -H "Content-Type: application/json" \
  -H "X-OpenClaw-Signature: ${SIG}" \
  -H "X-OpenClaw-Timestamp: ${TS}" \
  -d "$BODY"
# Esperado: HTTP/1.1 200 {"proposalId":"smoke-dry","injectedIntoCanvas":true,"requiresApproval":false}

# 9.6 — Smoke 3: firma válida, acción supervised → 200 requiresApproval:true
BODY='{"proposal":{"id":"smoke-sup","category":"node_register_proposed","severity":"medium","headline":"t","body":"t","evidenceRefs":[],"runbookRef":"register-sender-node-local.md","targetRef":"svc-new","delivrix_actions_required":["register_sender_node_local"]},"audit":{"skillSlug":"drift-monitor","modelVersion":"sonnet-4-6","promptVersion":"v1"},"schemaVersion":"2026-05-18.v1"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex | awk '{print $2}')
curl -s -X POST http://127.0.0.1:3000/v1/agent/proposals \
  -H "Content-Type: application/json" \
  -H "X-OpenClaw-Signature: ${SIG}" \
  -H "X-OpenClaw-Timestamp: ${TS}" \
  -d "$BODY"
# Esperado: {"proposalId":"smoke-sup","injectedIntoCanvas":true,"requiresApproval":true}

# 9.7 — Smoke 4: aprobar la propuesta supervised
curl -s -X POST http://127.0.0.1:3000/v1/agent/proposals/smoke-sup/approve \
  -H "X-Operator-Id: op-juanes"
# Esperado: {"approvalToken":{"tokenId":"...","actionId":"register_sender_node_local","expiresAt":"...","signature":"..."}}

# 9.8 — Smoke 5: replay del mismo nonce (debe rechazar)
#       Reusar el token devuelto en 9.7 y enviarlo dos veces a un endpoint
#       que llame validateApprovalToken. Como aún no hay runbook cabeado,
#       hacerlo vía test unitario en lugar de curl.

# 9.9 — Smoke 6: acción prohibida → 403
BODY='{"proposal":{"id":"smoke-prohib","category":"node_pause_proposed","severity":"low","headline":"t","body":"t","evidenceRefs":[],"runbookRef":"x.md","targetRef":"x","delivrix_actions_required":["smtp_send_real_email"]},"audit":{"skillSlug":"drift-monitor","modelVersion":"sonnet-4-6","promptVersion":"v1"},"schemaVersion":"2026-05-18.v1"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex | awk '{print $2}')
curl -i -X POST http://127.0.0.1:3000/v1/agent/proposals \
  -H "Content-Type: application/json" \
  -H "X-OpenClaw-Signature: ${SIG}" \
  -H "X-OpenClaw-Timestamp: ${TS}" \
  -d "$BODY"
# Esperado: HTTP/1.1 403 {"rejectReason":"live_blocked_hito_5_11_b"} o "prohibited_action"
# (smtp_send_real_email está en future_live_requires_new_phase según matrix)
```

## Paso 10 — Validación final

- [ ] `npm test` (tests unitarios HMAC + matrix) — 148 → 155+ pass
- [ ] `npm --workspace @delivrix/admin-panel run check` — 15/15 pass
- [ ] Build Gateway OK
- [ ] Drift-monitor en container OpenClaw, post `kill -HUP`, ejecuta su cron y
      emite propuestas firmadas con HMAC. Verificable en audit JSONL local:
      `grep oc.hmac.validated.ok .audit/audit-events.jsonl | tail -5`
- [ ] Admin panel renderiza el botón "Aprobar" cuando
      `proposal.requiresApproval=true`. Verificable abriendo el panel y
      mirando una propuesta supervised (registro de nodo).
- [ ] Audit de `oc.proposal.approved` y `oc.approval_token.issued` presentes
      después de aprobar una propuesta desde el panel.
- [ ] SQLite `approval_nonces` tiene exactamente 1 fila por token emitido,
      status `issued` o `consumed`.

## Cuándo cerrar D+4 AM

D+4 AM se cierra verde cuando:

1. **HMAC inbound funcional** — los 3 smokes 9.4 → 9.6 pasan con los códigos esperados.
2. **Pipeline matrix activo** — 9.9 retorna 403, no 200.
3. **ApprovalToken emitido y persistido** — 9.7 devuelve el token y SQLite tiene la fila.
4. **Panel renderiza "Aprobar"** — verificación visual operador.

Si los 4 salen verdes, queda listo para **D+4 PM** (`delivrix-report-ops` con
respuesta por chat en lugar de Notion).

## Lo que NO entra en D+4 AM

- **Audit hash chain SHA-256** — eso es D+5 AM.
- **Ejecutar runbooks consumiendo ApprovalToken** — eso es D+5 PM
  (warming-step, pause-ip, register-sender-node-local).
- **Session cookie real del operador** — D+4 AM usa header placeholder
  `X-Operator-Id`. La sesión OIDC real cae en post-MVP.
- **Rate limiter** — pseudocódigo Doc 2 §4.1 lo menciona, pero la
  implementación real cae en Hito 5.12 cuando haya tráfico real del agente.
