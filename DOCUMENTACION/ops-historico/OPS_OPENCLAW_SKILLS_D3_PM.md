# OPS · D+3 PM — drift-monitor + POST /v1/agent/proposals + canvas.prompt visible

> Cronograma: D+3 PM del `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`.
> Pre-requisitos: D+3 AM cerrado (alert-ops cargado con fallback honesto).
> Construye sobre: `OPENCLAW_DELIVRIX_API_CONTRACT.md` §4.2, Doc 2,
> `DOCUMENTACION/skills/drift-monitor/SKILL.md`.

## Objetivo

Este es el milestone **más visual** del Hito 5.11.B. Después de este OPS,
el operador abre el admin panel → Canvas → y **ve una propuesta inyectada
por el agente** en el `prompt` strip de la pantalla.

Tres piezas técnicas:

1. **Endpoint privado `POST /v1/agent/proposals`** en el Gateway con auth
   Bearer `DELIVRIX_OPENCLAW_TOKEN`. NO expuesto al panel (bundle frontend
   sigue GET-only).
2. **Plugin TS `drift-monitor`** en container OpenClaw con cron interno
   cada 5 min + dedupe por hash `targetRef+category` (TTL 6h SQLite local).
3. **Visibilidad inmediata en el admin panel**: propuestas aterrizan en
   `canvas.prompt` que ya renderiza el frontend desde H.23.

## Entregables verificables

- [ ] Endpoint `POST /v1/agent/proposals` en `apps/gateway-api/src/main.ts`
- [ ] Persistencia in-memory en el Gateway (Map por sesión, TTL 1h)
- [ ] `buildOpenClawLiveCanvas` modificado: devuelve `canvas.prompt` desde el
      store si hay propuesta agente, sino fallback a `buildPromptCard` local
- [ ] Plugin TS `drift-monitor` con scheduler cada 5 min
- [ ] Dedupe SQLite local en container (TTL 6h)
- [ ] Smoke real: el operador abre el admin panel → Canvas → ve la propuesta
      del agente en el prompt strip
- [ ] Audit `oc.skill.drift.invoke` + `oc.proposal.submitted` por cada call
- [ ] Si la propuesta es rechazada (acción no en matriz): audit
      `oc.proposal.rejected` con `rejectReason` del pipeline Doc 2 §4

## Paso 1 — Gateway: endpoint `POST /v1/agent/proposals`

Codex edita `apps/gateway-api/src/main.ts` para agregar:

