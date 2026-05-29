# OPS Codex — Resolver items backend de auditoría frontend

**Para:** Codex.
**De:** Claude (PM + Frontend senior).
**Fecha:** 2026-05-28 jueves, tarde.
**Prioridad:** Alta — items del backend que bloquean cierre de auditoría visual pre-demo viernes.
**Tiempo estimado:** ~6h totales, organizables en 2 sesiones de ~3h.

---

## Contexto

Hice una auditoría completa de las 11 vistas del panel admin con Chrome MCP y criterio senior frontend. Doc completo en `DOCUMENTACION/AUDITORIA_FRONTEND_COMPLETA_2026_05_28.md` (lectura recomendada antes de empezar).

Yo (Claude) ya cerré los **4 CRÍTICOS frontend** en este sesión:

- A-CRIT-02 chips Live + Idle unificados (`canvas-v4.tsx`).
- A-CRIT-03 errores SSH a lenguaje operativo + collapsible (`canvas-v4.tsx`).
- A-CRIT-04 guard de gráficas Hardware cuando series vacías (`hardware/index.tsx`).
- A-CRIT-01 B filtro frontend de tareas fallidas conversacionales (`canvas-live-client.ts` + `canvas-v4.tsx`).

Este OPS cubre los items de la **columna Codex** + decisiones acordadas con Juanes:

1. **Defensa en profundidad para A-CRIT-01** — A + B. Yo hice B (filtro frontend). Vos hacés A (limpieza workspace) — 10 min.
2. **Traducir 22 gates a español** — Juanes pidió hacerlo ahora, no post-demo.
3. **5 items MEDIO de tu columna**.
4. **3 items BAJO de tu columna**.

---

## Tareas

### Tarea 1 — A-CRIT-01-A · Limpieza workspace de tareas fallidas (10 min)

**Problema:** el Canvas Live sidebar muestra 2 tareas fallidas top:

- `🔴 necesito que configures un nue... fallida hace ~30m`
- `🔴 Ok, hemos adquirido un nuevo ... fallida hace ~30m`

Son falsos positivos del extractor de intent del Bloque 9 — Juanes mandó contexto conversacional al agente, el extractor lo clasificó como intent ejecutable, no hubo skill que lo matchee, terminó `status=failed`.

Para el demo viernes (mañana 11h Colombia) NO pueden aparecer.

**Acción:**

```bash
cd "/Users/juanescanar/Documents/delivrix app/runtime/openclaw-workspace/executions"

# 1. Localizar los archivos
find . -name "*.md" -newer 2026-05-28 -not -newer 2026-05-29 | xargs grep -l "necesito que configures\|Ok, hemos adquirido" 2>/dev/null

# 2. Confirmar matches con Juanes antes de borrar
# 3. Borrar los 2 archivos identificados
# 4. Forzar reemision del snapshot del Canvas Live (si tu stream cachea, restart del WSS o invalida cache)
```

**Verificación:** abrir `localhost:5173/canvas` y confirmar que las 2 tasks ya no aparecen en el sidebar TAREAS.

**Defensa futura:** ya implementé filtro frontend (A-CRIT-01-B) que oculta tareas fallidas root sin actions/artifacts con `<5 min` de antigüedad + toggle "Mostrar N ocultas". Si durante el demo se crea otra falsa intent, queda invisible automáticamente.

**Post-demo (Sprint S1):** Opción C — mejorar el extractor del Bloque 9 para que NO cree task si:
- El mensaje del operador no contiene verbos de intent ejecutable conocidos (whitelist).
- O el LLM clasificador devuelve `confidence < 0.7` sobre que es intent vs contexto/pregunta.

Tiempo estimado de C: 3-4h. Solo cuando ya no aprieta el demo.

---

### Tarea 2 — A-ALT-02 · Localizar 22 gates a español operativo (2h)

**Problema:** en `/` Vista General → sidebar derecho "Gates no negociables" 22 gates en estado `revisión pendiente` están en inglés técnico truncado:

- `no real email from delivrix`
- `admin panel reads cluster state from backend contract`
- `admin panel reads canvas and hardware from backend contracts`
- etc.

Para los jefes del viernes es ruido.

**Acción:**

1. Localizar el JSON/TS que define los gates. Probable ubicación: `apps/gateway-api/src/services/operating-north.ts` o `packages/domain/src/operating-north.ts`.
2. Agregar `displayLabel: string` (ES) y opcionalmente `description: string` (ES, 1 frase larga) a cada gate.
3. Mapeo sugerido (modificá los textos si no te gustan, criterio operativo + claro):

