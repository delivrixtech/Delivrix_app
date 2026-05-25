# Audit Panel FE — 2026-05-24 sesión por sesión

Auditoría profunda de cada feature del admin panel post-MVP día 21/30. Sirve de checklist para revisar uno por uno hasta cerrar todos los pendientes.

**HEAD main:** `1947e34` (SSH bridge OpenClaw funcionando)

---

## Matriz ejecutiva por feature

| Feature | Estado data | Botones huérfanos | Hardcoded | Prioridad |
|---|---|---|---|---|
| **Overview** | ✅ Real (10 endpoints) | 1: "Abrir canvas" | 1 pill demo `"+6 esta semana"` quemado en KPI | **P1** |
| **Onboarding** | ✅ Real (onboardingState) | 3: Guardar borrador / Volver / Continuar | Hostname/Datacenter placeholders demo | **P0** |
| **Canvas** | ✅ WSS + REST real | 0 ✅ | Topología fallback si backend vacío | **P2** done |
| **Hardware** | ✅ Real (physicalHost + telemetry) | 1: "Solicitar snapshot manual" | "Servidor físico primario · Popayán" si data vacía | **P0** |
| **Collector** | ✅ Real (snapshot-ingestion) | 1: "copy" CLI | ACCEPTED_FIELDS es helper, no mock | **P2** |
| **Infrastructure** | ✅ Real (Webdock Claude · DK live) | 0 ✅ | — | **P2** done |
| **Clusters** | ✅ Real (admin/clusters) | 1: "Activar interruptor de corte" — CRÍTICO | Posibles fallback ROWS | **P0** |
| **Learning** | ✅ Real (skills-audit + evidence) | 1: "Revisar" row evidencia | LEARNING_POLL config OK | **P1** |
| **Safety** | ✅ Real (audit + IAM + compliance) | 2: "Exportar" + "Mostrar 24 más" | KillSwitch armed/active OK ya migrado | **P1** |

### Features con carpeta vacía (placeholders viejos sin index.tsx)

- `audit-log/` → ✅ contenido vive en `safety/index.tsx` (Audit table)
- `openclaw/` → ✅ contenido vive en `canvas/canvas-v4.tsx`
- `reports/` → ⚠️ no existe en sidebar, sin implementación
- `sender-nodes/` → ✅ contenido vive en `overview/index.tsx` KPI
- `settings/` → ⚠️ no existe en sidebar, sin implementación
- `workflow/` → ✅ contenido vive en `canvas/canvas-flow.tsx` (Topología tab)

**Decisión sugerida**: borrar las 6 carpetas vacías para que no confundan en grep/buscar. Son legacy.

---

## Plan de ataque sesión por sesión

### Sesión 1 — Botones críticos (P0) — sin estos el panel no cumple su rol de "ejecución"

**1.1 Onboarding · Continuar / Volver / Guardar borrador**

Estado: 3 botones de wizard sin handler. El usuario no puede avanzar pasos.

Trabajo:
- Cablear `Continuar` con setStep(next) + validación de campos del paso actual.
- Cablear `Volver` con setStep(prev).
- Cablear `Guardar borrador` con POST `/v1/openclaw/onboarding/state` (backend que YA existe).

**1.2 Hardware · Solicitar snapshot manual**

Estado: botón sin handler. El operador debería poder pedir un snapshot fresco al recolector.

Trabajo:
- Cablear a POST `/v1/devops/collector/request-snapshot` (endpoint a confirmar con Codex si existe; si no, OPS rápido para crear).
- Toast.info "Snapshot solicitado · esperando recolección" al click.
- Disabled mientras está pending (lockout 30s).

**1.3 Clusters · Activar interruptor de corte**

Estado: botón sin handler. **MÁS CRÍTICO** porque es safety mechanism.

Trabajo:
- Cablear a POST `/v1/kill-switch` con confirmación modal de 2 personas (regla actual).
- Toast.warning "Pendiente segunda aprobación humana" + audit event.
- Después de quorum, ejecuta arm real.

### Sesión 2 — Botones P1 (UX productiva)

**2.1 Overview · Abrir canvas** → trivial, navegar a sección canvas.

**2.2 Safety · Exportar audit** → download JSON o CSV del audit chain.

**2.3 Safety · Mostrar 24 entradas más** → paginate cliente o server-side.

**2.4 Learning · Revisar evidencia row** → modal con detail del snapshot + accept/reject.

### Sesión 3 — Datos hardcoded sutiles

**3.1 Overview KPI** "+6 esta semana" pill text quemado → calcular delta real vs snapshot anterior.

**3.2 Onboarding placeholders** "Servidor fisico primario / Popayan" → mostrar lo que viene del physicalHost real, no placeholder.

**3.3 Hardware fallback** "Servidor físico primario · Popayán" cuando data vacía → mejor empty state.

### Sesión 4 — Limpieza estructural

**4.1 Borrar 6 carpetas vacías** (audit-log, openclaw, reports, sender-nodes, settings, workflow). Confunden el grep.

**4.2 Revisar contenido "decorativo"** en cada feature: hay info que no aporta a operar (texto descriptivo demasiado largo). Posible refactor de densidad.

**4.3 Inconsistencias visuales menores** detectadas durante revisión.

### Sesión 5 — Cerrar pendientes Notion

Marcar checklist en Notion Task Board para cada item completado en sesiones 1-4. Sin agregar páginas nuevas, solo checks.

---

## Orden recomendado de ataque

1. **Sesión 1.3 Clusters KillSwitch** (más crítico safety-wise).
2. **Sesión 1.1 Onboarding wizard** (afecta flow principal del usuario nuevo).
3. **Sesión 1.2 Hardware snapshot** (operador necesita refresh manual del recolector).
4. **Sesión 2 entera** (UX productiva, ~1h total).
5. **Sesión 3 entera** (cleanup visual).
6. **Sesión 4 cleanup carpetas** (10 min).
7. **Sesión 5 Notion checklist** (último, cerrar todo).

---

## Métrica de éxito por sesión

Después de cada sesión:
- `tsc --noEmit` clean.
- `vite build` clean.
- QA visual: el botón hace lo que dice + toast feedback + ninguna acción silenciosa.
- Commit temático con mensaje descriptivo.

Cuando las 5 sesiones estén cerradas: el panel pasa de "lindo demo" a "panel administrativo operacional real".
