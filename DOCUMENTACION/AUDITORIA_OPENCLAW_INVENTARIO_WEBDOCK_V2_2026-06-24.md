# Auditoría v2 (re-auditoría adversarial) — OpenClaw, inventario, cuentas y ciclo de vida

**Fecha:** 2026-06-24
**Método:** 16 subagentes simultáneos + 1 verificador final, todos read-only, sobre código, estado en disco, los 3 chats reales y verificación en vivo del panel. Cada hallazgo con `file:line` propio; lo no verificable estáticamente se marca como pendiente de verificación en vivo.
**Objeto:** revalidar desde cero el diagnóstico v1, confirmar que la solución no rompe nada, y cubrir lo que faltaba — Contabo, audit chain, conexiones, sesiones completas, frontend y, sobre todo, el ciclo de vida de cuentas que fallan y por qué no hay forma de darlas de baja.
**Documento base:** `AUDITORIA_OPENCLAW_INVENTARIO_WEBDOCK_2026-06-24.md` (v1). Este v2 lo confirma en lo esencial y lo **corrige en tres puntos que eran determinantes**.

---

## 1. Veredicto en una línea

El diagnóstico v1 apuntaba en la dirección correcta (panel y OpenClaw leen fuentes distintas; el reparto 3/5 es alucinación), **pero su plan de fix era incompleto y, en dos detalles, equivocado**: subir el límite de ítems era inútil, y "preservar accountId en el resumen" no basta. Además aparecieron **dos problemas que v1 no cubrió**: la memoria episódica caída (co-causa central de "OpenClaw no recuerda mis SMTPs") y la ausencia total de un ciclo de vida para cuentas que se bloquean. La solución correcta, sin romper nada, se reparte en tres carriles: operativo, código y producto.

---

## 2. Qué se confirmó del v1

- **Dos endpoints divergentes.** `GET /v1/webdock/inventory` (`main.ts:1451-1452`, adapter `new WebdockRealAdapter()` sin args en `:373` → `WEBDOCK_API_KEY_PRIMARY`) es **mono-cuenta**. `GET /v1/infrastructure/inventory` (`main.ts:1842-1854`, itera `webdockAccountAdapters`) es **multi-cuenta** y es el del panel. Confirmado por lectura independiente.
- **El reparto `server85,88,91 / server92-96` es alucinación (~95%).** Copiado byte por byte del artefacto `fc5db266` del 11-jun (`state/canvas-live/artifacts.jsonl`). El `runBinding` real de server85 dice `serverAccountId: "ops"`, ni siquiera "primary". La fuente viva (`runtime/openclaw-workspace/inventory/webdock-servers.json`) trae los 25 servidores con `accountId: null`.
- **El panel ve bien y está aislado.** Verificado en vivo: 5 cuentas (Dep Infraestructura 9 Activo, InfraVPS 13 Pausado, pep.prz001 401, Host Latam 401, emael 0 en cola) + Contabo 8. El frontend no enmascara cuentas; las pinta 1:1 del backend. El fix no lo toca.
- **Las 5 cuentas están bien cableadas en env** (PRIMARY/OPS/ACCOUNT = misma cuenta madre, mismo token; secondary/tertiary/quaternary/quinary con token propio). Los labels coinciden con el panel.

---

## 3. Las tres correcciones al v1 (importantes)

### Corrección A — El bridge ya fusiona ambas fuentes; el defecto es otro
v1 dijo "el bridge borra el accountId por server". Impreciso. `summarizeInventoryServers` (`openclaw-bedrock-bridge.ts:1968-2014`) **ya consume los dos endpoints y los fusiona** (webdock primero para quedarse con la IP, infraestructura después para el resto). Los defectos reales son dos: (1) **no proyecta** `accountId`/`accountLabel` al objeto que emite, aunque ese dato sí viaja en `detail` del feed de infraestructura (`infrastructure.ts:579-580`); y (2) el orden "webdock primero" + recorte puede **dejar fuera a Contabo**. Conclusión: el fix no es "cambiar la fuente primaria" (ya está cableada), es **proyectar la cuenta + evitar que Contabo se quede sin sitio**.

### Corrección B — Subir el límite de ítems es inútil; el cap que muerde es el de 3000 caracteres
v1 proponía subir `OPENCLAW_LIVE_CONTEXT_ITEM_LIMIT` de 20 a 60. **Es inerte.** El bloque `inventory_servers` se serializa con un tope de 3000 caracteres (`bridge:1069`) que corta por substring antes de llegar a 20 ítems: caben ~12 servidores con IP, y **solo ~9 si se les añade accountId** (es decir, "preservar accountId" a lo bruto empeora la cobertura). Y la suma de los sub-topes del live_context (~26000) ya excede el techo global de 18000 (`bridge:74`), que recorta desde el final (sacrifica overview/canvas/audit). El fix correcto: **un bloque `accounts[]` compacto colocado arriba** (label + estado + nº de servidores), que sobrevive el recorte y da el conteo por cuenta sin inflar cada servidor; y subir el sub-tope de la lista solo lo justo, vigilando el techo de 18000.

