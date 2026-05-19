# Commit script — Fase H.1 + H.2 (tokens Pencil + 4 fuentes custom)

Archivos modificados:

- `apps/admin-panel/src/app/tokens.css` (paleta Pencil completa, light + dark + prefers-color-scheme)
- `apps/admin-panel/src/app/globals.css` (font-family bindings: headings, mono, caption)
- `apps/admin-panel/src/main.tsx` (imports de las 4 fuentes via @fontsource)
- `apps/admin-panel/package.json` (+ 4 deps de @fontsource)

Validacion en sandbox:

```
npx tsc --noEmit                                 OK
npx vite build --outDir /tmp/admin-build-h2      OK 47 kB CSS / 615 kB JS + ~20 woff/woff2 bundled
```

El visual cambia automaticamente porque los componentes consumen
`var(--color-*)` y los valores cambiaron a la paleta Pencil. No hay regresion
funcional. HMR del dev server lo recoge al guardar.

Desde la terminal de macOS:

```bash
cd ~/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de

git add \
  apps/admin-panel/src/app/tokens.css \
  apps/admin-panel/src/app/globals.css \
  apps/admin-panel/src/main.tsx \
  apps/admin-panel/package.json \
  package-lock.json

git commit -m "Implement Hito 5.10 Fase H.1 + H.2: Pencil paleta + 4 fuentes custom

Rebrand visual del admin panel para alinear con el archivo Pencil
'Panel Front End.pen', tomado como source-of-truth para el design system.

Paleta nueva:
- Accent: amber/orange (#F59E0B light, #FBBF24 dark) reemplazando el
  purple Stripe/Notion (#534AB7).
- Surfaces: warm creams (#FFFBF5, #F7F2EA, #FFFFFF) reemplazando los
  cool grays (#fafaf7, #ffffff, #f4f4f0).
- Foreground: deep browns (#1A1410, #5C544A, #8A8073) reemplazando
  cool blacks.
- Borders: warm taupes (#EAE0CE, #D4C5A8) reemplazando cool grays.
- Estado unknown: purple (#7C3AED) como categoria distinta de neutral.
- Estados con tonos saturados Tailwind 700-800 sobre soft bg.
- Hero gradients yellow -> amber -> orange.

Dark mode reescrito para warm browns: #14110D bg, #241D16 cards,
#1B1611 sunken, foreground cream #F5EDDF.

Tipografia: 4 fuentes custom via @fontsource (offline-first):
- Funnel Sans 400/500/600/700 para headings.
- Geist Variable para body.
- Inter 400/500/600 para captions.
- IBM Plex Mono 400/500 para data y codigo.
Reemplaza el system font stack que veniamos usando desde Fase B.

Spacing y radii ajustados a valores Pencil (radius-md 8 -> 6,
radius-lg 12 -> 8).

Nombres semanticos de variables CSS no cambian; solo los valores y la
binding de font-family. Los componentes shared/ui y todas las pantallas
absorben el rebrand sin cambios de codigo, sigue compilando, build OK.

Reference: DOCUMENTACION/HITO_5_10_FASE_H_BLUEPRINT_2026-05-17.md"
```

## Lo que queda en Fase H

- H.3 Actualizar shared/ui para audit visual fino con los nuevos tokens.
- H.4 Reescribir sections.ts (7 secciones → 5 Pencil).
- H.5 Nuevos primitives (Sparkline, Stepper, AuditLogTable, OpenClawPromptPanel, DarkCliSnippet, GradientGauge).
- H.6 Overview Dashboard pantalla nueva.
- H.7 Onboarding Wizard pantalla nueva.
- H.8 Hardware reescrito con riqueza Pencil.
- H.9 Collector reescrito.
- H.10 Clusters & Security unificado.
- H.11 Validar + commit final.
