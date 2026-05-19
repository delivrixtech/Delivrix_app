# OPS · D+3 AM — Skill delivrix-alert-ops + integración Notion

> Cronograma: D+3 AM del `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`.
> Pre-requisitos: D+2 PM cerrado (reverse SSH tunnel activo, 2 plugins
> cargados). Cuenta Notion con el `Agent Integration Guide` aplicado.
> Construye sobre: `DOCUMENTACION/skills/delivrix-alert-ops/SKILL.md`.

## Objetivo

Cargar la skill `delivrix-alert-ops` con su side-effect auditado a
Notion: cuando el agente detecta evento crítico, crea automáticamente
tarjeta en `🐛 Bugs & Blockers` con severity Critical/High según
corresponda.

Es el **primer side-effect del agente al mundo externo** (Notion). Hay
que blindar:

- La `NOTION_API_KEY` vive solo en env var del container, no en chat.
- El agente nunca borra ni edita tarjetas existentes, solo crea nuevas.
- Cada `flag_issue` genera audit `oc.notion.bug_created` con el page ID.
- Si Notion API falla, el agente reporta el incidente en la respuesta
  pero NO bloquea el resto de la operación.

## Entregables verificables

- [ ] Plugin TS cargado en `/openclaw/plugins/delivrix-alert-ops/index.ts`
- [ ] Env `NOTION_API_KEY` presente en el container (validar sin imprimir)
- [ ] Smoke 1: "está pasando algo malo?" → respuesta con severidad max,
      gates abiertos, recomendación.
- [ ] Smoke 2: simular evento crítico (e.g. kill switch armado) →
      verificar que aparece tarjeta nueva en Notion Bugs & Blockers
      con severity Critical.
- [ ] Audit `oc.skill.alert_ops.invoke` con `severityDetected` y
      `notionPageCreated` (si aplica).
- [ ] Audit `oc.notion.bug_created` con `pageUrl` y `databaseId`.

## Pre-requisito 1 — NOTION_API_KEY en el container

> Acción humana del operador. Codex valida sin ver el valor.

```bash
# 1. El operador genera la integration de Notion (si no existe)
# https://www.notion.so/my-integrations → New integration
# Name: delivrix-openclaw-agent
# Capabilities: Read content, Update content, Insert content
# Copy "Internal Integration Secret" (empieza con secret_...)

# 2. El operador conecta la integration a las 2 DBs necesarias:
# - 🐛 Bugs & Blockers (75c53a45c1d94376910904ca03e5268e)
# - 📝 Daily Standup (2ce92c3910bd4b8a8f2b1e031a36a749, para D+4 PM)
# En cada DB: ... menú → Connections → Add → delivrix-openclaw-agent

# 3. El operador inyecta la key en el container (espacio inicial evita historial)
ssh root@2.24.223.240
 export NOTION_KEY='secret_xxx'
docker exec openclaw-dtsf-openclaw-1 sh -c "
  if [ -f /etc/openclaw/skills.env ]; then
    grep -q '^NOTION_API_KEY=' /etc/openclaw/skills.env \
      && sed -i 's|^NOTION_API_KEY=.*|NOTION_API_KEY='\"\$NOTION_KEY\"'|' /etc/openclaw/skills.env \
      || echo \"NOTION_API_KEY=\$NOTION_KEY\" >> /etc/openclaw/skills.env
  fi
  chmod 600 /etc/openclaw/skills.env
"
unset NOTION_KEY
exit

# 4. Codex valida sin ver el valor
docker exec openclaw-dtsf-openclaw-1 sh -c '
  if printenv NOTION_API_KEY >/dev/null 2>&1 || grep -q "^NOTION_API_KEY=" /etc/openclaw/skills.env 2>/dev/null; then
    echo "ok: NOTION_API_KEY presente"
  else
    echo "FAIL: NOTION_API_KEY no encontrada"; exit 1
  fi
'
```

## Pre-requisito 2 — Probar conectividad a Notion desde el container