### Corrección C — La memoria episódica en 503 no es "Postgres apagado"
Hallazgo nuevo y relevante (v1 no lo cubrió). En los 3 chats, la **memoria episódica devuelve HTTP 503 de forma crónica** (17 menciones, 9 de 503). Pero el código (`routes/episodic-scratch.ts`) trata Postgres-caído como **HTTP 200 con resultado vacío** (`:104-110`), no 503. El 503 (`:111-114`) salta con **cualquier otro error**, y el más probable es **esquema no migrado o incompleto** (`undefined_table 42P01` / `undefined_column 42703`) en la tabla `openclaw_episodic_scratch`. Es decir: **es operativo (correr/completar migraciones), no "levantar Postgres"**. Hay además una fragilidad de código: el `catch` colapsa cualquier excepción a un 503 opaco sin telemetría de la causa. Pendiente de cerrar en vivo (ver §6).

---

## 4. Lo nuevo: ciclo de vida de cuentas que fallan (la queja del operador)

El operador preguntó por qué, cuando una cuenta de Webdock se bloquea (como pep.prz001 y Host Latam, ambas en 401 hoy), no aparece la opción de darla de baja o eliminarla. Hallazgos, todos confirmados en código:

- **No existe ningún mecanismo para dar de baja / deshabilitar / eliminar una cuenta.** Las cuentas son puramente derivadas del env (`createWebdockAdaptersFromEnv`, slots fijos `primary…quinary`); la única forma de "quitar" una es borrar su variable de entorno y reiniciar. No hay endpoint, ni tool, ni botón.
- **El sistema no distingue un token expirado de una cuenta suspendida/baneada.** Ambos caen en `responseOk:false` → `status:"error"`. El enum `ProviderStatus` solo tiene `active|paused|error|planned` — no existe `suspended`/`banned`. Por eso la única acción concebida es "Reautenticar" (rotar la API key).
- **El botón "Reautenticar" del panel es decorativo.** Está `disabled` por código, sin `onClick`, sin endpoint (`Infrastructure.tsx:875-883`). Todo el panel es read-only por diseño; las mutaciones reales viven en el flujo firmado con ApprovalGate, que la vista de Infraestructura no invoca.
- **Cuando una cuenta cae, sus servidores desaparecen en silencio.** `visibleServers = responseOk ? servers : []` (`infrastructure.ts:221`): una cuenta en 401 pasa a 0 ítems sin ningún aviso de "tenía N servidores, ahora no se ven; pueden seguir existiendo y cobrándose en el proveedor". No hay diff ni snapshot previo.
- **Los sender-nodes y servidores huérfanos no se pueden limpiar.** El store de sender-nodes solo tiene `list`/`upsert`, no `delete`. El motor de drift solo emite un *warning* ("verifica"), nunca una acción de borrado, y además **no corre en el endpoint multi-cuenta** (solo en el legacy mono-cuenta), lo que genera falsos huérfanos. Por diseño el sistema nunca borra (los reverts marcan `retired_pending_approval`).
- **InfraVPS "Pausado" (13 servidores detenidos) no genera alerta** de "VPS abandonados consumiendo saldo".

En resumen: el "letrero de eliminar" no existe porque (a) el panel es de solo lectura, y (b) **el modelo de dominio no tiene el concepto de cuenta retirada**. Es un gap real de producto, no un bug.

---

## 5. Por qué está pasando (síntesis de las sesiones)

Las 3 sesiones de chat (20→24 jun) muestran el patrón: el operador lleva días levantando SMTPs limpios en Contabo (los viejos de Webdock, rango 193.181.213.x, cayeron en blacklist `ivmSIP24` el 20-jun). Logró ~7 SMTPs entregados a inbox, a costa de docenas de reintentos. **Se frustra siempre en el mismo punto: al preguntarle a OpenClaw "¿qué tengo?"** (inventario, conteo, credenciales, cuentas). Convergen cuatro defectos:

1. **Inventario sesgado a Webdock.** La tool activa de OpenClaw (`read_webdock_servers`) es Webdock-only; Contabo (donde está todo el trabajo nuevo) no aparece cuando OpenClaw consulta, y en el contexto pasivo puede quedar fuera por el recorte. Por eso "los Contabo no tienen IP".
2. **Cuentas aplanadas a alias.** OpenClaw ve `webdock-primary`/`webdock-quinary` sin saber qué cuenta/email es cada una, y solo 2 de 5.
3. **Memoria episódica caída (503 crónico).** Sin persistencia, OpenClaw reconstruye en cada turno desde el contexto volátil; no acumula "qué SMTPs existen / cuáles tienen credencial". La queja literal "que tú mejores la memoria" está fundada.
4. **Dos cuentas realmente caídas (401).** pep.prz001 y Host Latam no autentican hoy; aunque OpenClaw fuera perfecto, no vería sus servidores hasta renovar el token.

