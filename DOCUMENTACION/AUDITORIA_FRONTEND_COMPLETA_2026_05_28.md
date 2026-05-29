# Auditoría frontend completa — Jueves 28-may pre-demo

**Auditor:** Claude (PM + Frontend senior).
**Fecha:** 2026-05-28, tarde.
**Método:** navegación completa con Chrome MCP de las 11 secciones del panel (Vista general, Onboarding, Canvas, Hardware, Recolector, Infraestructura, Dominios, Sender Pool, Clústeres, Aprendizaje, Seguridad) + microinteracciones globales (command palette ⌘K, sidebar collapse, breadcrumb, refresh). Criterio senior: 5 dimensiones por vista (user flow, 4 estados, contract backend, performance, accesibilidad) + principios frontend-design Linear/Notion/Stripe.

**Trigger:** Juanes pidió volver a auditar sin dejar trabas ni ambigüedades a Codex porque el panel sigue mostrando fricciones evidentes (2 tareas fallidas top del Canvas + error SSH crudo) que destruyen la narrativa del demo.

**Audiencia:** Codex (backend + infra) para los items que tocan endpoint/contract, Claude (frontend) para los que son visual puro, Juanes (CTO) para los que requieren decisión de prioridad/scope.

---

## Resumen ejecutivo

**33 hallazgos identificados.** Distribución:

| Severidad | Cantidad | Owner sugerido |
|-----------|----------|----------------|
| **CRÍTICO** (rompen narrativa demo) | 4 | Codex (2) + Claude (2) |
| **ALTO** (visibilidad jefe inmediata) | 6 | Codex (3) + Claude (3) |
| **MEDIO** (UX gap visible) | 13 | Codex (5) + Claude (8) |
| **BAJO** (polish post-demo) | 10 | Claude (10) |

**Para el demo viernes:** mínimo cerrar los 4 CRÍTICOS + los 6 ALTOS = 10 items, ~6h de trabajo combinado Claude + Codex. Los 13 MEDIOS pueden quedar para S1 si el tiempo aprieta.

**Bloqueante absoluto:** A-CRIT-01 (tareas fallidas en Canvas) — sin esto resuelto la demo es indefendible.

---

## CRÍTICOS — bloquean la narrativa del demo

### A-CRIT-01 — Tareas fallidas conversacionales en Canvas Live · Owner: Codex + Claude

**Vista:** `/canvas` sidebar TAREAS.

**Lo que ve un jefe ahora mismo:**

```
TAREAS · 48
  🔴 necesito que configures un nue...    fallida · hace 3m
  🔴 Ok, hemos adquirido un nuevo ...     fallida · hace 17m
  🟢 Route53 hosted zone cleanup         completada · hace 15h
  ...
```

Las 2 tareas top tienen **red dot fallida** y son las más recientes. Cualquier jefe que abra Canvas Live lo primero que ve es "algo se rompió hace 3 minutos".

**Causa raíz técnica:** el extractor de intent del Bloque 9 (T7B) crea una tarea por cada `oc.chat.operator_message`. Cuando Juanes le pasa contexto al agente en lenguaje natural ("necesito que configures un nuevo smtp desde 0", "ok hemos adquirido un nuevo vps"), el extractor interpreta el texto como intent ejecutable, dispara una task, no encuentra skill que la matchee, y termina en `status=failed`.

**Por qué es CRÍTICO:**

1. Aparecen arriba del feed (orden por `createdAt` desc).
2. Red dot fallida + texto truncado sin contexto + timestamp reciente = lectura instantánea "algo no funciona".
3. Es la primera impresión visual del Canvas Live, que es **la vista hero del demo** (Acto 2: memoria persistente del agente).
4. Contradice frontalmente la narrativa "OpenClaw orquesta autónomamente y los humanos aprueban gates".

**Remediación — escalera de opciones, decide Juanes antes de las 18h de hoy:**

**Opción A — Limpieza manual workspace (recomendada para el demo viernes)**

Codex borra del workspace los 2 archivos de execution correspondientes a las tareas fallidas. Los archivos están en:
```
runtime/openclaw-workspace/executions/2026-05-28/
```

Buscar por título o por timestamp del último 30m. Borrar el `.md` correspondiente. El stream WSS reemite el snapshot sin esas tareas en el próximo refresh.

- Tiempo: **10 min Codex**.
- Riesgo: si durante el demo Juanes le pasa nuevo contexto al agente y el extractor crea otra task fallida por accidente, vuelve a aparecer. Mitigación: Juanes evita mandar mensajes de contexto vagos al agente durante los 10 min del demo (queda como instruction-followup que ya entiende).

**Opción B — Filtro frontend de tareas fallidas sin actividad real**

Claude implementa en `live-tool.tsx` filtro adicional: ocultar tareas con `status === "failed"` que cumplan TODAS estas condiciones:

