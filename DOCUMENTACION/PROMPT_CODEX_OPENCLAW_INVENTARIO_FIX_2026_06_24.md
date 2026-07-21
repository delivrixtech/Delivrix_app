# PROMPT CODEX v2 — Fix: OpenClaw ve inventario degradado + cuentas/Contabo/memoria

Diagnostico completo: `DOCUMENTACION/AUDITORIA_OPENCLAW_INVENTARIO_WEBDOCK_V2_2026-06-24.md`
(2a auditoria: 16 subagentes + verificador final). Este brief CORRIGE el plan del v1.

## CORRECCIONES AL PLAN v1 (leer primero — el v1 no habria funcionado)

1. NO subir `OPENCLAW_LIVE_CONTEXT_ITEM_LIMIT` (20->60): es INERTE. El cap que muerde
   primero es `stringifyLiveContext(..., 3000)` del bloque servers (bridge:1069). Caben ~12
   servers con IP, ~9 si se agrega accountId. Subir el item-limit no cambia nada.
2. El bridge YA fusiona ambos feeds (no hay que "cambiar la fuente primaria"). El defecto real
   es que `summarizeInventoryServers` NO proyecta accountId/accountLabel (que SI vienen en el
   `detail` de /v1/infrastructure/inventory) y que el orden webdock-first puede hambrear Contabo.
3. La memoria episodica 503 NO es "Postgres apagado" (eso da HTTP 200 vacio). Es esquema no
   migrado/incompleto (42P01/42703 -> 503). Es OPERATIVO (migraciones), no levantar PG.

## INVARIANTES (no romper)

- NO tocar el panel (`routes/infrastructure.ts` solo additive). NO tocar `buildWebdockCreateRegistry`
  ni el write-path. NO cambiar la FORMA de `/v1/webdock/inventory` (alimenta evaluateWebdockDrift,
  buildWebdockInventoryContract y el frontend Canvas; cambiarla rompe ~5 tests + drift + contract).
- Respetar [5A] ENTITY_GROUNDING: el objetivo es que el inventario REAL (con cuenta) llegue al
  contexto para PODER afirmar con grounding; no relajar el protocolo.
- Tests del bridge usan assert.match (additive-safe). El contrato gana accountId como campo OPCIONAL.
- node --check + suite verde. Sin secretos en logs.

## CARRIL CODIGO (Codex) — aditivo, bajo riesgo

### P0.1 — Proyectar la cuenta + bloque accounts[] (el fix central)
Archivo: `apps/gateway-api/src/openclaw-bedrock-bridge.ts`, `summarizeInventoryServers` (~1968-2014).
- Proyectar `accountId`/`accountLabel` al objeto emitido por server: en la rama infra leer
  `entry.item.detail.accountId`/`accountLabel` (vienen de infrastructure.ts:579-580); en la rama
  webdock leer `server.accountId` si existe.
- Anteponer un bloque COMPACTO `accounts[]` (uno por cuenta: `{accountId, accountLabel, status,
  serverCount, providerId}`) ARRIBA del bloque servers, con su propio sub-cap (~800-1000 chars),
  fuera del slice de 3000 de servers. Sobrevive la truncacion global (truncateLiveContext recorta
  desde el final) y da el conteo por cuenta sin inflar cada server.
- Subir el sub-cap de la lista de servers de 3000 SOLO lo justo (p.ej. 5000) y COMPENSAR bajando
  otro bloque menos critico para no superar `liveContextMaxChars=18000` (bridge:74). Verificar la
  suma de sub-caps tras el cambio.

### P0.2 — Incluir la flota completa (Contabo no se puede hambrear)
- En `summarizeInventoryServers`, antes del `.slice(0,limit)`, INTERCALAR por cuenta/proveedor
  (round-robin) en vez de webdock-first puro, para que los servers Contabo (kind `contabo_server`,
  ya pasan el filtro `/server|compute/i` en bridge:1987) no queden expulsados por una flota Webdock
  grande (InfraVPS=13).

