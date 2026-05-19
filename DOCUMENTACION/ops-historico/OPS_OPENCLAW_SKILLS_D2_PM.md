# OPS · D+2 PM — Skills webdock-inventory-sync + delivrix-fleet-ops

> Cronograma: D+2 PM del `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`.
> Pre-requisito: D+2 AM cerrado (KB Capa 1 + Capa 2, recall@5 ≥ 80%).
> Construye sobre: `OPENCLAW_SKILLS_CATALOG.md`, skills literales en
> `DOCUMENTACION/skills/`, `OPENCLAW_DELIVRIX_API_CONTRACT.md`.

## Objetivo

Cargar las 2 primeras skills tipadas al container OpenClaw:

- `webdock-inventory-sync` — formato simple, una llamada HTTP.
- `delivrix-fleet-ops` — combina 4 endpoints en paralelo, lógica
  más compleja.

Resultado verificable: el operador escribe "qué hay en Webdock?" en la
UI de OpenClaw → el agente invoca la skill → llama al Gateway Delivrix
→ formatea respuesta con tabla + drift + evidencia.

## Pre-requisito de network (decisión arquitectural)

El container OpenClaw vive en `2.24.223.240` (Hostinger). El Gateway
Delivrix corre hoy en `localhost:3000` del Mac del operador. **No hay
conectividad container → Gateway todavía.**

Tres opciones reales, en orden de preferencia:

### Opción A — Reverse SSH tunnel (Recomendada para MVP, 5 min)

Codex monta un túnel SSH reverso desde el Mac del operador al VPS
Hostinger. El container del VPS puede entonces llegar a
`http://host.docker.internal:3000` o `http://172.17.0.1:3000` que mapea
al Mac local del operador.

```bash
# En el Mac del operador (Codex)
ssh -R 3000:127.0.0.1:3000 root@2.24.223.240 -N -f
# Esto deja el túnel corriendo en background.

# Desde el container OpenClaw, el Gateway está en:
#   http://host.docker.internal:3000  (en Docker Desktop)
#   http://172.17.0.1:3000             (en Docker Linux nativo)

# Verificar desde el container
docker exec openclaw-dtsf-openclaw-1 curl -s http://172.17.0.1:3000/health
# Esperado: {"status":"ok", ...}
```

**Pros**: 5 minutos, cero infraestructura nueva, el Gateway no se expone
a internet, el túnel muere si el operador apaga la Mac (gate físico).

**Contras**: solo funciona mientras el operador tiene el Mac prendido y
el túnel activo. Si Codex no relanza el túnel tras restart de la Mac,
el agente queda sin datos del Gateway.

### Opción B — Deploy Gateway a VPS Hostinger separada (~30 min)

Codex despliega el Gateway Delivrix a otra VPS de Hostinger (o a la
misma `2.24.223.240` en otro puerto). El container OpenClaw le llama
por IP pública o por bridge interno.

**Pros**: Gateway siempre disponible, no depende del Mac del operador.

**Contras**: 30 min de deploy + necesita config Postfix/Postgres si
quieres datos reales, no mocks. Y expone el Gateway a internet,
incluso si solo es Bearer auth.

### Opción C — Skills devuelven mocks por ahora (~0 min)

Skills no llaman al Gateway real. Cada skill tiene un mock hardcoded
con datos representativos del MVP. Cuando el Gateway esté disponible
en su URL definitiva, se cambia la base URL en una env var.

**Pros**: skills cargan ya, podemos probar el flujo completo agente
→ skill → respuesta.

**Contras**: no hay datos vivos, no detectamos drift real, smoke parcial.
Falsea progreso del cronograma.

### Mi recomendación

**Opción A (reverse SSH tunnel)** para MVP día 17-30. Es lo más rápido,
no expone nada a internet, y el operador puede matar el túnel cuando
quiera (gate físico de safety).

Para producción post-MVP queda Opción B (Hito 5.11.C o 5.12).

## Paso 1 — Montar reverse SSH tunnel (Opción A)

