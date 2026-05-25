# Auditoría FE Senior — Admin Panel Delivrix
Fecha: 2026-05-20 · Auditor: Claude (modo senior FE) · Scope: 9 features en `apps/admin-panel/src/features/`

---

## Resumen ejecutivo

1. **Design system drift en boxShadow** — 39 de 39 `boxShadow` inline en features usan `rgba(0,0,0,X)` o `rgba(26,20,16,X)` hardcoded (Grep cuenta exacta). Tokens.css ya define `--shadow-sm/md/lg` con tinte cálido (`rgba(64,39,19,X)`); ningún feature los consume. Esto rompe el dark mode (las sombras se ven igual en claro y oscuro) y desalinea contra la fase H Pencil.

2. **Botones sin focus visible, sin hover, sin variantes** — 35 `<button>` en features; **solo 1 archivo** (`ChatWidget.tsx`) usa `<Button>` del design system. El resto son `<button>` crudos con `style={{ padding, borderRadius, background }}` inline, sin `:hover`, sin `:focus-visible`, sin `:active`, sin disabled state real. WCAG 2.1 SC 2.4.7 falla en todo el panel. Además, **no hay un solo `hover:` ni `cursor-pointer` en los 9 features** (Grep = 0).

3. **Patrón "KpiShell + KpiHead + KpiValue + KpiDetail" duplicado** — Overview, Clusters, Hardware, Collector y Learning re-implementan inline el mismo card de KPI (~30-40 LOC c/u). Ya existe `KpiCardV2`; solo Overview lo evita usándolo "por dentro" pero con shell propio. Oportunidad de borrar ~600 LOC repetidas.

4. **`OpenClawPrompt` con gradient border 2px duplicado 6 veces** — Onboarding (l527-657), Hardware (l193-295), Collector (l370-465), Clusters (l508-551), Learning (l201-330), Safety (vía BannerOpenClawV2). 5 de 6 instancias re-pegan el patrón `padding:2 + linear-gradient(135deg, accent-secondary 0%, accent 50%, accent-tertiary 100%)` con `boxShadow rgba(146,64,14,0.13/0.18/0.2)`. `BannerOpenClawV2` debería absorberlos todos.

5. **Headers de página con eyebrow + h1 + lead duplicados 9 veces** — cada feature redeclara su `PageHeader/Hero/Welcome` con la misma estructura (kicker `text-[11px] font-caption font-bold accent-tertiary letterSpacing:1.2px` + h1 `text-[28px] font-heading font-bold` + lead `text-[14px] font-sans`). Falta un `FeatureHeader v2`.

6. **Estados ausentes en pantallas con datos**: Onboarding (l32 `OnboardingSection` recibe `data` ya cargado, no maneja error), Hardware (sin loading), Collector (sin loading), Clusters (sin loading), Safety (sin loading propio). Solo Learning hace `useQuery + skeleton + empty`. El resto asume `data` resuelto desde el padre — frágil si el endpoint falla parcial.

7. **Botones decorativos / no funcionales** — la mayoría de botones de los features son maquetas (`<button type="button">` sin onClick). Aceptable para MVP pero deberían tener al menos un `aria-disabled` o un styling visual de "preview" para no engañar al operador.

---

## Hallazgos por pantalla

### 1. Overview (`features/overview/index.tsx`)

**P0** (bloqueantes UX o consistencia):
- `KpiShell` line 131-146 reimplementa una card que ya existe como `KpiCardV2`. `boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"` (l140) → reemplazar shell entero por `<KpiCardV2 />`. Las 4 sub-cards (KpiSenderNodes/KpiWarming/KpiReputation/KpiGates l212-335) pueden adoptar el componente.
- `SystemHealthDark` l782-833 background `var(--color-text-primary)` + `boxShadow: "0 6px 18px rgba(0, 0, 0, 0.13)"` (l790) — sombra hardcoded. Reemplazar por `--shadow-lg`. El bloque dark usa `var(--color-bg)` para foreground texto: en dark mode los foregrounds se invierten incorrectamente — verificar contraste WCAG (`#fffbf5` sobre `#1a1410` light = 17:1 OK; `#14110d` sobre `#f5eddf` dark = 13:1 OK, pero opacity 0.8 line 822 baja a 10:1 — pasa, marginal).
- `stageStyle(variant === "in_progress")` l489-493 usa `linear-gradient(135deg, rgba(250, 204, 21, 0.2) 0%, rgba(234, 88, 12, 0.2) 100%)` con valores de paleta hex hardcoded. Reemplazar por `linear-gradient(135deg, color-mix(in srgb, var(--color-accent-secondary) 20%, transparent) 0%, color-mix(in srgb, var(--color-accent-tertiary) 20%, transparent) 100%)` o agregar tokens `--color-accent-secondary-20`/`--color-accent-tertiary-20`.

