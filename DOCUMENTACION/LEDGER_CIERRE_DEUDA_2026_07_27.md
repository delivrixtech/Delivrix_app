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

**Estado:** 🟡 hecho, sin auditar · **Commit:** `25017a4` (2026-07-28) · **Deuda:** `debt-rollback-dup` · **Riesgo:** nulo

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

**Estado:** 🟡 hecho, sin auditar · **Commit:** `7fde182` (2026-07-28) · **Deuda:** `debt-redis` · **Riesgo:** nulo

> **Era más grande que la línea señalada.** Al verificar el resto del listado apareció una
> segunda divergencia que el ledger no tenía: **`Backend: NestJS`** también es falso — cero
> referencias en `apps/` y `packages/`, el gateway es `node:http` puro (`main.ts:5`, `:1602`).
> Se marcaron las dos con evidencia y se dejó dicho que los otros cinco ítems **no** se
> reverificaron.

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

**Estado:** ⬜ pendiente · **Deuda:** `debt-warmup-fork` · **No toca código** ·
**Reescrita 2026-07-28 contra el código**

> El planteo anterior de esta entrada era incorrecto y llevaba a decidir mal. Decía "engine v1 vs
> daemon LIVE, dos caminos". No son dos y no compiten como decía.

### Lo que realmente hay

**Tres caminos de envío, cada uno con su disparador:**

| # | Qué | Cómo manda | Se dispara |
|---|---|---|---|
| 1 | **Rampa del gateway** — `RampScheduler` en `routes/warmup-ramp.ts` | `/usr/sbin/sendmail` por SSH en el nodo (`warmup-ramp.ts:372`) | **Al arranque del gateway**: `main.ts:842` lo instancia, `main.ts:6100` llama `resumeRampsOnStartup()` |
| 2 | **Daemon LIVE** — `service/live-warmup-daemon.ts` (344 líneas) | `nodemailer` propio (`:181` crea el transport, `:187` `sendMail`) | Launcher propio: `scripts/delivrix-warmup-live-start.sh`, `WARMUP_LIVE_ENABLE=true`, con kill-file |
| 3 | **Daemon dry-run** — `service/dryrun-daemon.ts` (288 líneas) | Nada: asserta mock y **rehúsa arrancar** si no lo es | `scripts/delivrix-warmup-start.sh`, fuerza `WARMUP_TRANSPORT=mock` |

**Y una capa de abstracción que no usa nadie**, dentro del mismo paquete:

```
apps/warmup-engine/src/runtime/transport.ts             PostfixTransport
apps/warmup-engine/src/live/compose.ts:129              createWarmupTransport
apps/warmup-engine/src/runtime/auth-contract-builder.ts buildAuthReadinessContract
```

Los tres están exportados desde `index.ts` y tienen **cero callers**. Lo importante: **los dos
daemons que viven al lado tampoco los usan.** El LIVE se escribió su propio camino de envío con
nodemailer en vez de usar `PostfixTransport`.

**Corrección al planteo viejo:** "engine v1" no es un tercer desplegable compitiendo con los
daemons. Es una capa diseñada y nunca ejercitada, que los daemons de su propio paquete esquivan.

### Lo que hay que decidir

Eran dos preguntas. **(a) quedó resuelta por verificación** (abajo): son complementarios.
**Queda solo (b), y es barata.**

**(a) ¿Cuál es el camino de envío canónico — la rampa (1) o el daemon LIVE (2)?**

No hacen lo mismo, y esto es lo que hay que mirar antes de elegir:

- La **rampa** sube volumen usando el MTA del propio nodo. Simple, y es lo único que arranca solo.
- El **daemon LIVE** hace el warmup sofisticado: banco de conversaciones
  (`live/warmup-content-bank.ts`), OAuth de Google (`live/google-oauth-token-provider.ts`),
  descifrado de credenciales (`live/smtp-credential-decrypt.ts`).

**VERIFICADO 2026-07-28 — son complementarios, no rivales. La pregunta (a) se disuelve.**

- El **daemon LIVE** manda a **un solo destinatario**: el seed inbox
  (`WARMUP_GMAIL_SEED_USER`, default `infradelivrixdemo@gmail.com`, `live-warmup-daemon.ts:83`).
  El log de cada vuelta es literalmente `${box} → ${cfg.seedInbox}` (`:305`). No es un camino de
  volumen: es un **lazo de medición de placement** — manda al seed y después lee por Gmail OAuth
  si cayó en INBOX o en spam.
- La **rampa** manda a `recipientPool`, un array que provee el operador al crearla
  (`warmup-ramp.ts:682`, con mínimo `plan.recipientPoolMin`). Ese sí es el camino de volumen.

**Solo chocan si alguien mete el seed inbox dentro del `recipientPool` de una rampa.** Hoy no
puede pasar: `runtime/openclaw-workspace/inventory/warmup-progress.json` ni siquiera tiene la
clave `ramps` — solo `runs`. **Cero rampas activas.**

> **Deuda chica que salió de esto:** no hay ningún guard que impida meter el seed inbox en un
> `recipientPool`. Si pasa, la rampa bombardea la casilla de medición y **envenena la señal de
> placement**, que es justamente lo que gatea todo el warmup v1. Es un `if` en
> `parseRecipientPool`.

