# BRIEF CODEX — P0: no servir servidores mock en 401 (Infraestructura) — AUDITADO

Fecha: 2026-06-16 · **Auditado vs código actual 2026-06-17 (HEAD `ad91b87`)** · Ejecuta: Codex (backend) · Rama: `produ`.

Contexto: las cuentas Webdock en error (401) ya muestran "conteo no disponible" en la UI (el front lo gatea), PERO el backend sigue sirviendo 3 servidores **mock** como reales (`itemCount:3` + `items`). El front lo disimula; esto lo arregla de raíz. **NOTA: el front (quick wins + reorg) YA está commiteado (`f13ad93` + `ad91b87`); este P0 es un cambio de BACKEND standalone, no hay nada de front que bundlear.**

## Causa raíz (verificada en código, 2026-06-17)

`packages/adapters/src/webdock-real-adapter.ts` — ante HTTP no-ok (ej. 401) y ante excepción, devuelve `servers: this.withAccount(mockWebdockServers())` (3 servidores fijos: svc-warmup-01/02 + svc-prod-eu-01) con `source.kind:"mock"`, `responseOk:false`:
- **L313** (rama `if (!response.ok)` — el 401).
- **L332** (rama `catch` — error de red).
- L293 (rama `!readApiKey` / boot): mock **LEGÍTIMO**, `responseOk:true` — **NO tocar**.

Luego `buildWebdockProvider` (`apps/gateway-api/src/routes/infrastructure.ts` **L218**) copia `itemCount: webdock.servers.length` (=3, **L227**) e `items:` (**L232**) sin chequear `responseOk` (el `errorReason` sí se setea, L221). Resultado: "Credencial rechazada · 3 servidores" + drill-down con servidores fantasma.

El test `infrastructure.test.ts` (L130-143) **NO lo cacha**: inyecta una lista VACÍA vía el helper `webdockAccount("secondary", ..., [], { responseOk:false, errorMessage:"401" })` y asserta `["webdock-secondary","error",0]` (L143) — nunca ejercita el fallback real del adapter. Falsa confianza.

## Tareas

1. **Adapter (fix de raíz):** en las DOS ramas de error de `webdock-real-adapter.ts` (**L313 y L332**), devolver `servers: []` (o `this.withAccount([])`, equivalente) en vez de `mockWebdockServers()`. Mantener `source.kind:"mock"`, `responseOk:false` y el `errorMessage`. **NO** tocar la rama boot/sin-creds (L293), que es mock legítimo de arranque.
2. **Defensa en profundidad:** en `buildWebdockProvider` (`infrastructure.ts` L218-232), si `!webdock.source.responseOk` forzar `itemCount:0` e `items:[]` aunque el adapter ya lo haga. Verificar si `buildExternalVpsProvider` (L240, Contabo/externos) comparte el patrón de copiar `servers.length` sin chequear `responseOk`; si sí, aplicar el mismo guard.
3. **Test del 401 REAL:** añadir un caso que ejercite el fallback del adapter de verdad — instanciar `WebdockRealAdapter` (o su `readInventory`) con un `fetchImpl` que devuelva `{ ok:false, status:401 }` y asertar `servers:[]` / `itemCount 0` / `responseOk:false`. El test actual con fixture `[]` puede quedar, pero NO sustituye a este (es el que daba falsa confianza).
4. (Opcional, anti-frágil) `brandKey` tipado por provider para que el front no adivine la marca por string.

## Procedimiento y DoD (verificable)

- `node --test apps/gateway-api/src/routes/infrastructure.test.ts` + el test nuevo del adapter en verde, incluido el caso 401 real.
- `npm --workspace @delivrix/gateway-api run build` OK.
- **Reiniciar el gateway** (cambio de backend; no entra sin restart — ya nos pasó 3 veces).
- Re-verificar el endpoint vivo `GET /v1/infrastructure/inventory`: `webdock-secondary` y `webdock-tertiary` deben quedar con `itemCount:0` e `items:[]` (hoy traen 3). Claude revalida en Chrome contra el endpoint.

## Commit (CORREGIDO — el front YA está commiteado)

HEAD = `ad91b87`; el working tree de fuente está limpio (`f13ad93` = inventario + reorg UI, `ad91b87` = proxy `server.mjs`). Este P0 es un commit **NUEVO y standalone** con SOLO los archivos de backend tocados:

```
cd "/Users/juanescanar/Documents/delivrix app"
git add \
  packages/adapters/src/webdock-real-adapter.ts \
  apps/gateway-api/src/routes/infrastructure.ts \
  apps/gateway-api/src/routes/infrastructure.test.ts
git diff --cached --name-only    # SOLO esos 3 (+ archivo de test nuevo si lo creás aparte)
git commit -m "fix(infra): no servir servidores mock en error de inventario Webdock (401) + guard itemCount/items + test del fallback real"
git push origin produ
git rev-list --left-right --count origin/produ...produ   # 0  0
```

Nunca `git add -A` ni `git add .` (hay `.audit/*`, docs y `config/*.bak-*` con secretos).

## Fuera de alcance

- La reorg estructural y los quick wins de la UI **YA están hechos y commiteados** (`f13ad93` + `ad91b87`). Esto es exclusivamente el fix de datos del backend.
- No tocar la lógica de dedupe de la cuenta madre ni el cableado de Contabo (ya funcionan y están en `produ`).