OpenClaw, en estas sesiones, **no alucina inventario** — es honesto ("no tengo esa información"), lo que paradójicamente hace más visible el hueco.

---

## 6. Plan de remediación, sin romper nada (tres carriles)

### Carril operativo (operador — desbloquea de inmediato, sin deploy)
1. Verificar en vivo la memoria episódica: una llamada de lectura a `/v1/openclaw/scratch?grounded=true` revela si responde 200-vacío (Postgres caído) o 503 (esquema). Si es 503, **correr/completar las migraciones** de `openclaw_episodic_scratch`. No "levantar Postgres" a ciegas.
2. **Reautenticar/rotar los tokens** de pep.prz001 y Host Latam (por env + reinicio; el botón del panel no lo hace). Esto solo ya puede devolver cuentas al inventario.
3. Confirmar el `cwd` del gateway en ejecución (descartar arranque desde un worktree viejo que recita "3 cuentas").

### Carril código (Codex — aditivo, bajo riesgo)
4. `summarizeInventoryServers`: **proyectar `accountId`/`accountLabel`** por servidor + **bloque `accounts[]` compacto arriba** + **garantizar que Contabo no se quede sin sitio** (intercalar por cuenta antes del recorte) + ajustar el sub-tope de 3000 vigilando el techo de 18000. (No subir el item-limit: es inerte.)
5. Tool **nueva y aditiva** `read_infrastructure_inventory` (flota completa, Webdock + Contabo), **sin tocar** `/v1/webdock/inventory` legacy (alimenta drift/contract/frontend; cambiarlo es alto riesgo). Nota: el feed de infraestructura no trae IPv4; si OpenClaw la necesita, añadir `ipv4` a `InventoryItem.detail` (aditivo).
6. `Promise.all` → `Promise.allSettled` en el inventario multi-cuenta (`main.ts:1849`, `infrastructure.ts`): hoy, si una cuenta lanza en 401, puede tumbar todo el inventario.
7. Telemetría: que el 503 de la memoria episódica registre el código/mensaje de Postgres en vez de un 503 opaco.
8. Tool de lectura de sesiones (`list_conversations` + `read_conversation`) para "que OpenClaw lea cada sesión".

### Carril producto (decisión Juanes)
9. Reporte de cuentas caídas y de servidores/sender-nodes huérfanos (hoy desaparecen en silencio).
10. Capacidad de **baja/deshabilitar cuenta** con ApprovalGate, y distinguir token-expirado de cuenta-baneada (estado fino, backoff, auditoría de la caída).
11. Pre-flight con verificación en vivo por cuenta (hoy es estático y ciego a las 4 cuentas distintas + Contabo).

Invariantes respetados en todo el carril código: no se toca el panel (salvo añadir campos), ni el registro de create/delete, ni la forma del endpoint legacy. Los tests del bridge usan `assert.match` (toleran campos nuevos); el contrato Webdock gana `accountId` como campo opcional.

---

## 7. Qué queda solo verificable en vivo

1. Causa exacta del 503 episódico (tabla ausente vs columna ausente vs otro) — define migrar vs revisar conexión.
2. Cuántas cuentas Webdock están caídas ahora mismo y si vuelven al reautenticar.
3. Si el adapter Webdock lanza o devuelve `responseOk:false` ante un 401 — decide si `allSettled` es fix activo o defensa en profundidad.
4. Conteo real Contabo vs Webdock en el feed, para confirmar la inanición de Contabo.
5. Qué techo (3000 de la sección vs 18000 global) recorta primero con la flota actual.

---

## 8. Nota de higiene de seguridad

Durante la auditoría, una inspección de `.env.local` pudo haber impreso en el log de una sub-sesión valores de algunas claves `_WRITE`/`_ACCOUNT`. No se reprodujeron en ningún entregable y no llegaron al contexto principal, pero conviene tenerlo presente por si esos logs se conservan. Si hay duda, rotar esas claves es lo prudente.

---

## 9. Anexo — archivos clave (además de los del informe v1)

- `apps/gateway-api/src/routes/episodic-scratch.ts:104-114` — el 503 vs 200 de la memoria episódica.
- `apps/gateway-api/src/openclaw-bedrock-bridge.ts:1968-2014` — fusión de feeds, dónde proyectar accountId.
- `apps/gateway-api/src/routes/infrastructure.ts:221,569-598,691-702` — items vacíos en 401, mapper sin IPv4, clasificación de estado.
- `apps/admin-panel/src/v5/views/Infrastructure.tsx:464-486,826,875-883` — clasificación y botón "Reautenticar" decorativo.
- `packages/adapters/src/webdock-real-adapter.ts:929-976` — cuentas env-driven, slots fijos.
- `packages/local-store/src/local-file-sender-node-store.ts` — store sin delete.
- `apps/gateway-api/src/main.ts:1849` — `Promise.all` a cambiar por `allSettled`.
- `apps/gateway-api/src/env-preflight.ts:289-352` — pre-flight ciego a 4 cuentas + Contabo.