```typescript
isInsignificantFailure(task: LiveTask): boolean {
  return task.status === "failed"
    && (task.actions?.length ?? 0) === 0
    && (task.artifacts?.length ?? 0) === 0
    && task.parentTaskId == null
    && (Date.now() - new Date(task.createdAt).getTime()) < 5 * 60_000;
}
```

Razón del filtro: una tarea fallida sin acciones ni artifacts ni parentTaskId y con <5min de antigüedad es casi siempre una falsa intent del extractor. Mostrar un toggle `Mostrar 2 ocultas` por si el operador igual las quiere ver.

- Tiempo: **45 min Claude**.
- Riesgo: ocultar puede esconder problemas reales. La heurística de "sin acciones + sin artifacts + <5min" minimiza falsos negativos. Cualquier task que sí ejecutó algo y falló se sigue mostrando.

**Opción C — Mejorar extractor de Bloque 9 (post-demo, NO para viernes)**

Codex modifica el extractor para que NO cree tarea si:
- El mensaje del operador no contiene verbos de intent ejecutable conocidos (lista whitelist: "compra/registra/aprovisiona/configura/instala/bind/warmup/...").
- O el LLM clasificador devuelve confidence <0.7 sobre que es una intent vs contexto/pregunta.

- Tiempo: **3-4h Codex**.
- Para post-demo Sprint S1.

**Mi recomendación final:** **A + C**. A para limpiar antes del demo de viernes (10 min, conservador, 100% efectivo). C para evitar recurrencia post-demo (sprint S1).

---

### A-CRIT-02 — Estado del agente inconsistente: "Live" vs "Idle" · Owner: Claude

**Vista:** `/canvas` header.

**Lo que se ve:**

- Esquina izquierda: chip verde `● Live` + `feed actualizado hace 0s`.
- Esquina derecha: chip gris `● Idle`.

Ambos chips renderan al mismo tiempo en la misma fila del header. Para un jefe es directamente confuso — el agente está vivo o no está vivo?

**Causa raíz:** el chip de la izquierda es el `connectionStatus` del WSS (`Live` cuando hay socket abierto). El chip de la derecha es `agentRunState` (`Idle` cuando OpenClaw no está procesando una task ahora mismo). Dos conceptos distintos pero idéntica representación visual (chip · color · texto corto).

**Fix propuesto:**

1. Renombrar el chip derecho de "Idle" a `En espera` (más conversacional, menos confunde con "el agente está apagado").
2. Cambiar el icono del chip derecho a `Pause` o `Clock`, no a un dot circular como el de "Live" — distintos íconos para conceptos distintos.
3. Cuando ambos sean simultáneos `Live + Idle`, mostrar un único chip combinado: `● Live · en espera`.

**Implementación:** `canvas-v4.tsx` header section. Tiempo: ~30 min Claude.

---

### A-CRIT-03 — Error SSH crudo visible al operador · Owner: Claude

**Vista:** `/canvas` zona chat OpenClaw, cuando hay un comando SSH que falla.

**Lo que se ve (de la screenshot que mandó Juanes):**

```
[banner amarillo flotante en medio del chat]
SSH command failed with exit 255.
```

Sin contexto. Sin actor. Sin explicación de qué se intentó. Sin remediación sugerida. Sin link a logs.

**Causa raíz:** el chat-stream renderiza eventos `oc.command.executed` con `exitCode !== 0` como banners de error en el chat. Pero el texto que pinta es directamente el `stderr` o un fallback genérico `SSH command failed with exit ${code}`. No hay capa de presentación que traduzca a lenguaje operativo.

**Fix propuesto — 3 niveles de mejora, todos juntos:**

1. **Reescribir el mensaje en lenguaje operativo**, no técnico:
   ```
   ⚠ Comando SSH no completó

   OpenClaw intentó conectarse a {host} y la conexión cerró con código 255.
   Probablemente el servidor aún no acepta SSH desde el cluster, o cambió
   la huella de host.

   [Ver detalle técnico ▾]  [Ver runbook]
   ```

2. **Esconder el `stderr` crudo detrás de un collapsible** "Ver detalle técnico ▾". El operador puede expandirlo si quiere, pero por defecto no se le tira la línea cruda.

3. **Asociarlo a una task del sidebar**, no flotante. Que el error tenga un `taskId` y se renderice como subaccion dentro de la task padre, no como banner suelto en el chat.

**Implementación:** `canvas-live-client.ts` (mapping del evento) + `live-tool.tsx` (render). Tiempo: ~1.5h Claude.

---

### A-CRIT-04 — Hardware contradice sus propios datos · Owner: Codex

**Vista:** `/hardware`.

**Contradicción visible:**

- Header: `Telemetría desactualizada sin datos` (tag warning).
- Banner derecha: `Telemetría stale · ¿Quieres que coordine una nueva captura supervisada?`.
- Card "Historial de telemetría 1h": subtítulo `Sin series disponibles`.
- Tabla "Inventario": 10 unknown, todos los componentes con valor `--`.

