# OPS · D+4 PM — delivrix-report-ops responde en chat (Notion skippeado)

> Cronograma: D+4 PM del `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`.
> Pre-requisitos: D+4 AM cerrado (HMAC + ApprovalToken funcionales).
> Construye sobre: `DOCUMENTACION/skills/delivrix-report-ops/SKILL.md`,
> `.audit/decision-skip-notion-side-effect.md` (Hito 5.11.B → Notion diferido al 5.12).
> Decisiones del operador (chat 2026-05-18):
> 1. Trigger **manual** del operador (sin cron).
> 2. Output **solo en chat** de OpenClaw (no se inyecta en canvas).

## Objetivo

Cablear la skill `delivrix-report-ops` en el container OpenClaw para que el
operador pueda pedir un **reporte diario ejecutivo** desde el chat del agente,
construido literal a partir de los endpoints read-only del Gateway Delivrix.

Sin cron, sin canvas, sin Notion. Reporte sale como mensaje markdown en la
conversación con OpenClaw. Decisión auditada en
`.audit/decision-skip-notion-side-effect.md`: si `NOTION_API_KEY` no está
presente, side-effect Notion se omite y se audita el motivo. Plugin queda
listo para reactivar el side-effect con cero redeploy cuando el operador
tenga rol Workspace Owner.

Acción declarada al pipeline matrix: `generate_daily_report`
(categoría `allowed_dry_run`, audit ID `oc.dry.daily_report`). No requiere
aprobación humana, no toca estado real, solo compone markdown.

## Entregables verificables

- [ ] Plugin TS `delivrix-report-ops` en `services/openclaw-skills/src/skills/delivrix-report-ops/`
  - `SkillDescriptor` con slug `delivrix-report-ops`, trigger phrases típicos
  - `handler` que llama 5 endpoints read-only del Gateway con `Promise.allSettled`
  - LLM call a Bedrock Sonnet 4.6 con prompt template `daily-report-v1`
  - Fallback honesto: si un endpoint falla, audit + seguir con los demás
  - Si `NOTION_API_KEY` ausente, audit `oc.skill.report_ops.notion_skipped` y
    devolver el reporte en chat sin intentar la escritura
- [ ] Plugin compilado y desplegado al container OpenClaw
- [ ] Audit events:
  - `oc.skill.report_ops.invoke` — al entrar al handler
  - `oc.read.send_results`, `oc.read.ip_reputation`, `oc.read.stuck_jobs`,
    `oc.read.sender_nodes`, `oc.read.audit` (1 evento por endpoint)
  - `oc.skill.report_ops.partial_data` — si algún endpoint falla (no aborta)
  - `oc.skill.report_ops.notion_skipped` — si `NOTION_API_KEY` ausente
  - `oc.skill.report_ops.completed` — al terminar, con `reportLengthChars` y
    `endpointsOk` / `endpointsFailed`
- [ ] Smoke real: operador escribe en OpenClaw "correr report-ops" → recibe
      markdown ~500–1500 caracteres con secciones esperadas

## Paso 1 — Crear estructura del plugin

```bash
WORKTREE="/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
SKILL_DIR="${WORKTREE}/services/openclaw-skills/src/skills/delivrix-report-ops"
mkdir -p "${SKILL_DIR}"
```

Estructura final:

```
delivrix-report-ops/
├── descriptor.ts        # SkillDescriptor para OpenClaw
├── handler.ts           # Lógica principal
├── prompt-template.ts   # daily-report-v1 prompt
├── gateway-reads.ts     # 5 endpoints read-only con Promise.allSettled
└── index.ts             # Export agregador
```

## Paso 2 — `descriptor.ts`