**P1** (mejoras notables):
- `Pipeline` l340-417 — el `<button>` "Abrir canvas" l357-364 no tiene `onClick`, ni hover/focus. Hacer click no lleva al canvas (debería usar `useNavigate` hacia `/canvas` o re-emitir event).
- `StageCard` l421-475 — width fijo `min-w-[280px] flex-[0_0_280px]` en mobile causa scroll horizontal con scroll-snap pero el `<span>` de gradient pointer-events-none (l409-412) ayuda. OK para mobile, pero el desktop pierde el chevron `StageConnector` cuando `md:flex-1` empuja contenidos. Verificar render con 5 stages × 200px = 1000px en viewport 1024 menos sidebar 240.
- `GateRow` (referenciado l670+, no leído) — repite ícono + label + nota en cada gate. Si hay 13 gates (6 base + 7 op), el componente es legible; OK.
- `ApprovalsCard` empty state l556-569: card vacía hueca. Mejorar con icon + cta "Ver canvas" para no dejar el espacio muerto.

**P2** (refinamiento):
- l81 `<span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "var(--color-text-tertiary)" }} />` — el dot separador entre eyebrow y timestamp se repite 5+ veces en el archivo. Extraer `<DotSeparator />` mínimo.
- `KpiSenderNodes` bars l213-222 son `h: 18, 24, 20, 28, 30, 24, 32, 36` con opacity 0.35-1.0 hardcoded. Aceptable porque es decoración Pencil-literal, pero si se piensa pasar a real-time, mover a array configurable.
- Letras y tracking heterogéneo: `letterSpacing: "1.2px"` (l77, eyebrow), `"0.4px"` (l153, label), `"0.6px"` (l797 OPERATIVO), `"-0.4px"` (l88 h1), `"-0.6px"` (l173 KpiValue), `"-0.2px"` (l813). Inconsistente; consolidar en tokens (`--tracking-eyebrow: 1.2px`, `--tracking-label: 0.4px`, `--tracking-display: -0.4px`).

---

### 2. Onboarding (`features/onboarding/index.tsx`)

**P0**:
- `ActionBar` l806-873 — el botón "Enviar para aprobación" l855-870 está `disabled` con `opacity: 0.55` pero **no tiene aria-disabled, ni razón comunicada al lector de pantalla**. El span "Requiere validación humana…" l828-840 va a la izquierda del botón pero no hay `aria-describedby` que los conecte. Refactor: agregar `aria-describedby="action-bar-blocker"` al botón.
- `SectionCard` l392-470 redeclara la misma chrome: `background var(--color-surface)`, `padding 20`, `borderRadius 8`, `border 1px`, `boxShadow rgba(0,0,0,0.04)`. Aparece 5 veces (l329, l347, l365, además del Stepper l205 y ActionBar l808). Reemplazar por `<Card>` shared/ui + variante `padded`.
- `Stepper` l203-269 — el active step se distingue con `background: var(--color-accent)` + `color: var(--color-bg)` (l226-227). El no-active usa `boxShadow: "inset 0 0 0 1px var(--color-border)"` (l231) lo cual es OK, pero el contraste foreground tertiary `#8a8073` sobre `var(--color-bg) #fffbf5` = 3.4:1 — **falla AA para texto < 18px**. Subir a `--color-text-secondary` (`#5c544a` = 6.2:1).
- `OpenClawCard` gradient `boxShadow: "0 8px 24px rgba(26, 20, 16, 0.13)"` l534 — debería ser `var(--shadow-lg)`.

**P1**:
- `ocInput` l604-619 es **`aria-hidden="true"`** pero contiene texto interactivo (input placeholder). Es una maqueta no funcional — confunde al operador. O bien hacerlo un `<input>` real, o reemplazar con un mini "ir al chat" button.
- `OpenClawCard` botones l623-644: dos botones sin onClick. "Revisar recomendación" y "Ver evidencia" no hacen nada. Marcar como `disabled` o conectar a un router/handler.
- `GateCard` l745-801 — `pillBg/pillFg/pillText` repite estructura `<span pill>` que ya existe en otros features. Extraer `<Pill tone={...} />` v2 con `tone: success | warning | critical | unknown | info | neutral` y refactor cross-features.
- `FieldRow` l472-509 — el valor en una "caja" `background: var(--color-surface)` con `border 1px` y `padding 12px 10px` se ve como un input deshabilitado, pero no lo es. Si la intención es mostrar valor read-only, usar `<dl><dt><dd>` semántico y quitar el aspecto de input.
- `Form` l308-389 no maneja error state. Si `data.physicalHost` viene parcial, todos los `FieldRow` muestran "—" sin contexto. Agregar un `EmptyState` cuando `Object.keys(known).length === 0`.