```bash
# Codex en host del operador

# 1.1 — Asegurar que Gateway Delivrix esté corriendo en localhost:3000
bash "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/restart-gateway.sh"
# Confirma que los 28 endpoints responden + Webdock inventory live/mock OK.

# 1.2 — Montar túnel reverso
ssh -R 3000:127.0.0.1:3000 root@2.24.223.240 -N -f
# -R: reverse forward del puerto 3000 del Mac al puerto 3000 del VPS
# -N: no ejecutar comandos remotos
# -f: enviar al background

# 1.3 — Verificar que el túnel está activo
ps aux | grep "ssh -R 3000" | grep -v grep
# Debe aparecer un proceso ssh activo.

# 1.4 — Desde el container, probar conectividad al Gateway
docker exec openclaw-dtsf-openclaw-1 \
  curl -s -m 5 http://172.17.0.1:3000/health
# Esperado: {"status":"ok","service":"gateway-api","phase":"...","openClaw":{...},"operatingNorth":{...}}
# Si falla: probar http://host.docker.internal:3000/health
# Si sigue fallando: revisar config /etc/hosts del container o usar IP real del bridge

# 1.5 — Definir la base URL para las skills (env var del container)
DELIVRIX_BASE_URL="http://172.17.0.1:3000"  # ajustar según output de 1.4

docker exec openclaw-dtsf-openclaw-1 sh -c "
  if [ -f /etc/openclaw/skills.env ]; then
    grep -q '^DELIVRIX_BASE_URL=' /etc/openclaw/skills.env \
      && sed -i 's|^DELIVRIX_BASE_URL=.*|DELIVRIX_BASE_URL=${DELIVRIX_BASE_URL}|' /etc/openclaw/skills.env \
      || echo 'DELIVRIX_BASE_URL=${DELIVRIX_BASE_URL}' >> /etc/openclaw/skills.env
  else
    echo 'DELIVRIX_BASE_URL=${DELIVRIX_BASE_URL}' > /etc/openclaw/skills.env
  fi
  chmod 644 /etc/openclaw/skills.env
"

# 1.6 — Audit
cat >> "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/.audit/openclaw-skills.jsonl" <<EOF
{"id":"$(uuidgen)","occurredAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","actorType":"system","actorId":"codex@host","action":"oc.network.reverse_tunnel_up","targetType":"network","targetId":"openclaw->gateway","decision":"n/a","schemaVersion":"2026-05-18.v1","metadata":{"localPort":3000,"remoteHost":"2.24.223.240","remotePort":3000,"containerBaseUrl":"${DELIVRIX_BASE_URL}"},"prevHash":"PENDING_CHAIN_BOOTSTRAP","hash":"PENDING_CHAIN_BOOTSTRAP"}
EOF
```

> **Nota sobre auth**: el Gateway Delivrix hoy NO tiene Bearer auth
> implementado (es localhost-only). Las skills llaman sin
> `Authorization` header. Cuando llegue D+5 AM (audit batch endpoint),
> se agrega el Bearer y se actualizan las skills. Mientras tanto, el
> túnel SSH actúa como gate de auth (solo el operador puede mantener
> el túnel arriba).

## Paso 2 — Plugin TypeScript: webdock-inventory-sync

OpenClaw soporta plugins TypeScript en `/openclaw/plugins/<slug>/index.ts`.
Cada plugin exporta un `SkillDescriptor` con metadata + un `handler`
async que recibe context y retorna respuesta tipada.

