# OPS — Safety real-time Ola 1 (compliance + iam/roles + iam/sessions)

**Fecha:** 2026-05-20
**Sub-hito:** Integración real-time OpenClaw → admin panel, Ola 1 (Safety section)
**Ejecutor:** Codex
**Decisor humano:** Juanes (operador)
**Pencil:** trabajo paralelo (estados visuales nuevos — ver §8)

## 1. Contexto

Hoy las 3 cards de la sección Safety del admin panel se alimentan de **builders mock** en `packages/domain/src/`:

- `buildComplianceStatus()` — 3 controles GDPR/operativo/anti-abuse con strings literales
- `buildIamRoles()` — 4 roles canónicos con `userCount` hardcoded
- `buildIamSessions()` — 3 sesiones representativas con `minutesAgo` relativo a `now()`

El sub-hito reemplaza esos builders con **queries reales** sobre el audit log y estado del agente, manteniendo:

- El shape del contrato actual (`ComplianceStatusContract`, `IamRolesContract`, `IamSessionsContract`).
- Los textos literales MVP que ya están en main (Popayán, "31 gates", permisos detallados, etc.) como **valores por defecto / fallback** cuando los datos reales no aplican.

## 2. Scope

**Dentro:**

- Modificar los 3 builders (`compliance-status.ts`, `iam-supervised.ts`) para que reciban una fuente de datos opcional (audit log + agent state) y calculen valores dinámicos cuando esté disponible.
- Modificar handlers en `apps/gateway-api/src/main.ts` que sirven `/v1/compliance/status`, `/v1/iam/roles`, `/v1/iam/sessions` para invocar los builders con la fuente real.
- Cachear última respuesta exitosa por endpoint con `staleSinceMs`. Si query falla, devolver cache.
- Polling 30s desde el frontend (configurable por endpoint).
- Agregar 2 campos opcionales al payload: `dataSource: "live" | "cached" | "fallback"` y `staleSinceMs: number | null`.

**Fuera:**

- Cambios al bundle frontend (componentes React). Esos vienen después con los frames Pencil.
- Endpoints de Learning (`/v1/openclaw/skills/audit`, `/v1/openclaw/evidence`). Esos son Ola 2.
- Llamar a OpenClaw vía HTTP. Toda la lógica de Ola 1 vive sobre el audit log local; el agente ya escribe ahí vía batch endpoint.

## 3. Diseño por endpoint

### 3.1 `GET /v1/compliance/status`

Calcular `state` de cada control desde el audit log `.audit/audit-events.jsonl` con reglas determinísticas:

| Control | Estado deriva de | Regla |
|---|---|---|
| `gdpr` | Sin envíos reales en últimos 30d + audit chain integrity | `ok` si 0 eventos con action que contenga `smtp.send.real` + verify-chain OK. Si chain rota → `critical`. |
| `operational` | % de propuestas con `humanApproved=true` últimas 24h + kill switch state | `ok` si %humanApproved >= 100% para riskLevel medium+ y killSwitch.armed. `warning` si %<100%. `critical` si killSwitch.disabled con propuestas pendientes. |
| `anti-abuse` | Bypass attempts + propuestas rechazadas por `prohibited_action` | `ok` si 0 bypass + 0 prohibited rejections en 30d. `warning` si hay rejections (esperado). `critical` si hay bypass detectado. |

`lines` por control: 3 strings literales como hoy (textos MVP) pero agregar al final el valor calculado, por ejemplo:

```ts
{
  id: "operational",
  title: "Cumplimiento operativo",
  state: "warning",  // calculado
  lines: [
    "31 gates del MVP · 7 requieren revisión humana",
    "Dry-run obligatorio antes de cualquier escritura real",
    "Kill switch global probado en simulación",
    "Última verificación: 14/15 propuestas aprobadas en 24h"  // ← nuevo, dinámico
  ],
  runbookRef: "operating-north-runbook.md",
  evaluatedAt: "2026-05-20T16:35:00Z",  // ← nuevo
  metrics: {  // ← nuevo, opcional para debug
    humanApprovedRate: 0.933,
    pendingProposals: 1,
    killSwitchState: "armed"
  }
}
```

