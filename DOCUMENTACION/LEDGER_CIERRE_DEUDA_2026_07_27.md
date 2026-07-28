# Ledger de cierre de deuda — 2026-07-27

Registro ordenado de **todo lo que se modifica**, para auditar una entrada por vez.

**Regla:** una entrada = un commit. No se avanza a la siguiente hasta que la anterior esté
auditada y marcada. Si una entrada toca archivos fuera de su alcance declarado, se detiene.

- Rama: `fix/ops-ssh-ownership-verification`
- Base: `origin/produ` = `130f998`
- Mapa de referencia: `DOCUMENTACION/ARQUITECTURA_DELIVRIX_MAPA_INTERACTIVO_2026_07_27.html`

| Estado | Significado |
|---|---|
| ⬜ pendiente | No empezado |
| 🟡 hecho | Aplicado, **sin auditar** |
| ✅ auditado | Revisado y aprobado por Juanes |
| ⛔ ajeno | No es de este plan — no tocar |

---

## ⚠️ E-00 · Trabajo ajeno en el árbol — NO TOCAR

**Estado:** ⛔ ajeno · **Detectado:** 2026-07-27 20:22

Durante esta sesión aparecieron cambios sin commitear que **no son de este plan**. Modificados
hoy entre las 18:20 y 19:20; el único cambio propio es de las 15:08. Agregan un endpoint
`GET /v1/sender-pool/credentials/download-all` (descarga masiva de credenciales SMTP).

```
apps/gateway-api/src/routes/smtp-credentials.ts        +174
apps/gateway-api/src/routes/smtp-credentials.test.ts   +236
apps/gateway-api/src/smtp-credentials.ts                +56
apps/gateway-api/src/main.ts                            +12
apps/admin-panel/src/shared/api/smtp-credentials.ts     +24
apps/admin-panel/src/shared/api/read-boundary.ts         +1
apps/admin-panel/src/shared/api/client.test.ts           +1
apps/admin-panel/src/v5/views/SenderPool.tsx            +32
```

**Acción:** ninguna. Ningún commit de este ledger debe incluirlos. Todos los commits se hacen
con rutas explícitas (`git commit -- <archivos>`), nunca `git commit -a` ni `git add .`.

**Resuelto 2026-07-28:** Juanes autorizó commitearlos **aparte**, sin mezclar. Commit `d591bcb`,
sólo estos archivos.

⚠️ **Hallazgo al commitear:** el commit inicial quedó incompleto. `routes/smtp-credentials.ts:16`
importa `../zip-archive.ts`, y ese módulo (más su test y sus helpers) estaba **sin trackear** —
no ignorado, nunca agregado. Los tests pasaban porque los archivos existen en el working copy,
pero en un checkout limpio el commit no compilaba. Se enmendó `d591bcb` para incluirlos
(8 → 11 archivos) y se rebasearon los dos commits de arriba. Respaldo del estado previo:
rama `backup/pre-zip-fix-2026-07-28`.

> Lección: `git status` marca los `??` aparte de los ` M`, y un commit por rutas explícitas
> no avisa que falta un import. Verificar los imports del alcance contra `git ls-files`.

---

## E-01 · Catálogo de tools: reponer `semantic_remember` / `semantic_recall`

**Estado:** 🟡 hecho, sin auditar · **Commit:** `a906970` (2026-07-28) · **Deuda:** `debt-semantic-tools` (cerrada) · **Riesgo:** bajo

Estaban definidas en `toolDefinitions`, ruteadas en `tool-use-processor` y con endpoint vivo,
pero faltaban en el union `OpenClawToolName` y en `openClawToolNames()`, así que nunca llegaban
al modelo. Catálogo: 43 → 45. Payload real a Bedrock: 36 → 38 tools.

**Alcance (3 archivos):**
```
apps/gateway-api/src/openclaw-tools-builder.ts        +4   ← único cambio de producción
apps/gateway-api/src/openclaw-tools-builder.test.ts  +47   ← conteos, samples, test de regresión
apps/gateway-api/src/openclaw-bedrock-bridge.test.ts  +4   ← 36 → 38 en el payload
```

**Verificación:** `npm test` → 2154/2154 ✅ · revalidado post-rebase 2026-07-28: **2165/2165** ✅

**Qué auditar:**
- El diff de producción son 2 líneas repetidas en dos lugares (union + lista). Nada más.
- Las tools nuevas **no pasan por ApprovalGate**: van por la rama de memoria, con firma HMAC,
  a `/v1/openclaw/memory/remember` y `/recall`. Escriben en `openclaw_memory_vectors`.
