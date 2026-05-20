# OPS — Learning Real-Time Ola 2 (skills/audit + evidence)

**Fecha:** 2026-05-20
**Sub-hito:** Ola 2 — integración real-time OpenClaw → admin panel, sección Aprendizaje
**Ejecutor:** Codex
**Decisor humano:** Juanes (operador)
**Pre-requisito:** Ola 1 Safety real-time completa (`9d31d7d` backend + `f579368` frontend) — patrones cache/fallback/meta/componentes ya probados.

## 1. Contexto

Sección Aprendizaje del admin panel hoy renderiza 2 listas mock desde builders en `packages/domain/src/openclaw-skills-audit.ts`:

- **"Bitácora del aprendizaje"** ← `buildOpenClawSkillsAudit()` (5 eventos hardcoded con sha256 estable)
- **"Evidencia curada por OpenClaw"** ← `buildOpenClawEvidence()` (6 snapshots hardcoded)

Ola 2 reemplaza ambos builders con queries reales sobre el audit log `.audit/audit-events.jsonl`, manteniendo el shape del contrato (`OpenClawSkillsAuditContract`, `OpenClawEvidenceContract`) y los textos literales MVP como fallback.

## 2. Estado real del audit log (insumos verificados 2026-05-20)

| Patrón | Conteo | Uso |
|---|---|---|
| `oc.skill.*` (fleet_ops invoke/proposal, publish_proposal invoke/completed) | 9 eventos | feed primario de Bitácora |
| `oc.proposal.submitted` + `oc.proposal.approved` | 26 eventos | feed secundario Bitácora (decisiones humanas) |
| `oc.runbook.*.executed` + `oc.runbook.*.reverted` | 14 eventos | feed evidencia |
| eventos con `evidenceRefs` no vacío | 13 candidatos | feed primario de Evidencia |

## 3. Scope

**Dentro:**

- Modificar `packages/domain/src/openclaw-skills-audit.ts` — builders dinámicos sobre audit log + fallback textos MVP
- Modificar handlers en `apps/gateway-api/src/main.ts` líneas 393-400 (rutas existentes)
- Reusar el wrapper de cache + `meta.dataSource` + `meta.staleSinceMs` introducido en Ola 1 (`9d31d7d`)
- Polling 30s desde frontend (consistente con Ola 1)

**Fuera:**

- Cambios al bundle frontend (eso va en sub-OPS port React separado tras este)
- Llamar a OpenClaw vía HTTP. Toda data viene del audit log local (agente ya escribe ahí vía batch endpoint, ver Hito 5.11.B `OPENCLAW_AUDIT_INTEGRATION.md`)
- Tocar Ola 1 (Safety). Endpoints Safety ya están cerrados.

## 4. Diseño por endpoint

### 4.1 `GET /v1/openclaw/skills/audit`

**Source-of-truth:** últimos 50 eventos del audit log filtrados por:
- `actorType === "openclaw"`, o
- `action` empieza con `oc.skill.`, o
- `action` ∈ {`oc.proposal.submitted`, `oc.proposal.approved`, `oc.proposal.resolved`}

**Mapeo audit event → OpenClawSkillsAuditEvent:**

```ts
{
  id: event.id,                        // UUID del audit event
  occurredAt: event.occurredAt,        // ISO timestamp
  action: event.action,                // string del audit (e.g. "oc.skill.fleet_ops.invoke")
  actor: event.actorId,                // e.g. "openclaw-hostinger-prod" o "op-juanes-a"
  body: deriveBody(event),             // descripción humana derivada de metadata
  skillId: event.metadata?.skillSlug || extractSkillFromAction(event.action),  // opcional
  lessonId: event.metadata?.lessonId   // opcional (puede no existir en audit actual)
}
```

**Función `deriveBody(event)`** — mapeo determinístico:

| action | body derivado |
|---|---|
| `oc.skill.fleet_ops.invoke` | `"Skill fleet_ops invocada · ${meta.endpointsOk}/${meta.endpointsTotal} endpoints OK · ${meta.driftCount} drift"` |
| `oc.skill.fleet_ops.proposal` | `"Skill fleet_ops emitió propuesta de runbook"` |
| `oc.skill.publish_proposal.invoke` | `"Skill publish_proposal invocada para ${meta.runbookId} sobre ${meta.targetRef}"` |
| `oc.skill.publish_proposal.completed` | `"Propuesta inyectada en Canvas · proposalId=${meta.proposalId.slice(-16)}"` |
| `oc.proposal.submitted` | `"OpenClaw propuso ${meta.category} sobre ${meta.targetRef} · severity ${meta.severity}"` |
| `oc.proposal.approved` | `"${event.actorId} aprobó propuesta · target ${meta.targetRef}"` |
| `oc.proposal.resolved` | `"Propuesta resuelta: ${meta.decision}"` |
| fallback | `"${event.action} · ${event.actorId}"` |

**Orden:** descending por `occurredAt`, limit 50 (cabe en una pantalla con scroll).

**Si audit vacío o filter no match:** devolver textos MVP del builder actual (fallback).

### 4.2 `GET /v1/openclaw/evidence`

**Source-of-truth:** eventos del audit log con `evidenceRefs.length > 0`, dedup por `proposalHash`/`evidenceRefs[0]`. Hasta 20 más recientes.

**Mapeo audit event → OpenClawEvidenceItem:**

```ts
{
  snapshotId: shortHash(event.evidenceRefs[0]) || `snap-${event.id.slice(0,8)}`,
  type: deriveType(event),             // ver tabla
  description: deriveDescription(event), // body derivado
  actor: event.actorId,
  capturedAt: event.occurredAt.slice(0, 10), // YYYY-MM-DD
  mode: "get-only",
  impact: deriveImpact(event)          // alto | medio | bajo según riskLevel + severity
}
```