**(b) ¿La capa de abstracción se termina o se borra?**

Es lo que E-06 y E-07 preguntan.

| Opción | E-06 (auth contract) | E-07 (PostfixTransport) | Costo | Riesgo |
|---|---|---|---|---|
| **A · Borrar la capa** | borrar | borrar | mínimo | nulo — nadie la llama |
| **B · Terminarla** | cablear | cablear | alto | **ALTO** en E-07 |
| **C · Dejarla congelada** | nada | nada | cero | la deuda sigue creciendo |

**Recomendación: A.** No por pereza — por evidencia. Los dos daemons que viven en el mismo
paquete escribieron su propio camino en vez de usarla. Eso es la señal más fuerte que hay de que
la abstracción no era la que hacía falta. Queda en git si algún día se quiere volver.

⚠️ **Si elegís B, E-07 primero no.** Cablear `createWarmupTransport` quita la última barrera
*física* que impide que esa capa mande correo: hoy no puede porque nada la llama.

### Por qué ahora

`runtime/openclaw-workspace/inventory/warmup-progress.json` tiene `ramps` **vacío**, así que el
resume-on-boot del gateway no dispara nada. Decidir hoy no interrumpe ningún envío en curso.

**Hasta que (a) y (b) se decidan, E-06 y E-07 quedan congeladas.**

---

## E-06 · Contrato de auth del warmup

**Estado:** 🟡 cerrada POR BORRADO, sin auditar · **Commit:** `a593e30` (2026-07-28) · **Deuda:** `debt-auth-contract`

Rama A: llamar `buildAuthReadinessContract` en el composition root. Los 13 checks son
**lecturas** (DNS, RBL, TLS, PTR, probes de auth) — no escriben ni envían, y el engine corre en
mock, así que no puede empeorar el envío. Devolvería, nodo por nodo de los 64, cuál pasa el gate.
Rama B: borrar el subsistema.

---

## E-07 · `PostfixTransport`

**Estado:** 🟡 cerrada POR BORRADO, sin auditar · **Commit:** `a593e30` (2026-07-28) · **Deuda:** `debt-transport`

Se resolvió al revés de como estaba planteado: en vez de cablear `createWarmupTransport` —que
habría quitado la última barrera *física* al envío— **se borró**. Sin él no queda ningún camino
de construcción para que esa capa mande correo.

**Qué auditar:** que no haya quedado nada vivo apuntando a lo borrado. Se midió consumidor por
consumidor, export por export, antes de tocar: `runtime/transport.ts` **se queda** (el
`WarmupTransport` lo usan scheduler, send-worker y service; `MockTransport` lo usa el daemon
dry-run) y `live/mail-adapters.ts` **se queda** (el dry-run le importa `createGmailOAuthImapClient`).
No era "borrar tres archivos".

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

## A-05 · Guard de la casilla de medición

**Estado:** 🟡 hecho, sin auditar · **Commit:** `e30b897` (2026-07-28) · **Riesgo:** bajo

Salió de verificar E-05(a). No había nada que impidiera meter el seed inbox en el
`recipientPool` de una rampa; si pasaba, la rampa lo bombardeaba y envenenaba la señal de
placement que gatea todo el warmup v1. Ahora `parseRecipientPool` lo rechaza con 422.

**Qué auditar:** el guard **canonicaliza antes de comparar**. Gmail ignora los puntos del local
part y todo lo que siga a un `+`, así que `me.dic.ion+rampa@gmail.com` es la misma casilla que
`medicion@gmail.com` — un guard que compare strings se saltea con un punto. Y usa el mismo
default que `live-warmup-daemon.ts:83`, para que proteja la casilla real aunque el gateway no
tenga la env seteada.

---

## A-06 · Baja de la memoria semántica

**Estado:** 🟡 hecho, sin auditar · **Commit:** `a3878bc` (2026-07-28) · **Riesgo:** medio (acción destructiva nueva)

Cierra el otro extremo de A-01: ese commit hizo identificable cada fila, pero sin forma de
borrarla la procedencia sola no servía. `deleteMemoryVectors` en storage y
`POST /v1/openclaw/memory/forget` en el gateway.

**Qué auditar — son decisiones, no código:**
- **No es tool del modelo y no debe serlo.** Un agente que puede borrar su propia memoria puede
  tapar lo que escribió. Verificado: no aparece en `openclaw-tools-builder`.
- **Nunca borra en masa:** sin `ids` ni `actorId` tira `invalid_delete_filter` sin tocar la base.
- **Por `actorId` = la sesión entera.** Es el caso real y lo habilitó A-01.
- **`dryRun`** para ver qué se llevaría antes de llevárselo.
- **Se audita siempre, incluido el dry-run**, con `riskLevel: critical`. El evento guarda los
  **ids, no el contenido**: el audit log no es lugar para el texto que se está sacando.
- Hay test de que el `DELETE` consulta `metadata -> 'provenance' ->> 'actorId'`, la misma ruta
  donde `remember` la escribe. Si no coincidieran, el borrado por sesión no matchearía nada y
  fallaría **en silencio**.

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
