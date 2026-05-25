# Audit profundo · Canvas OpenClaw (`features/canvas/index.tsx`)
Fecha: 2026-05-24 · Auditor: Claude (FE senior · diagnóstico "sigue igual")

## Diagnóstico raíz: el Canvas no es un canvas

El operador dijo desde el día 1: "el Canvas ni es canvas ni es pizarra". Es **5 swimlanes apiladas verticalmente con scroll horizontal por carril**. No hay pizarra, no hay pan, no hay edges, no hay grid. La sensación es la de un panel de listas más, no la de una vista operativa viva.

El refactor v2 anterior (LiveIndicator en Hero) fue cosmético. **Lo que hace que "siga igual" no es el chrome, es la arquitectura visual.**

## Findings priorizados

### P0 — bloqueantes UX/percepción "viva"

1. **Status changes no se ven** · líneas 737–793
   - `NodeCard` repinta cuando el contrato cambia, pero el cambio no es visible: no hay animación, no hay halo, no hay highlight diferencial.
   - El polling es cada 5s. Si un nodo pasa de `in_progress` → `ready`, el operador no tiene cómo notarlo a menos que esté mirando esa card específica.
   - **Fix**: detectar cambios de `node.status` con `useRef` + signature, aplicar clase `v2-tick-halo` (ya está en globals.css, animación 600ms `box-shadow 0 0 0 6px transparent`) en el card. Mismo patrón que `useRealtimePulse` en safety/index.tsx l70.

2. **Sin edges/connections entre nodos relacionados** · líneas 708–733
   - Los nodos están separados por `<ChevronRight>` static. No hay líneas que muestren que "DKIM rotation" depende de "Postfix install".
   - Si un nodo está `blocked`, los siguientes en la cadena NO muestran que están bloqueados por dependencia.
   - **Fix corto**: cuando un nodo es `blocked` y el siguiente sería `not_started`, pintar el chevron en `var(--color-critical)` con `v2-edge-flow` animation (ya en globals.css).
   - **Fix largo**: migrar a ReactFlow (ya importado por `delivrix-node` en globals.css l128) con edges reales.

3. **Zoom es CSS transform**, distorsiona texto · líneas 638–643
   ```ts
   style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: scale !== 1 ? `${100 / scale}%` : "100%" }}
   ```
   - A 50% el texto se vuelve borroso y los hover hitbox se desalinean.
   - El "100% / Ajustar" no hace nada distinto (porque scale=1 ya es ajustar).
   - **Fix**: o quitar el zoom (los swimlanes ya hacen scroll horizontal nativo), o reemplazar por un control de densidad real (`small/comfortable/spacious` que cambie `padding`/`fontSize`).

4. **PromptStrip queda enterrado al final** · líneas 832–1075
   - Está después de Swimlanes + antes del Footer. Si los swimlanes son largos, el operador scrollea y se pierde el prompt activo.
   - El audit dice este es EL CTA principal (OpenClaw propone, humano aprueba) — debería ser sticky o destacar.
   - **Fix**: `position: sticky; bottom: 0` con backdrop blur, o moverlo arriba del swimlanes (después del Hero/Toolbar).

5. **Lane sidebar 120w es desperdicio** · líneas 689–707
   - Solo lleva un dot 6×6 + texto 9px ALL CAPS. Pierde ~120px × 5 carriles = 600px verticales de espacio útil.
   - **Fix**: reducir a 80w + alinear vertical center + agregar count "3/5" al lado del nombre.

6. **Modal RunBook no atrapa Escape** · líneas 1549–1640
   - Falta `onKeyDown={(e) => e.key === 'Escape' && onClose()}` en backdrop o `useEffect` con event listener global.
   - Falta focus trap (Tab cicla fuera del modal).
   - **Fix**: agregar `useEffect` con `document.addEventListener('keydown', ...)`. Ideal: usar `@radix-ui/react-dialog` que ya está en `node_modules` (lo usa ChatWidget).

7. **DetailPanel sin freshness** · líneas 1299–1503
   - No muestra "hace Ns" desde el último update del nodo seleccionado.
   - No muestra polling activo (poll 5s desde el header).
   - **Fix**: agregar `<LiveIndicator pollIntervalSec={5} lastUpdateAt={dataUpdatedAt}>` en `dpHead`.

### P1 — calidad/feel profesional