| Gate slug (inglés) | displayLabel (español) |
|---|---|
| `no_real_email_from_delivrix` | `Sin envíos reales — gate del norte MVP` |
| `admin_panel_reads_cluster_state_from_backend_contract` | `Panel lee estado de clusters vía contrato gateway` |
| `admin_panel_reads_canvas_and_hardware_from_backend_contracts` | `Panel lee Canvas y hardware vía contrato gateway` |
| `openclaw_learning_uses_curated_evidence` | `Aprendizaje de OpenClaw usa evidencia curada` |
| `hardware_telemetry_starts_mock_or_supervised` | `Telemetría de hardware arranca mock o supervisada` |
| `devops_collector_must_declare_source` | `Recolector debe declarar fuente verificada` |
| `supervised_collector_sources_required` | `Fuentes del recolector deben ser supervisadas` |
| `collector_snapshots_must_be_redacted` | `Snapshots del recolector deben redactar secretos` |
| `manual_snapshot_ingestion_requires_audit` | `Ingesta manual de snapshot requiere audit` |
| `admin_panel_must_not_post_manual_evidence` | `Panel admin no puede postear evidencia manual` |
| `ml_readiness_signals_must_not_self_promote` | `Signals de readiness no pueden auto-promoverse` |
| `openclaw_onboarding_before_topology_plan` | `Onboarding OpenClaw antes de plan de topología` |
| `topology_plan_before_provisioning_dry_run` | `Plan de topología antes de provisioning dry-run` |
| `provisioning_dry_run_before_live_application` | `Provisioning dry-run antes de aplicación live` |
| `scheduler_must_observe_report_and_pause` | `Scheduler debe observar, reportar y pausar` |
| `permission_matrix_before_limited_execution` | `Matrix de permisos antes de ejecución limitada` |
| `kill_switch_proof_before_phase_5_deploys` | `Prueba de kill switch antes de despliegues fase 5` |
| `mvp_demo_blueprint_before_demo_real` | `Blueprint del demo MVP antes de demo real` |

(Si los slugs no coinciden exactamente, ajustá. Lo importante es que CADA gate tenga `displayLabel` en español.)

4. Endpoint que sirve esto: `GET /v1/operating-north`. Agregar `displayLabel` (y `description` si querés) al schema del gate retornado.

**Yo (Claude) después agrego:**

- Tooltip al hover de cada gate con `displayLabel + description`.
- Render preferente: si `displayLabel` está, usalo. Si no, fallback al slug actual.

Para el frontend yo lo cerro mañana viernes a primera hora cuando vea tu commit. ~1h Claude.

---

### Tarea 3 — A-ALT-04 · Webdock × 3 cuentas separadas en inventory (1h)

**Problema:** `/infrastructure` header dice `Webdock × 3 cuentas, AWS Route53, ...` pero el grid solo muestra **1 card Webdock** (Claude · DK con 7 items).

**Hipótesis:** el endpoint `GET /v1/infrastructure/inventory` solo retorna 1 cuenta agregada o solo descubre el `WEBDOCK_API_KEY_PRIMARY`.

**Acción:**

1. Verificar que `apps/gateway-api/src/services/infrastructure-inventory.ts` (o equivalente) intenta leer las 3 keys:
   - `WEBDOCK_API_KEY_PRIMARY`
   - `WEBDOCK_API_KEY_OPS`
   - `WEBDOCK_API_KEY_ACCOUNT`
2. Cada key apunta a una cuenta Webdock distinta. Para cada una, hacer un fetch del inventory.
3. Retornar 3 entries separadas en el array `providers[]`:

```typescript
{
  id: "webdock-primary",
  provider: "Webdock",
  label: "Claude · DK · PRIMARY",
  scope: "Compute · read-only",
  itemCount: 7,
  lastFetchAt: "2026-05-28T16:18:42.123Z",
  source: "live"
},
{
  id: "webdock-ops",
  provider: "Webdock",
  label: "Claude · DK · OPS",
  scope: "Compute · server writes",
  itemCount: 0,
  lastFetchAt: "2026-05-28T16:18:42.123Z",
  source: "live"
},
{
  id: "webdock-account",
  provider: "Webdock",
  label: "Claude · DK · ACCOUNT",
  scope: "SSH keys mgmt",
  itemCount: 2,
  lastFetchAt: "2026-05-28T16:18:42.123Z",
  source: "live"
}
```

**Verificación:** `/infrastructure` muestra 3 cards Webdock distinguibles por `label`.

---

### Tarea 4 — A-MED-03 · Traducir titles de tasks B8/B9 a frases operativas (30 min)

**Problema:** las tasks del Canvas tienen titles tipo `B8 B9 finish T5 T6 cleanup` — nomenclatura interna del equipo, jerga ininteligible para jefes externos.

**Acción:** localizar dónde se generan los `title` de tasks (puede ser en `oc.task.declare` o en el supervisor del Bloque 10). Mapear los conocidos:

