# Commit script - Fase D (Ruta + Clusters + Aprendizaje migrated)

Archivos modificados en el worktree:

- `apps/admin-panel/src/app/App.tsx` (WorkflowSection con progress strip + filter chips + Card-based steps con statusReason elevado + Collapsible read boundary; ClustersSection con KPIs + tabla de sender nodes por cluster + nextActions panel; LearningSection con Readiness signals lista + Stages numeradas tone'd + Gobierno del modelo panel)

No hay archivos nuevos esta vez — la Fase D consume los primitives que ya viven en `shared/ui/` desde Fases B-C.

Validacion ejecutada en sandbox:

```
npx tsc --noEmit                                 OK
node --test src/shared/lib/formatters.test.ts    7/7 pass
npx vite build --outDir /tmp/admin-build-d       OK 58 kB CSS / 613 kB JS (sin deps nuevas)
```

Validado en vivo via Claude in Chrome (HMR activo sobre dev server en worktree):

- **Ruta**: PageHeader + progress strip (5 listos / 2 en revision / 3 bloqueados / 0 no iniciados) + filter chips (Todos 10 / Pendientes 5 / Bloqueados 3) + workflow steps con `statusReason` elevado al subtitulo + Card border-left tone'd + Data sources como `<code>` mono + Evidence como Badge neutral + Frontera de lectura panel al fondo con 17 endpoints como `<code>` chips.

- **Clusters**: PageHeader + 4 KPIs con microcopy ("Clusters 3 / Bajo gobierno", "Sender nodes 11 / 6 activos o calentando", "Provisioning runs 1 / Plan dry-run", "Acciones siguientes 2 / En backlog operacional") + Card por cluster con border-left tone'd, badge de cantidad de nodos + tabla con columnas Nodo / Estado / Salud + filas con UiBadge tone'd por status y health + panel "Acciones siguientes" al fondo si hay items.

- **Aprendizaje**: PageHeader + 4 KPIs con microcopy y tonos correctos ("Self promote / Blocked / Modelo no se auto-asciende" en success; "Human approval / Required / Barandilla activa" en success; "Stages 5 / 4 listos"; "Signals 3 / Readiness scores") + lista de Readiness signals con dots semanticos + Stages numeradas con border-left tone'd y titulos completos + panel "Gobierno del modelo" con DefinitionList compacta y descripcion de barandillas.

Desde la terminal de macOS, en la carpeta del worktree:

```bash
cd ~/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de

git add apps/admin-panel/src/app/App.tsx

git commit -m "Implement Hito 5.10 Fase D: Ruta + Clusters + Aprendizaje migrated

Migrate the three Procesos screens to the new Tailwind+shadcn stack,
reusing primitives introduced in Fases B-C (Card, UiBadge, UiMetricCard,
PageHeader, DefinitionList).

- Ruta: replace the workflow-list legacy layout with PageHeader + progress
  strip global (counts ready/needs_review/blocked/not_started) + filter
  chips (Todos / Pendientes / Bloqueados) backed by useState. Each step
  becomes a tone'd Card with statusReason elevated under the title (it
  was buried at the bottom before). Data sources render as <code> mono
  chips; Evidence as Badges. 'Frontera de lectura' moves to its own Card
  at the bottom with the 17 allowed endpoints as mono chips, descriptive
  text on top.

- Clusters: replace the workflow-step look-alike with a dedicated table
  per cluster (Nodo / Estado / Salud columns) so 'Delivrix Demo Sender
  5.1: warming' becomes a row with separate status and health badges.
  KPIs read from clusters.totals with explicit named fields instead of
  Object.entries.slice. Adds 'Acciones siguientes' panel surfacing
  nextActions.

- Aprendizaje: replace signal-row/action-row legacy lists with semantic
  list components. Readiness signals use a dot-by-status pattern with
  humanized keys. Stages render as a numbered list with tone'd
  border-left, showing stage.title with B.1 fallback. Adds 'Gobierno
  del modelo' panel exposing modelMode/modelVersion/promptVersion plus
  a short Barandillas explanation that flips copy when canSelfPromote
  is true.

All seven sections (Canvas, Hardware, Collector, Ruta, Clusters,
Aprendizaje, Seguridad) now live in the new stack. styles.css legacy
selectors are still loaded but no longer referenced by any section.
Panel remains GET-only. No backend or runtime contract changed.

Fase E will remove the legacy CSS and polish responsive."
```

Despues del commit, el dev server actual ya tiene los cambios via HMR.

Lo que sigue: Fase E (polish responsive + dark mode pass + eliminar styles.css legacy).