```typescript
/* Hito 5.11.B D+3 PM — agent proposals endpoint privado */

interface AgentProposal {
  id: string;
  category:
    | 'node_pause_proposed'
    | 'node_resume_proposed'
    | 'node_register_proposed'
    | 'node_orphan_warning'
    | string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  headline: string;
  body: string;
  evidenceRefs: string[];
  runbookRef: string;
  targetRef: string;
  delivrix_actions_required: string[];
}

interface AgentProposalRequest {
  proposal: AgentProposal;
  audit: {
    skillSlug: string;
    modelVersion: string;
    promptVersion: string;
    tokensUsed?: number;
  };
  schemaVersion: '2026-05-18.v1';
}

// Store in-memory: por simplicidad MVP, lista única con TTL 1h.
// En producción moverla a Redis o store persistente.
interface StoredProposal extends AgentProposal {
  receivedAt: string;
  expiresAt: string;
  status: 'pending' | 'resolved' | 'expired';
  resolution?: { decision: 'allow' | 'reject'; resolvedAt: string; approverIds?: string[] };
}

const proposalsStore: StoredProposal[] = [];

function pruneExpiredProposals(now: Date) {
  const cutoff = now.getTime();
  for (let i = proposalsStore.length - 1; i >= 0; i--) {
    if (new Date(proposalsStore[i]!.expiresAt).getTime() < cutoff) {
      proposalsStore[i]!.status = 'expired';
    }
  }
}

function findPendingProposalByHash(hash: string): StoredProposal | undefined {
  return proposalsStore.find(
    (p) => p.status === 'pending' && hashProposal(p) === hash
  );
}

function hashProposal(p: { category: string; targetRef: string }): string {
  return createHash('sha256').update(`${p.category}|${p.targetRef}`).digest('hex').slice(0, 16);
}

// Token expected (MVP: hardcoded; D+4 AM lo migra a HMAC tokens reales)
const DELIVRIX_OPENCLAW_TOKEN = process.env.DELIVRIX_OPENCLAW_TOKEN ?? 'dev-token-d3pm';

if (request.method === 'POST' && request.url === '/v1/agent/proposals') {
  // 1. Auth Bearer
  const auth = request.headers.authorization ?? '';
  if (auth !== `Bearer ${DELIVRIX_OPENCLAW_TOKEN}`) {
    return json(response, 401, {
      rejectReason: 'auth_token_invalid',
      details: 'Bearer token missing or invalid'
    });
  }

  // 2. Parse body
  const body = await readJson<AgentProposalRequest>(request);
  if (!body || !body.proposal || !body.audit) {
    return json(response, 400, {
      rejectReason: 'schema_mismatch',
      details: 'Missing proposal or audit fields'
    });
  }

  // 3. Validar contra matriz (Doc 2 §4)
  const allowedActions = new Set([
    'propose_warming_step',
    'propose_pause_ip',
    'propose_rotate_dns',
    'propose_register_sender_node',
    'propose_quarantine',
    'generate_daily_report',
    'evaluate_webdock_drift'
  ]);

  const declared = body.proposal.delivrix_actions_required ?? [];
  const unknownAction = declared.find((a) => !allowedActions.has(a));
  if (unknownAction) {
    await auditLog.append({
      actorType: 'openclaw',
      actorId: 'openclaw-hostinger-prod',
      action: 'oc.proposal.rejected',
      targetType: 'proposal',
      targetId: body.proposal.id,
      riskLevel: 'medium',
      metadata: {
        rejectReason: 'unknown_action',
        unknownAction,
        skillSlug: body.audit.skillSlug
      }
    });
    return json(response, 400, {
      rejectReason: 'unknown_action',
      details: `Action ${unknownAction} not in matrix`
    });
  }

  // 4. Dedupe: si ya hay propuesta pending con mismo hash, no duplicar
  const hash = hashProposal(body.proposal);
  const existing = findPendingProposalByHash(hash);
  if (existing) {
    return json(response, 200, {
      proposalId: existing.id,
      injectedIntoCanvas: true,
      duplicate: true
    });
  }

  // 5. Persistir
  const now = new Date();
  const stored: StoredProposal = {
    ...body.proposal,
    receivedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), // 1h
    status: 'pending'
  };
  proposalsStore.push(stored);
  pruneExpiredProposals(now);

  // 6. Audit
  await auditLog.append({
    actorType: 'openclaw',
    actorId: 'openclaw-hostinger-prod',
    action: 'oc.proposal.submitted',
    targetType: 'proposal',
    targetId: body.proposal.id,
    riskLevel: body.proposal.severity === 'critical' ? 'high' : body.proposal.severity === 'high' ? 'medium' : 'low',
    metadata: {
      category: body.proposal.category,
      severity: body.proposal.severity,
      targetRef: body.proposal.targetRef,
      runbookRef: body.proposal.runbookRef,
      skillSlug: body.audit.skillSlug,
      modelVersion: body.audit.modelVersion,
      promptVersion: body.audit.promptVersion,
      tokensUsed: body.audit.tokensUsed
    }
  });

  return json(response, 200, {
    proposalId: body.proposal.id,
    injectedIntoCanvas: true
  });
}
```

Luego en `buildOpenClawLiveCanvas` (o donde compone el snapshot del canvas):

```typescript
// Modificación al builder del live-canvas para preferir propuestas
// recibidas del agente sobre las generadas por rules engine local.
const agentProposal = proposalsStore.find(
  (p) => p.status === 'pending' && new Date(p.expiresAt).getTime() > Date.now()
);

const promptCard = agentProposal
  ? mapStoredProposalToPromptCard(agentProposal)
  : buildPromptCard(nodes, blockedBy);  // fallback al rules engine local
```

## Paso 2 — Configurar `DELIVRIX_OPENCLAW_TOKEN`