```bash
docker exec -it openclaw-dtsf-openclaw-1 sh -c "
mkdir -p /openclaw/plugins/webdock-inventory-sync
cat > /openclaw/plugins/webdock-inventory-sync/index.ts <<'TS'
/**
 * Skill: webdock-inventory-sync
 * Doc: DOCUMENTACION/skills/webdock-inventory-sync/SKILL.md
 *
 * Lee inventario de Webdock pasando por el Gateway Delivrix (no directo
 * al proveedor). El Gateway aplica cache 60s, audit log y rules engine
 * de drift; esta skill solo expone el resultado al agente.
 */

import { SkillDescriptor, SkillContext, SkillResult } from '@openclaw/skill-sdk';

const DELIVRIX_BASE_URL = process.env.DELIVRIX_BASE_URL || 'http://172.17.0.1:3000';

interface WebdockServer {
  slug: string;
  name: string;
  status: string;
  ipv4: string;
  location?: string;
  profileSlug?: string;
  lastDataReceived?: string;
}

interface WebdockInventoryPayload {
  inventory: {
    schemaVersion: string;
    generatedAt: string;
    mode: string;
    source: { kind: 'live' | 'mock'; responseOk: boolean; errorMessage?: string };
    summary: { total: number; running: number; stopped: number; suspended: number; other: number };
    servers: WebdockServer[];
  };
  drift: {
    proposals: Array<{ id: string; severity: string; category: string; headline: string }>;
  };
}

export const descriptor: SkillDescriptor = {
  slug: 'webdock-inventory-sync',
  version: '1.0.0',
  trigger: [
    'qué servidores tengo en Webdock',
    'inventario',
    'cuántos VPS',
    'muéstrame el inventario'
  ],
  delivrixActions: ['read_webdock_inventory'],
  returns: 'structured-markdown',
  auditIdPrefix: 'oc.skill.webdock_sync',
  fallback: 'mock-canonical'
};

export async function handler(ctx: SkillContext): Promise<SkillResult> {
  const startMs = Date.now();
  const auditEvidence: string[] = [];

  try {
    const res = await fetch(\`\${DELIVRIX_BASE_URL}/v1/webdock/inventory\`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) {
      throw new Error(\`Gateway responded \${res.status} \${res.statusText}\`);
    }

    const data = await res.json() as WebdockInventoryPayload;
    const inv = data.inventory;
    const drift = data.drift;

    auditEvidence.push(\`oc.read.webdock#\${ctx.shortHash(JSON.stringify(inv))}\`);

    const sourceWarning = inv.source.kind === 'mock'
      ? \`\\n> ⚠️ Fuente: **mock**. Configurar \\\`WEBDOCK_API_KEY\\\` en el Gateway para datos reales.\\n\`
      : '';

    const serversTable = inv.servers.map(s =>
      \`| \${s.slug} | \${s.name} | \${s.status} | \${s.ipv4} | \${s.location || '—'} | \${s.profileSlug || '—'} | \${s.lastDataReceived || '—'} |\`
    ).join('\\n');

    const driftSection = drift.proposals.length === 0
      ? 'Ninguno.'
      : drift.proposals.slice(0, 5).map(p =>
          \`- [\${p.severity}] \${p.category}: \${p.headline}\`
        ).join('\\n');

    const markdown = \`
## Webdock — inventario \${inv.generatedAt}
\${sourceWarning}
**Resumen**
- Total: \${inv.summary.total}
- Running: \${inv.summary.running}
- Stopped: \${inv.summary.stopped}
- Suspended: \${inv.summary.suspended}
- Otros: \${inv.summary.other}

**Servers**
| slug | name | status | ipv4 | location | profile | lastDataReceived |
|---|---|---|---|---|---|---|
\${serversTable}

**Drift detectado por rules engine**
\${driftSection}

_Evidencia_: \${auditEvidence.join(', ')}
\`.trim();

    await ctx.audit({
      action: \`\${descriptor.auditIdPrefix}.invoke\`,
      decision: 'allow',
      metadata: {
        skillSlug: descriptor.slug,
        durationMs: Date.now() - startMs,
        serverCount: inv.summary.total,
        sourceKind: inv.source.kind,
        driftCount: drift.proposals.length
      },
      evidenceRefs: auditEvidence
    });

    return { content: markdown, format: 'markdown' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await ctx.audit({
      action: \`\${descriptor.auditIdPrefix}.gateway_timeout\`,
      decision: 'reject',
      metadata: { errorMessage: errMsg, durationMs: Date.now() - startMs }
    });
    return {
      content: \`No pude leer el inventario de Webdock. Gateway no respondió: \${errMsg}\`,
      format: 'markdown',
      isDegraded: true
    };
  }
}
TS
echo 'ok: plugin webdock-inventory-sync escrito'
"
```

