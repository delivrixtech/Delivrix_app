# OPS Codex Hotfix — Gateway hung sin responder HTTP

**Fecha:** 2026-05-30 sábado ~16:45 COT.
**Severidad:** P0 BLOQUEANTE smoke E2E Fase 0.5.
**Owner:** Codex backend senior.
**PM:** Claude.
**Pre-requisito:** ninguno — debug inmediato.

---

## Síntoma

Gateway arranca limpio (`gateway-api listening on http://127.0.0.1:3000`), proceso vivo, puerto abierto, acepta TCP connect, pero **no responde NADA a ningún request HTTP**. Curl recibe timeout sin bytes.

## Reproducción

```bash
cd "/Users/juanescanar/Documents/delivrix app"
lsof -ti :3000 | xargs kill -9 2>/dev/null
sleep 2
OPENCLAW_SIGN_ALLOW_UNSIGNED_LOCAL_PANEL=true node --env-file=.env.local apps/gateway-api/src/main.ts
# En otra terminal:
curl -m 3 http://127.0.0.1:3000/health
# Timeout. Nada en foreground.
```

## Diagnóstico confirmado

| Test | Resultado |
|---|---|
| Proceso node vivo (`ps -p <pid>`) | ✅ |
| Puerto 3000 abierto (`lsof -ti :3000`) | ✅ |
| TCP connect (`curl -v`) | ✅ "Connected to 127.0.0.1 port 3000" |
| Request enviada | ✅ "Request completely sent off" |
| Response | ❌ "0 bytes received" timeout |
| CPU time del proceso | 0.65s (stuck en algún await) |
| ExperimentalWarning SQLite | Aparece (esperado) |
| Logs de request en foreground | ❌ Ninguno |
| Test puerto 3001 con `http.createServer` simple | ✅ "REQ GET /test" + "ok" → red OK, Node OK |
| Locks SQLite (.wal, .shm, .journal) | ❌ no existen |
| Cambios en .env.local | sin cambios desde viernes |
| Cambios en main.ts | sin cambios desde commit 7af9213 |

**Conclusión:** el HTTP handler del gateway nunca ejecuta nada loggable. Algo entre `http.createServer(handler)` y la primera línea del handler se queda colgado. Hipótesis fuertes:

1. **Middleware async hung en algún `await`** que nunca resuelve (probable: lectura de stream sin 'end' event)
2. **Lock SQLite interno** en `DatabaseSync` que se reabre en cada request y deadlock-ea
3. **Promesa unhandled rejected** silenciada

## Contexto importante

- **Ayer viernes 2026-05-29 funcionaba perfecto** con el mismo comando + mismo .env.local
- **Hoy sábado** Mac durmió + se rebooteó algún componente
- Repo en commit `7af9213` (mismo que ayer)
- Codex modificó 3 archivos pero NO los commiteó (OPENCLAW_PERMISSIONS_MATRIX + OPENCLAW_SYSTEM_PROMPT + build-system-context.sh) — esos no son del runtime gateway

## Lo que SÍ sabemos (no perder tiempo en esto)

- ❌ NO es bug de red Mac (test puerto 3001 anda)
- ❌ NO es lock SQLite huerfano (no hay .wal/.shm)
- ❌ NO es race timing (esperamos 10s, NODE_DEBUG=http en log)
- ❌ NO es .env.local malformado (cargó el secret, login mostró var en logs)
- ❌ NO es problema de import inicial (warning de SQLite imprime + "listening" aparece)

## ACTUALIZACION 2026-05-30 17:08 COT — bug confirmado en commit 7af9213

Tras restaurar TODOS los cambios sin commit del backup `/tmp/gateway-hung-backup/`:
- `packages/adapters/src/index.ts` (1 línea: `export * from "./ionos-dns-actuator.ts";`)
- `apps/gateway-api/package.json` (6 líneas)
- `apps/gateway-api/src/main.ts` (35 líneas: agrega endpoint `GET /v1/openclaw/proposals` para polling del panel)

**Resultado:**
- Gateway arranca limpio (PID 39823, `gateway-api listening on http://127.0.0.1:3000`)
- Curl `/health` devuelve `STILL_HUNG` — handler sigue colgado.

**Diagnóstico final:** los 35 cambios de main.ts que Codex tenía sin commit son un endpoint nuevo (`GET /v1/openclaw/proposals`) NO un fix al handler hung. El bug del handler está en código que YA está en el commit `7af9213` en main.