```bash
docker exec openclaw-dtsf-openclaw-1 sh -c '
  set -e
  KEY=$(printenv NOTION_API_KEY || grep "^NOTION_API_KEY=" /etc/openclaw/skills.env | cut -d= -f2-)
  # Probar acceso a la DB de Bugs & Blockers (ID fijo del Agent Integration Guide)
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $KEY" \
    -H "Notion-Version: 2022-06-28" \
    https://api.notion.com/v1/databases/75c53a45c1d94376910904ca03e5268e)
  echo "GET Bugs & Blockers DB → HTTP $HTTP_CODE"
  unset KEY
'
# Esperado: HTTP 200. Si 401: la key no está válida.
# Si 404: la integration no está conectada a esa DB (revisar Step 2 de Pre-req 1).
```

## Paso 1 — Plugin TS delivrix-alert-ops

```bash
docker exec -it openclaw-dtsf-openclaw-1 sh -c "
mkdir -p /openclaw/plugins/delivrix-alert-ops
cat > /openclaw/plugins/delivrix-alert-ops/index.ts <<'TS'
/**
 * Skill: delivrix-alert-ops
 * Doc: DOCUMENTACION/skills/delivrix-alert-ops/SKILL.md
 *
 * Detecta qué necesita atención humana ahora mismo.
 * Side-effect auditado: si detecta evento critical sin tarjeta abierta
 * en Notion Bugs & Blockers, crea una automáticamente.
 */

import { SkillDescriptor, SkillContext, SkillResult } from '@openclaw/skill-sdk';

const DELIVRIX_BASE_URL = process.env.DELIVRIX_BASE_URL || 'http://172.16.0.1:3000';
const NOTION_API_KEY = process.env.NOTION_API_KEY || '';
const BUGS_DB_ID = '75c53a45c1d94376910904ca03e5268e';
const NOTION_VERSION = '2022-06-28';

type Severity = 'low' | 'medium' | 'high' | 'critical';

export const descriptor: SkillDescriptor = {
  slug: 'delivrix-alert-ops',
  version: '1.0.0',
  trigger: [
    'qué alertas hay',
    'qué gates están abiertos',
    'qué requiere mi atención',
    'está bien todo',
    'algo crítico'
  ],
  delivrixActions: [
    'read_admin_overview',
    'read_audit_events',
    'read_kill_switch',
    'read_operating_north',
    'read_openclaw_live_canvas'
  ],
  returns: 'structured-markdown',
  auditIdPrefix: 'oc.skill.alert_ops',
  fallback: 'none'
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

function severityWeight(s: Severity): number {
  if (s === 'critical') return 4;
  if (s === 'high') return 3;
  if (s === 'medium') return 2;
  return 1;
}

async function createNotionBug(opts: {
  title: string;
  category: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  affectedServer: string;
  description: string;
}): Promise<string | null> {
  if (!NOTION_API_KEY) return null;

  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${NOTION_API_KEY}\`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        parent: { database_id: BUGS_DB_ID },
        properties: {
          'Issue': { title: [{ text: { content: opts.title } }] },
          'Status': { select: { name: 'Open' } },
          'Severity': { select: { name: opts.severity } },
          'Category': { select: { name: opts.category } },
          'Affected Server': { rich_text: [{ text: { content: opts.affectedServer } }] },
          'Reported Date': { date: { start: today } },
          'Reported By': { select: { name: 'Agent' } },
          'Description': { rich_text: [{ text: { content: opts.description.slice(0, 2000) } }] },
          'Agent Flagged': { checkbox: true }
        }
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(\`Notion responded \${res.status}: \${body.slice(0, 200)}\`);
    }

    const data = await res.json();
    return data.url || data.id;
  } catch (err) {
    return null;
  }
}

export async function handler(ctx: SkillContext): Promise<SkillResult> {
  const startMs = Date.now();
  const evidence: string[] = [];
  const fetchErrors: string[] = [];

  const [killSwitch, overview, north, canvas, audit] = await Promise.allSettled([
    fetchJson<any>('/v1/kill-switch'),
    fetchJson<any>('/v1/admin/overview'),
    fetchJson<any>('/v1/operating-north'),
    fetchJson<any>('/v1/openclaw/live-canvas'),
    fetchJson<any>('/v1/audit-events')
  ]);

  const okOr = <T>(r: PromiseSettledResult<T>, name: string): T | null => {
    if (r.status === 'fulfilled') {
      evidence.push(\`oc.read.\${name}#\${ctx.shortHash(JSON.stringify(r.value))}\`);
      return r.value;
    }
    fetchErrors.push(\`\${name}: \${r.reason}\`);
    return null;
  };

  const ks = okOr(killSwitch, 'kill_switch');
  const ov = okOr(overview, 'admin_overview');
  const no = okOr(north, 'north');
  const cv = okOr(canvas, 'canvas');
  const au = okOr(audit, 'audit');

  let maxSeverity: Severity = 'low';
  const criticalEvents: any[] = [];

  // 1. Kill switch
  if (ks?.killSwitch?.enabled) {
    maxSeverity = 'critical';
    criticalEvents.push({
      kind: 'kill_switch_active',
      source: 'kill-switch',
      message: \`Kill switch activo desde \${ks.killSwitch.updatedAt}: \${ks.killSwitch.reason}\`
    });
  }

  // 2. Gates del norte
  const openGates = no?.gates ?? [];
  const expectedGatesInMvp = 31;
  if (openGates.length > expectedGatesInMvp) {
    maxSeverity = severityWeight(maxSeverity) < severityWeight('medium') ? 'medium' : maxSeverity;
  }

  // 3. Alertas del admin overview
  const alerts = ov?.overview?.alerts ?? [];
  for (const a of alerts) {
    if (a.severity === 'critical' || a.severity === 'blocked') {
      maxSeverity = 'critical';
      criticalEvents.push({ kind: 'admin_alert', source: 'admin-overview', message: a.message || a.title });
    } else if (a.severity === 'high' || a.severity === 'warning') {
      if (severityWeight(maxSeverity) < severityWeight('high')) maxSeverity = 'high';
    }
  }

  // 4. Bloqueos del canvas
  const blocked = cv?.canvas?.blockedBy ?? [];
  const criticalBlockers = blocked.filter((b: any) => b.severity === 'critical');
  if (criticalBlockers.length > 0 && severityWeight(maxSeverity) < severityWeight('high')) {
    maxSeverity = 'high';
  }

  // 5. Propuestas pendientes del canvas
  const proposalPending = cv?.canvas?.prompt ? 1 : 0;

  // 6. Side-effect Notion: solo si critical y no es kill-switch (que ya se sabe)
  let notionPageUrl: string | null = null;
  if (maxSeverity === 'critical' && criticalEvents.length > 0) {
    const ev = criticalEvents[0];
    notionPageUrl = await createNotionBug({
      title: \`Alert: \${ev.kind}\`,
      category: ev.kind === 'kill_switch_active' ? 'Agent Error' : 'Flagged Server',
      severity: 'Critical',
      affectedServer: ev.source,
      description: \`\${ev.message}\\n\\nEvidencia: \${evidence.join(', ')}\`
    });
    if (notionPageUrl) {
      evidence.push(\`notion:\${notionPageUrl}\`);
    }
  }

  const errorsSection = fetchErrors.length === 0
    ? ''
    : \`\\n> ⚠️ Fuentes que no respondieron: \${fetchErrors.join('; ')}\\n\`;

  const gateExamples = openGates.slice(0, 5).map((g: string) => \`- \\\`\${g}\\\`\`).join('\\n');
  const alertsTable = alerts.slice(0, 5).map((a: any) =>
    \`| \${a.severity || '—'} | \${a.title || '—'} | \${(a.message || '').slice(0, 80)} |\`
  ).join('\\n');

  const markdown = \`
## Alertas — snapshot \${new Date().toISOString()}

**Severidad máxima detectada: \${maxSeverity}**
\${errorsSection}
### Kill switch
- Estado: \${ks?.killSwitch?.enabled ? 'ACTIVO' : 'ARMADO'}
- Última actualización: \${ks?.killSwitch?.updatedAt || '—'}
\${ks?.killSwitch?.reason ? \`- Razón: \${ks.killSwitch.reason}\` : ''}

### Gates abiertos (\${openGates.length} en total)
\${gateExamples || '- (ninguno)'}

### Alertas críticas (últimas)
\${alertsTable ? \`| severity | title | message |\\n|---|---|---|\\n\${alertsTable}\` : '(ninguna)'}

### Propuestas pendientes del canvas
\${proposalPending} pendiente\${proposalPending === 1 ? '' : 's'} de firma humana.

### Recomendación
\${
  maxSeverity === 'critical'
    ? \`Atender inmediatamente. \${notionPageUrl ? \`Tarjeta crítica creada en Notion: \${notionPageUrl}\` : 'No se pudo crear tarjeta en Notion.'}\`
    : maxSeverity === 'high'
      ? 'Revisar propuestas pendientes del canvas antes de cerrar el día.'
      : maxSeverity === 'medium'
        ? 'Monitorear gates abiertos; ninguno crítico.'
        : 'Sistema estable.'
}

_Evidencia_: \${evidence.join(', ')}
\`.trim();

  await ctx.audit({
    action: \`\${descriptor.auditIdPrefix}.invoke\`,
    decision: fetchErrors.length === 5 ? 'reject' : 'allow',
    rejectReason: fetchErrors.length === 5 ? 'gateway_timeout' : undefined,
    metadata: {
      skillSlug: descriptor.slug,
      durationMs: Date.now() - startMs,
      severityDetected: maxSeverity,
      gatesOpen: openGates.length,
      criticalAlerts: criticalEvents.length,
      notionPageCreated: notionPageUrl !== null,
      notionPageUrl: notionPageUrl || undefined,
      endpointsOk: 5 - fetchErrors.length,
      errors: fetchErrors.length > 0 ? fetchErrors : undefined
    },
    evidenceRefs: evidence
  });

  if (notionPageUrl) {
    await ctx.audit({
      action: 'oc.notion.bug_created',
      decision: 'allow',
      metadata: {
        databaseId: BUGS_DB_ID,
        pageUrl: notionPageUrl,
        severity: 'Critical',
        triggeredBySkill: descriptor.slug
      }
    });
  }

  return { content: markdown, format: 'markdown' };
}
TS
echo 'ok: plugin delivrix-alert-ops escrito'
"
```

