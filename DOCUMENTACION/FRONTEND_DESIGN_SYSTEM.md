# Frontend design system

Fecha: 2026-05-09

Documento vivo de referencia visual para el admin panel Delivrix. Lo mantiene Claude como senior frontend owner del Hito 5.10. Codex revisa cada cambio.

Documentos rectores:

- `HITO_5_10_FRONTEND_UX_CLAUDE.md`
- `FRONTEND_UX_CONTRACT_GUIDE.md`
- `NORTE_OPERATIVO_DELIVRIX.md`

## Filosofia

El admin panel es un control plane operativo, no una landing page. La interfaz debe priorizar densidad operacional, claridad de estado y trazabilidad de evidencia, en ese orden.

Reglas que vienen de la guia y este sistema las hace cumplir:

- estado visual viene de contratos `GET` del Gateway, no se hardcodea;
- estados `unknown`, `stale`, `needs_review`, `blocked` y `ready` se diferencian visualmente;
- frescura visible siempre que un dato la tenga;
- sin gradientes decorativos, orbes, hero sections ni cards anidadas;
- sin animaciones de marketing.

## Tema

El tema por defecto es `dark`. El tema `light` queda disponible por toggle.

Razon: los control planes operativos casi siempre se operan en dark. Reduce fatiga visual en sesiones largas y los estados de color (success/warning/critical/unknown/stale) saltan con mas contraste sobre grafito.

El usuario puede alternar entre dark y light desde el toggle del topbar. La preferencia se persiste en `localStorage` con la llave `delivrix-admin-theme`.

Cuando no hay preferencia guardada, se respeta `prefers-color-scheme` del sistema. Un script inline en `index.html` aplica el atributo `data-theme` al `<html>` antes del primer paint para evitar FOUC.

## Tokens

Todos los tokens viven en `apps/admin-panel/src/app/tokens.css`. Se exponen como CSS custom properties bajo `:root`, `[data-theme="dark"]` y `[data-theme="light"]`.

### Color

Tokens semanticos (no usar valores hex directos en componentes):

| Token | Uso |
| --- | --- |
| `--color-bg` | Fondo de la app |
| `--color-surface` | Cards, paneles |
| `--color-surface-raised` | Hover, rows internas, sidebar |
| `--color-surface-sunken` | Code blocks, fondos extra-bajos |
| `--color-surface-overlay` | Popovers, dialogs |
| `--color-border` | Bordes normales |
| `--color-border-strong` | Bordes prominentes, divisores |
| `--color-border-focus` | Outline de foco accesible |
| `--color-text-primary` | Texto principal |
| `--color-text-secondary` | Texto secundario, labels |
| `--color-text-tertiary` | Captions, metadata |
| `--color-text-disabled` | Disabled |
| `--color-text-inverse` | Sobre fondo de acento |

### Acento de marca

`--color-accent` representa la identidad de OpenClaw. Es el unico color reservado a la marca; no se usa para estados.

| Token | Uso |
| --- | --- |
| `--color-accent` | Botones primarios futuros, focus ring, brand mark |
| `--color-accent-hover` | Hover de acento |
| `--color-accent-soft` | Background de chips de OpenClaw |
| `--color-accent-fg` | Texto sobre `--color-accent-soft` |

### Estados (6 tonos)

Cada estado tiene `solid` (color base), `soft` (background), `border` (linea) y `fg` (texto). Los seis tonos son distintos visualmente y no se confunden.

| Estado | Cuando usarlo |
| --- | --- |
| `success` | `ready`, `healthy`, `ok`, gates aprobados |
| `info` | `active`, `in_progress`, datos llegando |
| `warning` | `needs_review`, atencion humana esperada |
| `critical` | `blocked`, `requires_approval`, `kill_switch_active` |
| `unknown` | Sin evidencia, contrato vacio, dato no disponible |
| `stale` | Datos viejos, frescura caducada |

Importante: `unknown` y `stale` no son sinonimos de `warning`. La guia los separa explicitamente porque significan cosas distintas operativamente. `unknown` = no hay dato; `stale` = el dato es viejo. Visualmente:

- `unknown` se renderiza con outline (sin fill), dot hueco, lila pálido — vacio por construccion;
- `stale` se renderiza filled con tono marron calido, idealmente con icono de reloj y label de antigüedad.

### Tipografia

Fuentes locales via `@fontsource`:

- Sans: Inter Variable (`@fontsource-variable/inter`).
- Mono: JetBrains Mono pesos 400 y 500 (`@fontsource/jetbrains-mono`).

La mono se usa exclusivamente para datos tecnicos: IPs, hashes, IDs, uptimes, schema versions, endpoints, valores numericos crudos en metric values. Aplicar con `font-family: var(--font-mono)` o la utility class `.mono`.

