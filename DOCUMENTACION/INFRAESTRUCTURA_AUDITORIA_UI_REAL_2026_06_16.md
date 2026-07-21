# Auditoría profunda de la sección "Infraestructura" (UI REAL, no mockup)

Fecha: 2026-06-16 · Método: inspección de la UI en vivo (Chrome, ruta `/infrastructure`, tema dark real) + 3 subagentes senior en paralelo (UX/IA · diseño visual · accesibilidad/contenido) · Read-only.
Componente: `apps/admin-panel/src/v5/views/Infrastructure.tsx` + `apps/admin-panel/src/v5/components/primitives.tsx`.
Reemplaza el intento previo (mockup claro) — el panel real es **oscuro** (bg #0a0a0a, surface #141414, Montserrat + JetBrains Mono, semánticos desaturados).

## Veredicto

La vista está bien **arquitecturada** (grupos por función, zona de atención, KPIs, separación de críticos) pero floja en **ejecución** y arrastra **dos defectos de datos del backend**. El contraste de TEXTO está bien (todo pasa WCAG AA con holgura) — el problema no es legibilidad, es jerarquía, señal y veracidad del inventario. El objetivo del CTO ("reconocer cada proveedor") hoy NO se cumple.

## Hallazgos (cross-confirmados, por prioridad)

### Bloqueantes / datos

1. **La cuenta madre aparece 3 veces (raíz en BACKEND).** `webdock-real-adapter.ts:941-958` emite `primary/ops/account` desde 3 env keys que apuntan a la MISMA cuenta "Dep Infraestructura" (9 servidores). El de-dup de `main.ts:351-355` solo colapsa el registry de ESCRITURA; el path de inventario (`infrastructure.ts:127-129`) emite las 3. Efecto: 3 filas idénticas, "Compute · 8" inflado, KPI "5 proveedores" falso, 9 servidores contados 3×. La etiqueta "PUENTE cuenta-2" es engañosa (es la madre con rol ops).
2. **Contabo ausente.** No hay `buildContaboProvider` en `infrastructure.ts`; el subtítulo enumera 5 marcas sin Contabo. La "vista de toda tu infraestructura" omite un proveedor ya conectado. (Backend.)
3. **Los KPIs cuentan proveedores, no recursos.** No existe en toda la página el total real de servidores/zonas/dominios — la pregunta #1 de un CTO. El backend ya calcula `itemTotal` (`infrastructure.ts:156`) y el front lo descarta.

### Confianza / interacción

4. **26 botones muertos.** Grep `onClick|href|navigate` en la vista = 0. "Ver detalle", "Reautenticar", "Marcar online", "Preparar plan", "Abrir chat", "Ver docs", "Ver guía" no hacen nada. Promete acción y no entrega; para teclado/lector de pantalla los anuncia como accionables. Erosiona confianza (clic en "Reautenticar" durante un 401 → nada).
5. **Doble representación.** Las cuentas en error (secondary/tertiary) salen en "Atención requerida" Y otra vez en la lista Compute, con datos que se contradicen (la fila Compute muestra "3 items" pese al 401).
6. **Estado sin frescura.** AWS Bedrock muestra "Activo" (verde) con último fetch "hace 29 d", sin degradar a stale. Un verde que podría estar mintiendo.
7. **Contradicción IONOS.** El caption de DNS afirma "IONOS Cloud DNS ya es read+write (actuator)" pero la fila muestra "Planeado · 0". El texto y el dato se desmienten (`Infrastructure.tsx:459` vs `infrastructure.ts:303-319`).

### Reconocimiento de proveedores (lo que pidió el CTO)

8. **"N items" genérico** para todo (servidores, zonas, dominios) + bug "1 items". Debe ser "9 servidores" / "13 zonas" / "3 dominios" / "1 host" (el `kind` ya existe).
9. **Capabilities crudas como identidad.** Bajo cada nombre, en mono gris: `webdock-primary · list_compute_servers · get_compute_server_detail`. Vocabulario de máquina, no rol de negocio. Debe ser un rol legible ("VPS de envío SMTP", "Modelo LLM del agente", "DNS lectura/escritura").
10. **"emael rodriguez": nombre de persona** como label de cuenta en un panel para stakeholders. Normalizar a propósito/organización.
11. **Iconos idénticos** (mismo `Server` en las 8 filas) → no anclan reconocimiento. Proponer monograma de marca (iniciales B/N: WB/AW/IO/PB).

### Visual / accesibilidad

12. **Color de estado invisible a distancia.** El texto de las pills pasa AAA, pero la cápsula (soft-bg vs surface) da 1.06–1.20 de contraste: a distancia no se ve "¿hay algo rojo?". Fix: el dot de la pill debe usar el color semántico base, no `bg-current` (`primitives.tsx:280`).
13. **Bordes fallan 3:1** (1.4.11): hairline `#262626` (1.31), `critical-border` (1.81), `warning-border` (2.58). El "borde tonal" de Atención es casi invisible.
14. **Muro de mono gris + 1 columna de ~625px → página de 1832px.** Densidad sin jerarquía; ~45% del viewport vacío. Proponer ensanchar + grid con columnas alineadas (hoy la columna derecha "baila" porque no hay tracks fijos).
15. **Eyebrow redundante** ("Cómputo"/"Compute", "Hardware"/"Servidor físico") + `kind=compute` (enum técnico) visible en la UI.
16. **Sin `aria-live`** en un panel que se auto-refresca (poll 30s); saltos de heading (las filas de Atención no son navegables por encabezado). KPI value mono 30px > H1 22px (jerarquía invertida).

## Plan priorizado

### Quick wins — front-only (`Infrastructure.tsx` + `primitives.tsx`), alto impacto, bajo riesgo
- Excluir de Compute/DNS las cuentas ya listadas en Atención (mata la doble representación) — un `.filter`.
- Reemplazar la 2ª línea (id + capabilities) por un **rol legible** + dato útil; id a tooltip.
- "N items" → label por `kind` ("servidores/zonas/dominios/host") + pluralización.
- Pill: dot con color semántico base (estado visible a distancia).
- Frescura: si `lastFetched` supera umbral y status=active, degradar pill a stale.
- KPI con **total real de recursos** (sumar `itemCount` de-dupeado).
- Condicionar el caption de IONOS al status real (no afirmar "actuator" si está Planeado).
- Deshabilitar (o esconder) los botones sin handler con `aria-label` explicativo.
- Monograma de marca en vez de icono repetido; quitar eyebrow redundante y `kind=` de la UI.
- "emael rodriguez" → label de propósito; `aria-live` en Atención.

### Backend (coordinar con Codex)
- **De-dup de la cuenta madre en el path de inventario** (reusar la lógica de `buildWebdockCreateRegistry` que ya de-dupea para escritura). Fix real de #1.
- **`buildContaboProvider`** + cablear `vpsProviderEntries` al handler (`main.ts:1741-1758`; el registry ya existe en `main.ts:359`).
- Exponer la capability `dns:write` real de IONOS o ajustar su status.

### Estructural (mayor, requiere validación de diseño)
- Ensanchar contenedor + grid con tracks alineados (o tabla densa) → resuelve el "baile" de la columna derecha y la página de 1832px.
- **Drill-down** por proveedor: el backend ya envía `items[]` (servidores/zonas/dominios con detalle) y la vista solo muestra el conteo. Es el mayor salto de valor.
- Cablear el flujo de remediación (dry-run OpenClaw, deep-link a chat, rotación de credencial gated).
- Separar IA (Bedrock) de Compute; servidor físico como "pendiente de instalación", no "offline".

## Anclas
- `apps/admin-panel/src/v5/views/Infrastructure.tsx` (lista L746-808, brandName L197, accountSuffix L213, isOfflineLike L280, caption IONOS L459, KPIs L497-567, CTAs muertos L622-628/717-734/886/959).
- `apps/admin-panel/src/v5/components/primitives.tsx` (Pill dot L280, Stat value L353).
- `apps/gateway-api/src/routes/infrastructure.ts` (builders; falta Contabo; itemTotal L156).
- `packages/adapters/src/webdock-real-adapter.ts:941-958` (accountSpecs madre 3x).
- `apps/gateway-api/src/main.ts:351-355` (de-dup solo escritura), `:359` (vpsProviderEntries), `:1741-1758` (handler inventario).