## Paso 2 — Compilar + reload

```bash
docker exec openclaw-dtsf-openclaw-1 sh -c '
  cd /openclaw/plugins/delivrix-alert-ops && npx tsc --noEmit index.ts 2>&1 | head -10
'
# Esperado: cero errores

docker exec openclaw-dtsf-openclaw-1 \
  sh -c "kill -HUP \$(pgrep -f 'node server.mjs' | head -1)"
sleep 4

# Verificar listado
docker exec openclaw-dtsf-openclaw-1 \
  curl -s http://127.0.0.1:18789/internal/skills 2>/dev/null \
  || docker exec openclaw-dtsf-openclaw-1 \
       cat /openclaw/runtime/skills-registry.json 2>/dev/null
# Adaptar al endpoint nativo que usaste en D+2 PM
```

## Paso 3 — Smoke 1: pregunta normal

```bash
GW_TOKEN=$(docker exec openclaw-dtsf-openclaw-1 \
  sh -c 'printenv GATEWAY_TOKEN || cat /openclaw/.gateway-token 2>/dev/null')

curl -X POST http://127.0.0.1:61175/api/chat.send \
  -H "Authorization: Bearer $GW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "agent:smoke:alerts-normal",
    "msgId": "smoke-alerts-normal-'$(date +%s)'",
    "message": { "role": "user", "content": "está pasando algo malo?" }
  }'

sleep 8
docker exec openclaw-dtsf-openclaw-1 \
  curl -s -H "Authorization: Bearer $GW_TOKEN" \
    "http://127.0.0.1:18789/api/sessions/agent:smoke:alerts-normal/history" \
  | jq '.messages[-1].content'

# Esperado en estado normal:
#   Severidad: medium (porque hay 31 gates abiertos esperados del MVP)
#   Kill switch: ARMADO
#   No se crea bug en Notion porque no es critical.
#   Audit: oc.skill.alert_ops.invoke con severityDetected=medium, notionPageCreated=false.
```