```bash
# 2.1 — Generar token aleatorio (MVP simple; HMAC viene en D+4 AM)
TOKEN=$(openssl rand -hex 32)

# 2.2 — Inyectarlo al Gateway local (.env.local del worktree)
echo "DELIVRIX_OPENCLAW_TOKEN=${TOKEN}" >> "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/.env.local"

# 2.3 — Inyectarlo al container OpenClaw (mismo token)
ssh root@2.24.223.240
 export OC_TOKEN='<token-mismo>'
docker exec openclaw-dtsf-openclaw-1 sh -c "
  if grep -q '^DELIVRIX_OPENCLAW_TOKEN=' /etc/openclaw/skills.env 2>/dev/null; then
    sed -i 's|^DELIVRIX_OPENCLAW_TOKEN=.*|DELIVRIX_OPENCLAW_TOKEN='\"\$OC_TOKEN\"'|' /etc/openclaw/skills.env
  else
    echo \"DELIVRIX_OPENCLAW_TOKEN=\$OC_TOKEN\" >> /etc/openclaw/skills.env
  fi
"
unset OC_TOKEN
exit

# 2.4 — Restart Gateway local cargando el nuevo token
bash "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/restart-gateway.sh"

# 2.5 — Smoke del endpoint (sin autenticar → 401, autenticado → 200)
curl -i -X POST http://127.0.0.1:3000/v1/agent/proposals \
  -H "Content-Type: application/json" \
  -d '{"proposal":{"id":"test","category":"node_pause_proposed","severity":"medium","headline":"t","body":"t","evidenceRefs":[],"runbookRef":"pause-ip-runbook.md","targetRef":"svc-test","delivrix_actions_required":["propose_pause_ip"]},"audit":{"skillSlug":"test","modelVersion":"test","promptVersion":"test"},"schemaVersion":"2026-05-18.v1"}'
# Esperado: 401 (auth_token_invalid)

curl -i -X POST http://127.0.0.1:3000/v1/agent/proposals \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{...same...}'
# Esperado: 200 {"proposalId":"test","injectedIntoCanvas":true}
```

## Paso 3 — Plugin TS `drift-monitor` en container OpenClaw

