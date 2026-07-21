# Auditoría: por qué OpenClaw "ve" un inventario Webdock distinto al panel

**Fecha:** 2026-06-24
**Alcance:** Webdock (5 cuentas), gateway Delivrix, bridge Bedrock de OpenClaw, sesiones de chat, registry de sender-nodes.
**Método:** 12 subagentes de auditoría en paralelo (read-only sobre código, estado en disco y los 3 chats reales de OpenClaw) + 1 verificador adversarial. Todo verificado contra `file:line`; lo no verificable estáticamente se marca como pendiente de verificación en vivo.
**Disparador:** OpenClaw reporta solo 2 cuentas Webdock (`webdock-primary`, `webdock-quinary`) con 8 servidores mal repartidos, mientras el panel de Infra muestra correctamente 5 cuentas / ~22 servidores. La cuenta madre "Dep Infraestructura" (serviciosinfradev@proton.me) está limpia y funcionando.

---

## 1. Resumen ejecutivo

El panel y OpenClaw **no leen la misma fuente**. El panel ve bien; OpenClaw recibe un inventario degradado por **tres defectos encadenados en la capa que arma su contexto** — no por un problema de las cuentas Webdock (que están sanas). Además, el reparto `server85,88,91 → primary / server92-96 → quinary` que mostró OpenClaw **es una alucinación**: copió esa tabla, byte por byte, de un artefacto viejo del 11 de junio que quedó en su historial. El propio OpenClaw se desdijo 44 segundos después en el mismo chat ("solo tengo 2 cuentas identificadas... las otras 3 no aparecen en el inventario vivo").

Los tres defectos estructurales (todos en el backend del gateway, todos confirmados en código):

1. **La tool y un feed de OpenClaw apuntan a un endpoint mono-cuenta.** `GET /v1/webdock/inventory` solo consulta la cuenta madre; el endpoint que sí enumera las 5 cuentas (`GET /v1/infrastructure/inventory`, el que usa el panel) no lo invoca ninguna read-tool de OpenClaw.
2. **El bridge fusiona mal los dos feeds y borra la cuenta.** Al resumir el inventario para el contexto, prioriza el feed mono-cuenta, lo trunca a 20 ítems y descarta el `accountId`/`accountLabel` de cada servidor — así OpenClaw no puede atribuir ningún servidor a su cuenta.
3. **Las cuentas que fallan (401) llegan vacías.** Una cuenta con error aparece en el panel como tarjeta con badge "en atención/en cola" pero con cero servidores; OpenClaw consume servidores, no tarjetas, así que de esas cuentas no ve nada.

Resultado neto: OpenClaw solo "ve" servidores de las cuentas sanas, sin saber a qué cuenta pertenecen, y rellena los huecos con su memoria — produciendo el reparto inventado.

---

## 2. Causa raíz, defecto por defecto

### Defecto A — Dos endpoints de inventario divergentes (mono-cuenta vs multi-cuenta)

| Endpoint | Quién lo usa | Qué consulta | Cobertura |
|---|---|---|---|
| `GET /v1/webdock/inventory` | la tool `read_webdock_servers` de OpenClaw + uno de los dos feeds del bridge | `webdockRealAdapter.listServers()` con un único adapter sin cuenta | **1 cuenta (la madre)** |
| `GET /v1/infrastructure/inventory` | el panel de Infra + el otro feed del bridge | `webdockAccountAdapters.map(...)` sobre las 5 cuentas (tras dedup) | **5 cuentas** |

Evidencia:
- `apps/gateway-api/src/main.ts:373` — `const webdockRealAdapter = new WebdockRealAdapter();` (sin argumentos).
- `packages/adapters/src/webdock-real-adapter.ts:246-249` — el constructor sin opciones resuelve la read key a `WEBDOCK_API_KEY_PRIMARY` (la cuenta madre).
- `apps/gateway-api/src/main.ts:1451-1452` — `GET /v1/webdock/inventory` → `await webdockRealAdapter.listServers()` (una sola cuenta).
- `apps/gateway-api/src/main.ts:1842-1854` — `GET /v1/infrastructure/inventory` → `Promise.all(webdockAccountAdapters.map(a => a.adapter.listServers()))` (las 5 cuentas).
- `apps/gateway-api/src/routes/infrastructure.ts:164-173` — `dedupeWebdockInventoryAccounts` colapsa los roles `primary/ops/account` de la madre en una sola tarjeta; el panel termina mostrando 1 madre + secondary/tertiary/quaternary/quinary = **5**.