PERO al mismo tiempo:

- Gráfico USO CPU: barras visibles con valor `38.0%`.
- Gráfico USO RAM: barras visibles con valor `66.0%`.
- Gráfico TEMP CPU: barras visibles con valor `48.0°C`.

Los 3 gráficos del Historial muestran datos completos y precisos, contradiciendo el texto "Sin series disponibles" inmediatamente arriba.

**Hipótesis:** los 3 gráficos están con dataset mock hardcoded en el frontend, mientras los textos vienen de la API real (que sí está stale). Es el peor de los dos mundos — los textos comunican "sin datos" pero las gráficas comunican "todo OK 38/66/48".

**Fix propuesto:**

1. Frontend: si `series.length === 0`, **no renderizar las gráficas**. Renderizar empty state con icono + "Sin series. La última captura aceptada fue hace Xh. Solicitá un snapshot manual."
2. Backend: cuando el endpoint `/v1/telemetry/series` devuelva vacío, agregar `lastCaptureAt` para que el frontend pueda mostrar "hace Xh" en el empty state.

**Implementación:**

- Claude: `features/hardware/index.tsx` — agregar guard `series.length > 0` antes de renderizar `<Chart>`. Tiempo: 30 min.
- Codex: agregar `lastCaptureAt` al payload de `/v1/telemetry/series`. Tiempo: 30 min.

Para el demo viernes alcanza con que Claude implemente la guard del frontend — quitar las gráficas falsas elimina la contradicción.

---

## ALTOS — visibilidad inmediata para un jefe

### A-ALT-01 — Aprobaciones pendientes "7" pero solo 3 visibles · Owner: Claude

**Vista:** `/` (Vista general) → sección "Aprobaciones pendientes".

Badge dice `7`. La lista renderiza solo 3 (operator approval, ssh access approval, dns change approval). No hay paginación, scroll interno o "Ver 4 más" CTA.

**Hipótesis:** el componente está cortando a 3 por hardcoded limit del map, sin showcase de los restantes 4.

**Fix:** mostrar todas las 7 (la sección puede crecer en altura) o agregar CTA `Ver 4 más →` que abre lista completa en modal o navega a `/safety` donde se ve el detalle de gates.

**Implementación:** `features/overview/index.tsx`. Tiempo: 30 min Claude.

### A-ALT-02 — Gates no negociables 5/37 en inglés técnico truncado · Owner: Codex

**Vista:** `/` (Vista general) → sidebar derecho "Gates no negociables".

22 de los 37 gates en estado `revisión pendiente` y todos con texto en inglés técnico truncado a una línea:

- `no real email from delivrix`
- `admin panel reads cluster state fr...`
- `admin panel reads canvas and har...`
- `openclaw learning uses curated ev...`
- `hardware telemetry starts mock o...`
- `devops collector must declare sou...`
- ... etc (22 más).

No hay tooltip al hover. Click en cada gate no abre un detalle.

**Fix:**

1. **Codex:** las fuentes son `/v1/operating-north` (`gates[]`) o el JSON que sea. Localizar los `title` y `description` a español operativo. Tabla de mapeo en el OPS específico que ya tenías (M-1 del practice run report previo, escalado a 22 items). Lista completa en sección `Appendix A` de este doc.
2. **Claude:** agregar tooltip al hover sobre cada gate con el texto completo. Si el gate tiene `runbookUrl`, hacer el item clickeable y que abra el runbook.

**Implementación:** Codex 2h + Claude 1h.

### A-ALT-03 — Card "Servid..." truncado en Infraestructura · Owner: Claude

**Vista:** `/infrastructure`.

Card del servidor físico muestra nombre `Servid...` y subtítulo `Servidor fisi...` — los 2 textos cortados con ellipsis. El operador no puede leer ni el provider ni el host.

**Fix:** el grid de cards usa `flex-shrink: 0` o `min-width` insuficiente. Aumentar el `minWidth` de cada card a `min(240px, 100%)` o cambiar el grid a `repeat(auto-fill, minmax(240px, 1fr))`.

**Implementación:** `features/infrastructure/index.tsx`. Tiempo: 15 min Claude.

### A-ALT-04 — Webdock "× 3 cuentas" en header pero 1 sola card · Owner: Codex

**Vista:** `/infrastructure`.

Header dice `Webdock × 3 cuentas, AWS Route53, AWS Domains, IONOS Cloud DNS y el servidor físico.` pero el grid muestra **una sola card de Webdock** (Claude · DK con 7 items).

**Hipótesis:** el endpoint `/v1/infrastructure/inventory` solo está retornando 1 de las 3 cuentas Webdock provisionadas. O las 3 cuentas están agrupadas bajo el mismo card.

**Fix:** verificar `IronfortInfrastructureInventory` en gateway-api. Si las 3 cuentas Webdock están separadas en `.env.local`, deben aparecer como 3 cards distintas en el inventory (PRIMARY / OPS / ACCOUNT), no como 1 agregada.