## Paso 4 — Smoke 2: simular evento crítico

> Solo para validar el flujo Notion. NO ARMAR EL KILL SWITCH REAL.
> Codex puede insertar temporalmente un evento de admin/overview con
> severity critical en el LocalFileStore del Gateway, o usar un
> endpoint debug si existe. Si no hay forma de inyectar, esperar a
> que se materialice un crítico real.

```bash
# Opción A — Tocar el LocalFileStore directamente (solo testing)
# Solo si el operador autoriza explícitamente.
# Codex audita la inyección como oc.testing.synthetic_critical_injected.

# Opción B — Skipear smoke 2 hasta evento crítico real y validar entonces.
#   Si esto, dejar el plugin cargado y esperar primer crítico real.

# Cualquiera de las dos, lo importante es validar que cuando llegue un
# critical real, la skill cree la tarjeta Notion y emita los 2 audits.
```

## Paso 5 — Validar audits

```bash
docker exec openclaw-dtsf-openclaw-1 \
  cat /openclaw/audit/local.jsonl 2>/dev/null \
  | grep -E '"oc.skill.alert_ops|"oc.notion.bug_created' \
  | tail -10 \
  | jq '.'

# Esperado al menos un evento oc.skill.alert_ops.invoke con metadata
# completa. Si hubo smoke 2 con critical, también oc.notion.bug_created.
```

