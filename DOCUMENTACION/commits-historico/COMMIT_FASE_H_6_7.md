# Commit Fase H.6 + H.7 + H.10 stubs

Ejecutar desde host (Codex), dentro del worktree
`.claude/worktrees/youthful-mirzakhani-c517de`.

## 1. Borrar features fantasma (sandbox no puede unlink)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
rm -rf apps/admin-panel/src/features/canvas
rm -rf apps/admin-panel/src/features/clusters
rm -rf apps/admin-panel/src/features/learning
rm -rf apps/admin-panel/src/features/safety
rm -rf apps/admin-panel/src/features/workflow
```

## 2. Verificar antes del commit

```bash
cd apps/admin-panel
npx tsc --noEmit
node --test src/shared/api/client.test.ts src/shared/lib/formatters.test.ts src/shared/lib/domain-state-copy.test.ts
# build opcional desde host (sandbox no puede sobrescribir dist/):
npx vite build
```

## 3. Commit

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
git add apps/admin-panel/src/features
git add apps/admin-panel/src/app
git status
git commit -m "admin: Fase H.6/H.7 — Overview, Onboarding, Clusters&Security pencil

- Crea apps/admin-panel/src/features/overview/index.tsx (Overview dashboard
  Pencil frame e1ashz): hero con titulo gradient Funnel Sans + OpenClawPromptPanel,
  4 KPIs con Sparkline, pipeline horizontal Flujo operativo, aprobaciones,
  gateway saludable (panel dark inverse) y eventos recientes.
- Crea apps/admin-panel/src/features/onboarding/index.tsx (Pencil frame T9osf):
  Stepper de 6 pasos (servidor/IPs/identidad/conexion/DNS/lanzamiento) tone'd
  por OpenClawOnboardingState.readinessByCategory, inventario en 3 cards,
  OpenClawPromptPanel guiado por blockers/warnings, y 3 status cards al pie.
- Crea apps/admin-panel/src/features/clusters-security/index.tsx
  (Pencil frame V8h2t): unifica las pantallas previas Clusters y Seguridad en
  tabs internas; KPIs de top alinean clusters totales + writes + kill switch.
- Borra features/canvas, clusters, learning, safety, workflow: la
  re-arquitectura pasa de 7 a 5 pantallas top-level.

All-read still enforced: ningun feature postea ni infiere severidad."
```

Si tsc o tests fallan, revisar el log y volver a llamar al asistente antes
de commitear.