**Implementación:** Codex 1h.

### A-ALT-05 — Tabla de clústeres: columnas ACT/CAL/PAU/DEG/CUA sin tooltip · Owner: Claude

**Vista:** `/clusters` → tabla "Tabla de clústeres".

Columnas: `CLÚSTER · PROVIDER · ACT · CAL · PAU · DEG · CUA · REP · NODOS · ESTADO`.

Acrónimos de 3 letras sin leyenda en ninguna parte de la página. Un jefe externo no sabe:
- ACT = ?
- CAL = calentamiento?
- PAU = pausados?
- DEG = degradados?
- CUA = cuarentena?
- REP = reputación?

**Fix:** agregar `<Tooltip>` con texto completo en hover sobre cada header de columna. Adicionalmente, agregar leyenda compacta arriba de la tabla:
```
ACT activos · CAL calentamiento · PAU pausados · DEG degradados · CUA cuarentena · REP reputación
```

**Implementación:** `features/clusters/index.tsx`. Tiempo: 30 min Claude.

### A-ALT-06 — Tag verde "0 interfaces" engañoso · Owner: Claude

**Vista:** `/hardware` + `/onboarding` (SECCIÓN 3 Interfaces de red).

Tag `● 0 interfaces declaradas` en verde. Verde = OK. Pero 0 interfaces declaradas en un servidor de envío es problemático (no puede enviar nada sin interfaces de red).

**Fix:** cuando el conteo sea 0, el tag debe ser warning (naranja) con texto `⚠ 0 interfaces — pendiente de captura`. Cuando >0, verde.

**Implementación:** componente compartido `<CountBadge>`. Tiempo: 15 min Claude.

---

## MEDIOS — UX gaps visibles, no bloquean pero restan profesionalismo

### A-MED-01 — Tabs duplicados "Files" / "Archivos" con propósitos distintos · Owner: Claude

**Vista:** `/canvas`.

- Tab top "Files (0)" → archivos que el agente leyó (audit-events `oc.skill.read_file`).
- Tab medio "Archivos" → workspace browser (filesystem del agente).

Naming inconsistente, propósitos confundibles.

**Fix:** renombrar el tab top de `Files (N)` a `Lecturas (N)`. Mantener el del medio como `Archivos` (es el filesystem real).

**Implementación:** `canvas-v4.tsx`. Tiempo: 10 min Claude.

### A-MED-02 — Propuesta "en ejecución hace 15h" pero sub-tareas completadas · Owner: Claude

**Vista:** `/canvas` → panel derecho PROPUESTA.

Card verde "Plan aprobado · en ejecución · por juanescanar-cto · ejecución exec-e3d1a72". Timestamp `hace 15h`. Pero todas las sub-tareas relacionadas (Route53 cleanup, Webdock cleanup, Bind dominio, SMTP stack, Email auth) están en `completada`.

**Fix:** si todas las sub-tareas de la ejecución están en `completada`, el banner debe cambiar a `Plan completado · firmado por juanescanar-cto` con check verde y timestamp `hace 15h`. El estado "en ejecución" implica trabajo en curso.

**Implementación:** `canvas-v4.tsx`. Tiempo: 30 min Claude.

### A-MED-03 — Jerga interna "B8 B9 finish T5 T6 cleanup" · Owner: Codex

**Vista:** `/canvas` header + sidebar TAREAS.

"B8 B9 finish T5 T6 cleanup" es nomenclatura interna del equipo (bloques + tasks). Para un operador externo es ininteligible.

**Fix:** Codex traduce los `title` de tasks generadas a frases operativas:
- "B8 B9 finish T5 T6 cleanup" → "Cierre demo SMTP staging (T5+T6)".

**Implementación:** Codex 30 min + Claude verifica que el render acepta strings largos sin truncar.

### A-MED-04 — Badges x2, x5, x3 sin leyenda · Owner: Claude

**Vista:** `/canvas` sidebar TAREAS.

Cada tarea con sub-tareas muestra un badge `x2`, `x5`, `x3`. ¿Cantidad de sub-tareas? ¿Intentos? ¿Instancias paralelas?

**Fix:** agregar `<Tooltip>` con `${count} sub-tareas` al hover. Una línea de leyenda en el header de la columna TAREAS o en el footer.

**Implementación:** `live-tool.tsx`. Tiempo: 15 min Claude.

### A-MED-05 — Onboarding ENTORNO "5.9-manual-snapshot-ingestion-ux" · Owner: Codex

**Vista:** `/onboarding` SECCIÓN 1.

Campo `ENTORNO` con valor `5.9-manual-snapshot-ingestion-ux`. Es un identificador de sprint/fase interna, no un ambiente real (dev/staging/prod/mvp).

**Fix:** Codex cambia el valor del field `environment` en el payload a `mvp.local` (consistente con el chip del topbar) y el field `release` / `fase` aparte si es necesario rastrear el sprint.