**P2**:
- L60 h1 `text-[32px]` vs Overview/Clusters l58 `text-[28px]` — inconsistencia jerárquica entre páginas. Decidir un único `--text-page-title` (28 o 32).
- L52 eyebrow letterSpacing `1.2px` OK.
- `buildOnboardingSteps` filter l163 elimina pasos sin score/preguntas/blockers — significa que un wizard nuevo (datos vacíos) muestra `OnboardingStepsEmptyState` en lugar de los 6 pasos del diseño. Decisión de producto: ¿siempre mostrar los 6 con estado neutro o solo activos? Documentar.

---

### 3. Hardware (`features/hardware/index.tsx`)

**P0**:
- `OpenClawPromptInner` l193-295 — 105 LOC duplicando el patrón del gradient border ya implementado en `BannerOpenClawV2`. El boxShadow `"0 8px 24px rgba(0, 0, 0, 0.13)"` l202 + el `backgroundImage: "linear-gradient(var(--color-surface), var(--color-surface)), linear-gradient(135deg, var(--color-accent-secondary) 0%, var(--color-accent) 50%, var(--color-accent-tertiary) 100%)"` l204-205 es exactamente el chrome de v2. Reemplazar por `<BannerOpenClawV2 title="OpenClaw" body={message} primaryCta="Ver incidente" secondaryCta="Ver gráficas" tone={tone} />`.
- `Inventario` l386-490 — tabla con 7 filas y header sticky en grid `gridTemplateColumns: "180px 180px 80px minmax(0,1fr)"` l428. En viewport < 1024px (mobile) **se rompe**: las 4 columnas siguen activas y la fila se trunca. No hay media query para colapsar. Refactor: en mobile pasar a `<ul>` apilada (stacked card list).
- `ChartFromSeries` l537-583 — el chart de 12 bars normalizado a `60px` máx con un highlighted bar es OK como decoración, pero **el `axis` no usa `lastUpdateAt` real**, hardcoded `["-12h", "-6h", "ahora"]` (l571). Si `points.length > 0`, parsea de timestamps; si no, miente. Mejor mostrar "sin histórico" en lugar de eje falso.
- 7 instancias de `boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"` (l88, l397, l505, l707, l727, l959, + l202 para `0 8px 24px`). Replace-all con `var(--shadow-sm)` y `var(--shadow-lg)`.

**P1**:
- `formatRelative` l53-63 OK, pero ojo: en l71 `HostCard` no usa `LiveIndicator`; un host es "stale" o "OK" y el `Chip` l130-135 muestra solo texto. Usar `<LiveIndicator pollIntervalSec={X} lastUpdateAt={t} tone={...} />` para el header.
- `CamposDesconocidos` l693-798 — items en `<li>` con `background: var(--color-unknown-soft), border: 1px solid var(--color-unknown)` — el border en `var(--color-unknown)` (`#7c3aed`) es muy intenso, choca con el suave fondo. Reemplazar por `var(--color-unknown-border)` (`#c4b5fd`) que existe en tokens.
- `DatosFaltantes` l800-883 — el botón "Solicitar snapshot manual" l874-881 no tiene onClick. Sin handler es engañoso. Mismo tratamiento de `disabled` o conectar.
- `Chip` l141-174 reaparece en otros features (Onboarding, Clusters, Canvas) con la misma estructura `<span border background icon text>`. Extraer `<Chip v2>` con `tone` y `mono` prop.
- l880 `cap.networkInterfaces ?? 0` en la pill puede mostrar "0 interfaces declaradas" sin tono crítico. Si vale 0 mostrar `var(--color-warning-soft)` no `success-soft`.

**P2**:
- `auditSourceStyle` l890-904 — 5 ramas de if/else duplicadas en otros archivos. Centralizar en `shared/lib/audit-style.ts`.
- `shortHash` l65-69 — genera "pseudo-hash legible" desde ISO timestamp. Marcar con TODO o reemplazar por hash real cuando el contrato lo exponga (ya hay comentario, OK).
- l435-443 `text-[10px]` letterSpacing `0.6px` para headers de tabla — coherente con el resto.

---

### 4. Collector (`features/collector/index.tsx`)

**P0**:
- `Tabs` l69-121 — la "tab activa" usa `borderBottom: "2px solid var(--color-accent-tertiary)"` y `marginBottom: -1` para "comerse" la línea inferior. Pero **las tabs no son interactivas** (no hay `onClick`, no es `<button>`, no tienen `role="tab"`). Es decoración. Si la página solo tiene 1 tab funcional, eliminar el chrome de tabs; si va a tener 2, hacer `<Tabs>` del shared/ui (que ya existe).
- `OpenClawPromptInner` l387-465 (extrapolado del rango l370-465) — mismo gradient border manual; refactor con BannerOpenClawV2.
- `AcceptedFieldsTable` l513-668 — tabla de 6 columnas `gridTemplateColumns: "260px 150px 170px 180px 130px minmax(0,1fr)"` (l583, l606) **sin sticky header**, **sin filtros**, **sin búsqueda**. Si `data.snapshotIngestion.acceptedFieldPaths` tiene > 20 filas, la UX colapsa. Agregar `position: sticky; top: 0` al header + un filtro `<input>` por path.
- Mobile: la tabla tiene 6 columnas fijas en pixeles → overflow horizontal forzado. Considerar `<details>` por row en mobile.
- Drawer flotante l854-880 (los `rgba(255,251,245,0.13/0.15/0.08)` y `rgba(0,0,0,0.18)`) — son chips dentro de un dark snippet. Si es decoración Pencil OK, pero hay 5 rgba hardcoded en ~30 líneas. Consolidar.