**`deriveType(event)`:**
| condición | type |
|---|---|
| action `oc.proposal.submitted`, category `node_pause_proposed` o `quarantine` | `"Promo skill"` |
| action `oc.skill.fleet_ops.invoke` con `driftCount > 0` | `"DNS drift"` o `"Webdock drift"` según evidence URL |
| action `oc.proposal.approved` | `"Evidencia humana"` |
| action `oc.runbook.*.executed` | `"Promoción"` |
| action `oc.skill.*` con `endpointsOk < endpointsTotal` | `"Evaluación"` |
| fallback | `"Curated lesson"` |

**`deriveImpact(event)`:** `event.riskLevel === "high"` o `meta.severity === "critical"` → `"alto"`; `severity === "high"` → `"medio"`; resto → `"bajo"`.

**Si audit sin evidenceRefs:** fallback al builder mock actual (6 snapshots hardcoded).

## 5. Shape del payload con meta

Reusar `RealTimeMeta` introducido en Ola 1:

```ts
export interface OpenClawSkillsAuditContract {
  events: OpenClawSkillsAuditEvent[];
  meta: RealTimeMeta;  // ← nuevo
}

export interface OpenClawEvidenceContract {
  curated: OpenClawEvidenceItem[];
  meta: RealTimeMeta;  // ← nuevo
}
```

## 6. Cache y fallback

Mismo patrón de Ola 1 (in-memory Map por endpoint, TTL implícito por polling, fallback al builder mock si query falla o devuelve 0 items aprovechables).

## 7. Trabajo paralelo de Pencil

Reusar 3 componentes ya existentes (Ola 1):
- `JeXwj` Stale Data Badge — para corner de cards Bitácora
- `GVCBF` Fallback Banner — para top de sección Aprendizaje
- `hlLkJ` Realtime Tick — para indicar eventos nuevos arriba de la lista

**Componentes nuevos a diseñar en Pencil (~30 min Claude):**

1. **Skeleton Row** — esqueleto para una fila de la Bitácora mientras carga. ~480×52, 3 rectángulos: timestamp 80×10, body 320×14, badge 60×20.
2. **Empty Events Card** — variante de `ZXqFn` (Empty Sessions) con icon `inbox_off`, título "Sin eventos del agente", footer "Refresca cada 30 s". Reusable para Bitácora vacía.
3. **Empty Evidence Card** — variante con icon `description_off`, título "Sin evidencia curada", footer mismo.

Si después decides que 2 y 3 son demasiado similares, hacemos uno genérico `EmptyDataCard` con prop `kind: "sessions" | "events" | "evidence"` (decisión post-revisión).

Ubicación: agregar al frame `u10Bpu` "Componentes / Estados Real-Time" existente (al final).

## 8. Verificación

1. `npm test` — debe seguir verde (191/191).
2. `npm run test:admin` — debe seguir verde (17/17 actuales).
3. Agregar tests para los 2 builders modificados:
   - Caso 1: audit log vacío → fallback al mock
   - Caso 2: audit log con eventos reales → builders mapean correctamente
   - Caso 3: cache hit → cached con staleSinceMs
4. Smoke curl:
   - `curl http://localhost:3000/v1/openclaw/skills/audit | jq '.meta'` → debe tener `dataSource: "live"` y `staleSinceMs: null`
   - Segundo curl en <30s → `dataSource: "cached"`
   - `curl .../v1/openclaw/evidence | jq '.curated | length'` → > 0 si audit tiene evidenceRefs

## 9. Restricciones

- **No** modificar Ola 1 (Safety) — endpoints y builders Safety ya cerrados.
- **No** llamar a OpenClaw vía HTTP. Solo lectura del audit log local.
- **No** cambiar shape de `OpenClawSkillsAuditEvent` u `OpenClawEvidenceItem` — solo agregar campos opcionales si necesario.
- **No** tocar la lógica de hash chain del audit (verify-chain.ts debe seguir verde 212+).
- **No** invadir Hito 5.12 (multi-provider). Solo Learning.

## 10. Reporte esperado al terminar

```
LEARNING REAL-TIME OLA 2 — implementado

builders modificados: openclaw-skills-audit.ts (2 builders dinámicos)
endpoints actualizados: /v1/openclaw/skills/audit, /v1/openclaw/evidence
cache: in-memory, hits funcionando, fallback a mock OK
test: N/N verdes (X nuevos para mappers + cache)
verify-chain: events_total=N, chain_ok=N, OK
smoke curl: 2 endpoints con meta.dataSource live; segundo curl cached

next action: Pencil components nuevos + port React Ola 2
```

## 11. Próximos OPS (después de este)

1. **OPS Pencil Ola 2** — diseñar SkeletonRow + EmptyEventsCard + EmptyEvidenceCard (yo)
2. **OPS Port React Ola 2** — port a React + cableo en `apps/admin-panel/src/features/learning/index.tsx` (Codex)

## 12. Referencias

- Ola 1 backend (patrón a copiar): `DOCUMENTACION/OPS_OPENCLAW_SAFETY_REALTIME_OLA1.md` + commit `9d31d7d`
- Ola 1 frontend (referencia para Ola 2 port): `DOCUMENTACION/OPS_OPENCLAW_SAFETY_REALTIME_OLA1_PORT_REACT_V2.md` + commit `f579368`
- Audit chain spec: `DOCUMENTACION/OPENCLAW_AUDIT_INTEGRATION.md`
- Builders mock actuales: `packages/domain/src/openclaw-skills-audit.ts`
- Pencil source: `DOCUMENTACION/design/Panel_Front_End.pen`
