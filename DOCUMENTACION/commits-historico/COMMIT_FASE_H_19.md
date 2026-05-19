# Commit Fase H.19 — Fix gates layout overflow

## Contexto

Tras Wave 2B, las pantallas Overview / Seguridad / Clústeres muestran los gates
reales del operating-north. Los IDs largos del contrato
(`admin_panel_reads_canvas_and_hardware_from_backend_contracts`) rompían el
flex row: el texto se desbordaba y empujaba el note "revisión pendiente"
fuera del contenedor.

## Cambios

- `features/overview/index.tsx` · GatesCard humaniza `operatingNorth.gates`
  con `humanize()`; preserva el ID original como `rawLabel` para el atributo
  `title` del `<li>`. GateRow ahora usa `flex items-center min-w-0`, label
  con `flex: 1 1 auto; minWidth: 0; truncate`, note con `shrink-0;
  whiteSpace: nowrap`.
- `features/safety/index.tsx` · mismo fix en `buildSafetyGates` +
  GatesCard `<li>`. Base gates obtienen `rawLabel = label` para uniformar.
- `features/clusters/index.tsx` · mismo fix en `buildGates` + GatesCard
  `<li>`.

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
git add apps/admin-panel/src/features
git status
git commit -m "admin: Fase H.19 — fix gates layout overflow

Los gates IDs largos del operatingNorth (p.ej.
admin_panel_reads_canvas_and_hardware_from_backend_contracts) rompían el
layout del GatesCard tras Wave 2B: el label desbordaba el flex row y
empujaba el note 'revisión pendiente' fuera del contenedor.

Fix:
- humanize(id) convierte snake_case largo en texto legible.
- rawLabel preservado en title=... para que hover muestre el ID original.
- Layout estable con flex 1 1 auto + minWidth: 0 + truncate en el label y
  shrink-0 + whiteSpace: nowrap en el note.
- Aplicado de forma consistente en Overview GatesCard, Seguridad gates de
  seguridad y Clústeres gates de la flota.

tsc --noEmit verde, 15/15 tests pass."
```