### Defecto B — El bridge aplana el inventario y borra la dimensión "cuenta"

El bridge de Bedrock arma el bloque `inventory_servers` que ve OpenClaw a partir de **ambos** endpoints, pero la función que los fusiona introduce tres pérdidas:

- `apps/gateway-api/src/openclaw-bedrock-bridge.ts:1037-1038` — consume `safeGet("/v1/infrastructure/inventory")` y `safeGet("/v1/webdock/inventory")`.
- `openclaw-bedrock-bridge.ts:1968-2014` — `summarizeInventoryServers(infrastructure, webdock, limit)`:
  - **Prioridad invertida en el dedup:** el feed webdock (mono-cuenta, sin `providerId`) se carga primero; luego, para el feed de infraestructura, `if (!slug || servers.has(slug)) continue` (línea ~1989) descarta cualquier slug ya presente. Es decir, los servidores de la madre entran **sin etiqueta de cuenta** y bloquean su versión etiquetada. Solo los slugs exclusivos de cuentas no-madre conservan `providerId`.
  - **Truncamiento por conteo:** `const items = [...servers.values()].slice(0, limit)` con `limit = OPENCLAW_LIVE_CONTEXT_ITEM_LIMIT` y `defaultLiveContextItemLimit = 20` (línea 73). Con ~25 servidores reales, se pierden ~5.
  - **Pérdida de cuenta:** el resumen emite `serverSlug, name, status, serverIp, ipVerified` (y a lo sumo `providerId` en la rama de infraestructura), pero **nunca `accountId`/`accountLabel`**. El dato de cuenta existe aguas arriba (`webdock-real-adapter.ts:770-776` lo estampa) pero el resumen lo tira.
- Truncamiento adicional de string: `stringifyLiveContext(..., 3000)` por sección (línea ~1069) puede recortar el listado incluso por debajo de 20.

Consecuencia: aunque el feed de infraestructura traiga las 5 cuentas, lo que llega al modelo es una lista plana de servidores, sesgada hacia la cuenta madre y sin forma de saber de qué cuenta es cada uno.

### Defecto C — Las cuentas con error llegan vacías (no es un filtro deliberado)

- `apps/gateway-api/src/routes/infrastructure.ts:221,233` — `visibleServers = webdock.source.responseOk ? webdock.servers : []`. Una cuenta cuya API responde no-OK (p. ej. 401) sigue apareciendo como **tarjeta** en el panel, pero con `items: []`.
- `apps/gateway-api/src/routes/infrastructure.ts:691-702` — `resolveWebdockProviderStatus`: `!responseOk → error` (badge "en atención"); `responseOk && 0 servidores → planned` (badge "en cola"); con servidores corriendo → `active` (badge "conectada"). Esto explica el "2 conectadas · 2 en atención · 1 en cola" del panel.
- `packages/adapters/src/webdock-real-adapter.ts:312-339` — ante cualquier fallo/no-2xx, `listServers()` devuelve `servers: []` silenciosamente y solo registra el error en `source.errorMessage`, que el resumen del bridge **no propaga**.

El panel muestra las 5 tarjetas con su estado; OpenClaw consume servidores-ítem, así que de las cuentas en error/cola simplemente no recibe nada. **No hay un filtro "solo conectadas" en el bridge** — es un efecto colateral de que esas cuentas aportan listas vacías.

---

## 3. El reparto 3/5 es una alucinación (no un dato)

El reparto `webdock-primary = server85,88,91` y `webdock-quinary = server92,93,94,95,96` **no proviene del inventario vivo**:

