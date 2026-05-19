# Commit script - Fase B (Topbar + Sidebar + Seguridad migradas)

Esta rama esta lista para commit pero el sandbox no puede borrar `.git/worktrees/youthful-mirzakhani-c517de/index.lock` (limite del FUSE bindfs).

Desde la terminal de macOS, en la carpeta del worktree:

```bash
cd ~/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de
rm -f .git/worktrees/youthful-mirzakhani-c517de/index.lock 2>/dev/null
rm -f ../../../.git/worktrees/youthful-mirzakhani-c517de/index.lock 2>/dev/null

git add \
  apps/admin-panel/index.html \
  apps/admin-panel/package.json \
  apps/admin-panel/vite.config.ts \
  apps/admin-panel/src/main.tsx \
  apps/admin-panel/src/app/App.tsx \
  apps/admin-panel/src/app/tokens.css \
  apps/admin-panel/src/app/globals.css \
  apps/admin-panel/src/shared/lib/cn.ts \
  apps/admin-panel/src/shared/ui \
  package-lock.json

git commit -m "Implement Hito 5.10 Fase B: Tailwind 4 + shadcn primitives, Topbar/Sidebar shell, Seguridad migrated

- Install Tailwind 4 with @tailwindcss/vite, plus Radix Slot/Tooltip/Separator,
  clsx, tailwind-merge, class-variance-authority. Remove @fontsource Inter and
  JetBrains Mono in favor of the system font stack per Hito 5.10 decisions.

- Flip tokens.css to light theme as default; dark moves to [data-theme=dark].
  Adopt Stripe/Notion neutrals (#fafaf7, #ffffff, #f4f4f0) and Delivrix purple
  (#534ab7) as the single accent. Update prefers-color-scheme handler so OS
  preference still wins when no explicit theme is stored.

- Add globals.css wiring tokens into Tailwind via @theme inline so utilities
  like bg-surface, text-fg-muted, border-strong resolve to the active theme.
  Define :focus-visible to use shadow-focus globally and enable tabular nums.

- Create shared/ui primitives in shadcn style: Card, Badge, Button (with cva
  variants), Tooltip (Radix), Separator (Radix). Each consumes the token CSS
  variables instead of hardcoded hex.

- Create domain components: BrandBlock (Delivrix Admin one-liner), ModeBadge
  (persistent Mock dry-run with tooltip), FreshnessTag (relative time with
  absolute tooltip), Eyebrow, MetricCard, PageHeader, ThemeToggle.

- Replace global Topbar to use BrandBlock + ModeBadge + FreshnessTag + refresh
  button + ThemeToggle. Replace global Sidebar to group sections in three lanes
  (Estado vivo, Procesos, Barandillas) with dot indicators and section
  eyebrows. Wrap the app in TooltipProvider.

- Migrate SafetySection to the new stack with PageHeader, four MetricCards
  with actionable microcopy, two action panels (allowed/blocked), a new gates
  pending panel surfacing operatingNorth.gates, and a roles dl. The other six
  screens stay on legacy CSS until Fases C-D.

The panel remains GET-only. No backend, gateway or runtime contract changed.
Build passes (tsc, tests, vite build to /tmp). Light theme renders correctly
in both modes."
```

Despues del commit, regresa al directorio principal:

```bash
cd ~/Documents/delivrix\ app
```

Para ver el resultado en vivo:

```bash
npm install
npm run dev:gateway   # terminal 1
npm run dev:admin     # terminal 2
# Abrir http://127.0.0.1:5173 y entrar a la seccion Seguridad
```

Si la pantalla Seguridad luce limpia y profesional, Fase B esta lista. El resto
de las pantallas (Canvas, Hardware, Collector, Ruta, Clusters, Aprendizaje)
siguen con el estilo viejo hasta Fases C-D.