```typescript
import type { SkillDescriptor } from '@openclaw/skill-sdk';

export const descriptor: SkillDescriptor = {
  slug: 'delivrix-report-ops',
  displayName: 'Delivrix · Reporte diario operativo',
  description:
    'Genera reporte ejecutivo del día: send_results, ip_reputation, stuck_jobs, sender_nodes, audit_events. Responde en chat. Side-effect Notion omitido si NOTION_API_KEY ausente.',
  triggerPhrases: [
    'correr report-ops',
    'reporte diario',
    'daily report',
    'resumen del día',
    'cómo va la operación hoy'
  ],
  declaredActions: ['generate_daily_report'],
  schemaVersion: '2026-05-18.v1',
  modelHint: 'us.anthropic.claude-sonnet-4-6'
};
```

## Paso 3 — `gateway-reads.ts`

5 endpoints read-only del read-boundary Delivrix (Doc 2 §3.1). Bearer dev sigue
sirviendo para reads — solo escrituras requieren HMAC (decisión D+4 AM).

```typescript
import { auditLog } from '../../lib/audit.js';

const GATEWAY_BASE = process.env.DELIVRIX_GATEWAY_URL ?? 'http://host.docker.internal:3000';
const BEARER = process.env.DELIVRIX_OPENCLAW_TOKEN ?? '';

interface ReadResult<T> {
  endpoint: string;
  ok: boolean;
  data?: T;
  error?: string;
}

async function readEndpoint<T>(
  path: string,
  auditId: string
): Promise<ReadResult<T>> {
  try {
    const res = await fetch(`${GATEWAY_BASE}${path}`, {
      headers: { Authorization: `Bearer ${BEARER}` }
    });
    if (!res.ok) {
      await auditLog.append({
        actorType: 'openclaw',
        actorId: 'openclaw-hostinger-prod',
        action: auditId,
        targetType: 'gateway_read',
        targetId: path,
        riskLevel: 'low',
        metadata: { status: res.status, responseOk: false }
      });
      return { endpoint: path, ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as T;
    await auditLog.append({
      actorType: 'openclaw',
      actorId: 'openclaw-hostinger-prod',
      action: auditId,
      targetType: 'gateway_read',
      targetId: path,
      riskLevel: 'low',
      metadata: { status: 200, responseOk: true }
    });
    return { endpoint: path, ok: true, data };
  } catch (err) {
    await auditLog.append({
      actorType: 'openclaw',
      actorId: 'openclaw-hostinger-prod',
      action: auditId,
      targetType: 'gateway_read',
      targetId: path,
      riskLevel: 'low',
      metadata: { responseOk: false, error: String(err) }
    });
    return { endpoint: path, ok: false, error: String(err) };
  }
}

export interface GatewayReads {
  sendResults: ReadResult<unknown>;
  ipReputation: ReadResult<unknown>;
  stuckJobs: ReadResult<unknown>;
  senderNodes: ReadResult<unknown>;
  auditEvents: ReadResult<unknown>;
}

export async function fetchAllReads(): Promise<GatewayReads> {
  // Promise.allSettled — si uno falla, los demás siguen
  const [sr, ip, sj, sn, ae] = await Promise.all([
    readEndpoint('/v1/send-results', 'oc.read.send_results'),
    readEndpoint('/v1/ip-reputation/reports', 'oc.read.ip_reputation'),
    readEndpoint('/v1/stuck-jobs', 'oc.read.stuck_jobs'),
    readEndpoint('/v1/sender-nodes', 'oc.read.sender_nodes'),
    readEndpoint('/v1/audit-events?limit=50', 'oc.read.audit')
  ]);
  return { sendResults: sr, ipReputation: ip, stuckJobs: sj, senderNodes: sn, auditEvents: ae };
}
```

**Detalle:** `Promise.all` con catch interno por endpoint reemplaza
`Promise.allSettled` para mantener el tipo `ReadResult` uniforme — cada
`readEndpoint` ya nunca rechaza, captura su propio error y lo retorna como
`{ok: false}`. Es funcionalmente equivalente al fallback que tenemos en el
adapter Webdock (Hito 5.11.A).