### 3.2 `GET /v1/iam/roles`

Mantener los 4 roles canónicos como están. Cambiar **solo** el campo `userCount` para que sea derivado del audit log:

- `operator`: count distinct `actorId` con `actorType=operator` y action que empiece con `oc.proposal.approved` o `oc.runbook.*.executed` en últimos 30d.
- `sre`: count distinct `actorId` con `actorType=system` que haya emitido eventos `oc.skill.*` o tocado `/v1/hardware/*` (de las evidenceRefs).
- `external-auditor`: count distinct `actorId` con `actorType=operator` y único action `read:audit-events` en últimos 30d (placeholder por ahora — sin auditores externos en MVP).
- `read-only`: fijo en 5 hasta que tengamos IdP real (placeholder).

```ts
{
  id: "operator",
  name: "Operador",
  color: "amber",
  userCount: 1,  // ← calculado: distinct actorIds (en MVP solo op-juanes-a/op-juanes-b → 2)
  permissions: [...],  // ← sin cambios
  countDerivedFrom: "audit log 30d, oc.proposal.approved + oc.runbook.*.executed"  // ← nuevo
}
```

### 3.3 `GET /v1/iam/sessions`

Reemplazar las 3 sesiones hardcoded por una **union real**:

- **(a)** Approval tokens vigentes (no expirados) → 1 sesión por token, actor = `metadata.approverId`, transport = "mfa", risk = riskLevel del token mapeado a low/medium/high.
- **(b)** Eventos con `actorType=operator` últimos 15 min → 1 sesión por actorId, dedupe.
- **(c)** Chat sessions OpenClaw (eventos con `sessionKey` últimos 15 min, derivado de metadata cuando esté) → opcional, depende de si el audit captura `sessionKey`.

Campos hoy hardcoded que deben quedar **derivados o nulos**:

- `actor`: del audit (actorId o metadata.approverId).
- `location`: si el audit captura IP/region en metadata → derivar; si no → `"-"` (no inventar Popayán/Bogotá/Madrid).
- `transport`: derivado del tipo de evento (operator local = "vpn", token = "mfa", agent = "internal").
- `startedAt` / `lastSeenAt`: primer/último timestamp del actorId en la ventana.
- `risk`: derivar del riskLevel promedio del actorId.

Si no hay sesiones reales en la ventana de 15 min → devolver `sessions: []` con `dataSource: "live"`. **No inventar sesiones para evitar UI vacía.**

## 4. Shape del payload — nuevos campos comunes

Cada respuesta agrega 2 campos opcionales al top level:

```ts
export interface RealTimeMeta {
  dataSource: "live" | "cached" | "fallback";
  staleSinceMs: number | null;  // null si dataSource=live; ms desde última query exitosa si cached/fallback
  evaluatedAt: string;  // ISO timestamp del cálculo más reciente
}

export interface ComplianceStatusContract {
  controls: ComplianceControl[];
  meta: RealTimeMeta;  // ← nuevo
}

// idem para IamRolesContract, IamSessionsContract
```

## 5. Cache y fallback

- Gateway mantiene un `Map<endpoint, {payload, fetchedAt}>` en memoria.
- En cada GET: intenta query real. Si OK, actualiza cache + responde `dataSource: "live"`, `staleSinceMs: null`.
- Si query falla (audit chain broken, no data, exception): responde cache con `dataSource: "cached"`, `staleSinceMs = now - fetchedAt`.
- Si no hay cache aún (primera query falló): responde el mock builder actual con `dataSource: "fallback"`, `staleSinceMs: null`.

Estructura del cache:

```ts
type EndpointCache = Map<string, {
  payload: unknown;
  fetchedAt: number;  // Date.now()
}>;
```

## 6. Frontend (sin cambios en este Ola)