- Gate: `OPENCLAW_EPISODIC_SCRATCH_ENABLE` (compartido con `read_episodic_scratch`).
  Ojo: `postgresConfigured()` **no mira `POSTGRES_URL`** pese al nombre.

**Revertir:** `git checkout -- <los 3 archivos>`

---

## E-02 · Entregables del mapa de arquitectura

**Estado:** 🟡 hecho, sin auditar · **Commit:** `c5911be` (2026-07-28) · **Riesgo:** nulo (documentación, no ejecuta en producción)

**Alcance (2 archivos nuevos):**
```
DOCUMENTACION/ARQUITECTURA_DELIVRIX_MAPA_INTERACTIVO_2026_07_27.html   114 KB
DOCUMENTACION/arquitectura-delivrix-2026-07-27.json                     95 KB
DOCUMENTACION/LEDGER_CIERRE_DEUDA_2026_07_27.md                        este archivo
```

**Qué auditar:** que la evidencia `archivo:línea` sea real. Se muestrearon 15 citas y las 15
coincidían. El JSON va embebido en el HTML: si se edita el JSON hay que reinyectarlo.

**Revertir:** borrar los archivos. No hay ningún import hacia ellos.

---

## E-03 · Borrar el rollback muerto

**Estado:** ⬜ pendiente · **Deuda:** `debt-rollback-dup` · **Riesgo:** nulo · **Costo:** minutos

`apps/gateway-api/src/security/rollback-snapshot.ts` no tiene un solo importador en producción
(verificado: los 2 hits eran el nombre del directorio `runtime/rollback-snapshots` usado por
`auto-rollback.ts`, y un comentario en un test). Convive con `auto-rollback.ts`, que sí corre.

**Alcance previsto (verificado 2026-07-27):**
```
apps/gateway-api/src/security/rollback-snapshot.ts        borrar
apps/gateway-api/migrations/0008_rollback_snapshots.sql   borrar — su único consumidor es el de arriba
```

Verificado antes de ejecutar:
- **No tiene test propio.** El único archivo en `security/` con ese nombre es el `.ts`.
- **La `0008` se auto-aplica igual que la `0007`**, desde `rollback-snapshot.ts:120`. Como ese
  módulo es su único referenciador, la migración queda huérfana si se borra el módulo: van juntos.
- La tabla `rollback_snapshots` **existe** en `runtime/gateway.sqlite`, así que el módulo corrió
  alguna vez (probablemente en tests). Borrar el código no borra la tabla; queda inerte.
  Si molesta, se limpia aparte — es un archivo local gitignoreado.

**Verificación:** `npm test` sigue en verde y el gateway arranca sin error de import.

**Revertir:** `git checkout -- apps/gateway-api/src/security/`

---

## E-04 · Corregir `AGENTS.md`: las colas no son Redis + BullMQ

**Estado:** ⬜ pendiente · **Deuda:** `debt-redis` · **Riesgo:** nulo · **Costo:** minutos

`AGENTS.md:33` declara `Queues: Redis + BullMQ`. En el código hay **cero** uso de bullmq —
el único hit es un comentario en `warmup-ramp.ts:108` que dice literalmente "No usa BullMQ".
Las colas son `LocalFileSendQueue` sobre `runtime/send-jobs.json`; Redis sólo se pinguea en
`/health`. Importa porque `AGENTS.md` es la fuente de verdad que leen Codex y Claude.

**Alcance previsto:** `AGENTS.md` (1 línea, quizá 2 con una nota)

**Verificación:** ninguna automática. Se audita leyendo.

**Revertir:** `git checkout -- AGENTS.md`

> **Aparte, operativo (no es cambio de código):** el gateway local tiene `REDIS_URL=127.0.0.1:6379`
> y ese puerto lo ocupa `jectstoreapp-redis-1`, de otro proyecto. `delivrix-redis` está parado.
> Decisión de Juanes: dejarlo así o remapear.

---

## E-05 · DECISIÓN: ¿cuál es el warmup canónico?

**Estado:** ⬜ pendiente · **Deuda:** `debt-warmup-fork` · **No toca código**