8. **Hover state de NodeCard no se siente "clickable"** · líneas 774–793
   - Solo borde gris (selected: `1px solid laneColor`). Sin shadow lift, sin transform.
   - **Fix**: en hover agregar `transform: translateY(-1px)` + `boxShadow: var(--shadow-md)` con transition 120ms.

9. **Sin minimap** — el diseño Pencil original tenía `aAgug Minimap` reusable
   - 5 lanes × hasta 8 nodos cada una = 40 nodos visibles. Sin minimap es fácil perder contexto.
   - **Fix**: agregar minimap fixed top-right 200×120 con bloques que representen los nodos.

10. **Toolbar > 1440px se queda mal** · líneas 477–608
    - El cluster selector + time range + zoom + fit + spacer + legend total = ~900px. En viewport ancho deja la legend pegada al borde, en viewport angosto colapsa los time range.
    - **Fix**: legend va abajo en su propia row cuando viewport < 1100px.

11. **`statusToVisual` repite mapeo que ya existe en safety/learning** · líneas 829–839
    - Mismo mapeo `status → {dot, fg, label}` aparece en 4 features.
    - **Fix**: extraer a `shared/lib/status-visual.ts`.

12. **`hasPrompt` gradient duplica BannerOpenClawV2** · líneas 750–772
    - El "node con prompt" pinta un gradient `accent-secondary → accent-tertiary`. Es exactamente el chrome del `BannerOpenClawV2` ya implementado.
    - **Fix**: extraer un `NodeCardPromptWrapper` que envuelva `NodeCardBody` con el mismo gradient + offset visual.

13. **TimelineLive vs StaticLog** — el footer dice "Última actividad: hash audit X" pero no hay timeline en vivo
    - El usuario probablemente espera ver eventos llegando ("13:42:08 · ssh.gate.granted · operator@delivrix").
    - **Fix**: agregar `<TimelineLive>` arriba del Footer mostrando los últimos 5 audit events del nodo seleccionado.

### P2 — refinamiento

14. **Lane labels en uppercase 9px** son ilegibles a 1m de distancia · l706
15. **`borderRadius: 10` en Swimlanes container** rompe la escala `var(--radius-md=6)` — usar var
16. **Box-shadow ya migrado** (1 residuo `var(--shadow-md)` en l762 está OK)
17. **Sin keyboard navigation entre nodos** (no arrow keys, no Tab semántico ordenado por lane → posición)

## ¿Por qué "sigue igual" después del refactor v2?

El refactor v2 solo agregó **LiveIndicator** en el Hero. No tocó:
- Swimlanes (l614–663)
- NodeCard (l737–793)
- DetailPanel (l1299–1503)
- PromptStrip (l832–1075)
- Modal (l1549)

Son ~1500 LOC sin tocar de las 1770 totales. El operador ve **exactamente la misma pantalla** salvo un pulse verde "Live · poll 5s · hace Xs" arriba a la derecha.

## Plan de fix priorizado

### Opción A · Mantener swimlanes + hacerlas vivas (4–6h)
- F1 · Pulse halo cuando cambia status nodo (el `v2-tick-halo` ya existe en globals.css)
- F2 · Edge flow `var(--color-critical)` cuando hay dependencia bloqueada
- F3 · PromptStrip sticky bottom con backdrop blur
- F4 · Modal Escape trap + focus trap
- F5 · DetailPanel LiveIndicator + lastUpdate por nodo
- F6 · NodeCard hover lift (translateY + shadow-md)
- F7 · Lane sidebar 80w + count "3/5"
- F8 · Quitar zoom CSS transform (reemplazar por densidad o quitar)

→ Output: el Canvas se siente vivo sin reescribir el motor. Buen ROI inmediato.

### Opción B · ReactFlow real (2–3 días)
- Migrar swimlanes a ReactFlow grid (ya está en `delivrix-node` styling)
- Pan + zoom nativos
- Edges con flechas + animación
- Minimap built-in
- Background grid pattern
- Pero: implica reescribir DetailPanel para reaccionar a `onSelectionChange`, manejar `nodes/edges` como state, etc.

→ Output: el Canvas se vuelve una pizarra real estilo Linear/Whimsical.

## Recomendación senior

**Empezar con A (mismo sprint que el resto del P0 panel)** + dejar B agendado como Hito 5.13. La razón: el operador necesita ver progreso ya y el ROI de las 8 fixes A es altísimo (4–6h de trabajo = canvas que "respira"). B es ambicioso pero requiere 2–3 días dedicados.