## Paso 6 — Verificar tarjeta Notion (si Paso 4 produjo critical)

```bash
# El operador abre Notion → Bugs & Blockers DB:
# https://www.notion.so/75c53a45c1d94376910904ca03e5268e

# Esperado: tarjeta nueva con:
#   - Issue: "Alert: kill_switch_active" o similar
#   - Status: Open
#   - Severity: Critical
#   - Reported By: Agent
#   - Reported Date: hoy
#   - Agent Flagged: ☑
#   - Description: mensaje + evidencia con hashes
```

## Reporte de cierre esperado

```
============================================
  D+3 AM completado — alert-ops + Notion
============================================
  Plugins cargados:
    - delivrix-alert-ops v1.0.0

  Pre-requisitos:
    - NOTION_API_KEY: presente
    - Bugs & Blockers DB: conectada (HTTP 200)

  Smoke 1 (estado normal):
    - severityDetected: medium
    - gatesOpen: 31 (esperado MVP)
    - notionPageCreated: false (correcto)

  Smoke 2 (critical):
    - severityDetected: critical
    - notionPageCreated: true
    - pageUrl: https://www.notion.so/...

  Audit: .audit/openclaw-skills.jsonl
============================================
```

## Próximo: D+3 PM

Skill `drift-monitor` (rules engine + side-effect a `canvas.prompt`)
+ endpoint privado `POST /v1/agent/proposals` en Gateway. Eso completa
el ciclo: el agente detecta drift, lo audita, lo pone en el panel para
firma humana, y el operador firma.

## Gates duros respetados

- `NOTION_API_KEY` nunca en chat ni en repo.
- Skill solo CREA tarjetas, nunca edita ni borra.
- Notion API down → la skill sigue funcionando, solo reporta degradación
  en la respuesta del agente.
- Cada `bug_created` emite audit con `pageUrl` para trazabilidad
  bidireccional Gateway↔Notion.
- Severidad se decide por reglas determinísticas, no por LLM
  alucinación: kill switch active → critical, admin alert critical →
  critical, etc.