### P0.3 — Tool aditiva de flota completa
- Crear `read_infrastructure_inventory` (o `read_fleet_servers`) que pegue a
  `/v1/infrastructure/inventory` (multi-cuenta + Contabo). Declararla en `openclaw-tools-builder.ts`
  + permisos en `main.ts` (~1030) + `skill-contracts.ts` + `c2-detector.ts`. NORMALIZAR su parser:
  la forma es `{providers:[{items:[...]}]}`, NO `{inventory:{servers}}` (no reusar
  `filterWebdockInventoryResult` tal cual). NO tocar ni eliminar `read_webdock_servers`.
- OJO: `/v1/infrastructure/inventory` NO trae IPv4 (InventoryItem.detail sin IP). Si OpenClaw
  necesita IP verificada, sub-fix aditivo: agregar `ipv4` a `webdockServerToInventoryItem`
  (infrastructure.ts:569) + tipo `InventoryItem` (infrastructure-inventory.ts) — additive, tocaria
  infrastructure.test.ts:231/270/472 (deepEqual de detail) -> actualizar esos fixtures.
- Ajustar el system-prompt: hoy dice `read_webdock_servers -> inventario VPS` (sesga a creer que es
  la flota entera). Aclarar que la flota completa es la tool nueva.

### P1.1 — Promise.allSettled (una cuenta caida no debe tumbar el inventario)
- `main.ts:1849` (webdockListServers map dentro de Promise.all) e `infrastructure.ts` (~97):
  cambiar a `Promise.allSettled` y mapear rejected -> `responseOk:false` por cuenta. Defensa real
  si el adapter throwa en 401 (verificar en vivo si throwa o ya devuelve responseOk:false).

### P1.2 — Telemetria del 503 episodico
- `routes/episodic-scratch.ts:111-114`: el catch que devuelve 503 debe logear el `code`/`message`
  de Postgres (no colapsar ciego), para diagnosticar esquema-vs-otro sin re-auditar a oscuras.

### P1.3 — Tool de sesiones (pedido del operador)
- `list_conversations` + `read_conversation(conversationId)` envolviendo OpenClawChatHistoryStore
  (lectura paginada sin el recorte de 40 turnos). Permisos read-only nuevos.

## CARRIL OPERATIVO (operador, NO Codex)
- Verificar `/v1/openclaw/scratch?grounded=true` -> 200-vacio (PG caido) vs 503 (esquema). Si 503,
  correr/completar migraciones de `openclaw_episodic_scratch`.
- Reautenticar/rotar tokens de pep.prz001 (SECONDARY) y Host Latam (TERTIARY) por env + restart.
- Confirmar cwd del gateway (no worktree viejo).

## CARRIL PRODUCTO (decision Juanes, fuera de este fix)
- Baja/deshabilitar cuenta con ApprovalGate; distinguir token-expirado de cuenta-baneada (estado
  fino + backoff + auditar la caida).
- Reporte de cuentas caidas + servers/sender-nodes huerfanos (hoy desaparecen en silencio).
- Pre-flight con live-check por cuenta (hoy estatico, ciego a las 4 cuentas distintas + Contabo).

## VERIFICACION (antes de merge)
1. Unit bridge: fixture 5 cuentas (2 con servers, 1 vacia, 2 en 401) + Contabo -> live_context
   lista servers de TODAS las cuentas con servers, cada server con accountId, accounts[] con las 5
   y su status, Contabo presente, no trunca por debajo de la flota real.
2. Regresion: panel `/v1/infrastructure/inventory` byte-identico; create/delete intacto; drift y
   contract del endpoint legacy intactos.
3. E2E vivo: chat "que cuentas Webdock tenemos" + "lista los SMTP Contabo" -> enumera correcto.
4. node --check + suites gateway/domain/admin-panel.

## PENDIENTES LIVE (no verificable estatico)
- Causa exacta 503 (42P01 vs 42703). Cuantas cuentas caidas hoy. Si el adapter throwa en 401.
  Conteo Contabo vs Webdock en el feed. Que techo recorta primero con la flota actual.