## Paso 3 — Plugin TypeScript: delivrix-fleet-ops

```bash
docker exec -it openclaw-dtsf-openclaw-1 sh -c "
mkdir -p /openclaw/plugins/delivrix-fleet-ops
cat > /openclaw/plugins/delivrix-fleet-ops/index.ts <<'TS'
/**
 * Skill: delivrix-fleet-ops
 * Doc: DOCUMENTACION/skills/delivrix-fleet-ops/SKILL.md
 *
 * Combina 4 endpoints del Gateway Delivrix en paralelo y reporta estado
 * operativo de la flota: clústeres, sender nodes, canvas, Webdock real.
 */

import { SkillDescriptor, SkillContext, SkillResult } from '@openclaw/skill-sdk';

const DELIVRIX_BASE_URL = process.env.DELIVRIX_BASE_URL || 'http://172.17.0.1:3000';

export const descriptor: SkillDescriptor = {
  slug: 'delivrix-fleet-ops',
  version: '1.0.0',
  trigger: [
    'estado de la flota',
    'qué clústeres tenemos',
    'cuántos sender nodes',
    'qué nodos activos',
    'cómo va la operación'
  ],
  delivrixActions: [
    'read_admin_clusters',
    'read_sender_nodes',
    'read_openclaw_live_canvas',
    'read_webdock_inventory'
  ],
  returns: 'structured-markdown',
  auditIdPrefix: 'oc.skill.fleet_ops',
  fallback: 'rules-engine-local'
};

async function fetchJson<T>(path: string, timeoutMs = 6000): Promise<T> {
  const res = await fetch(\`\${DELIVRIX_BASE_URL}\${path}\`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(\`\${path} returned \${res.status}\`);
  return await res.json() as T;
}

export async function handler(ctx: SkillContext): Promise<SkillResult> {
  const startMs = Date.now();
  const evidence: string[] = [];
  const errors: string[] = [];

  // Llamadas en paralelo con fallback parcial: si una falla, sigue con las otras
  const [clusters, senderNodes, canvas, webdock] = await Promise.allSettled([
    fetchJson<any>('/v1/admin/clusters'),
    fetchJson<any>('/v1/sender-nodes'),
    fetchJson<any>('/v1/openclaw/live-canvas'),
    fetchJson<any>('/v1/webdock/inventory')
  ]);

  const okOr = <T>(r: PromiseSettledResult<T>, name: string): T | null => {
    if (r.status === 'fulfilled') {
      evidence.push(\`oc.read.\${name}#\${ctx.shortHash(JSON.stringify(r.value))}\`);
      return r.value;
    }
    errors.push(\`\${name}: \${r.reason}\`);
    return null;
  };

  const c = okOr(clusters, 'admin_clusters');
  const sn = okOr(senderNodes, 'sender_nodes');
  const cv = okOr(canvas, 'canvas');
  const wd = okOr(webdock, 'webdock');

  const clusterCount = c?.clusterOverview?.clusters?.length ?? 0;
  const nodes = sn?.nodes ?? [];
  const senderActive = nodes.filter((n: any) => n.status === 'active').length;
  const senderWarming = nodes.filter((n: any) => n.status === 'warming').length;
  const senderPaused = nodes.filter((n: any) => n.status === 'paused').length;
  const currentStep = cv?.canvas?.currentStepId ?? '—';
  const wdSummary = wd?.inventory?.summary ?? { running: 0, stopped: 0, suspended: 0, total: 0 };

  const clustersTable = (c?.clusterOverview?.clusters || []).map((cl: any) =>
    \`| \${cl.id} | \${cl.provider} | \${cl.managementState} | \${(cl.senderNodes || []).length} |\`
  ).join('\\n');

  const topNodes = nodes
    .sort((a: any, b: any) => (b.warmupDay || 0) - (a.warmupDay || 0))
    .slice(0, 5)
    .map((n: any) =>
      \`| \${n.id} | \${n.provider} | \${n.status} | \${n.ipAddress || '—'} | \${n.warmupDay || 0} | \${n.dailyLimit || 0} |\`
    ).join('\\n');

  const errorsSection = errors.length === 0
    ? ''
    : \`\\n> ⚠️ Fuentes que no respondieron: \${errors.join('; ')}\\n\`;

  const markdown = \`
## Flota — snapshot \${new Date().toISOString()}
\${errorsSection}
**Resumen**
- Clústeres: \${clusterCount}
- Sender nodes: \${senderActive} activos / \${senderWarming} warming / \${senderPaused} pausados
- Webdock real: \${wdSummary.running} running, \${wdSummary.stopped} stopped, \${wdSummary.suspended} suspendidos
- Canvas current step: \\\`\${currentStep}\\\`

**Por clúster**
| cluster_id | provider | mgmt_state | sender_nodes_count |
|---|---|---|---|
\${clustersTable || '| (sin clústeres) | | | |'}

**Sender nodes (top 5 por warmupDay)**
| id | provider | status | ipv4 | warmupDay | dailyLimit |
|---|---|---|---|---|---|
\${topNodes || '| (sin nodos) | | | | | |'}

_Evidencia_: \${evidence.join(', ')}
\`.trim();

  await ctx.audit({
    action: \`\${descriptor.auditIdPrefix}.invoke\`,
    decision: errors.length === 4 ? 'reject' : 'allow',
    rejectReason: errors.length === 4 ? 'gateway_timeout' : undefined,
    metadata: {
      skillSlug: descriptor.slug,
      durationMs: Date.now() - startMs,
      endpointsTotal: 4,
      endpointsOk: 4 - errors.length,
      errors: errors.length > 0 ? errors : undefined
    },
    evidenceRefs: evidence
  });

  return {
    content: markdown,
    format: 'markdown',
    isDegraded: errors.length > 0
  };
}
TS
echo 'ok: plugin delivrix-fleet-ops escrito'
"
```