Los componentes React de Safety ya consumen los endpoints vía `READ_ENDPOINTS`. No tocar el bundle. Los nuevos campos `meta.dataSource` y `meta.staleSinceMs` van a estar disponibles para cuando los frames Pencil de los nuevos estados estén listos (sub-task paralela).

## 7. Verificación

- `npm test` debe seguir pasando.
- `npm run test:admin` debe seguir pasando (el bundle no cambió).
- Agregar tests unitarios para los 3 builders modificados:
  - Caso 1: audit log vacío → builders devuelven defaults MVP, `dataSource: "fallback"`.
  - Caso 2: audit log con eventos reales → builders calculan valores correctos.
  - Caso 3: cache hit → segundo GET dentro de 30s devuelve cached.
- Smoke manual: `curl http://localhost:3000/v1/compliance/status | jq` debe mostrar `meta.dataSource` poblado.
- `verify-chain.ts` debe seguir verde después de implementar.

## 8. Trabajo paralelo de Pencil (Juanes / Claude con Pencil tools)

Estados visuales nuevos que necesitan frames Pencil antes del port al panel:

1. **Stale data warning** — banner amarillo en card "Última actualización: hace 12 m" cuando `meta.dataSource === "cached"`.
2. **Fallback warning** — banner gris claro "Mostrando valores de respaldo" cuando `dataSource === "fallback"`.
3. **Loading skeleton** — shimmer en cards mientras polling 30s espera primera respuesta.
4. **Tick / refresh animation** — sutil pulse cuando un valor cambia entre polls (especialmente `userCount` en IAM y `state` en compliance).
5. **Empty state IAM sessions** — cuando `sessions: []`, mostrar mensaje "Sin sesiones activas en últimos 15 min" en vez de tabla vacía.

Esfuerzo estimado Pencil: ~1.5 h de diseño. No bloquea el backend de Codex.

## 9. Restricciones para Codex

- **No** cambiar el shape de `ComplianceControl`, `IamRole`, `IamSession`. Solo agregar campos opcionales nuevos (`evaluatedAt`, `metrics`, `countDerivedFrom`).
- **No** modificar los componentes React de Safety. Esto se hace en sub-task paralela después de los frames Pencil.
- **No** llamar a OpenClaw vía HTTP en esta Ola. Toda la información viene del audit log local.
- **No** romper los tests existentes. Si algún test asume el mock actual, ajustar para que tolere los nuevos campos.
- **No** tocar el detector C2 (`scripts/openclaw/smoke-c2-gates.ts`) — esa es task #10 separada.
- **No** invadir el scope de Ola 2 (Learning). `/v1/openclaw/skills/audit` y `/v1/openclaw/evidence` siguen como mocks hasta que arranquemos Ola 2.

## 10. Reporte esperado al terminar

```
SAFETY REAL-TIME OLA 1 — implementado

builders modificados: compliance-status.ts, iam-supervised.ts
endpoints actualizados: /v1/compliance/status, /v1/iam/roles, /v1/iam/sessions
cache: in-memory Map, hits funcionando, fallback a builder OK
tests: <N>/<N> verdes (X nuevos para builders dinámicos)
verify-chain: events_total=<N>, chain_ok=<N>, OK
smoke curl: 3 endpoints retornan payload con meta.dataSource poblado

next action: Pencil termina frames de estados nuevos, después port al bundle
```

## 11. Referencias

- Read boundary actual: `apps/admin-panel/src/shared/api/read-boundary.ts`
- Builders mock actuales: `packages/domain/src/compliance-status.ts`, `iam-supervised.ts`
- Audit chain: `.audit/audit-events.jsonl` (formato definido en `apps/gateway-api/src/audit/schema.ts`)
- Gateway main: `apps/gateway-api/src/main.ts` (handlers línea 381+ para los 3 endpoints actuales)
- Doc rector Hito 5.11.B (cerrado): `DOCUMENTACION/HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md`
- Sub-hito sucesor potencial Ola 2 (Learning): `/v1/openclaw/skills/audit`, `/v1/openclaw/evidence`
