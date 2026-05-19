# Commit script — Fase G (modularizar features, App.tsx queda como shell)

Archivos modificados / nuevos:

- `apps/admin-panel/src/app/App.tsx` (**reescrito**: 301 lineas, era 1847)
- `apps/admin-panel/src/features/canvas/index.tsx` (**NEW**, 500 lineas — CanvasSection + Topology + Inspector + BlockersAccordion + TimelineList + Legend + dagre layout)
- `apps/admin-panel/src/features/hardware/index.tsx` (**NEW**, 208 lineas)
- `apps/admin-panel/src/features/collector/index.tsx` (**NEW**, 276 lineas)
- `apps/admin-panel/src/features/workflow/index.tsx` (**NEW**, 214 lineas)
- `apps/admin-panel/src/features/clusters/index.tsx` (**NEW**, 172 lineas)
- `apps/admin-panel/src/features/learning/index.tsx` (**NEW**, 210 lineas)
- `apps/admin-panel/src/features/safety/index.tsx` (**NEW**, 188 lineas)

Validacion ejecutada en sandbox:

```
npx tsc --noEmit                                 OK
node --test 3 archivos                           15/15 pass
npx vite build --outDir /tmp/admin-build-g       OK 46.96 kB CSS / 615.72 kB JS
```

Validado en vivo via Claude in Chrome despues de aplicar un fix defensivo en
`groupCanvasBlockers`: si un blocker llega con una `category` no enumerada en
el contrato (lo que ocurre hoy con todos los 32 blockers mock — tienen una
categoria que no calza con `"hardware" | "openclaw" | "network" | "provider" |
"other"`), la UI lo manda al bucket `other` en vez de crashear con
`Cannot read properties of undefined (reading 'push')`.

**Nota para Codex / dominio**: en el render actual los 32 blockers caen
todos en "Otros" porque el mock del dominio (`packages/domain/src/openclaw-
canvas.ts`) no esta emitiendo la `category` que el contrato declara. Esto se
debe a un mismatch entre el shape declarado en `OpenClawCanvasPayload` y el
shape que `collectBlockers` realmente produce. La UI muestra los datos sin
romper, pero la categorizacion solo agrupara bien cuando el dominio emita los
strings declarados.

Desde la terminal de macOS, en la carpeta del worktree:

```bash
cd ~/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de

git add \
  apps/admin-panel/src/app/App.tsx \
  apps/admin-panel/src/features/canvas/index.tsx \
  apps/admin-panel/src/features/hardware/index.tsx \
  apps/admin-panel/src/features/collector/index.tsx \
  apps/admin-panel/src/features/workflow/index.tsx \
  apps/admin-panel/src/features/clusters/index.tsx \
  apps/admin-panel/src/features/learning/index.tsx \
  apps/admin-panel/src/features/safety/index.tsx

git commit -m "Implement Hito 5.10 Fase G: split 7 SectionViews into src/features/<name>

Reduce App.tsx from 1847 to 301 lines by moving every section view into its
own feature folder. App.tsx now holds only the shell: TooltipProvider, Topbar
(brand + ModeBadge + FreshnessTag + refresh + ThemeToggle), Sidebar (grouped
nav reading the manifest in sections.ts), SectionView router (switch with
exhaustive check), LoadingState, ErrorState, Skeleton, toneForSection (sidebar
dot derivation) and errorMessage.

Per-feature modules:

- features/canvas/index.tsx: CanvasSection, useCanvasFlow (dagre TB
  autolayout), CanvasNodeLabel, CanvasLegend, edgeColor, toneColorVar,
  groupCanvasBlockers (with defensive fallback for unknown category values),
  hardwareBlockersAreRootCause and the local type aliases for the contract
  blocker shape.
- features/hardware/index.tsx: HardwareSection consuming
  physicalHost.readiness.recommendedNextStep from the contract.
- features/collector/index.tsx: CollectorSection + local CollectorTokenGroup.
- features/workflow/index.tsx: WorkflowSection + WorkflowTally,
  WorkflowFilterChip, WorkflowTokenGroup.
- features/clusters/index.tsx: ClustersSection rendering a real table per
  cluster from senderNodes.
- features/learning/index.tsx: LearningSection with stages, signals and
  modelGovernance panels.
- features/safety/index.tsx: SafetySection + local ActionTokenList and
  RoleField.

Each module imports primitives from shared/ui, helpers from shared/lib and
domain-state-copy, and the section metadata from app/sections.ts. The panel
remains GET-only.

Defensive fallback in groupCanvasBlockers: if a blocker arrives with a
category not in the declared enum, it lands in 'other' instead of crashing
the canvas. Today every mock blocker hits this fallback because the domain
mock emits a category string the contract does not declare. Fixing the
domain mock is out of scope for the frontend; the type contract remains the
source of truth.

No backend, gateway or runtime contract changed."
```

Despues del commit, opcional:

```bash
rm COMMIT_FASE_B.md COMMIT_B1.md COMMIT_FASE_C.md COMMIT_FASE_D.md COMMIT_FASE_C_D_AMEND.md COMMIT_FASE_E.md COMMIT_FASE_F.md COMMIT_FASE_G.md
```

## Tarea backend documentada por esta Fase G

`packages/domain/src/openclaw-canvas.ts` (funcion `collectBlockers` o similar)
debe emitir, en cada blocker, una `category` que pertenezca al union declarado:

```ts
category: "hardware" | "openclaw" | "network" | "provider" | "other"
```

Hoy emite strings que no calzan (probablemente kebab-case largo tipo
`missing_or_invalid_ip_pool_total` en lugar de `network`). La UI los redirige
a `other` para no romper, pero la categorizacion solo funcionara cuando el
dominio emita los valores enum.