## Paso 4 — Build + reload del agente

```bash
# 4.1 — Compilar los plugins TypeScript (OpenClaw los compila al cargar)
docker exec openclaw-dtsf-openclaw-1 sh -c '
  cd /openclaw/plugins/webdock-inventory-sync && npx tsc --noEmit index.ts 2>&1 | head -10
  cd /openclaw/plugins/delivrix-fleet-ops && npx tsc --noEmit index.ts 2>&1 | head -10
'
# Esperado: cero errores TS. Si hay errores, ajustar tipos.

# 4.2 — Reload del agente para que cargue los plugins
docker exec openclaw-dtsf-openclaw-1 \
  sh -c "kill -HUP \$(pgrep -f 'node server.mjs' | head -1)"
sleep 4

# 4.3 — Verificar que las skills se cargaron
docker exec openclaw-dtsf-openclaw-1 \
  curl -s http://127.0.0.1:18789/api/skills 2>/dev/null \
  | jq '.skills[] | select(.slug | startswith("webdock") or startswith("delivrix"))'
# Esperado: 2 entradas, una por cada skill.
```

## Paso 5 — Smoke real con datos vivos

```bash
GW_TOKEN=$(docker exec openclaw-dtsf-openclaw-1 \
  sh -c 'printenv GATEWAY_TOKEN || cat /openclaw/.gateway-token 2>/dev/null')

# 5.1 — Webdock inventory
curl -X POST http://127.0.0.1:61175/api/chat.send \
  -H "Authorization: Bearer $GW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "agent:smoke:webdock-sync",
    "msgId": "smoke-webdock-'$(date +%s)'",
    "message": { "role": "user", "content": "qué tengo en Webdock?" }
  }'

sleep 8
docker exec openclaw-dtsf-openclaw-1 \
  curl -s -H "Authorization: Bearer $GW_TOKEN" \
    "http://127.0.0.1:18789/api/sessions/agent:smoke:webdock-sync/history" \
  | jq '.messages[-1].content'

# Esperado:
#   ## Webdock — inventario <ISO>
#   Resumen + tabla de servers + drift detectado + evidencia.
#   Con badge "mock" si WEBDOCK_API_KEY no configurada, o lista real
#   de tu cuenta Webdock si configurada.

# 5.2 — Fleet ops
curl -X POST http://127.0.0.1:61175/api/chat.send \
  -H "Authorization: Bearer $GW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "agent:smoke:fleet",
    "msgId": "smoke-fleet-'$(date +%s)'",
    "message": { "role": "user", "content": "cómo va la flota?" }
  }'

sleep 10
docker exec openclaw-dtsf-openclaw-1 \
  curl -s -H "Authorization: Bearer $GW_TOKEN" \
    "http://127.0.0.1:18789/api/sessions/agent:smoke:fleet/history" \
  | jq '.messages[-1].content'

# Esperado:
#   ## Flota — snapshot <ISO>
#   Resumen + clústeres + top 5 nodos + evidencia.
```