```bash
docker exec -it openclaw-dtsf-openclaw-1 sh -c "
mkdir -p /openclaw/plugins/drift-monitor
mkdir -p /openclaw/state

cat > /openclaw/plugins/drift-monitor/index.ts <<'TS'
/**
 * Skill: drift-monitor
 * Doc: DOCUMENTACION/skills/drift-monitor/SKILL.md
 *
 * Cron 5 min: lee inventario Webdock vs registry local, identifica
 * drift, dedupe por hash, POSTea propuestas al Gateway para que
 * aparezcan en canvas.prompt.
 */

import { SkillDescriptor, SkillContext, SkillResult } from '@openclaw/skill-sdk';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DELIVRIX_BASE_URL = process.env.DELIVRIX_BASE_URL || 'http://172.16.0.1:3000';
const DELIVRIX_TOKEN = process.env.DELIVRIX_OPENCLAW_TOKEN || '';
const DEDUPE_PATH = '/openclaw/state/drift-dedupe.json';
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export const descriptor: SkillDescriptor = {
  slug: 'drift-monitor',
  version: '1.0.0',
  trigger: ['hay algo desalineado', 'drift', 'qué propone OpenClaw'],
  schedule: '*/5 * * * *',  // cron 5 min
  delivrixActions: [
    'read_webdock_inventory',
    'read_sender_nodes',
    'read_openclaw_live_canvas'
  ],
  returns: 'structured-markdown',
  auditIdPrefix: 'oc.skill.drift',
  fallback: 'rules-engine-local'
};

interface Dedupe { [hash: string]: { expiresAt: number; proposalId: string } }

async function loadDedupe(): Promise<Dedupe> {
  try {
    const raw = await fs.readFile(DEDUPE_PATH, 'utf-8');
    const data = JSON.parse(raw) as Dedupe;
    const now = Date.now();
    // Limpiar entradas expiradas
    for (const k of Object.keys(data)) {
      if (data[k]!.expiresAt < now) delete data[k];
    }
    return data;
  } catch { return {}; }
}

async function saveDedupe(d: Dedupe): Promise<void> {
  await fs.mkdir(path.dirname(DEDUPE_PATH), { recursive: true });
  await fs.writeFile(DEDUPE_PATH, JSON.stringify(d, null, 2));
}

function hashProposal(p: { category: string; targetRef: string }): string {
  return crypto.createHash('sha256').update(`\${p.category}|\${p.targetRef}`).digest('hex').slice(0, 16);
}

export async function handler(ctx: SkillContext): Promise<SkillResult> {
  const startMs = Date.now();

  // 1. Leer drift del Gateway (que ya incluye drift.proposals[])
  const res = await fetch(\`\${DELIVRIX_BASE_URL}/v1/webdock/inventory\`, {
    method: 'GET',
    signal: AbortSignal.timeout(8000)
  });
  const data = await res.json() as any;
  const proposals = data.drift?.proposals ?? [];

  // 2. Cargar dedupe local
  const dedupe = await loadDedupe();
  const now = Date.now();
  const newlySubmitted: string[] = [];
  const ignored: string[] = [];

  // 3. Por cada propuesta, decidir si POSTear o ignorar
  for (const p of proposals.slice(0, 10)) {  // max 10/run según Doc 3
    const hash = hashProposal({ category: p.category, targetRef: p.targetRef });

    if (dedupe[hash]) {
      ignored.push(p.id);
      continue;
    }

    // POST al Gateway
    const proposalReq = {
      proposal: {
        id: p.id,
        category: p.category,
        severity: p.severity,
        headline: p.headline,
        body: p.body,
        evidenceRefs: p.evidenceRefs ?? [],
        runbookRef: p.runbookRef,
        targetRef: p.targetRef,
        delivrix_actions_required: ['evaluate_webdock_drift']  // o el específico según categoría
      },
      audit: {
        skillSlug: descriptor.slug,
        modelVersion: 'us.anthropic.claude-sonnet-4-6',
        promptVersion: 'openclaw-prompt-v1.0'
      },
      schemaVersion: '2026-05-18.v1'
    };

    try {
      const postRes = await fetch(\`\${DELIVRIX_BASE_URL}/v1/agent/proposals\`, {
        method: 'POST',
        headers: {
          'Authorization': \`Bearer \${DELIVRIX_TOKEN}\`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(proposalReq),
        signal: AbortSignal.timeout(5000)
      });

      if (postRes.ok) {
        const body = await postRes.json();
        if (!body.duplicate) {
          dedupe[hash] = { expiresAt: now + DEDUPE_TTL_MS, proposalId: p.id };
          newlySubmitted.push(p.id);
        } else {
          ignored.push(p.id);
        }
      } else {
        await ctx.audit({
          action: 'oc.proposal.submit_failed',
          decision: 'reject',
          metadata: { proposalId: p.id, httpStatus: postRes.status }
        });
      }
    } catch (err) {
      await ctx.audit({
        action: 'oc.proposal.submit_failed',
        decision: 'reject',
        metadata: { proposalId: p.id, error: String(err) }
      });
    }
  }

  await saveDedupe(dedupe);

  const markdown = \`
## Drift — snapshot \${new Date().toISOString()}

**Total propuestas detectadas: \${proposals.length}**

### Inyectadas al canvas en este run
\${newlySubmitted.length > 0 ? newlySubmitted.map((id) => \`- \\\`\${id}\\\`\`).join('\\n') : '(ninguna nueva)'}

### Ignoradas (dedupe activo)
\${ignored.length > 0 ? ignored.map((id) => \`- \\\`\${id}\\\`\`).join('\\n') : '(ninguna)'}

_Evidencia_: oc.read.webdock#\${ctx.shortHash(JSON.stringify(data))}
\`.trim();

  await ctx.audit({
    action: \`\${descriptor.auditIdPrefix}.invoke\`,
    decision: 'allow',
    metadata: {
      skillSlug: descriptor.slug,
      durationMs: Date.now() - startMs,
      proposalsDetected: proposals.length,
      proposalsSubmitted: newlySubmitted.length,
      proposalsIgnored: ignored.length
    }
  });

  return { content: markdown, format: 'markdown' };
}
TS
echo 'ok: plugin drift-monitor escrito'
"
```

## Paso 4 — Compilar + reload + smoke

```bash
docker exec openclaw-dtsf-openclaw-1 sh -c '
  cd /openclaw/plugins/drift-monitor && npx tsc --noEmit index.ts 2>&1 | head -10
'
# Esperado: cero errores

docker exec openclaw-dtsf-openclaw-1 \
  sh -c "kill -HUP \$(pgrep -f 'node server.mjs' | head -1)"
sleep 5

# Trigger manual (no esperar al cron de 5 min)
GW_TOKEN=$(docker exec openclaw-dtsf-openclaw-1 \
  sh -c 'printenv GATEWAY_TOKEN || cat /openclaw/.gateway-token 2>/dev/null')

curl -X POST http://127.0.0.1:61175/api/chat.send \
  -H "Authorization: Bearer $GW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "agent:smoke:drift-trigger",
    "msgId": "smoke-drift-'$(date +%s)'",
    "message": { "role": "user", "content": "qué está desalineado?" }
  }'

sleep 10
docker exec openclaw-dtsf-openclaw-1 \
  curl -s -H "Authorization: Bearer $GW_TOKEN" \
    "http://127.0.0.1:18789/api/sessions/agent:smoke:drift-trigger/history" \
  | jq '.messages[-1].content'

# Esperado:
#   - Lista de proposalsSubmitted con al menos 1 ID
#   - audit oc.skill.drift.invoke con metadata completa
```