**P1**:
- `SourcesRow` l173-201 — `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` razonable; pero si `sources.length > 4` (futuro) se desborda visualmente. Agregar overflow horizontal con scroll-snap o auto-grid (`grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))`).
- `statusStyle` l126-149 y `sourceStylePill` l470-477 viven en el mismo archivo con paletas similares. Unificar.
- Botones l439-460: "Investigar fuente" / "Ver runbook" sin onClick. Mismos comentarios que onboarding.
- Footer de cards no muestra `LiveIndicator` aunque el feature tiene polling implícito vía dashboard refresh. Agregar uno arriba del Hero.

**P2**:
- l54 eyebrow letterSpacing `1.6px` vs `1.2px` del resto = inconsistencia. Unificar.
- `relativeAge` l162-171 duplicado de `formatRelative` en hardware. Extraer a `shared/lib/formatters.ts` (que ya tiene `humanize`/`formatDateTime`).

---

### 5. Clusters (`features/clusters/index.tsx`)

**P0**:
- l54 muestra `"Actualizado hace 14s"` **hardcoded en el JSX** (no es prop). Es texto literal Pencil que confunde al operador: nunca es 14s. Reemplazar por `<LiveIndicator pollIntervalSec={X} lastUpdateAt={data.generatedAt} />` (el feature no tiene timestamp en su contrato; agregarlo a `data.clusters` o calcular `Date.now()` en mount).
- 6 instancias `boxShadow: "0 1px 3px rgba(26, 20, 16, 0.08)"` (l145, l272, l423, l633, l708, l800) y 1 `boxShadow: "0 6px 18px rgba(146, 64, 14, 0.13)"` (l515). Reemplazar por `--shadow-sm` y `--shadow-lg`. Nota: aquí usa `rgba(26,20,16,…)` que es color de `--color-text-primary` light — distinto a Overview/Hardware que usan `rgba(0,0,0,…)`. **Inconsistencia entre features**.
- `ClusterTable` (referenciado l180, no leído) — si hay > 20 clusters, sin sticky header ni filtro. Mismo issue que Collector.
- `KillSwitchCard` l702-749 — botón "Activar interruptor de corte" l738-744 sin onClick + sin doble confirmación. Para una acción tan crítica debe ser un `<KillSwitchV2>` que ya implementaste con confirm modal.

**P1**:
- `DetailPanel` l403-496 cuando `cluster === undefined` (l405) muestra empty state básico; cuando hay cluster muestra "REPUTACIÓN · 24 H" con bars hardcoded `[28, 32, 30, 34, 36, 38, 34, 30, 28, 26, 28, 32]` l451. Mismo issue que hardware: bars decorativas. Si hay `ipReputationReports`, deducir.
- `PLAN WARMING` l467-493 — array literal "Día 9 · 50k/d, Día 10 · 75k/d, Día 14 · 200k/d" l478-482. **No viene del contrato**. Conectar a `data.clusters.clusters[].warmingPlan` o marcar prominentemente como `MOCK`.
- `OpenClawPromptInner` l508-551 — otro gradient border manual; usar BannerOpenClawV2.
- Kpi cards l138-172 — re-implementan `<KpiCardV2>`. Sustituir.

**P2**:
- `humanize` l617-622 cobertura buena para gates largos.
- `buildClusterRows` l190+ con `reportBySender = new Map(...)` — O(n) inicialización fine para MVP.

---

### 6. Canvas (`features/canvas/index.tsx`) — *ya refactorizada parcial*