## Paso 6 — Validar audits

```bash
# Confirmar que cada skill invoke emitió audit
docker exec openclaw-dtsf-openclaw-1 \
  curl -s -H "Authorization: Bearer $GW_TOKEN" \
    "http://127.0.0.1:18789/api/audit?since=10m" 2>/dev/null \
  | jq '[.events[] | select(.action | startswith("oc.skill"))] | .[0:5]'

# Esperado: eventos oc.skill.webdock_sync.invoke y oc.skill.fleet_ops.invoke
# con duration, evidenceRefs, decision=allow.
```

## Reporte de cierre

```
============================================
  D+2 PM completado — 2 skills cargadas
============================================
  Pre-requisito network: reverse SSH tunnel activo
    Mac:3000 → VPS Hostinger:3000

  Skills cargadas:
    - webdock-inventory-sync v1.0.0
    - delivrix-fleet-ops v1.0.0

  Smoke 1 (webdock-sync):
    - latencia: <ms>
    - resultado: <ok | degraded>

  Smoke 2 (fleet-ops):
    - latencia: <ms>
    - endpoints OK: <N>/4
    - resultado: <ok | degraded>

  Audit: .audit/openclaw-skills.jsonl
============================================
```

## Próximos pasos del cronograma

| Día | Milestone |
| --- | --- |
| D+3 AM | Skill `delivrix-alert-ops` + integración Notion Bugs & Blockers |
| D+3 PM | Skill `drift-monitor` + endpoint privado `POST /v1/agent/proposals` en Gateway |
| D+4 AM | Permissions pipeline en Gateway + tokens HMAC |
| D+4 PM | Skill `delivrix-report-ops` + cron diario Notion |
| D+5 AM | Audit batch endpoint + hash chain |

## Gates duros respetados

- Gateway sigue sin endpoints expuestos a internet. Reverse SSH tunnel
  encapsula auth en la capa de transport.
- Cada skill invoca solo las acciones declaradas en su `delivrixActions`
  (matriz Doc 2). Si invoca una fuera de declaración, el SDK rechaza.
- Audit emit por cada call con decisión + métricas + evidencia.
- Skills tienen timeout 6-8s. Si Gateway no responde, fallback degradado
  (no respuestas falsas).
- Bundle frontend sigue GET-only. Nada de lo que se hace aquí toca el
  admin panel.

## Si Codex hace D+2 PM con Opción C (mocks) en vez de A

Solo cambiar `DELIVRIX_BASE_URL` por algo que no responde y dejar que
las skills caigan al fallback declarado en sus SKILL.md (mock-canonical
para webdock, rules-engine-local para fleet). El flujo agente → skill
→ respuesta queda probado, solo sin datos vivos.
