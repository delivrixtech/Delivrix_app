# Hito 5.10 — Variantes Pencil (Dark + Tablet + Mobile)

> Auditoría leyendo los frames Pencil con `mcp__pencil-desktop__batch_get +
> resolveVariables=true`. Documento es la fuente de verdad para el wave H.21
> (variantes UX). No interpretar valores: usar los hex literales que Pencil
> guarda en el `.pen`.

## 1. Frames auditados

| Frame ID | Nombre Pencil                                  | Variante      |
| -------- | ---------------------------------------------- | ------------- |
| `NBLpA`  | Screen / Hardware Telemetry — Dark             | Dark · 1440w  |
| `saqG4`  | Screen / Collector & Ingestion — Dark          | Dark · 1440w  |
| `J1xQ0`  | Screen / Clusters & Security — Dark            | Dark · 1440w  |
| `QUsbP`  | Screen / Aprendizaje — Dark                    | Dark · 1440w  |
| `Y0RKZ`  | Screen / Seguridad — Dark                      | Dark · 1440w  |
| `zLnkx`  | Screen / Hardware Telemetry — Tablet           | Tablet · 768w |
| `pYjWp`  | Screen / Hardware Telemetry — Mobile           | Mobile · 390w |

## 2. Paleta dark (literal de Pencil)

Bases:

- `bg-canvas` · `#14110D` (Hero, Topbar, página entera)
- `bg-surface` · `#241D16` (cards, KillSwitch, AuditFooter)
- `bg-surface-alt` · `#1B1611` (audit rows, chips, evidence pill)
- `border` · `#322A20` (1px subtle warm)

Texto:

- `text-heading` · `#F5EDDF` (Funnel Sans bold, Geist 600)
- `text-muted` · `#B5A892`
- `text-subtle` · `#867865` (timestamps, table headers)

Accent:

- `accent` · `#FB923C` (operator@delivrix, actor names)
- `accent-soft-bg` · `#3A2A10` (warning chip dark)
- Gradient OpenClaw (border 2px del prompt + avatar):
  - 135° · `#FDE047 0%` → `#FBBF24 50%` → `#FB923C 100%`

Status soft (chips):

- success: bg `#14352A` · fg `#4ADE80`
- info: bg `#1B2845` · fg `#93C5FD`
- purple: bg `#26204A` · fg `#C4B5FD`
- warn: bg `#3A2A10` · fg `#FDE68A`
- critical: bg `#3F1A1A` · fg `#FCA5A5`

Sombras:

- subtle: `0 1px 3px #0000000A`
- prompt grande: `0 8px 24px #00000022`

CTA buttons (inversión vs light):

- primary: bg `#F5EDDF` · fg `#14110D` (botón cream sobre dark)
- secondary: bg `#241D16` · border `#322A20` · fg `#F5EDDF`

> ✅ Los valores ya están en `apps/admin-panel/src/app/tokens.css`
> bajo `[data-theme="dark"]` y `@media (prefers-color-scheme: dark)`.
> Verificado con diff contra Pencil.

## 3. Estado de la implementación

### Foundations listas

- `tokens.css` · 60+ tokens duplicados para light/dark (linea 92-166)
- `prefers-color-scheme` honrado cuando no hay `data-theme` (linea 263)
- `ThemeToggle` en `shared/ui/theme-toggle.tsx` (persiste a localStorage)

### Bloqueador para Dark real

Las 5 secciones (`features/*.tsx`) usan hex literales en `style={{...}}` y
clases Tailwind arbitrarias `bg-[#FFFFFF]`. La tokenización del Topbar y
Sidebar ya consume vars, pero el contenido de cada sección no. Sin un
sweep que reemplace literales por `var(--color-…)`, el toggle invierte
solo el chrome.

Ejemplo del literal predominante (encontrado en `features/learning/index.tsx`
y `features/safety/index.tsx`):

```tsx
className="flex flex-col bg-[#FFFFFF]"
style={{ border: "1px solid #EAE0CE", color: "#1A1410" }}
```

Debe convertirse en:

```tsx
className="flex flex-col"
style={{
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  color: "var(--color-text-primary)"
}}
```

Estimación: 6 archivos × ~40 literales = 240 ediciones puntuales. No es
intelectualmente difícil pero requiere un sweep dedicado para no romper
estados intermedios. Mejor cerrarlo como **H.21 Theme tokenization**.