## Paso 4 — `prompt-template.ts`

```typescript
import type { GatewayReads } from './gateway-reads.js';

export function buildDailyReportPrompt(reads: GatewayReads, today: string): string {
  const okEndpoints = Object.entries(reads).filter(([, r]) => r.ok).length;
  const failedEndpoints = 5 - okEndpoints;

  return `Eres OpenClaw, senior SRE de Delivrix LLC, proyecto JECT. Recibiste un pedido
del operador para generar el reporte diario operativo del ${today}.

Tienes ${okEndpoints} de 5 endpoints disponibles. ${failedEndpoints > 0 ? `${failedEndpoints} fallaron y se omiten honestamente.` : 'Todos los reads OK.'}

# Datos recolectados

## send-results
${reads.sendResults.ok ? JSON.stringify(reads.sendResults.data, null, 2).slice(0, 2000) : `(no disponible: ${reads.sendResults.error})`}

## ip-reputation
${reads.ipReputation.ok ? JSON.stringify(reads.ipReputation.data, null, 2).slice(0, 2000) : `(no disponible: ${reads.ipReputation.error})`}

## stuck-jobs
${reads.stuckJobs.ok ? JSON.stringify(reads.stuckJobs.data, null, 2).slice(0, 1000) : `(no disponible: ${reads.stuckJobs.error})`}

## sender-nodes
${reads.senderNodes.ok ? JSON.stringify(reads.senderNodes.data, null, 2).slice(0, 1500) : `(no disponible: ${reads.senderNodes.error})`}

## audit-events (últimos 50)
${reads.auditEvents.ok ? JSON.stringify(reads.auditEvents.data, null, 2).slice(0, 2000) : `(no disponible: ${reads.auditEvents.error})`}

# Tarea

Construye un reporte ejecutivo en markdown con estas secciones (en orden, sin saltearlas):

1. **Resumen ejecutivo** (3-4 frases)
2. **Métricas clave del día** (numeradas, 1 línea cada una)
3. **Top 5 hallazgos** (priorizados por severidad, formato: \`- [severity] descripción\`)
4. **Nodos en alerta** (lista de IDs con motivo, o "ninguno")
5. **Próximos pasos sugeridos para el operador** (máximo 3, accionables)

Restricciones duras:
- Citá solo lo que está en los datos. NO inventes métricas.
- Si un endpoint falló, mencionalo en el resumen ejecutivo y NO uses esa fuente.
- Longitud objetivo: 500-1500 caracteres totales.
- Markdown plano, sin tablas (el chat no las renderiza bien).
- Cero saludos, cero firmas. El operador ya sabe que sos OpenClaw.

Empezá directo con \`# Reporte diario · ${today}\`.`;
}
```

## Paso 5 — `handler.ts`

```typescript
import type { SkillContext, SkillResponse } from '@openclaw/skill-sdk';
import { auditLog } from '../../lib/audit.js';
import { callBedrockSonnet } from '../../lib/bedrock.js';
import { fetchAllReads } from './gateway-reads.js';
import { buildDailyReportPrompt } from './prompt-template.js';

const NOTION_API_KEY = process.env.NOTION_API_KEY;