`font-variant-numeric: tabular-nums` esta activo globalmente — los digitos se alinean en columna. Esto importa cuando una metrica cambia de "1234" a "1235" sin saltos.

Escala:

| Token | Tamaño |
| --- | --- |
| `--text-xs` | 11px (eyebrow micro) |
| `--text-sm` | 12px (eyebrow, captions) |
| `--text-base` | 13px (body small, table cells) |
| `--text-md` | 14px (body) |
| `--text-lg` | 15px (h3) |
| `--text-xl` | 16px (lead) |
| `--text-2xl` | 18px |
| `--text-3xl` | 20px (h1 actual) |
| `--text-4xl` | 24px |
| `--text-5xl` | 28px |
| `--text-display` | 32px (metric values grandes) |

### Spacing

Multiplos de 2 px hasta 4 px y de ahi pares. La densidad por defecto se logra con steps 4–8.

| Token | Valor |
| --- | --- |
| `--space-1` | 2 |
| `--space-2` | 4 |
| `--space-3` | 6 |
| `--space-4` | 8 |
| `--space-5` | 10 |
| `--space-6` | 12 |
| `--space-7` | 14 |
| `--space-8` | 16 |
| `--space-9` | 20 |
| `--space-10` | 24 |
| `--space-11` | 28 |
| `--space-12` | 32 |
| `--space-13` | 40 |
| `--space-14` | 48 |

### Radii

| Token | Valor | Uso |
| --- | --- | --- |
| `--radius-xs` | 4 | Tags, chips densos |
| `--radius-sm` | 6 | Inputs estrechos |
| `--radius-md` | 8 | Cards, botones, badges (default) |
| `--radius-lg` | 12 | Paneles grandes |
| `--radius-xl` | 16 | Dialogs |
| `--radius-pill` | 999 | Status pills, contadores redondos |

### Sombras

Tres niveles. En dark llevan mas alpha; en light son sutiles.

| Token | Uso |
| --- | --- |
| `--shadow-sm` | Hover ligero, divisores con profundidad |
| `--shadow-md` | Cards, paneles (default) |
| `--shadow-lg` | Popovers, dialogs |
| `--shadow-focus` | Anillo de foco accesible (sobre `--color-accent`) |

### Motion

Sin librerias de animacion. CSS transitions para feedback funcional, nada decorativo.

| Token | Valor | Uso |
| --- | --- | --- |
| `--duration-fast` | 120ms | Hover micro |
| `--duration-base` | 200ms | Toggle, tabs (default) |
| `--duration-slow` | 320ms | Drawer, layout shifts |
| `--ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | Default |
| `--ease-emphasized` | `cubic-bezier(0.2, 0, 0, 1)` | Entradas con peso |

## Aliases legacy

Mientras el panel se migra fase por fase, `tokens.css` exporta aliases hacia los nombres antiguos para no romper `styles.css`:

```
--bg            → --color-bg
--surface       → --color-surface
--surface-muted → --color-surface-raised
--border        → --color-border
--border-strong → --color-border-strong
--text          → --color-text-primary
--text-muted    → --color-text-secondary
--blue          → --color-info
--green         → --color-success
--amber         → --color-warning
--red           → --color-critical
--violet        → --color-accent
--shadow        → --shadow-md
```

Los aliases se eliminan cuando todas las referencias se reescriban en componentes nuevos. No introducir aliases nuevos.

## Reglas de uso

- No introducir colores hex nuevos en componentes; siempre usar tokens.
- No agregar valores hardcodeados de espaciado; usar `--space-*`.
- No mezclar `--color-info` con identidad de marca; el acento es solo para OpenClaw.
- No usar `--color-warning` para representar `unknown`.
- No usar `--color-warning` para representar `stale` — tiene token propio.
- No envolver `var()` dentro de otro `var()` mas de una vez (legibilidad).
- No agregar shadow mayor a `--shadow-lg` para evitar halos pesados.

## Fases del Hito 5.10

Cada fase es un commit independiente revisable por Codex.

| Fase | Alcance | Estado |
| --- | --- | --- |
| A | Tokens + dark mode + tipografia | en progreso |
| B | Reestructura archivos | pendiente |
| C | Componentes base | pendiente |
| D | Recharts + Hardware charts | pendiente |
| E | Canvas rediseño | pendiente |
| F | Collector + Workflow refinado | pendiente |
| G | Clusters + Aprendizaje + Seguridad | pendiente |
| H | Responsive + a11y + polish final | pendiente |

## Validacion

```bash
npm --workspace @delivrix/admin-panel run check
```

Cubre `tsc --noEmit`, `node --check server.mjs`, los tests del cliente read-only y `vite build`.
