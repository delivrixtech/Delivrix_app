# OPS — Tokenización + Cleanup hardcoded del admin panel

**Fecha:** 2026-05-20
**Ejecutor:** Codex
**Decisor humano:** Juanes (operador)
**Trigger:** Juanes reporta "muchas cosas hardcodeadas, se ve horrible"
**Pre-requisito:** Ola 2 Learning backend implementada (puede hacerse en paralelo después o entre ambas)

## 1. Contexto

Auditoría del admin panel post-Ola 1 Safety encontró:

- **837 hex codes literales** distribuidos en las 9 vistas (`canvas` 144, `safety` 117, `hardware` 101, `overview` 99, `clusters/learning` 98 c/u, `collector` 85, `onboarding` 57, `App.tsx` 38).
- Los hex coinciden con tokens ya definidos en `apps/admin-panel/src/app/tokens.css` (335 líneas, variables CSS Light/Dark).
- La sección Safety nueva (commit `f579368`) usa los tokens correctamente — el resto no.
- 5 arrays hardcoded como fallback (`CLUSTER_ROWS_DEMO`, `PLAN_MILESTONES`, `SKILLS`, `STEPS`, `AUDIT_ROWS`), 3 de ellos con endpoints inventados que no existen en el read-boundary.

**Impacto:** modo dark roto en 8/9 vistas, paleta congelada en hex literal, inconsistencia visual entre secciones.

## 2. Top hex → token mapping (referencia para el refactor)

| Hex | Token CSS variable | # usos |
|---|---|---|
| `#8A8073` | `--foreground-tertiary` | 159 |
| `#1A1410` | `--foreground-primary` | 157 |
| `#EAE0CE` | `--border-subtle` | 137 |
| `#5C544A` | `--foreground-secondary` | 107 |
| `#15803D` | `--state-success` | 84 |
| `#B45309` | `--state-warning` | 70 |
| `#FFFFFF` | `--surface-tertiary` | 68 |
| `#EA580C` | `--accent-tertiary` | 60 |
| `#FFFBF5` | `--surface-primary` | 58 |
| `#F7F2EA` | `--surface-secondary` | 58 |
| `#B91C1C` | `--state-critical` | 52 |
| `#DCFCE7` | `--state-success-bg` | 42 |
| `#FEF3C7` | `--state-warning-bg` | 38 |
| `#1D4ED8` | `--state-info` | 38 |
| `#FACC15` | `--gradient-start` | 36 |
| `#FEE2E2` | `--state-critical-bg` | 29 |
| `#7C3AED` | `--state-unknown` | 27 |
| `#DBEAFE` | `--state-info-bg` | 25 |
| `#F59E0B` | `--gradient-mid` / `--accent-primary` | 24 |
| `#EDE9FE` | `--state-unknown-bg` | 20 |

(Verificar valores exactos en `apps/admin-panel/src/app/tokens.css` antes de mapear.)

## 3. Scope

**Dentro:**

- Refactor mecánico de hex → token en las 9 vistas (incluye App.tsx).
- Patrones a reemplazar:
  - `className="bg-[#FFFBF5]"` → `className="bg-[var(--surface-primary)]"` (o `bg-surface-primary` si se agregan tokens a tailwind.config)
  - `style={{ background: "#FFFBF5" }}` → `style={{ background: "var(--surface-primary)" }}`
  - `style={{ color: "#1A1410" }}` → `style={{ color: "var(--foreground-primary)" }}`
- Auditar los 5 arrays hardcoded:
  - **`CLUSTER_ROWS_DEMO` (clusters:186)**: verificar si `/v1/admin/clusters` o `/v1/webdock/inventory` provee data equivalente. Si sí, cablear y borrar el const. Si no, dejar como fallback con nombre `CLUSTER_ROWS_FALLBACK` (renombrar para que no parezca "demo activo").
  - **`PLAN_MILESTONES` (learning:411)**: verificar si `/v1/openclaw/learning-plan` lo provee. Si sí, cablear. Si no, renombrar a `PLAN_MILESTONES_FALLBACK`.
  - **`SKILLS` (learning:567)**: los endpoints inventados (`/v1/openclaw/skills/degradation`, etc.) **NO existen**. Borrar esos endpoints inventados del const o cablear desde `data.readinessSignals.recommendations` (que ya está siendo usado parcialmente).
  - **`STEPS` (onboarding:73)**: verificar contra `/v1/openclaw/onboarding/state` y `/v1/openclaw/onboarding/questionnaire`.
  - **`AUDIT_ROWS` (safety:841)**: cablear desde `/v1/audit-events` (existe ya en read-boundary).

**Fuera:**

- No tocar la sección Safety realtime (Ola 1 ya está bien tokenizada).
- No cambiar tokens existentes en `tokens.css` (solo CONSUMIRLOS desde JSX).
- No alterar lógica de fetch/data flow — solo cambiar la presentación.
- No tocar los nuevos componentes Ola 1 (`apps/admin-panel/src/shared/ui/realtime/`) — ya usan tokens.