- `runtime/openclaw-workspace/inventory/webdock-servers.json` (reescrito hoy 15:47Z): 25 servidores, **todos con `providerId = null`, `accountId = null`**. La fuente real no agrupa por cuenta.
- `state/canvas-live/artifacts.jsonl` — el artefacto `artifact-chat-fc5db266-20260611` (del **11-jun**) contiene ese reparto exacto. La tabla que OpenClaw mostró hoy es byte-idéntica a ese artefacto viejo.
- `state/openclaw-chat/chat-d13c6dbe-...jsonl` — línea 217 (16:23:12Z) OpenClaw produce la tabla; líneas 219-223 (hasta 16:26:54Z) se autodesmiente: *"Los `providerId` que veo son `webdock-primary` y `webdock-quinary`, pero eso es el alias interno... Solo tengo 2 cuentas identificadas en el inventario vivo... El sistema prompt indica 5 cuentas pero las otras 3 no aparecen."*

Lectura correcta: los identificadores `webdock-primary` y `webdock-quinary` **sí son reales** (el feed de infraestructura los emite como `id: webdock-${accountId}`, `infrastructure.ts:224`), pero **la asignación de cada servidor a esas cuentas la inventó el modelo** rellenando, desde su memoria de los últimos 40 turnos, el hueco que dejó el Defecto B (servidores sin `accountId`). Confianza: alta.

Verificación histórica: en los 3 chats (20→24 jun), OpenClaw **nunca** vio más de 8 servidores ni más de 2 alias de cuenta; las palabras `secondary`/`tertiary`/`quaternary` no aparecen ni una vez. La degradación es persistente, no de hoy.

---

## 4. Hallazgos colaterales

### 4.1 El "5 cuentas" del prompt es estático y choca con el grounding
"Webdock (5 cuentas)" es texto fijo escrito a mano en `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md:177` (→ `.audit/system-context.txt:146`), no un conteo derivado del inventario. El protocolo `[5A] ENTITY_GROUNDING` del propio prompt le prohíbe a OpenClaw afirmar entidades que no estén en el `live_context`. De ahí la incoherencia honesta de OpenClaw: "el prompt dice 5, pero solo puedo probar 2". El número y los nombres de las cuentas viven en docs (Capa 2 RAG), no en el contexto vivo.

### 4.2 Riesgo de split-brain por worktree
El bridge lee el system prompt desde `join(process.cwd(), ".audit", "system-context.txt")` (`openclaw-bedrock-bridge.ts:249`) con caché por mtime, y `OPENCLAW_SYSTEM_CONTEXT_PATH` no está seteado. El repo principal está fresco ("5 cuentas"), pero el worktree `.claude/worktrees/mc-webdock` todavía dice "3 cuentas". Si el gateway llegara a arrancar desde ese directorio, recitaría datos viejos. Verificar el `cwd` real del proceso.

### 4.3 Sender-nodes huérfanos = datos de prueba en producción
Los "6 sender_nodes huérfanos" que reporta OpenClaw son reales pero inofensivos: `runtime/sender-nodes.json` contiene 11 nodos **todos de prueba/demo** (IPs del rango de documentación `203.0.113.x`, hostnames `.example`), de los cuales 6 con `provider: webdock` disparan `node_orphan_warning` en `packages/domain/src/openclaw-rules.ts:145-160`. No existe tool de `prune` (el store solo expone `list`/`upsert`). OpenClaw reporta correctamente un drift contra un registry contaminado con fixtures que nunca se limpiaron.

### 4.4 Sesiones: "que OpenClaw lea cada una de sus sesiones"
La persistencia por sesión **ya está implementada** (un `state/openclaw-chat/chat-<uuid>.jsonl` por sesión, aislamiento por `conversationId`, rehidratación tras reinicio). Lo que falta para el pedido literal del operador:
- No hay tool que permita a OpenClaw enumerar y leer **otras** sesiones; solo accede a la sesión activa.
- Hay un tope de 40 turnos en memoria/respuesta, así que ni siquiera la sesión activa se lee completa si es larga.
- Gap mínimo: exponer una read-tool `list_conversations` + `read_conversation` envolviendo el store que ya existe (lectura paginada sin el recorte de 40).

---

## 5. Plan de remediación (brief para Codex — backend)

Prioridad P0 (corrige el síntoma reportado):