| Slug interno | Frase operativa |
|---|---|
| `B8 B9 finish T5 T6 cleanup` | `Cierre demo SMTP staging (T5+T6)` |
| `B8 finish` | `Cierre Bloque 8 — provisioning` |
| `B9 finish` | `Cierre Bloque 9 — extractor de intent` |
| `T7B extractor` | `Extractor de intent` |
| `T7C supervisor` | `Supervisor multi-agent` |

Si las tasks vivas no permiten cambio retroactivo, al menos asegurar que las NUEVAS tasks (las que se creen en el demo) usen frases en español.

---

### Tarea 5 — A-MED-05 · Campo `environment` debe ser `mvp.local`, no `5.9-manual-snapshot-ingestion-ux` (30 min)

**Problema:** `/onboarding` SECCIÓN 1 muestra `ENTORNO: 5.9-manual-snapshot-ingestion-ux`. Para un jefe es nombre de sprint interno, no un environment legible.

**Acción:**

En el endpoint que sirve onboarding state (probable `GET /v1/onboarding/state`):

1. Renombrar/separar fields:
   - `environment: "mvp.local"` (consistente con el chip del topbar)
   - `releasePhase: "5.9-manual-snapshot-ingestion-ux"` (campo nuevo, opcional, para tracking interno — se mantiene oculto en el panel)
2. Mismo issue aparece en `/safety` "FASE DEL NORTE" — ajustar el campo correspondiente (`A-BAJ-05`).

---

### Tarea 6 — A-MED-07 · Agregar `detectedCount` a onboarding state (30 min)

**Problema:** `/onboarding` SECCIÓN 2 muestra tag verde `● detectado por el recolector` pero todos los campos están en `--`. Contradicción.

**Acción:** en `GET /v1/onboarding/state` retornar:

```typescript
{
  sections: [
    {
      id: "compute-inventory",
      name: "Inventario de cómputo",
      detectedFieldCount: 0,      // cuántos campos efectivamente trae valor
      totalFieldCount: 4,          // total esperado
      source: "collector" | "manual" | "pending"
    },
    // ...
  ]
}
```

Yo en el frontend cambio el tag: si `detectedFieldCount === 0 && source === "pending"` → tag warning `pendiente · esperando snapshot` en vez de verde "detectado".

---

### Tarea 7 — A-MED-09 · Agregar `blockedReason` + `expectedInMvp` a CollectorSource (30 min)

**Problema:** `/collector` muestra 3 de 4 fuentes con badge `BLOQUEADO` rojo + `15% confianza`, sin explicación operativa de si es problema o estado esperado del MVP.

**Acción:** en `GET /v1/collector/supervised-plan` (o el endpoint que sirve las CollectorSource), agregar al schema:

```typescript
interface CollectorSource {
  // ... fields existentes
  blockedReason?: string;          // "missing_proxmox_endpoint" → ya existe pero como detalle interno
  blockedReasonOperator?: string;  // "Proxmox no expone el endpoint todavía — habilitar cuando esté online"
  expectedInMvp: boolean;          // true si bloqueado es estado esperado del MVP, false si problema
}
```

Yo en el frontend renderizo tooltip al hover del badge con `blockedReasonOperator`. Si `expectedInMvp=true`, el badge en gris neutro en vez de rojo crítico.

---

### Tarea 8 — A-MED-10 · Placeholders URLs `example.invalid` → frase neutra (20 min)

**Problema:** `/collector` cards muestran URLs `proxmox.example.invalid`, `bmc.example.invalid`. Son placeholders típicos pero comunican "esto es mock falso" al jefe.

**Acción:** en el shape de `CollectorSource`, si la URL real no está configurada, retornar `url: null` (no un string con `.invalid`).

Yo en el frontend renderizo `URL pendiente · configurar via .env` cuando `url === null`.

---

### Tarea 9 — A-MED-11 · Traducir status strings (`not_online_yet`, etc.) (30 min)

**Problema:** `/infrastructure` card "Servidor físico" tiene badge rojo `not_online_yet`. Snake_case en inglés.

**Acción:** todos los enums de status que salen al panel deben tener display name en español. Mapeo:

| Status interno | Display (ES) |
|---|---|
| `not_online_yet` | `Aún offline` |
| `online` | `Activo` |
| `degraded` | `Degradado` |
| `error` | `Con error` |
| `paused` | `Pausado` |
| `planned` | `Planeado` |
| `live` | `Activo · live` |
| `mock` | `Mock · demo` |

Implementación: agregar al schema del provider/inventory un field `statusLabel: string` (ES). Frontend usa `statusLabel` y fallback al `status` raw si no está.

---

### Tarea 10 — A-BAJ-04 · Display name de roles RBAC en español (30 min)

