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

> Pendiente de Juanes: confirmar de quién son y si van a `produ` antes o después de este plan.

---

## E-01 · Catálogo de tools: reponer `semantic_remember` / `semantic_recall`

**Estado:** 🟡 hecho, sin auditar · **Deuda:** `debt-semantic-tools` (cerrada) · **Riesgo:** bajo

Estaban definidas en `toolDefinitions`, ruteadas en `tool-use-processor` y con endpoint vivo,
pero faltaban en el union `OpenClawToolName` y en `openClawToolNames()`, así que nunca llegaban
al modelo. Catálogo: 43 → 45. Payload real a Bedrock: 36 → 38 tools.

**Alcance (3 archivos):**
```
apps/gateway-api/src/openclaw-tools-builder.ts        +4   ← único cambio de producción
apps/gateway-api/src/openclaw-tools-builder.test.ts  +47   ← conteos, samples, test de regresión
apps/gateway-api/src/openclaw-bedrock-bridge.test.ts  +4   ← 36 → 38 en el payload
```

**Verificación:** `npm test` → 2154/2154 ✅

**Qué auditar:**
- El diff de producción son 2 líneas repetidas en dos lugares (union + lista). Nada más.
- Las tools nuevas **no pasan por ApprovalGate**: van por la rama de memoria, con firma HMAC,
  a `/v1/openclaw/memory/remember` y `/recall`. Escriben en `openclaw_memory_vectors`.
- Gate: `OPENCLAW_EPISODIC_SCRATCH_ENABLE` (compartido con `read_episodic_scratch`).
  Ojo: `postgresConfigured()` **no mira `POSTGRES_URL`** pese al nombre.

**Revertir:** `git checkout -- <los 3 archivos>`

---

## E-02 · Entregables del mapa de arquitectura

**Estado:** 🟡 hecho, sin auditar · **Riesgo:** nulo (documentación, no ejecuta en producción)

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

## Fuera de este ledger

- **`ChatWidget.test.ts` en rojo** — preexistente, verificado con `git stash`. No es de este plan.
- **3 commits en la rama sin llegar a `produ`**: `6a87096`, `904a32e`, `0ac3d78`.
- **Server del mapa** en `127.0.0.1:8899` (`python3 -m http.server`). Bajar con
  `pkill -f "http.server 8899"`.