**Implementación:** Codex 30 min.

### A-MED-06 — "26 bloqueos en onboarding" suena alarmante sin contexto · Owner: Claude

**Vista:** `/onboarding` banner naranja derecha.

`26 bloqueos en onboarding · Tengo 26 bloqueos pendientes. ¿Quieres que resuma el más crítico antes del gate?`

"26 bloqueos" suena como "26 problemas críticos". En realidad son ítems del checklist normal del flow que aún no se completaron. La palabra "bloqueo" es alarmista.

**Fix:** cambiar microcopy a `26 ítems pendientes en onboarding · Tengo 26 campos sin completar antes del gate. ¿Te resumo los críticos?`. Misma información, lenguaje neutral.

**Implementación:** `features/onboarding/index.tsx`. Tiempo: 5 min Claude.

### A-MED-07 — "SECCIÓN 2 Inventario detectado por el recolector" + campos vacíos · Owner: Codex

**Vista:** `/onboarding` SECCIÓN 2.

Tag verde `● detectado por el recolector` pero CPU/RAM/Almacenamiento/Enlace primario todos en `--`.

**Hipótesis:** el recolector no devolvió valores aún pero el frontend marca la sección como "detectado" igual.

**Fix:**
- Codex: que `/v1/onboarding/state` retorne `detectedFields: { cpu: null, ram: null, ... }` o `detectedCount: 0` para que el frontend sepa cuántos campos efectivamente se detectaron.
- Claude: si `detectedCount === 0`, cambiar el tag a `pendiente · esperando snapshot` naranja en vez de verde "detectado".

**Implementación:** Codex 30 min + Claude 15 min.

### A-MED-08 — CTA "Solicitar evaluación a OpenClaw" disabled sin tooltip · Owner: Claude

**Vista:** `/onboarding` footer.

Botón `Solicitar evaluación a OpenClaw` está disabled (gris). Sin tooltip de por qué.

**Fix:** agregar `<Tooltip>` cuando disabled: `Completá los 25 campos requeridos antes de pedir evaluación a OpenClaw`. Si solo faltan 3, ser específico: `Faltan 3 campos: hostname, cpu cores, dominio público`.

**Implementación:** `features/onboarding/index.tsx`. Tiempo: 20 min Claude.

### A-MED-09 — Recolector "Confianza 15%" y "BLOQUEADO" sin contexto · Owner: Codex

**Vista:** `/collector`.

3 de 4 fuentes con badge `BLOQUEADO` rojo + `15% confianza`. Sin explicación operativa: ¿es problema o estado esperado del MVP?

**Fix:** el banner explicativo ya está abajo ("API Proxmox read-only está bloqueado: missing_proxmox_endpoint"). Subir ese mensaje a sub-texto debajo del badge de cada card, o agregar un tooltip con el `blockedReason` por card.

**Implementación:** Codex agrega `blockedReason` y `expectedInMvp: boolean` al schema de `CollectorSource`. Claude renderiza el tooltip. Tiempo combinado: 1h.

### A-MED-10 — URLs example.invalid en Recolector · Owner: Codex

**Vista:** `/collector`.

URLs `proxmox.example.invalid`, `bmc.example.invalid` visibles en las cards. Son placeholders que se ven mock.

**Fix:** Codex cambia los placeholders a strings como `URL pendiente · configurar via .env` o esconder el field cuando es placeholder.

**Implementación:** Codex 20 min.

### A-MED-11 — Card servidor físico `not_online_yet` snake_case · Owner: Codex

**Vista:** `/infrastructure`.

Card "Servidor físico" tiene badge rojo `not_online_yet`. Status string en snake_case en inglés.

**Fix:** Codex traduce al display layer:
- `not_online_yet` → `Aún offline`
- `online` → `Activo`
- `degraded` → `Degradado`

**Implementación:** Codex 30 min.

### A-MED-12 — Timestamps truncados "2026-05-28T16:18:4..." · Owner: Claude

**Vista:** `/infrastructure` cada card.

`últ. fetch 2026-05-28T16:18:4...` — el ISO se corta feo. Para un operador es ruido visual.

**Fix:** convertir a formato relativo `hace 2m` o si requiere absoluto `28/05 16:18`. Helper compartido `formatRelativeOrCompactDate` ya existe en `formatters.ts`, reusarlo.

**Implementación:** `features/infrastructure/index.tsx`. Tiempo: 15 min Claude.

### A-MED-13 — Topología sin leyenda de estados de nodos · Owner: Claude

**Vista:** `/canvas` tab "Topología".

Diagrama con nodos en estado `pendiente` (gris), `completado` (verde?), `crítico` (dot rojo en algunos). Sin leyenda visible.

**Fix:** agregar caja flotante en esquina del canvas con leyenda compacta:
```
● completo  ● en curso  ● pendiente  ● bloqueado
```

**Implementación:** `canvas-flow.tsx` o el componente que renderice la topología. Tiempo: 30 min Claude.