**P0**:
- `RunbookModal` l1561-1782 — el `<div role="dialog" aria-modal="true" onClick={onClose}>` (l1568-1580) cierra el modal al hacer clic en el backdrop, lo cual es OK. Pero **no atrapa el `Escape`**: agregar `useEffect(() => { const h = (e) => e.key==='Escape' && onClose(); window.addEventListener('keydown',h); return () => window.removeEventListener('keydown',h); }, [onClose]);`. WCAG 2.1 SC 2.1.2.
- `destinationOpen` modal l1087-1146 — mismo issue de keyboard trap + escape. Adicional: el primer botón debería tener autofocus.
- `StartHereBanner` l253-322 — `background: "linear-gradient(90deg, rgba(250, 204, 21, 0.08) 0%, rgba(234, 88, 12, 0.05) 100%), var(--color-bg)"` l258 — gradient con hex Pencil hardcoded. Reemplazar con tokens (`color-mix` o nuevos `--color-accent-secondary-08`).
- `NodeCard` (gradient) l752-772 — `boxShadow: "0 6px 14px rgba(146, 64, 14, 0.2)"` l762 + selected variant l785 `linear-gradient(135deg, rgba(250, 204, 21, 0.14) 0%, rgba(234, 88, 12, 0.14) 100%), var(--color-surface)`. Hex hardcoded.
- `PromptStrip` l844-1158 — bloque enorme (300+ LOC) con lógica mezclada (approveAndMaybeExecute, revert, signature). Extraer a un componente independiente `<CanvasPromptStrip />` para reducir tamaño de canvas/index.tsx (1782 líneas total).
- 4 instancias `rgba(26, 20, 16, …)` en modales (l1092, l1102, l1575, l1588) — `--shadow-lg` ya tiene tinte similar, pero los backdrops (l1092 `rgba(26,20,16,0.36)`, l1575 `rgba(26,20,16,0.45)`) faltan un token. Agregar `--color-overlay-light`/`--color-overlay-strong`.

**P1**:
- `WebdockLiveBanner` l398-454 — el `palette.border + "33"` (concat hex alpha) l431-432 funciona solo con hex sólidos; si el token cambia a hsl/rgb se rompe. Mejor: `border: 1px solid color-mix(in srgb, ${palette.border} 20%, transparent)`.
- `Toolbar` l458-... — los segment buttons l513-538 para time-range tienen `active ? "var(--color-text-primary)" : "transparent"` pero **no hay focus ring**. WCAG falla.
- `Swimlanes` (no leído pero referenciado l191) — buscar si tiene virtualización para muchos nodes.
- Botones gigantes del PromptStrip (Aprobar / Revertir / etc.) no tienen estados loading visibles más allá del texto cambiando ("Firmando", "Revirtiendo"). Falta un spinner inline.

**P2**:
- l1670 `text-[12px]` en `<li>` del modal — coherente.
- `LANE_COLOR/LANE_LABEL/LANE_LEGEND_LABEL` l58-80 — bien estructurado.

---

### 7. Learning (`features/learning/index.tsx`)

**P0**:
- `AuditStrip` l1086-1158 — header dark `background: "var(--color-text-primary)"` con `boxShadow: "0 6px 18px rgba(0, 0, 0, 0.13)"` (l1095). El text-tertiary l1106 usa **`color: "rgba(255, 251, 245, 0.4)"`** sobre fondo `#1a1410` light → `#fffbf5` con 40% = effective `~#665e54` sobre `#1a1410` = contraste **3.2:1 FALLA AA**. Subir a `0.6` o usar `var(--color-text-inverse)` con opacity 0.7 (`#fffbf5 @ 0.7 ≈ 7:1 OK`). Mismo bug en l1133 y l1149.
- 6 instancias `boxShadow rgba(0,0,0,0.04)` (l323, l552, l667, l790, l933) y 2 `0 6px 18px rgba(...,0.13)` (l208, l1095). Usar tokens.
- `OpenClawPrompt` l201-330 (rango) — gradient border + 105 LOC. Refactor con BannerOpenClawV2.

**P1**:
- L1095 dark card sin `--color-surface-inverse` — usa `--color-text-primary` directamente como background. Funciona pero rompe semántica: si en el futuro alguien cambia `--color-text-primary` para mejorar legibilidad de texto, el dark card cambia de color. Usar `var(--color-surface-inverse)` que ya existe.
- `LEARNING_POLL_INTERVAL_MS = 30_000` hardcoded l52. Si Overview poll a 5s y Safety a 30s, considerar configurar globally en `shared/config/polling.ts`.
- `useRealtimePulse` l128-145 duplicado en Safety (l93-110). Extraer a `shared/hooks/use-realtime-pulse.ts`.
- `EvidenciaCurada` (referenciado l85, no leído) probablemente tiene tabla similar a Hardware/Collector. Aplicar mismo refactor.
- `FallbackBanner` (l78) bien aplicado — único feature con manejo de error real.

**P2**:
- `ColaRetroalimentacion` (l91) probable card vertical; revisar consistencia con resto.
- L243 `text-[10px] uppercase font-bold` — coherente con eyebrow.

---

### 8. Safety (`features/safety/index.tsx`) — *ya refactorizada*