## 4. Estrategia de ejecución (sugerida)

Para evitar romper visualmente algo, hacer **por feature** y verificar:

```
Fase A — Setup (~30 min)
  1. Leer apps/admin-panel/src/app/tokens.css y mapear hex → CSS variables exactos
  2. Decidir: agregar utility classes a tailwind.config (preferido) o usar bg-[var(--X)] directo
  3. Crear script bash de validación: grep -c "#[0-9A-Fa-f]\{6\}" por feature (baseline ~837)

Fase B — Por feature (~30-45 min cada una × 8 features = ~5-6 hrs)
  Para cada feature en este orden (de menos a más complejo):
  - onboarding (57 hex, más simple)
  - collector (85)
  - clusters (98)
  - learning (98)
  - overview (99)
  - hardware (101)
  - safety (117) — extra cuidado, ya tiene parte tokenizada
  - canvas (144) — más complejo

  Por cada feature:
  1. Reemplazar hex → token con sed o IDE refactor
  2. Verificar build (npm run build)
  3. Verificar test (npm run test:admin)
  4. Smoke visual: levantar panel, ver que la feature renderice idéntico a antes
  5. Commit chico: feat(panel): tokenize <feature> color refs

Fase C — Arrays hardcoded (~1-2 hrs)
  Para cada uno de los 5 arrays:
  1. Buscar si hay endpoint del read-boundary que provea data equivalente
  2. Si SÍ: cablear, borrar const
  3. Si NO: renombrar el const con suffix _FALLBACK para clarificar intención
  4. Commit: chore(panel): wire <feature> arrays to read-boundary or rename to FALLBACK

Fase D — Validación final (~30 min)
  1. grep -c "#[0-9A-Fa-f]\{6\}" en features → debería caer cerca de 0 (solo quedan los del tokens.css que SÍ son fuente de verdad)
  2. Test dark mode manualmente o con prefers-color-scheme override
  3. npm run test:admin debe seguir verde
  4. npm run build OK
  5. Screenshot comparativo: antes/después de cada feature (opcional pero recomendado)
```

## 5. Validación dark mode

El admin panel debe respetar `prefers-color-scheme: dark` después del refactor. Probarlo:

```bash
# En Chrome DevTools: Rendering panel → "Emulate CSS media feature prefers-color-scheme" → dark
# O agregar temporalmente a globals.css: html { color-scheme: dark; }
```

Todos los tokens en `tokens.css` ya tienen valores para `@media (prefers-color-scheme: dark)`. El refactor expone ese contraste automáticamente.

## 6. Restricciones

- **No** tocar `packages/domain/src/` (backend ya cerrado, solo presentation cleanup).
- **No** romper tests existentes (17/17 + los nuevos de Ola 2 cuando lleguen).
- **No** alterar el data flow (`loadDashboardData()`, props que llegan a features).
- **No** modificar tokens.css (solo consumirlos).
- **No** reemplazar hex en `tokens.css` mismo — esos SÍ son fuente de verdad.
- **No** hacer Big Bang refactor — feature por feature con commit chico cada una, para minimizar blast radius.

## 7. Reporte esperado al terminar

```
PANEL TOKENIZATION CLEANUP — implementado

features tokenizadas: 8 (onboarding, collector, clusters, learning, overview, hardware, safety, canvas) + App.tsx
hex hardcoded reducidos: 837 → N (residuales documentados)
arrays hardcoded:
  - CLUSTER_ROWS_DEMO: <cableado a /v1/admin/clusters | renombrado a FALLBACK>
  - PLAN_MILESTONES: <cableado a /v1/openclaw/learning-plan | renombrado a FALLBACK>
  - SKILLS: <cableado a readinessSignals | endpoints inventados borrados>
  - STEPS: <cableado a /v1/openclaw/onboarding/state | renombrado a FALLBACK>
  - AUDIT_ROWS: <cableado a /v1/audit-events | renombrado a FALLBACK>
tests: <N>/<N> verdes
build vite: OK
dark mode: visualmente verificado en N/8 features
commits: <count> commits chicos por feature

next action: operator review (validar paridad visual con happy path actual)
```

## 8. Commits sugeridos

1. `docs: add panel tokenization cleanup spec`
2. `feat(panel): tokenize onboarding color refs`
3. `feat(panel): tokenize collector color refs`
4. ... (uno por feature)
5. `chore(panel): wire/rename hardcoded arrays in features`
6. `chore(panel): verify dark mode renders correctly post-tokenization`

## 9. Referencias

- Tokens CSS source: `apps/admin-panel/src/app/tokens.css`
- Pencil tokens equivalentes (mismo color, diferente formato): `DOCUMENTACION/design/Panel_Front_End.pen` variables section
- Patrón correcto a copiar: `apps/admin-panel/src/features/safety/index.tsx` (post-Ola 1) y `apps/admin-panel/src/shared/ui/realtime/*.tsx`
- Read-boundary endpoints disponibles: `apps/admin-panel/src/shared/api/read-boundary.ts` (27 endpoints)