1. **Que el contexto de OpenClaw preserve la cuenta y enumere todas.** En `summarizeInventoryServers` (`openclaw-bedrock-bridge.ts:1968-2014`): invertir la prioridad del dedup para que el feed multi-cuenta (`/v1/infrastructure/inventory`, que sí trae `providerId`) gane el slug, o fusionar campos en vez de descartar; y **emitir `accountId`/`accountLabel` por servidor** más un resumen `accounts[]` (label + status + itemCount). Sin esto, subir el límite solo expone más servidores sin cuenta.
2. **Repuntar la read-tool de OpenClaw al endpoint multi-cuenta.** Hacer que `read_webdock_servers` consuma `/v1/infrastructure/inventory` (o un nuevo `read_infrastructure_inventory`). **Preferir esto a mutar `/v1/webdock/inventory`**, porque ese endpoint legacy también alimenta `evaluateWebdockDrift` y `buildWebdockInventoryContract` y cambiar su forma puede romper el cálculo de drift.
3. **Subir el tope de ítems** (`OPENCLAW_LIVE_CONTEXT_ITEM_LIMIT`) y el corte de 3000 chars de la sección de servidores de forma conjunta, para que entren los ~25 servidores con su etiqueta.

Prioridad P1:

4. **Propagar el estado de cuenta al contexto** (`responseOk`/`errorMessage`) para que OpenClaw distinga "cuenta sin servidores" de "cuenta que falló (401)" en vez de no verla.
5. **Derivar "N cuentas" del inventario**, no de texto fijo, o explicitar en el prompt que el número es de referencia y debe validarse contra `live_context` (alinear con `[5A]`).

Prioridad P2:

6. **Tool de lectura de sesiones** (`list_conversations` + `read_conversation`) para cumplir "que lea cada sesión".
7. **Limpiar el registry de sender-nodes** (quitar los 11 fixtures de prueba) y añadir una primitiva `prune` con ApprovalGate.

Invariante a respetar: el panel ya funciona — no tocar `routes/infrastructure.ts` salvo para añadir campos; no alterar el registry de create/delete (`buildWebdockCreateRegistry`). Validar con un run gated real que el create/delete sigue resolviendo la cuenta correcta.

---

## 6. Qué falta confirmar en vivo (no verificable estáticamente)

1. `curl /v1/infrastructure/inventory` → contar providers `webdock-*`, su `status` e `itemCount`; confirmar cuáles 2 dan 401 ("en atención") y cuál tiene 0 servidores ("en cola").
2. `curl /v1/webdock/inventory` → confirmar que devuelve solo la cuenta madre.
3. `cwd` real del proceso del gateway (descartar arranque desde worktree viejo).
4. Si las 7 variables `WEBDOCK_API_KEY_*` corresponden a 5 cuentas distintas (los roles primary/ops/account son la misma cuenta).

El payload exacto del `live_context` de cada turno no se persiste hoy en los `.jsonl` (solo `role/content/createdAt/msgId`); para depurar a futuro convendría loguearlo.

---

## 7. Anexo — archivos clave

- `apps/gateway-api/src/main.ts:373, 381, 1451-1485, 1842-1854` — wiring de adapters y los dos endpoints.
- `apps/gateway-api/src/openclaw-bedrock-bridge.ts:73, 249, 1032-1113, 1968-2014` — bridge, system prompt, resumen de inventario.
- `apps/gateway-api/src/routes/infrastructure.ts:128, 164-173, 218-235, 691-702` — endpoint del panel, dedup, estado por cuenta.
- `apps/gateway-api/src/tool-use-processor.ts:750-763` — la read-tool `read_webdock_servers`.
- `packages/adapters/src/webdock-real-adapter.ts:246-258, 312-339, 770-776, 929-976` — adapter, manejo de error, etiqueta de cuenta, factory multi-cuenta.
- `packages/domain/src/openclaw-rules.ts:145-160` — drift de sender-nodes huérfanos.
- `runtime/openclaw-workspace/inventory/webdock-servers.json` — snapshot real (providerId/accountId null).
- `state/canvas-live/artifacts.jsonl` (`artifact-chat-fc5db266-20260611`) — origen del reparto 3/5 alucinado.
- `state/openclaw-chat/chat-d13c6dbe-...jsonl` — el chat donde OpenClaw se autodesmiente.