export async function handler(ctx: SkillContext): Promise<SkillResponse> {
  const invokeId = crypto.randomUUID();
  const today = new Date().toISOString().slice(0, 10);

  await auditLog.append({
    actorType: 'openclaw',
    actorId: 'openclaw-hostinger-prod',
    action: 'oc.skill.report_ops.invoke',
    targetType: 'skill_invocation',
    targetId: invokeId,
    riskLevel: 'low',
    metadata: { skillSlug: 'delivrix-report-ops', triggerUtterance: ctx.utterance, today }
  });

  // 1. Pull reads
  const reads = await fetchAllReads();
  const okCount = Object.values(reads).filter((r) => r.ok).length;
  const failedCount = 5 - okCount;

  if (failedCount > 0) {
    await auditLog.append({
      actorType: 'openclaw',
      actorId: 'openclaw-hostinger-prod',
      action: 'oc.skill.report_ops.partial_data',
      targetType: 'skill_invocation',
      targetId: invokeId,
      riskLevel: 'low',
      metadata: {
        endpointsOk: okCount,
        endpointsFailed: failedCount,
        failedList: Object.entries(reads)
          .filter(([, r]) => !r.ok)
          .map(([k, r]) => ({ key: k, error: r.error }))
      }
    });
  }

  // 2. Build prompt + LLM call
  const prompt = buildDailyReportPrompt(reads, today);
  const llmResponse = await callBedrockSonnet({
    prompt,
    maxTokens: 1200,
    temperature: 0.4
  });

  // 3. Notion side-effect skip (decisión Hito 5.11.B → 5.12)
  if (!NOTION_API_KEY) {
    await auditLog.append({
      actorType: 'openclaw',
      actorId: 'openclaw-hostinger-prod',
      action: 'oc.skill.report_ops.notion_skipped',
      targetType: 'skill_invocation',
      targetId: invokeId,
      riskLevel: 'low',
      metadata: {
        reason: 'NOTION_API_KEY no presente; side-effect Notion omitido. Decisión auditada en .audit/decision-skip-notion-side-effect.md'
      }
    });
  } else {
    // Reactivación futura (Hito 5.12) — placeholder, no ejecuta hoy.
    // Si NOTION_API_KEY aparece sin haber implementado la escritura,
    // auditamos y seguimos sin romper.
    await auditLog.append({
      actorType: 'openclaw',
      actorId: 'openclaw-hostinger-prod',
      action: 'oc.skill.report_ops.notion_pending',
      targetType: 'skill_invocation',
      targetId: invokeId,
      riskLevel: 'low',
      metadata: {
        reason: 'NOTION_API_KEY presente pero escritura no implementada en MVP. Ver Hito 5.12.'
      }
    });
  }

  // 4. Audit completion
  await auditLog.append({
    actorType: 'openclaw',
    actorId: 'openclaw-hostinger-prod',
    action: 'oc.skill.report_ops.completed',
    targetType: 'skill_invocation',
    targetId: invokeId,
    riskLevel: 'low',
    metadata: {
      reportLengthChars: llmResponse.text.length,
      endpointsOk: okCount,
      endpointsFailed: failedCount,
      modelVersion: 'us.anthropic.claude-sonnet-4-6',
      promptVersion: 'daily-report-v1',
      tokensUsed: llmResponse.tokensUsed
    }
  });

  // 5. Devolver el reporte como respuesta de chat
  return {
    output: llmResponse.text,
    metadata: {
      source: 'openclaw-managed',
      skillSlug: 'delivrix-report-ops',
      invokeId,
      endpointsOk: okCount,
      endpointsFailed: failedCount,
      notionSideEffect: NOTION_API_KEY ? 'pending' : 'skipped'
    }
  };
}
```

## Paso 6 — `index.ts` (export agregador)

```typescript
import { descriptor } from './descriptor.js';
import { handler } from './handler.js';
export default { descriptor, handler };
```

Registrarlo en el agregador raíz de skills (mismo patrón que drift-monitor y
alert-ops):

```typescript
// services/openclaw-skills/src/index.ts
import reportOps from './skills/delivrix-report-ops/index.js';
// ... existentes
export const skills = [driftMonitor, alertOps, fleetOps, webdockInventorySync, reportOps];
```

## Paso 7 — Build + deploy

```bash
cd "${WORKTREE}/services/openclaw-skills"
npm run build

# Copiar a container
ssh root@2.24.223.240 'mkdir -p /opt/openclaw/skills'
docker cp dist/ openclaw-dtsf-openclaw-1:/opt/openclaw/skills/