## Paso 5 — Validar visualmente en el admin panel

Acción del operador:

1. Abre el admin panel en el navegador.
2. Navega a la sección **Canvas**.
3. Espera el polling de 5s.
4. **Esperado**: aparece en el `prompt` strip del canvas (la cajita con
   gradient amber abajo del swimlane) una propuesta inyectada por el
   agente. Algo tipo:
   - Headline: "Servidor Webdock `svc-warmup-01` sin registro local"
   - Body: descripción del rules engine
   - Botón primario: "Revisar plan dry-run"
   - Botón secundario: "Posponer"

Si la propuesta aparece visualmente, **D+3 PM cerrado**.

Si no aparece:
- Verificar que `GET /v1/openclaw/live-canvas` devuelve `canvas.prompt`
  no null con el `nodeId` de la propuesta del agente (vs la propuesta
  generada localmente por rules engine).
- Validar el `buildOpenClawLiveCanvas` modificado en Paso 1.

## Paso 6 — Audit validation

```bash
# 6.1 — Audit del Gateway: ver propuestas aceptadas
tail -50 /Users/juanescanar/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de/.audit/*.jsonl \
  | grep '"oc.proposal' \
  | jq '{id, action, targetId, metadata}'

# 6.2 — Audit del agente: skill.drift.invoke
docker exec openclaw-dtsf-openclaw-1 \
  cat /openclaw/audit/local.jsonl 2>/dev/null \
  | grep '"oc.skill.drift' \
  | tail -5 \
  | jq '.'

# 6.3 — Verificar dedupe state
docker exec openclaw-dtsf-openclaw-1 cat /openclaw/state/drift-dedupe.json | jq .
# Esperado: hashes de las propuestas con expiresAt + 6h
```

## Reporte de cierre

```
============================================
  D+3 PM completado — drift-monitor + canvas
============================================
  Endpoint nuevo: POST /v1/agent/proposals
    Auth: Bearer DELIVRIX_OPENCLAW_TOKEN
    Persistence: in-memory store, TTL 1h
    Pipeline: valida acción contra matriz Doc 2

  Plugin nuevo: drift-monitor
    Cron: */5 * * * *
    Dedupe: SQLite local TTL 6h
    Max propuestas/run: 10

  Smoke real:
    proposalsDetected: <N>
    proposalsSubmitted: <N>
    canvasPromptVisible: yes/no

  Audit: oc.skill.drift.invoke, oc.proposal.submitted
============================================
```

## Próximos pasos

| Día | Milestone |
| --- | --- |
| D+4 AM | Permissions pipeline en Gateway + tokens HMAC (reemplaza el Bearer dev del Paso 2) |
| D+4 PM | Skill `delivrix-report-ops` con reporte por chat (Notion deferred, ver decision-skip-notion) |
| D+5 AM | Audit batch endpoint + hash chain SHA-256 |

## Gates duros respetados

- Bundle frontend sigue GET-only. El POST a `/v1/agent/proposals` es
  privado, no aparece en `read-boundary.ts`.
- Validación de acción contra matriz **antes** de persistir. Si propone
  algo `prohibited` o desconocido → 400 con `rejectReason` tipificado.
- Dedupe blinda contra spam: misma propuesta detectada cada 5 min no
  inunda el canvas. Solo se inyecta una vez, expira a 6h.
- Audit emit por cada call: `oc.proposal.submitted`, `oc.proposal.rejected`,
  `oc.proposal.submit_failed`, `oc.skill.drift.invoke`.
- El token Bearer del MVP es temporal. D+4 AM lo reemplaza con HMAC
  tokens firmados (Doc 4 §11 + §13).

## Lo más importante de este milestone

**Es la primera vez que vas a ver al agente activo en la UI del panel.**
Hasta ahora todo era audit JSONL + respuestas en chat de OpenClaw. Esto
cierra el bucle: agente razona en Bedrock → escribe al Gateway → panel
lo muestra al operador → operador firma fuera → audit cierra el ciclo.
