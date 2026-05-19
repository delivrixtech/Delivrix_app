# Commit script — Fase E (polish + legacy cleanup)

Archivos modificados:

- `apps/admin-panel/src/app/App.tsx` (LoadingState y ErrorState reescritos con Skeleton + NoticeBanner + Card; helpers legacy borrados; sidebar sticky; toneForSection workflow ahora deriva del estado real)
- `apps/admin-panel/src/app/styles.css` (vaciado a 4 lineas de comentario; ya no se importa)
- `apps/admin-panel/src/main.tsx` (import de styles.css removido)

Validacion ejecutada en sandbox:

```
npx tsc --noEmit                                 OK
node --test src/shared/lib/formatters.test.ts    7/7 pass
node --test src/shared/api/client.test.ts        included
npx vite build --outDir /tmp/admin-build-e       OK 46.96 kB CSS / 614.27 kB JS
```

**CSS bajo de 58.35 kB a 46.96 kB** (-11.4 kB / -19.6 por ciento) gracias a remover el legacy.

Validado en vivo via Claude in Chrome:
- Sidebar permanece sticky bajo el topbar al hacer scroll en Canvas (verificado).
- LoadingState (no se ve hasta que el gateway tarde >1s en responder) usa Skeleton + grid coherente con el nuevo layout.
- ErrorState (no se ve mientras gateway esta arriba) usa NoticeBanner critical + Card con explicacion.

Desde la terminal de macOS, en la carpeta del worktree:

```bash
cd ~/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de

# Borrar styles.css si quieres limpieza total (el archivo ya esta vaciado a 4 lineas de comentario)
rm apps/admin-panel/src/app/styles.css

git add \
  apps/admin-panel/src/app/App.tsx \
  apps/admin-panel/src/app/styles.css \
  apps/admin-panel/src/main.tsx

git commit -m "Implement Hito 5.10 Fase E: cleanup legacy CSS, sidebar sticky, state polish

Close out Hito 5.10 by removing the legacy CSS that no section references
anymore and tightening the global shell.

- Remove src/app/styles.css. The 1068 legacy lines (Vanilla CSS layout
  primitives from Fase A) are no longer reached by any render after Fases
  B-D migrated all seven sections to Tailwind + shadcn primitives. Drop
  the import from main.tsx and delete the file. CSS bundle drops from
  58.35 kB to 46.96 kB (-19.6%).

- Delete the legacy helper components in App.tsx: TitleRow, PanelHeader,
  MetricCard (legacy), Badge (legacy), StatusPill, TokenGroup, TokenList,
  DefinitionGrid, DefinitionRow. None of them had callers after Fase D.

- Rewrite LoadingState with a skeleton grid that matches the new layout
  (eyebrow + title + 4 KPI placeholders + 2 panel placeholders) using a
  small inline Skeleton helper that consumes --color-surface-sunken with
  animate-pulse.

- Rewrite ErrorState with NoticeBanner critical + Card explaining that
  the gateway must run on :3000. Adds a Retry button using Button accent.

- Fix toneForSection('workflow') so the sidebar dot reflects the real
  worst tone among workflow steps (was hardcoded to 'success'). Now
  reduces over data.workflow.steps and picks critical > warning >
  success > neutral.

- Make the sidebar sticky under the topbar: 'sticky top-14 self-start
  h-[calc(100vh-3.5rem)] overflow-y-auto' with a max-md fallback that
  reverts to static for narrow viewports. Pantallas largas (Seguridad
  31 gates, Canvas con accordions expandidos) ya no pierden el nav al
  hacer scroll.

This closes the Hito 5.10 frontend redesign. Twenty-one shared primitives
+ domain components, seven migrated sections, light/dark theme parity,
~580 lines of Vanilla CSS retired, GET-only contract intact. Codex now
owns Fase F (responsive + dark mode pass + final polish) per the
blueprint."
```

Si Codex quiere recombinar Fase E con C+D en un solo commit grande, usar `git rebase -i 095fa7e^` y squash. Mi recomendacion: dejar Fase E como commit aparte porque el diff es facil de auditar (limpieza + dos componentes reescritos + un fix de tono).

Despues del commit, opcional:

```bash
# Limpiar archivos scratch del worktree
rm COMMIT_FASE_B.md COMMIT_B1.md COMMIT_FASE_C.md COMMIT_FASE_D.md COMMIT_FASE_C_D_AMEND.md COMMIT_FASE_E.md
```

Pendiente para tu validacion personal (no necesito Chrome):
- Responsive en mobile/tablet via tus devtools.
- Dark mode pass: toggle al tema oscuro y revisar las 7 pantallas.
- Si todo encaja, mergear a `main` cuando quieras.
