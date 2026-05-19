# Commit script - Fase C (Canvas + Hardware + Collector migrated)

Archivos modificados en el worktree:

- `apps/admin-panel/package.json` (+ @dagrejs/dagre, @radix-ui/react-accordion, @radix-ui/react-collapsible, @radix-ui/react-tabs)
- `apps/admin-panel/src/app/App.tsx` (CanvasSection con dagre TB autolayout + inspector + bloqueos por categoria + timeline; HardwareSection con PageHeader + NoticeBanner + KPI con microcopy + Cards con DefinitionList; CollectorSection con Tabs Fuentes/Ingesta manual/Politica + source cards tone'd)
- `apps/admin-panel/src/app/globals.css` (+ .delivrix-node styles + line-clamp-2 helper)
- `apps/admin-panel/src/shared/ui/accordion.tsx` (NEW)
- `apps/admin-panel/src/shared/ui/definition-list.tsx` (NEW)
- `apps/admin-panel/src/shared/ui/notice-banner.tsx` (NEW)
- `apps/admin-panel/src/shared/ui/tabs.tsx` (NEW)
- `apps/admin-panel/src/shared/ui/index.ts` (re-exports nuevos)

Validacion ejecutada en sandbox:

```
npx tsc --noEmit                                 OK
node --test src/shared/lib/formatters.test.ts    7/7 pass (sin nuevos tests, behaviour preservada)
node --test src/shared/api/client.test.ts        included
npx vite build --outDir /tmp/admin-build-c       OK 58.35 kB CSS / 602.10 kB JS (added dagre + radix tabs/accordion)
```

Validado en vivo via Claude in Chrome con dev server corriendo en worktree:
- Canvas: autolayout TB, nodes legibles, inspector funcional al click, Accordion de bloqueos categorizando los 32 en Hardware (5), Red (4), Provider/DevOps (6), Otros (17). Timeline reciente con dots tone'd.
- Hardware: PageHeader, NoticeBanner "Inventario pendiente", 4 KPI con microcopy "Esperando snapshot manual", Cards Inventario y Telemetria reciente con DefinitionList, "Campos pendientes" humanizados al pie.
- Collector: Tabs (Fuentes | Ingesta manual | Politica). Fuentes muestra 4 source cards con border-left tone'd. Ingesta manual muestra "Contrato del endpoint" + "Campos esperados" con mapping field-to-target + Rejected keys.

Desde la terminal de macOS, en la carpeta del worktree:

```bash
cd ~/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de

git add \
  apps/admin-panel/package.json \
  apps/admin-panel/src/app/App.tsx \
  apps/admin-panel/src/app/globals.css \
  apps/admin-panel/src/shared/ui/accordion.tsx \
  apps/admin-panel/src/shared/ui/definition-list.tsx \
  apps/admin-panel/src/shared/ui/notice-banner.tsx \
  apps/admin-panel/src/shared/ui/tabs.tsx \
  apps/admin-panel/src/shared/ui/index.ts \
  package-lock.json

git commit -m "Implement Hito 5.10 Fase C: Canvas + Hardware + Collector migrated

Migrate the three Estado vivo screens to the new Tailwind+shadcn stack.

- Add deps: @dagrejs/dagre 3 (autolayout), @radix-ui/react-tabs,
  @radix-ui/react-accordion, @radix-ui/react-collapsible.

- New primitives in shared/ui: Tabs (Stripe-style underline), Accordion
  (clean grouped lists), NoticeBanner (root cause hints), DefinitionList
  (label/value rows, compact density variant).

- Canvas pantalla: dagre TB autolayout replaces the index-matrix layout.
  Edge labels now use labelBgStyle so they no longer overlap nodes.
  Inspector side panel renders node detail with summary, metrics,
  incoming/outgoing dependencies (click-through navigation). Blockers
  panel groups 32 blockers by category (hardware / openclaw / network /
  provider / other) via Accordion. Timeline reduced to 5 most recent.
  RootCauseBanner shows when hardware blockers >= 50% of total.

- Hardware pantalla: PageHeader with description; NoticeBanner 'Inventario
  pendiente' surfaces the actionable next step; 4 KPIs with microcopy
  'Esperando snapshot manual' or 'Snapshot vigente'; Cards Inventario y
  Telemetria with DefinitionList; humanized 'Campos pendientes'.

- Collector pantalla: Tabs split content into Fuentes / Ingesta manual /
  Politica. Fuentes uses tone'd Cards with DefinitionList + inline-code
  for endpoint/command + blocker badges. Ingesta manual surfaces the
  endpoint contract + field-to-target mapping in a clean grid. Politica
  groups gates, next safe actions, blocked actions per panel.

- globals.css: add .delivrix-node styles for new canvas nodes (tone'd
  borders) plus line-clamp-2 helper.

Legacy CSS still serves Ruta, Clusters, Aprendizaje. Those are Fase D.
Panel remains GET-only. No backend or runtime contract changed."
```

Despues del commit, el dev server actual ya tiene los cambios via HMR. Si quieres reiniciar desde cero:

```bash
cd ~/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de
npm install   # actualiza node_modules con deps nuevos si reinicias maquina
npm run dev:admin
```

Lo que sigue son Fases D-E.