**Problema:** `/safety` card "Roles del norte" muestra `control_plane · intelligent_cluster_operator_read_only`. Ilegible para humano.

**Acción:** en el endpoint que sirve `iam/roles` (o equivalente), agregar `displayName: string` por rol:

| roleId | displayName |
|---|---|
| `control_plane` | `Plano de control` |
| `intelligent_cluster_operator_read_only` | `Operador supervisado (sólo lectura)` |
| `kill_switch_operator` | `Operador del kill switch` |
| `auditor_external` | `Auditor externo` |
| `read_only` | `Sólo lectura` |
| `sre` | `SRE` |

Frontend renderiza `displayName` y fallback al `roleId` raw.

---

## Endpoint contract changes — resumen para tu QA

| Endpoint | Cambio | Tarea OPS |
|---|---|---|
| `GET /v1/operating-north` | + `gates[].displayLabel`, opcional `description` | Tarea 2 |
| `GET /v1/infrastructure/inventory` | retornar 3 Webdock separadas | Tarea 3 |
| `GET /v1/onboarding/state` | + `environment` separado de `releasePhase`, + `sections[].detectedFieldCount` | Tareas 5, 6 |
| `GET /v1/collector/supervised-plan` | + `sources[].blockedReasonOperator`, + `sources[].expectedInMvp`, + `sources[].url` puede ser null | Tareas 7, 8 |
| `GET /v1/infrastructure/inventory` | + `providers[].statusLabel` | Tarea 9 |
| `GET /v1/iam/roles` | + `roles[].displayName` | Tarea 10 |
| `GET /v1/telemetry/series` | + `lastCaptureAt` opcional (nice-to-have, no bloquea — yo defensiveamente uso fallback si no está) | A-CRIT-04 |

**Backward compat:** todos los fields nuevos son opcionales para el frontend. Si Codex no llega a algo, el frontend no rompe — solo cae a la representación raw que ya tiene.

---

## Orden sugerido de trabajo

**Sesión 1 — pre-cena (~3h):**

1. Tarea 1 (10 min) — limpiar workspace YA antes de que Juanes haga otro practice run.
2. Tarea 2 (2h) — 22 gates traducidos. Es lo más visible para los jefes.
3. Tarea 3 (1h) — Webdock × 3 cuentas.

**Sesión 2 — post-cena (~3h):**

4. Tarea 4 (30 min) — titles de tasks B8/B9.
5. Tarea 5 (30 min) — `environment` field.
6. Tarea 6 (30 min) — `detectedCount` en onboarding.
7. Tarea 7 (30 min) — `blockedReason` en collector.
8. Tareas 8 + 9 + 10 (~1h 30min) — URLs placeholders + status strings + roles displayName.

**Resultado al cierre del jueves:**

- Demo viernes con panel completamente en español operativo.
- Sin gates en inglés visibles, sin status snake_case, sin URLs placeholder `.invalid`.
- 3 cards Webdock distinguibles.
- Telemetría Hardware honesta (sin gráficas falsas — frontend ya lo cerró).

---

## Lo que NO toques

- No tocar el frontend (`apps/admin-panel/`). Los items frontend ya están cerrados o los cierro yo mañana.
- No cambiar los nombres de los endpoints — solo agregar fields. Backward compat estricto.
- No tocar `runtime/openclaw-workspace/executions/` salvo para la Tarea 1 (borrar los 2 archivos identificados).
- No restartear el servidor de Bedrock ni el WSS sin avisarme — tengo el panel abierto en el browser en localhost:5173 con HMR vivo y un restart del gateway corta mi sesión.

---

## Verificación final esperada al cerrar el OPS

```
✓ Tarea 1: Canvas Live sidebar sin 2 tareas fallidas top
✓ Tarea 2: /v1/operating-north retorna displayLabel en cada gate
✓ Tarea 3: /v1/infrastructure/inventory retorna 3 providers Webdock
✓ Tarea 4: tasks nuevas tienen titles en español
✓ Tarea 5: /onboarding muestra ENTORNO: mvp.local
✓ Tarea 6: /v1/onboarding/state retorna detectedFieldCount
✓ Tarea 7: /v1/collector/supervised-plan retorna blockedReasonOperator
✓ Tarea 8: /v1/collector/supervised-plan retorna url=null cuando no configurada
✓ Tarea 9: /v1/infrastructure/inventory retorna statusLabel en español
✓ Tarea 10: /v1/iam/roles retorna displayName en español

✓ Tests smoke pasando (no regresión).
✓ Notion entry actualizada con progress del jueves.
```

Cuando cierres, pingueame para yo correr practice run #3 con todo integrado. Si surgen blockers o el tiempo aprieta, escalá a Juanes para priorizar.

Gracias.