**Cualquier persona que clone el repo y arranque gateway recibe:**
1. Crash al import (falta export `IonosDnsActuatorError`) — fix: 1 línea en `packages/adapters/src/index.ts`
2. Handler hung después de arrancar — fix: ?? (no identificado, requiere Codex que conoce el código del handler).

## ACTUALIZACION 2026-05-30 17:00 COT — causa raíz REAL

Tras revertir los 3 archivos modificados al commit 7af9213, el gateway crashea al arrancar con:

```
SyntaxError: The requested module '../../../../packages/adapters/src/index.ts' does not provide an export named 'IonosDnsActuatorError'
   at routes/dns-ionos-upsert.ts:21
```

**Esto significa que el commit 7af9213 (último en main) está roto:** el handler `dns-ionos-upsert.ts` importa `IonosDnsActuatorError` pero `packages/adapters/src/index.ts` no lo exporta. Codex había agregado el export sin commit y eso es lo que vimos en `git diff`. Al revertirlo, dejamos el repo en estado inconsistente.

**Acción correcta:** restaurar SOLO `packages/adapters/src/index.ts` y `apps/gateway-api/package.json` del backup, NO los 35 cambios de main.ts (que parecían sospechosos del handler hung original).

**Implicación para Codex:** el commit 7af9213 necesita un hotfix que agregue el export `IonosDnsActuatorError` al `index.ts`. Sin eso, cualquier persona que clone el repo y arranque gateway recibe el crash.

## CAUSA RAÍZ ENCONTRADA 2026-05-30 16:50 COT

`git status` reveló cambios sin commit en 3 archivos:
- `apps/gateway-api/src/main.ts` (35 líneas agregadas)
- `apps/gateway-api/package.json` (6 líneas)
- `packages/adapters/src/index.ts` (1 línea)

`NODE_DEBUG=http` confirmó el síntoma exacto:
```
HTTP <pid>: SERVER new http connection
HTTP <pid>: SERVER socketOnParserExecute 83
HTTP <pid>: server socket close
```

El server parsea el request pero cierra el socket sin invocar handler. **Los cambios sin commit en main.ts rompieron el wiring del request handler.**

Acción inmediata: `git stash` de esos 3 archivos + restart con código del commit `7af9213` (último válido).

## Lo que SE necesita investigar

1. **Reproducir el hang en debug**:
   ```bash
   NODE_DEBUG=http,net OPENCLAW_SIGN_ALLOW_UNSIGNED_LOCAL_PANEL=true node --inspect --trace-warnings --trace-uncaught --env-file=.env.local apps/gateway-api/src/main.ts
   # Conectar Chrome DevTools al --inspect port 9229
   # Hacer curl /health
   # Ver call stack actual del Node — dónde está awaiting
   ```

2. **Confirmar handler entry**: agregar `console.log('REQ INCOMING', req.method, req.url)` como PRIMERA línea del handler de `http.createServer(...)` en main.ts. Si NO aparece cuando llega curl → el listener no está adjunto al handler correcto. Si SÍ aparece pero no continúa → el siguiente await se cuelga.

3. **Revisar SQLite synchronous reads**: el `approval-token.ts` usa `DatabaseSync` (módulo `node:sqlite`). Si alguna conexión queda abierta sin close, puede haber lock. Verificar todos los `DatabaseSync` y asegurar `close()` en algún momento.

4. **Revisar `readJson`**: si el handler hace `await readJson(req)` para GET sin body, el stream nunca emite 'end' y await queda colgado. Solución: skip readJson para GET/HEAD.

5. **Verificar middleware orden**: `readOnlyProxyBoundary` del vite proxy NO aplica acá (es del vite, no del gateway). Pero el gateway puede tener un middleware similar en main.ts.

## Workaround mientras se arregla

Ninguno conocido. Toda operación P0 está bloqueada hasta el fix.

## Tarea concreta

1. Reproducir el bug con `node --inspect` o agregar `console.log` al inicio del handler de `http.createServer` en main.ts.
2. Identificar la línea exacta donde se traba.
3. Patch + push hotfix.
4. Restart gateway + verificar `curl /health` responde.
5. Push commit con descripción del fix + reportar PM.

## Tarea bonus si tiempo permite

- Agregar log de request entry/exit + duración en main.ts. Sin esto, debug futuro es imposible.
- Tests E2E que detecten hang (timeout corto en CI).

---

— Claude PM