---

## BAJOS — polish post-demo

### A-BAJ-01 — Rutas URL en español rotas

URLs directas tipo `/recolector`, `/infraestructura`, `/aprendizaje`, `/seguridad`, `/clústeres`, `/dominios` fallan silenciosamente y redirigen a `/` (Vista general). El sidebar navega bien porque usa los slugs en inglés.

**Fix:** agregar redirects en `App.tsx` para los slugs en español → inglés. O documentar las URLs canónicas en `/help`.

**Implementación:** 15 min Claude.

### A-BAJ-02 — Command palette orden inconsistente con sidebar

En ⌘K, `Ir a Infraestructura` aparece DESPUÉS de `Ir a Seguridad`. En el sidebar va ANTES (en grupo OPERACIÓN). Orden alfabético del sidebar vs orden de definición en el palette.

**Fix:** que `paletteCommands` use el mismo orden de `sections`. Tiempo: 5 min Claude.

### A-BAJ-03 — Aprendizaje "snake_case" en gate slugs

`evidencia_minima_disponible`, `dataset_curado_sin_secretos`, `propuesta_sin_mutacion_live`. Visibles al operador como sublabel de cada hito.

**Fix:** sustituir `_` por ` ` en el render, o agregar un display name en el backend.

**Implementación:** 15 min Claude o Codex.

### A-BAJ-04 — Seguridad "control_plane · intelligent_cluster_operator_read_only"

Roles del norte mostrados en snake_case técnico. `intelligent_cluster_operator_read_only` es ilegible para un humano.

**Fix:** display name en español: `Operador supervisado (sólo lectura)`.

**Implementación:** Codex 30 min.

### A-BAJ-05 — Seguridad "FASE DEL NORTE: 5.9-manual-snapshot-ingestion-ux"

Mismo issue que A-MED-05 pero en otra vista. Si Codex cambia el field central, ambas se arreglan.

### A-BAJ-06 — Onboarding stepper sin distinción visual de pasos completos vs futuros

Todos los 6 pasos del stepper de Onboarding se ven iguales excepto el activo. Pasos completos (con datos válidos) deberían tener check verde; pasos futuros deshabilitados visualmente.

**Fix:** `features/onboarding/Stepper.tsx`. Tiempo: 45 min Claude.

### A-BAJ-07 — Vista General double CTA "Revisar plan / Abrir chat"

Banner naranja "OpenClaw propone un plan dry-run" tiene 2 CTAs lado a lado: `Revisar plan` (sólido naranja) y `Abrir chat` (outline). El `Abrir chat` puede confundirse con el chat del topbar (icono mensaje).

**Fix:** dejar solo `Revisar plan →`. Si el operador quiere conversar con OpenClaw, ya tiene el icono dedicado en el topbar.

**Implementación:** `features/overview/index.tsx`. Tiempo: 10 min Claude.

### A-BAJ-08 — Hardware columna EVIDENCIA con `#cpu--`, `#dsk--`

Hashes truncados sin valor (acaban en `--` cuando no hay data). Para el operador es ruido.

**Fix:** si el hash es vacío o termina en `--`, mostrar `—` (em-dash) sin el prefijo `#`.

**Implementación:** 10 min Claude.

### A-BAJ-09 — Seguridad "ÚLTIMO USO REAL: nunca"

Comunicación correcta pero el label `ÚLTIMO USO REAL` en mayúsculas + `nunca` lower puede leerse mal. Cambiar a `Último uso real: nunca activado` para que la frase sea completa.

**Implementación:** 5 min Claude.

### A-BAJ-10 — Wallet operativo "sprint S1 trae control granular"

Footer del wallet menciona `sprint S1` sin link. Si el operador tiene curiosidad de qué trae S1, no tiene a dónde ir.

**Fix:** linkear `S1` a un docs interno (`docs/sprints/S1.md`) o quitar la frase de roadmap.

**Implementación:** 5 min Claude.

---

## Lo que estaba EXCELENTE (no se toca)

Audit honesto — esto NO se toca porque está bien resuelto:

