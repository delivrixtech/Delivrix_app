# COMMIT FASE H.21 — Variantes Pencil (responsive base) + auditoría dark/mobile

## Resumen

Cierra Wave B de Hito 5.10:

- **Dark variant**: tokens ya estaban en `tokens.css` desde H.1; auditoría
  Pencil-vs-disco confirma equivalencia 1:1. Implementación full requiere
  tokenización de literales en `features/*` — agendada para H.22 (ver
  DOCUMENTACION/HITO_5_10_VARIANTES_PENCIL.md §3).
- **Tablet/Mobile auditoría literal**: leídos frames `zLnkx` (834×1112) y
  `pYjWp` (390×844). Specs en mismo documento §4 y §5.
- **Responsive base**: ajustes que aprovechan los breakpoints existentes
  para mejorar lectura en md (768-1023) sin requerir nuevos componentes:
  - Grid principal: `grid-cols-1 md:grid-cols-[200px_…] lg:grid-cols-[240px_…]`
    (sidebar más estrecha en tablet, evita aplastar el main).
  - Main padding escalonado: `px-4 sm:px-6 md:px-7 lg:px-10 xl:px-14 2xl:px-16`.
  - Topbar wrap automático en mobile + py escalonado (`py-3 sm:py-4`).
  - Sidebar usa `w-full` + padding responsive en lugar de `width: 240` rígido.

## Archivos

- `apps/admin-panel/src/app/App.tsx` — grid + main padding + Topbar + Sidebar.
- `DOCUMENTACION/HITO_5_10_VARIANTES_PENCIL.md` — auditoría completa de las
  3 variantes Pencil con specs literales.

## Validación local (sandbox)

```
cd apps/admin-panel
npx tsc --noEmit                         # 0 errores
node --test src/shared/api/client.test.ts \
            src/shared/lib/formatters.test.ts \
            src/shared/lib/domain-state-copy.test.ts   # 15 / 15 ok
```

## Próximo: H.22 (theme tokenization sweep)

Ver `DOCUMENTACION/HITO_5_10_VARIANTES_PENCIL.md §6` para el plan completo:

- H.22.A — Reemplazar ~240 hex literales en `features/*.tsx` por
  `var(--color-*)`. Esto activa el toggle light/dark realmente.
- H.22.B — Sidebar variant icon-rail (72w) para md zone + drawer hamburger
  para sm zone, siguiendo `zLnkx` y `pYjWp` literalmente.

## Comando de commit (Codex en host)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"

rm -rf apps/admin-panel/dist
npm test
npm --workspace @delivrix/admin-panel run check

git add \
  apps/admin-panel/src/app/App.tsx \
  DOCUMENTACION/HITO_5_10_VARIANTES_PENCIL.md \
  COMMIT_FASE_H_21.md

git commit -m "feat(panel): responsive base tablet + doc variantes Pencil

- App.tsx: grid escalonado (mobile stack, 200w tablet, 240w desktop),
  main padding por breakpoint, Topbar wrap + py responsive, Sidebar
  con ancho fluido y padding por breakpoint.
- DOCUMENTACION/HITO_5_10_VARIANTES_PENCIL.md: auditoría literal de
  los 7 frames variantes Pencil (5 dark, 1 tablet zLnkx, 1 mobile
  pYjWp). Paleta dark confirmada 1:1 contra tokens.css. Plan H.22
  para tokenización + sidebar icon rail + mobile drawer.
- 15/15 admin-panel tests · 138/138 domain tests · tsc clean.

Refs: Hito 5.10 Wave B · base responsive + auditoría variantes.
"
```