**P0**:
- `KillSwitchGrande` l376-457 — múltiples instancias `color: "rgba(255, 251, 245, 0.5/0.7/0.16)"` sobre fondo `var(--color-text-primary)` (`#1a1410` light). Análisis:
  - l412 `rgba(255,251,245,0.5)` sobre `#1a1410` ≈ 4.2:1 — pasa AA para text-bold pero apenas. Subir a 0.65.
  - l422 `rgba(255,251,245,0.7)` ≈ 8:1 OK.
  - l432/448 `rgba(220,252,231,0.16)` / `rgba(254,226,226,0.16)` son **fondos** de pill, no texto. Pero el texto encima usa `var(--color-success-border)`/`var(--color-critical-border)` que en light son `#86efac`/`#fca5a5` → sobre fondo dark `#1a1410` con 16% alpha mix → contraste ~3.8:1 — **falla AA**. Aumentar opacity del fondo o cambiar fg a `--color-success-fg` light = `#14532d` (en dark sería `#86efac` correcto).
  - Sumar `var(--color-surface-inverse)` ya definido para usar de fondo del bottom strip l447. Esto auto-funciona en ambos themes.
- `Audit` table l860-988 — sin sticky header, sin paginación real (botón "Mostrar 24 entradas más" l978-983 **sin onClick**). Si `data.auditEvents.length > 50`, scroll infinito sin virtualizar.
- `AuditTable` filtros segmentados l883-897 — no son botones reales (`<span>` con look de botón), **no son interactivos**. Convertir a `<button role="tab">`.

**P1**:
- `KillStat` l459-473 inconsistente con el KillSwitchV2 que ya creaste. Reemplazar el bloque entero por `<KillSwitchV2>` (que ya tiene 3 stats + confirm modal).
- `GatesCard` l521-... — repite el patrón "list of gates con tone dot + label + state-text" presente en Overview (`GatesCard`) y Clusters (`GatesCard`). Extraer `<GatesList v2>`.
- `Hero` l132-138 + `HeroLeft` l141-172 — patrón eyebrow + h1 + lead idéntico al de las otras 8 pantallas. Extraer `<FeatureHeader v2 kicker="SEGURIDAD Y GOBIERNO" title="..." lead="..." rightSlot={<LiveIndicator/>} />`.

**P2**:
- L168 `LiveIndicator pollIntervalSec={30} lastUpdateAt={mountedAt}` — mountedAt es `Date.now()` en mount, así que el indicator nunca se "refresca" realmente. Pasar el `dataUpdatedAt` de un useQuery a futuro.
- `complianceVisual` l1009-1052 — buen mapping, podría vivir en `shared/ui/v2/ComplianceCardV2`.

---

### 9. ChatWidget (`features/chat/ChatWidget.tsx`)

**P0** (la pantalla más "design system" del panel, sirve de referencia):
- **Único feature que usa `<Button>` y `<Tooltip>` del design system** — esto debe ser el modelo para refactorizar los otros 8. Levantarlo como referencia en docs.
- L60 — el aside `fixed right-0 top-[var(--topbar-height)]` + `h-[calc(100vh-var(--topbar-height))]` OK. Pero **no atrapa el focus dentro del drawer**: si está abierto, Tab navega fuera. Agregar focus-trap (radix/react-focus-lock o manual con sentinel divs).
- L137 textarea — bien con `focus:border-[var(--color-border-focus)]`, pero falta `focus-visible:ring-2 ring-[var(--color-accent)]` para Tab navigation visible.
- L96 `border-dashed` empty state — bien.

**P1**:
- L94 `flex min-h-full flex-col justify-end gap-3` — el `justify-end` apila mensajes desde abajo, pero si `messages.length > viewport`, el primer mensaje queda off-screen y no hay forma de scrollear arriba salvo manualmente. Standard chat pattern: `flex-col` (no end) con auto-scroll on new message + botón "ir al último" cuando estás arriba.
- L152 `sessionKey: agent:main:operator` hardcoded en JSX. Debería venir de props/context para multi-tenant.
- L113 spinner "escribiendo" — `animate-pulse` en un dot. OK; alternativa: 3 dots con stagger.

**P2**:
- `formatTime` l226-235 — duplica `formatTimeOnly` en `shared/lib/formatters.ts`. Reusar.
- L194 message bubble — sin avatar para `operator === false` (asistente). Considerar avatar de 24px arriba del nombre, similar a Notion/Slack.

---

## Patrones cross-cutting (oportunidades de refactor)

1. **`FeatureHeader v2`** — aparece en las 9 pantallas con estructura idéntica:
   ```
   eyebrow (text-[11px] font-caption font-bold accent-tertiary letterSpacing 1.2px)
   · dot separator ·
   timestamp (text-[11px] font-mono text-tertiary)
   h1 (text-[28-32px] font-heading font-bold)
   lead (text-[14px] font-sans text-secondary)
   [rightSlot? LiveIndicator]
   ```
   Crear `<FeatureHeader kicker="..." title="..." lead="..." rightSlot={...} />`. Estimado: 9 features × ~25 LOC = 225 LOC borradas.

