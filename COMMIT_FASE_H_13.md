# Commit Fase H.13 — Restaurar 8 secciones Pencil

Ejecutar desde host (Codex), dentro del worktree
`.claude/worktrees/youthful-mirzakhani-c517de`.

## 1. Borrar la carpeta colapsada (sandbox no puede unlink)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
rm -rf apps/admin-panel/src/features/clusters-security
```

(Las otras stubs — canvas, learning, safety — ahora tienen contenido real y
no hay que borrarlas.)

## 2. Verificar antes del commit

```bash
cd apps/admin-panel
npx tsc --noEmit
node --test src/shared/api/client.test.ts src/shared/lib/formatters.test.ts src/shared/lib/domain-state-copy.test.ts
npx vite build
```

## 3. Commit

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
git add apps/admin-panel/src/features
git add apps/admin-panel/src/app
git status
git commit -m "admin: Fase H.13 — restaurar 8 secciones Pencil

Pencil dibuja 8 secciones top-level y la fase anterior las habia colapsado a
5 (Canvas/Learning/Safety disueltos en otras). Esta fase las restaura tal cual
las dibuja Pencil.

Sections (8): Vista general, Onboarding, Canvas, Hardware, Recolector,
Clusters, Aprendizaje, Seguridad.

- src/app/sections.ts ahora declara 8 SectionId con iconos lucide exactos:
  layout-dashboard, compass, workflow, cpu, database, server, graduation-cap,
  shield-check.
- features/canvas/index.tsx: pantalla viva con ReactFlow autolayout +
  inspector + bloqueos por categoria + timeline (lee data.canvas).
- features/learning/index.tsx: 4 KPIs (stages / signals / governance) + plan
  supervisado + signals por capacidad + evidencia curada + cola feedback +
  audit strip dark (lee data.learningPlan + data.readinessSignals).
- features/safety/index.tsx: 4 KPIs booleanos del norte + acciones
  permitidas/bloqueadas + audit + compliance row + footer (lee
  data.operatingNorth + data.killSwitch).
- features/clusters/index.tsx: solo el inventario de clusters, sin tab de
  seguridad (esta ahora vive en safety).
- features/clusters-security/index.tsx: stub vacio (borrar en host).
- src/app/App.tsx: switch ampliado a los 8 ids, toneForSection cubre los 8."
```

Si tsc o tests fallan, abrir un canal con el asistente antes de commitear.