## 4. Tablet · 834w × 1112h (frame `zLnkx`)

Pencil reduce la sidebar a un **icon rail** de 72w, sin texto:

- Sidebar rail: `width=72`, fill `#F7F2EA`, padding [16,12], gap 6
  - Cada nav item: 44×44, cornerRadius 8, icon-only
  - Active nav: fill `#F59E0B` (Canvas en el screenshot)
  - "ARMADO" chip al fondo: 48w bg `#DCFCE7` border `#15803D`
- Main column: 762w, comienza en x=72
- Topbar reducido: padding [12,16] (vs [16,28] desktop)
- Hero strip: padding [18,24,14,24], compacta
- Canvas wrapper: 873h, fill `#F7F2EA`
- Drawer tab (32w) en x=802: sliding detail panel (cornerRadius `[8,0,0,8]`)

## 5. Mobile · 390w × 844h (frame `pYjWp`)

Mobile **elimina la sidebar completamente** y usa appbar + tab navigation:

- Appbar: 56h, fill `#FFFBF5`
  - Hamburger icon (menu) `#1A1410` en (18,17)
  - Título centrado: "OpenClaw Canvas" Funnel Sans 16 600
  - Read-only chip: bg `#DBEAFE` derecha
- Tab strip: 44h, padding [6,16], gap 8
  - Active tab: fill `#F59E0B`, padding [6,12]
  - Inactive tabs: fill `#F7F2EA`
  - 5 tabs visibles horizontalmente (scroll horizontal si caben más)
- Hero: 80h, padding [12,16,8,16]
  - Eyebrow "CANVAS OPERATIVO" 10/600 Inter `#8A8073`
  - H1 "Flujo OpenClaw" Funnel Sans 22 600
  - Subtitle Geist 12 normal `#5C544A`
- Legend strip: 40h, padding [8,16], gap 14 (5 swatches)
- Pipeline (Canvas en mobile): vertical stack de 6 step cards de 358w cada uno
  - Línea vertical guía: rectángulo `#D4C5A8` 2w × 560h en x=11
- OpenClaw prompt: 358w, gradient border 2px (`#FACC15 → #F59E0B → #EA580C`)
  - Prompt inner: bg `#FFFBF5`, cornerRadius 10, padding 14
- Bottom strip: 40h, "Actualizado hace 14s" centrado

## 6. Estado responsive actual (App.tsx)

El shell ya implementa stacking básico vía Tailwind:

```tsx
<div className="grid grid-cols-[240px_minmax(0,1fr)] min-h-screen max-md:grid-cols-1">
  <Sidebar ... className="sticky ... max-md:static max-md:h-auto" />
  <main className="min-w-0 flex-1 px-6 py-6 sm:px-7 lg:px-10 xl:px-14 2xl:px-16">
```

Y las secciones tienen breakpoints `sm:grid-cols-2 lg:grid-cols-4` y
`lg:grid-cols-[minmax(0,1fr)_440px]`. Funcionan a 1024-1440 pero no
implementan la transformación literal de Pencil:

| Width    | Estado actual          | Pencil pide                       |
| -------- | ---------------------- | --------------------------------- |
| ≥ 1024px | Sidebar 240w + 2col    | Sidebar 240w (✅)                 |
| 768-1023 | Sidebar full ancha top | Sidebar rail 72w lateral          |
| < 768px  | Sidebar stacks arriba  | Sidebar → appbar + tabs (overlay) |

## 6. Plan H.21 (próxima sesión)

### H.21.A — Theme tokenization sweep
- Reemplazar hex literales → `var(--color-*)` en 5 features + shared/ui
- Validar `npx tsc --noEmit` + tests
- Smoke con `data-theme` toggling

### H.21.B — Tablet/Mobile breakpoints
- Leer frames `zLnkx` y `pYjWp` con `batch_get readDepth=3`
- Aplicar Tailwind responsive: `sm:` (640+) `md:` (768+) `lg:` (1024+)
- Sidebar drawer (radix Dialog) para `<md`
- Stack Hero / KpiRow / TwoCol en mobile
- Tabla audit → list-of-cards en `<md`

### H.21.C — Validar y commit
- Chrome devtools responsive: 390 / 768 / 1024 / 1440
- Toggle light/dark en cada uno
- 7 screenshots × 2 themes × 3 widths = 42 screenshots de QA
- COMMIT_FASE_H_21.md con script
