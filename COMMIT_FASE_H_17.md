# Commit Fase H.17 — Layout responsive

## Validar

```bash
cd apps/admin-panel
npx tsc --noEmit
node --test src/shared/api/client.test.ts src/shared/lib/formatters.test.ts src/shared/lib/domain-state-copy.test.ts
```

Resultado esperado: tsc verde, 15/15 tests pass.

## Commit

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
git add apps/admin-panel/src
git status
git commit -m "admin: Fase H.17 — layout responsive · main fluid + max-width 1680

El frontend tenía maxWidth: 1352px fijo en cada section feature, lo que
dejaba ~350px de espacio vacío a la derecha en monitores 1920+ y 2560+.

Cambios:

- src/app/App.tsx · <main> ahora tiene padding escalable
  (px-6 sm:px-7 lg:px-10 xl:px-14 2xl:px-16) y un wrapper interno
  mx-auto w-full con max-width 1680px. El contenido respira en pantallas
  grandes y mantiene el límite legible.
- features/overview, onboarding, hardware, collector, clusters, canvas,
  learning, safety · removido maxWidth: 1352 de la section raíz. Cada
  pantalla ocupa el contenedor del main.
- features/overview/index.tsx · grid Welcome+OpenClaw cambia de
  minmax(0,598px)_minmax(0,523px) rígido a minmax(0,1.15fr)_minmax(0,1fr)
  proporcional.
- features/learning/index.tsx · mismo ajuste en el Header.

Validado en viewport 2000x1298: las KPI cards llenan el ancho disponible,
el pipeline ocupa toda la fila, Aprobaciones+Gates llenan el bottom row.

tsc --noEmit verde, 15/15 tests pass."
```
