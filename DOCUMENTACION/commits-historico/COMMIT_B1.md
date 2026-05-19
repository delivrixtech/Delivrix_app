# Commit script - Fase B.1 (5 fixes correctness)

Archivos modificados en el worktree (sin commitear):

- `apps/admin-panel/src/shared/lib/formatters.ts` (+ funcion `humanize`)
- `apps/admin-panel/src/shared/lib/formatters.test.ts` (+ test de `humanize`)
- `apps/admin-panel/src/shared/api/client.ts` (LearningPlanPayload stage `label` → `title`)
- `apps/admin-panel/src/app/App.tsx` (tonos invertidos Aprendizaje, `stage.title`, `humanize` en Clusters/Hardware, badge Hardware Collector DevOps)

Validacion ejecutada en sandbox:

```
npx tsc --noEmit                                 OK
node --test src/shared/lib/formatters.test.ts    7/7 pass
node --test src/shared/api/client.test.ts        included in same run
npx vite build --outDir /tmp/admin-build-b1      OK 54.24 kB CSS / 524.91 kB JS
```

Desde la terminal de macOS, en la carpeta del worktree:

```bash
cd ~/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de

git add \
  apps/admin-panel/src/shared/lib/formatters.ts \
  apps/admin-panel/src/shared/lib/formatters.test.ts \
  apps/admin-panel/src/shared/api/client.ts \
  apps/admin-panel/src/app/App.tsx

git commit -m "Implement Hito 5.10 Fase B.1: five correctness fixes from live render review

Fixes uncovered by the live render audit via Claude in Chrome on 2026-05-16
(see DOCUMENTACION/HITO_5_10_REVISION_RENDER_2026-05-16.md):

- formatters: add humanize() that splits camelCase, dots between letters and
  collapses whitespace. Tests added covering senderNodes, identity.cpuCores,
  needs_review, version strings and empty input. compactLabel left intact to
  preserve existing identity behaviour and test contract.

- client.ts LearningPlanPayload: stage field is title (the domain serializes
  OpenClawLearningStage.title, not label). Kept label optional for backwards
  compatibility while older drafts exist. This unblocks the Aprendizaje
  stages panel that rendered empty boxes because stage.label was undefined.

- LearningSection in App.tsx: invert tones for Self promote and Human
  approval. canSelfPromote=true is the danger condition (critical) and
  canSelfPromote=false is the safety guarantee (success). Same flip for
  requiresHumanApproval=true (success). Use stage.title with fallback to
  stage.label and humanize(stage.id). Apply humanize() to readiness score
  keys so hardwareCapacity reads as 'hardware capacity'.

- ClustersSection in App.tsx: use humanize() for clusterOverview.totals
  keys so KPI labels render as 'sender nodes' instead of 'senderNodes'.

- HardwareSection in App.tsx: map unknownFields through humanize() so the
  token chips read 'identity cpu cores' instead of 'identity.cpuCores'.
  Same for telemetry.quality.unknownFields and
  collector.unknownCapabilities. Change Collector DevOps panel badge from
  collector.collectorMode (which duplicates the page-level 'mock' badge)
  to compactLabel(collector.status).

No backend, gateway or runtime contract changes. The panel remains GET-only."
```

Despues del commit:

```bash
cd ~/Documents/delivrix\ app
npm install      # solo si no se hizo aun en este worktree
```

Para validar en vivo: parar el dev server actual y reiniciarlo apuntando al worktree:

```bash
cd ~/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de
npm install   # primera vez
npm run dev:admin
```

Abrir http://127.0.0.1:5173 y revisar:

- Topbar nuevo "Delivrix Admin" + ModeBadge "Mock · Dry-run" + freshness tag (Fase B).
- Sidebar agrupado en 3 secciones (Fase B).
- Aprendizaje: Self promote = success, Human approval = success cuando = required, Stages con titulos visibles (B.1).
- Clusters: KPIs "Clusters / Sender nodes / Provisioning runs / Active or warming" en sentence case (B.1).
- Hardware: tokens al pie son sentence case sin paths JSON; badge Collector DevOps lee "ready" en vez de "mock" (B.1).
- Seguridad: pantalla rediseñada con PageHeader, 4 MetricCard con microcopy, paneles Allowed/Blocked + Gates + Roles (Fase B).