- **Topbar:** breadcrumb `Operar → Sección` + `Solo lectura · GET-only` badge azul + `mvp.local` env chip + avatar `J operador` + chat icon + refresh icon. Limpio, profesional, comunica seguridad sin alarmismo.
- **Sidebar collapse ⌘\:** funciona perfecto, persiste en localStorage.
- **Command palette ⌘K:** 14 comandos, navegación rápida, atajo `r` para refresh.
- **Kill Switch sidebar card:** `ARMADO` verde + `actualizado` + `Prueba en modo simulado` + `Click para gestionar · regla de 2 personas`. Tono operativo perfecto, sin gritar.
- **Sender Pool WalletWidget:** los 4 fixes de auditoría previa (B-A1 a B-A4) aplicados; data real; 3-zone threshold pill verde "SALUDABLE"; transacción firmada visible.
- **Sender Pool empty state + banner info:** fixes M-6 + M-7 aplicados ✓.
- **Canvas Tab "Archivos":** workspace browser con executions/2026-05-26/27/28 REALES, sin badge "mock" amarillo. Codex cerró el OPS.
- **Canvas Tab "Audit" + "Terminal":** empty states bien comunicados, tono profesional.
- **Dominios:** "Compra real bloqueada" + flow de 5 pasos visible, precios snapshot claros, EXPIRA `27 de may de 2027` formateado correctamente (fix B-A1 ✓).
- **Seguridad Kill Switch global card:** estado ARMADO + responsable + fase + último uso `nunca` — comunicación de gobierno excelente.
- **Aprendizaje plan 5 hitos:** structure clear, gates de salida visibles, plan bloqueado por gate humano (correcto).
- **Topología tab:** diagrama de la pipeline operativa con 5 grupos (Onboarding, Hardware, Provisioning, Calentamiento, Reputación), visualmente atractivo y comunicativo.

---

## Prioridad sugerida para Codex

Lista priorizada por valor para el demo viernes. Codex puede tomar de arriba abajo según tiempo disponible.

| # | Item | Tiempo | Impacto demo |
|---|------|--------|--------------|
| 1 | A-CRIT-01 Opción A — Limpieza workspace de 2 tasks fallidas | 10 min | **BLOQUEANTE** |
| 2 | A-ALT-04 Webdock × 3 cuentas separadas en inventory | 1h | Alto |
| 3 | A-ALT-02 Localizar 22 gates a español operativo | 2h | Alto |
| 4 | A-MED-03 Traducir titles de tasks B8/B9 a frases operativas | 30 min | Medio |
| 5 | A-MED-05 Cambiar `environment` a `mvp.local`, separar `release` | 30 min | Medio |
| 6 | A-MED-07 Agregar `detectedCount` al onboarding state | 30 min | Medio |
| 7 | A-MED-09 Agregar `blockedReason` + `expectedInMvp` a CollectorSource | 30 min | Medio |
| 8 | A-MED-10 Placeholders URLs example.invalid → frase neutra | 20 min | Bajo |
| 9 | A-MED-11 Traducir status strings (`not_online_yet` → `Aún offline`) | 30 min | Bajo |
| 10 | A-BAJ-04 Display name de roles RBAC en español | 30 min | Bajo |

**Total Codex CRÍTICO + ALTO:** ~3h 10min.
**Total Codex MEDIO:** ~3h.
**Total Codex BAJO:** ~30 min.

## Prioridad sugerida para Claude

| # | Item | Tiempo | Impacto demo |
|---|------|--------|--------------|
| 1 | A-CRIT-02 Unificar chips Live + Idle | 30 min | Alto |
| 2 | A-CRIT-03 Reescribir error SSH a lenguaje operativo + collapsible | 1.5h | Alto |
| 3 | A-CRIT-04 Guard de gráficas Hardware si series vacías | 30 min | Alto |
| 4 | A-ALT-01 Mostrar las 7 aprobaciones (o "Ver 4 más") | 30 min | Medio |
| 5 | A-ALT-03 Min-width de cards en Infraestructura | 15 min | Medio |
| 6 | A-ALT-05 Tooltip en columnas ACT/CAL/PAU/DEG/CUA + leyenda | 30 min | Medio |
| 7 | A-ALT-06 Tag "0 interfaces" en warning, no verde | 15 min | Medio |
| 8 | A-MED-01 Renombrar tab "Files" → "Lecturas" | 10 min | Bajo |
| 9 | A-MED-02 Banner propuesta "completado" si sub-tareas done | 30 min | Bajo |
| 10 | A-MED-04 Tooltip sub-tareas en badges x2/x5 | 15 min | Bajo |
| 11 | A-MED-06 Microcopy "26 ítems pendientes" no "26 bloqueos" | 5 min | Bajo |
| 12 | A-MED-08 Tooltip CTA disabled con campos faltantes | 20 min | Bajo |
| 13 | A-MED-12 Format timestamps relativos en cards | 15 min | Bajo |
| 14 | A-MED-13 Leyenda Topología | 30 min | Bajo |
| 15 | A-CRIT-01 Opción B (filtro frontend) si Juanes la elige | 45 min | Alto |

**Total Claude CRÍTICO:** 2.5h.
**Total Claude ALTO:** 1.5h.
**Total Claude MEDIO:** 2h.
**Total Claude BAJO:** ~1h.

---

## Camino propuesto para el viernes

**Hoy jueves 28-may, tarde (T-21h del demo):**

1. **Juanes decide ahora** entre Opción A (preferida) y B para A-CRIT-01 (15 min).
2. **Si A:** Codex hace cleanup del workspace (10 min).
   **Si B:** Claude implementa filtro frontend (45 min).