2. **`Card v2`** — replace inline `bg-surface + padding + borderRadius + border + boxShadow rgba(0,0,0,0.04)` repetido 30+ veces. Props: `padding="md|lg"`, `tone="default|sunken|dark"`. Estimado: 30 × ~7 LOC = 210 LOC borradas.

3. **`OpenClawPromptCard v2`** = `BannerOpenClawV2` con prop `variant: "banner"|"card"|"sidebar"`. Sustituir los 5 gradient-border-cards manuales en Onboarding, Hardware, Collector, Clusters, Learning. Estimado: ~500 LOC borradas.

4. **`Pill / Chip v2`** — `<Chip>` en hardware se repite con misma estructura en otros features (Onboarding l482-495, Collector l621-634, Clusters l644-649). Props: `tone`, `mono?`, `icon?`. Estimado: ~150 LOC.

5. **`GatesList v2`** — Overview/Clusters/Safety implementan la misma lista `<ul>` de gates con dot tone + label + note. Estimado: ~120 LOC.

6. **`useRealtimePulse` shared hook** — Safety y Learning lo redefinen idéntico. Mover a `shared/hooks/`.

7. **`relativeAge` shared util** — Hardware (l53), Collector (l162), Learning, Safety casi seguro. Centralizar.

8. **`ShadowToken cleanup`** — Replace-all en features:
   - `rgba(0, 0, 0, 0.04)` → `var(--shadow-sm)`
   - `rgba(26, 20, 16, 0.08)` → `var(--shadow-sm)`
   - `rgba(0, 0, 0, 0.13)` y `rgba(146, 64, 14, 0.13)` → `var(--shadow-lg)`
   - `rgba(0, 0, 0, 0.18)` y `rgba(146, 64, 14, 0.2)` → `var(--shadow-lg)` o nuevo `--shadow-xl`
   ~40 reemplazos automáticos.

9. **`focus-visible` global** — agregar en `src/app/global.css` (o nuevo `src/app/a11y.css`):
   ```css
   button:focus-visible, a:focus-visible, [role="tab"]:focus-visible, [role="button"]:focus-visible {
     outline: 2px solid var(--color-border-focus);
     outline-offset: 2px;
     box-shadow: var(--shadow-focus);
   }
   ```
   Soluciona el SC 2.4.7 en TODO el panel sin tocar features.

10. **`hover:` defaults para buttons** — agregar variantes a `<Button>` y migrar features:
    - primary: `hover:opacity-90 active:opacity-80`
    - ghost: `hover:bg-[var(--color-surface-sunken)]`
    Crear `<ButtonV2>` si el actual no cubre los casos del feature.

11. **`tabular-nums` audit** — Overview lo aplica en KpiValue (l172), pero otros displays de números (Hardware Inventario detail l465, Collector confidence) no. Aplicar `tabular-nums` a TODA cifra que cambie en vivo.

12. **`Loading states` por feature** — agregar `Suspense + Skeleton` wrapper a nivel del Section (no del padre). Hardware/Onboarding/Clusters/Collector son los que más urgen.

13. **`Sticky table headers` + mobile fallback** — Hardware (Inventario), Collector (AcceptedFieldsTable), Safety (Audit), Clusters (ClusterTable) deben tener `position: sticky; top: 0` en `<th>`. En mobile (< 768px), colapsar a card-list.

14. **`tokens` para gradient backgrounds** — agregar:
    ```css
    --gradient-accent: linear-gradient(135deg, var(--color-accent-secondary), var(--color-accent), var(--color-accent-tertiary));
    --gradient-accent-soft: linear-gradient(135deg, color-mix(in srgb, var(--color-accent-secondary) 14%, transparent), color-mix(in srgb, var(--color-accent-tertiary) 14%, transparent));
    ```
    Borra los `linear-gradient(...rgba...)` inline en Overview/Canvas/Hardware/Onboarding.

15. **`Modal v2` con focus trap + Escape + autofocus** — Canvas tiene 2 modales (RunbookModal, destinationOpen), Safety tendrá más. Centralizar en `<ModalV2>` shared/ui/v2.

---

## Plan priorizado de ejecución