# Reload del agente
ssh root@2.24.223.240 'docker exec openclaw-dtsf-openclaw-1 kill -HUP 1'

# Verificar que aparece como eligible
ssh root@2.24.223.240 'docker exec openclaw-dtsf-openclaw-1 sh -c "ls /opt/openclaw/skills/dist/skills/"'
# Esperado: alert-ops/  delivrix-fleet-ops/  delivrix-report-ops/  drift-monitor/  webdock-inventory-sync/
```

## Paso 8 — Smoke real

Abrir OpenClaw en el dashboard de Hostinger (o vía API si ya está conectado el
frontend del agente al panel Delivrix) y escribir:

```
correr report-ops
```

**Resultado esperado en chat:**

```markdown
# Reporte diario · 2026-05-18

## Resumen ejecutivo
Operación estable. 5/5 endpoints respondieron. ...

## Métricas clave del día
1. send_results: ...
2. ip_reputation: ...
...

## Top 5 hallazgos
- [medium] svc-warmup-02 con drift Webdock pendiente de aprobación
- [low] ...
...

## Nodos en alerta
- svc-warmup-02 (Webdock drift)

## Próximos pasos sugeridos
1. Revisar plan dry-run para svc-warmup-02
2. ...
```

Si Webdock 401 o algún read falla, el reporte debe mencionarlo honestamente
en el resumen ejecutivo, no inventar datos.

## Paso 9 — Verificar audit

```bash
# Tail del audit JSONL local del Gateway
tail -50 "${WORKTREE}/.audit/audit-events.jsonl" | grep -E 'report_ops|read\.'
```

Eventos esperados (1 invocación):

```
oc.skill.report_ops.invoke
oc.read.send_results
oc.read.ip_reputation
oc.read.stuck_jobs
oc.read.sender_nodes
oc.read.audit
oc.skill.report_ops.notion_skipped    (si NOTION_API_KEY ausente)
oc.skill.report_ops.completed
```

Si algún endpoint falló, también:

```
oc.skill.report_ops.partial_data
```

## Paso 10 — Validación final

- [ ] `npm test` (incluyendo posibles tests del skill) — sin regresiones
- [ ] Skill aparece como eligible en OpenClaw (verificable via
      `triggerPhrases` matching o listado nativo del agente)
- [ ] Reporte sale como markdown válido, longitud 500-1500 chars
- [ ] Audit chain completo (8 eventos por invocación con todos los reads OK)
- [ ] Decision file `.audit/decision-skip-notion-side-effect.md` sigue intacto
      (no se modifica este OPS, solo se referencia)
- [ ] Plugin queda listo para reactivar Notion en Hito 5.12 con cero cambio
      de código: basta inyectar `NOTION_API_KEY` y agregar la rama de
      escritura debajo del bloque `notion_pending`

## Cuándo cerrar D+4 PM

Verde cuando:

1. **Smoke chat OK** — operador invoca, reporte sale con secciones esperadas.
2. **Audit chain completo** — 7-8 eventos por invocación.
3. **Fallback honesto** — si forzás un endpoint a fallar (ej. apagar Gateway
   1s), el reporte lo menciona en el resumen y no inventa.
4. **Notion skip auditado** — log `oc.skill.report_ops.notion_skipped` aparece.

## Lo que NO entra en D+4 PM

- **Cron auto-emisión** — diferido a Hito 5.12 cuando haya consumo no-técnico
  pasivo.
- **Tarjeta info en canvas** — no se inyecta nada al canvas (decisión
  operador).
- **Escritura real a Notion** — diferido a Hito 5.12 cuando el operador
  tenga rol Workspace Owner.
- **Persistencia local de reportes históricos** — cada invocación es
  ephemeral. El audit JSONL captura metadata; el texto completo del
  reporte vive solo en el chat de OpenClaw. Si más adelante necesitamos
  histórico, agregamos SQLite local en Hito 5.12.