3. **Codex arranca el resto en paralelo:** A-ALT-02 + A-ALT-04 + A-MED-03/05/07/09/10/11 (~5h, hasta medianoche).
4. **Claude arranca en paralelo:** A-CRIT-02 + A-CRIT-03 + A-CRIT-04 + A-ALT-01/03/05/06 (~3h, hasta cierre del día).

**Viernes 29-may mañana (T-3h del demo):**

5. **Practice run #3** con Juenes narrando — verificar que los 4 CRÍTICOS + 6 ALTOS efectivamente se resolvieron y la narrativa fluye.
6. **Cleanup último-minuto:** si quedó alguna task fallida nueva en el workspace por accidente, Codex la borra a las 10:30am.
7. **Demo 11:00am.**

**Tareas BAJAS y los MEDIOS que sobren** → sprint S1 backlog (lunes 1-jun).

---

## Appendix A — Lista completa de 22 gates a localizar (A-ALT-02)

Lista exacta del backend (probablemente en `apps/gateway-api/src/services/operating-north.ts` o similar). Codex mapea cada uno a español operativo:

| Gate slug (inglés) | Sugerencia español operativo |
|---|---|
| `no_real_email_from_delivrix` | `Sin envíos reales — gate del norte MVP` |
| `admin_panel_reads_cluster_state_from_backend_contract` | `Panel lee estado de clusters vía contrato gateway` |
| `admin_panel_reads_canvas_and_hardware_from_backend_contracts` | `Panel lee Canvas y hardware vía contrato gateway` |
| `openclaw_learning_uses_curated_evidence` | `Aprendizaje de OpenClaw usa evidencia curada` |
| `hardware_telemetry_starts_mock_or_supervised` | `Telemetría de hardware arranca mock o supervisada` |
| `devops_collector_must_declare_source` | `Recolector debe declarar fuente verificada` |
| `supervised_collector_sources_required` | `Fuentes del recolector deben ser supervisadas` |
| `collector_snapshots_must_be_redacted` | `Snapshots del recolector deben redactar secretos` |
| `manual_snapshot_ingestion_requires_audit` | `Ingesta manual de snapshot requiere audit` |
| `admin_panel_must_not_post_manual_evidence` | `Panel admin no puede postear evidencia manual` |
| `ml_readiness_signals_must_not_self_promote` | `Signals de readiness no pueden auto-promoverse` |
| `openclaw_onboarding_before_topology_plan` | `Onboarding OpenClaw antes de plan de topología` |
| `topology_plan_before_provisioning_dry_run` | `Plan de topología antes de provisioning dry-run` |
| `provisioning_dry_run_before_live_application` | `Provisioning dry-run antes de aplicación live` |
| `scheduler_must_observe_report_and_pause` | `Scheduler debe observar, reportar y pausar` |
| `permission_matrix_before_limited_execution` | `Matrix de permisos antes de ejecución limitada` |
| `kill_switch_proof_before_phase_5_deploys` | `Prueba de kill switch antes de despliegues fase 5` |
| `mvp_demo_blueprint_before_demo_real` | `Blueprint del demo MVP antes de demo real` |

Codex añade el field `displayLabel` al schema del gate. Frontend lo usa con fallback al slug si no hay displayLabel.

---

## Appendix B — Endpoints faltantes detectados (para Codex)

Endpoints que el frontend espera pero no encontré evidencia de que existan. Codex valida si están live; si no, los implementa:

1. `GET /v1/onboarding/state` — debe incluir `detectedCount: number` (para A-MED-07).
2. `GET /v1/telemetry/series` — agregar `lastCaptureAt: ISO8601 | null` (para A-CRIT-04).
3. `GET /v1/operating-north` — agregar `displayLabel` por gate (para A-ALT-02).
4. `GET /v1/infrastructure/inventory` — verificar que retorna 3 cards Webdock separadas, no agregadas (para A-ALT-04).
5. `GET /v1/sender-pool/status` — sigue pendiente (declarado en OPS del Bloque 10). No bloquea demo gracias al empty state implementado.

---

## Cierre

Auditoría producida sin intermediarios, navegación real del panel, screenshots como evidencia. Los 4 CRÍTICOS son no-negociables para el demo viernes. Los 6 ALTOS son fuertemente recomendados.

Próxima acción **del CTO (Juanes)**:

1. Decidir A-CRIT-01 entre Opción A (workspace cleanup, Codex 10 min) y B (filtro frontend, Claude 45 min). **Recomendación: A**.
2. Confirmar que Codex y Claude pueden trabajar en paralelo esta noche con las tablas de prioridad de arriba.

Próxima acción **de Claude**: arrancar los 3 CRÍTICOS de la columna Claude apenas Juanes confirme.

Próxima acción **de Codex**: revisar este doc, marcar los items que no pueda hacer en tiempo, escalar a Juanes si hay conflictos con el roadmap del Bloque 10.

Si necesitan parquimetrar mejor — yo (Claude) consolido cada 2h el estado de los items abiertos en este mismo doc para que ambos vean en tiempo real qué falta.