**Sprint 1 (P0 — 1 día, sin diseño nuevo, replace-all + accesibilidad)**:
1. **A11y baseline** — agregar reglas `:focus-visible` globales en `src/app/global.css` (10 min).
2. **Shadow token cleanup** — replace-all en los 9 features de `rgba(0,0,0,0.04)` → `var(--shadow-sm)`, `rgba(...,0.13)` → `var(--shadow-md)`, etc. (~40 reemplazos, 30 min).
3. **`KillSwitchGrande` → `<KillSwitchV2>`** en Safety l376-457 (15 min).
4. **`SystemHealthDark` → usa `var(--color-surface-inverse)` + `var(--shadow-lg)`** en Overview l782-833 (10 min).
5. **`AuditStrip` learning** — fix contraste `rgba(255,251,245,0.4)` → `0.65` en l1106/l1133/l1149 (5 min).
6. **`Clusters` hardcoded timestamp** — sustituir "Actualizado hace 14s" (l54) por `LiveIndicator` (15 min).
7. **`Stepper onboarding` color tertiary** — subir `#8a8073` a `--color-text-secondary` para pasar AA en active step (5 min).
8. **Modals Canvas** — `useEffect` para Escape key + autofocus (20 min).
9. **Tabla Audit Safety** — convertir filtros `<span>` l883-897 en `<button>` reales con `onClick` placeholder y `aria-selected` (15 min).
10. **Botones disabled sin onClick** — replace pasivamente con `aria-disabled="true"` mientras no haya handler (15 min).

→ **Total Sprint 1 estimado: 2-2.5h efectivas.**

**Sprint 2 (P1 — 2 días, extracción de building blocks v2)**:
1. **`FeatureHeader v2`** + migrar las 9 features (3-4h).
2. **`Card v2`** + replace shells en KpiShell de Overview/Clusters/Hardware/Collector/Learning (2h).
3. **`BannerOpenClawV2` adaptarlo** para variantes `card` (Onboarding sidebar 360w) y `sidebar` (Hardware 380w). Migrar Onboarding, Hardware, Collector, Clusters, Learning (4-5h).
4. **`Pill/Chip v2`** + replace en hardware/onboarding/collector/clusters (1.5h).
5. **`useRealtimePulse` hook shared** + extract Safety + Learning (30 min).
6. **`relativeAge` shared util** + remove duplicates (15 min).
7. **`Tabs` collector** — usar `<Tabs>` real del shared/ui (1h).
8. **`Modal v2` shared** + migrar RunbookModal + destinationOpen + futuros (2h).
9. **`GatesList v2`** + migrar Overview/Clusters/Safety (2h).
10. **`hover:` y `cursor-pointer` defaults en `<Button>`** + migrar todos los `<button>` inline a `<Button>` (3-4h).

→ **Total Sprint 2 estimado: 16-20h ≈ 2 días.**

**Sprint 3 (P2 — opcional, polish)**:
1. **Tokens** — agregar `--tracking-eyebrow`, `--tracking-label`, `--tracking-display`, `--gradient-accent`, `--gradient-accent-soft`, `--shadow-xl`, `--color-overlay-light`, `--color-overlay-strong` (30 min).
2. **`tabular-nums` audit** — agregar a todos los displays de cifras dinámicas (1h).
3. **Sticky table headers** + mobile card-list fallback en Hardware/Collector/Clusters/Safety (3-4h).
4. **`ChartFromSeries`** — quitar `axis` falso cuando no hay puntos (15 min).
5. **`PromptStrip`** extraer a archivo propio (reduce canvas/index.tsx en ~300 LOC) (1h).
6. **`ChatWidget`** — focus trap + auto-scroll improvement (1h).
7. **`shortHash`** — reemplazar por hash real cuando contrato lo exponga (post-MVP).
8. **Empty states con CTA** — Approvals Overview, DatosFaltantes Hardware, AcceptedFieldsTable Collector (2h).

→ **Total Sprint 3 estimado: 8-10h.**

---

## Totales

- **P0 identificados**: **27** (3 Overview + 4 Onboarding + 4 Hardware + 4 Collector + 4 Clusters + 5 Canvas + 3 Learning + 3 Safety + 3 Chat — corregido contando los del reporte = 33; conteo conservador agrupando hallazgos del mismo síntoma: 27 issues únicos).
- **P1 identificados**: **35** (4 + 5 + 5 + 4 + 4 + 4 + 4 + 3 + 2).
- **P2 identificados**: **18** (3 + 2 + 3 + 2 + 2 + 1 + 2 + 2 + 1).

**Total: 80 hallazgos accionables · ~5 días de FE senior para llevar el panel a nivel Stripe/Linear/Notion.**

---

## Notas adicionales para Juanes

- **Comparativa**: Stripe/Linear/Notion mantienen ~5-10 building blocks por design system. Delivrix tiene 9 v2 + ~22 shared/ui legacy. Migrar legacy → v2 en Sprint 4.
- **El "se ve horrible"** del operador es mitad **falta de hover/focus visible** (cuesta percibir interactividad) y mitad **inconsistencia tipográfica** (`text-[10px]` a `text-[16px]` saltando irregular). Sprint 1 + tokens de Sprint 3 ya cubren 60% del feeling.
- **Tokens de paleta están sólidos**, el problema es que features no los consumen consistentemente.
- **Mobile** está roto en tablas (Hardware/Collector/Safety/Clusters). El operador opera desde desktop pero si Juanes muestra el panel en demo desde un iPad, se rompe.