Es la bisagra. El engine v1 nunca se desplegó (`service/main.ts:46` dejó el cableado "al
deployment"); el daemon LIVE es el único con launcher propio y con envíos reales.

| Rama | E-06 (contrato de auth) | E-07 (PostfixTransport) |
|---|---|---|
| **A · engine v1 es el canónico** | conectar | conectar (después de A) |
| **B · daemon LIVE es el canónico** | borrar | borrar |

**Hasta que esto se decida, E-06 y E-07 quedan congeladas.** Tocarlas antes es trabajo que
puede tirarse entero.

---

## E-06 · Contrato de auth del warmup — congelada hasta E-05

**Estado:** ⬜ bloqueada por E-05 · **Deuda:** `debt-auth-contract` · **Riesgo:** bajo

Rama A: llamar `buildAuthReadinessContract` en el composition root. Los 13 checks son
**lecturas** (DNS, RBL, TLS, PTR, probes de auth) — no escriben ni envían, y el engine corre en
mock, así que no puede empeorar el envío. Devolvería, nodo por nodo de los 64, cuál pasa el gate.
Rama B: borrar el subsistema.

---

## E-07 · `PostfixTransport` — congelada hasta E-05 y E-06

**Estado:** ⬜ bloqueada · **Deuda:** `debt-transport` · **Riesgo:** ALTO

⚠️ **No es limpieza.** Cablear `createWarmupTransport` quita la última barrera *física* que
impide que el engine v1 mande correo: hoy no puede porque nada lo llama. Sólo después de A y
de tener el contrato de auth funcionando y medido.

---

## E-08 · DECISIÓN: ¿el runtime multi-agente va o se borra?

**Estado:** ⬜ pendiente · **Deuda:** `debt-multiagent` · **No toca código todavía**

Verificado: los tool specs son placeholders (`"Dispatch real: día 4"`, schemas vacíos) y tools
como `dns_zone_create` no tienen handler en ningún lado. Cablearlo hoy produciría agentes
llamando funciones inexistentes. Las dos salidas honestas: terminarlo o borrarlo (queda en git).

---

# Auditoría de la rama — 2026-07-28

Se auditaron los 4 commits nuevos (`d591bcb`, `a906970`, `c5911be`, `6c4c808`) con 6 lentes
independientes y refutación adversarial de cada defecto. **44 hallazgos crudos; sobrevivieron 7.**

**Lo que quedó verificado y en verde:**

- Los 4 commits **no tocan un solo archivo de warmup**. Cero envío accidental introducido.
- El árbol es autosuficiente: exportado limpio con `git archive`, los **1778 imports relativos
  de 693 fuentes resuelven** (0 rotos) y `npm test` da 2165/2165 ahí adentro, sin
  `config/gateway.env`, sin `runtime/`, sin `.env`. El caso `zip-archive` era el único.
- El módulo ZIP es correcto: CRC-32 contra vectores de referencia, offsets verificados con un
  parser independiente, leído por `zipfile`, libarchive y `ditto`, y `unzip -t` limpio.
- El mapa: 320 citas, 100% existentes y en rango; JSON embebido idéntico al standalone.
- Las 4 afirmaciones del ledger que sostienen E-03 y E-04 son **ciertas**: se pueden ejecutar
  tal como están escritas.

**Corrección importante:** el bloque de seguridad del `download-all` (token compartido sin RBAC,
rate limit spoofeable, kill switch ignorado) **es falso**. La ruta autoriza fail-closed, el
gateway escucha en loopback, los 3 tokens están seteados y son distintos, y el endpoint por
dominio que existe desde junio entrega *más* (clave SSH privada). `d591bcb` es neto
neutro-a-mejor. Cinco de los fixes que proponía la primera pasada **habrían roto producción**.

---

## A-01 · Procedencia de la memoria semántica

**Estado:** 🟡 hecho, sin auditar · **Commit:** `80985ee` · **Riesgo:** bajo (aditivo, sin migración)

`tool-use-processor.ts:968` ya firmaba el `actorId` con el id de la sesión y `parseRememberInput`
lo tiraba. Importa porque `openclaw_memory_vectors` **no tiene ningún camino de baja** — ni
DELETE, ni TTL, ni `expires_at` (verificado en todo el repo). Sin procedencia, una fila
envenenada es indistinguible de una legítima. Ahora `metadata.provenance` es clave reservada,
se escribe siempre y se aplica *después* del metadata del modelo, así que no se puede falsificar.

**Qué auditar:** que `provenance` sea realmente inforjable (hay test), y que `actorId: null`
distinga "vino sin atribuir" de "fila anterior al cambio". Consultable por
`metadata->'provenance'->>'actorId'`.

**Pendiente aparte:** el camino de baja no existe todavía. La procedencia lo habilita, no lo
reemplaza.

---

## A-02 · El borde de lectura de `server.mjs`

**Estado:** 🟡 hecho, sin auditar · **Commit:** `eb5b206` · **Riesgo:** bajo

Dos allowlists paralelas: `vite.config.ts` la deriva de `READ_ENDPOINTS`, `server.mjs` la lleva
a mano. Habían divergido en **12 rutas**, entre ellas las 4 de warmup y las 4 de compra de
dominios. Detrás había un segundo bug que el primero tapaba: el proxy pasaba el cuerpo por
`.text()`, que corrompe cualquier binario. Medido: 14371 → 20040 bytes, `unzip -t` con
`invalid compressed data`.

**Qué auditar:** el guard de `server.listen` (solo escucha si se ejecuta directo) y el test de
paridad, que corre en `npm run test:admin`, **no** en el gate raíz.

> **Dato que falta:** ¿qué corre el panel en Hostinger? Si es `server.mjs`, el botón de descarga
> devolvía 404 y la vista de Warmup estaba muerta. Si es Vite, era una bomba con temporizador.

---

## A-03 · Paridad del catálogo de tools

**Estado:** 🟡 hecho, sin auditar · **Commit:** `b6f701f` · **Riesgo:** nulo (solo test + un export)

El test de E-01 cierra el bug, no la clase. Ahora se compara `toolDefinitions` contra
`openClawToolNames()`. Comprobado por mutación: agregando una tool 46 definida pero no listada,
**16 tests quedan en verde y solo cae el nuevo**.

**Qué auditar:** que `openClawToolNames()` siga **sin** derivarse de `Object.keys` — medido, los
órdenes difieren en 9 posiciones y el de la lista es el que ve el modelo en cada request.

---

## A-04 · El vecindario SSH del mapa

**Estado:** 🟡 hecho, sin auditar · **Commit:** `21548a6` · **Riesgo:** nulo (documentación)

El nodo `ssh-bridge` apuntaba a `openclaw-ssh-bridge.ts`, que es el puente de chat contra el
container del agente, no el ejecutor de la flota (ese es `routes/smtp-provisioning.ts`). Tercer
error del mismo vecindario: la arista `e80` daba a `postfix-log-parser.ts` como el que lee
mail.log por SSH, y ese módulo es una función pura sin I/O. 66→68 nodos, 82→84 aristas.

**Qué auditar:** **existir no es ser correcta.** Las 320 citas del mapa existen y caen en rango,
pero `ssh-bridge` tenía citas válidas apuntando al módulo equivocado. Nadie revisó los otros 65
nodos con ese criterio. Si vas a usar el mapa para orientarte en warmup, chequeá esa capa a mano.

---

## Fuera de este ledger

- **`ChatWidget.test.ts` en rojo** — preexistente. Reverificado 2026-07-28 corriéndolo sobre un
  export limpio de HEAD: ya fallaba. Viene del rediseño Aivora (`6de8052`). No es de este plan.
- **11 commits en la rama sin llegar a `produ`** (2026-07-28): `6a87096`, `904a32e`, `0ac3d78`,
  `d591bcb`, `a906970`, `c5911be`, `6c4c808`, `eb5b206`, `80985ee`, `21548a6`, `b6f701f`.
  Ninguno se pusheó; subir a `produ` es decisión aparte.
- **Defectos de la auditoría que quedaron sin cerrar**, ninguno bloqueante: el camino de baja de
  la memoria semántica (A-01 lo habilita), 4 citas del mapa con off-by-one sobre 218,
  `cdn.tailwindcss.com` en el HTML del mapa (estilo de casa, hay 6 más iguales), y
  `_deploy_mapa/` sin trackear con una versión anterior del mapa — verificado que no está
  publicado, así que se borra y listo.
- **Trampa de configuración:** `main.ts:856-859` cae en cascada
  `DELIVRIX_READ_BOUNDARY_TOKEN || DELIVRIX_OPENCLAW_TOKEN || OPENCLAW_GATEWAY_TOKEN`. Hoy las
  tres están seteadas y son distintas. El día que vacíes la primera en una rotación, el token de
  lectura del panel pasa a ser el de mutaciones **en silencio**. Vale una línea en el runbook de
  rotación de secretos.
- **`.audit/audit-events.jsonl`** queda sin commitear a propósito: es dato de runtime que appendea
  el gateway, no un cambio de código.
- **`apps/admin-panel/src/assets/fonts/`** (Satoshi) sin trackear. Verificado: no lo importa
  nadie. Decidir si entra o se borra.
- **Rama de respaldo `backup/pre-zip-fix-2026-07-28`** — borrable una vez auditado E-00.
- **Server del mapa** en `127.0.0.1:8899` (`python3 -m http.server`). Bajar con
  `pkill -f "http.server 8899"`.
