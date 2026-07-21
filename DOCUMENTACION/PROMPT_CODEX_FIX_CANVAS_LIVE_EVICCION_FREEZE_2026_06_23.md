# BRIEF CODEX — Fix: el estado canvas-live crece sin tope (3.29 MB / 924 artifacts / 1040 tasks) y congela /canvas

Fecha: 2026-06-23 · Ejecuta: **Codex** (backend gateway + frontend admin + deploy) · Coordina: Juanes (CTO) · Auditado por Claude (en vivo) · Severidad: **alta (UX bloqueante en /canvas)**

## Contexto (auditado en vivo 2026-06-23)

`/canvas` se **congela** (pantalla con error, "Chrome no responde", OpenClaw "pensando"). Verificado en vivo:

- **Backend SANO:** `GET /v1/canvas/live/state` responde **200 en 36ms**. NO es OpenClaw/Bedrock colgado — la respuesta vuelve rapido.
- **El estado canvas-live esta GIGANTE:** la respuesta pesa **3.29 MB**, con **924 artifacts** y **1040 tasks** (acumulados sobre muchas sesiones de testing).
- **El que se congela es el FRONTEND de /canvas:** `CanvasV5Preview` parsea + retiene en memoria + renderiza los 924 artifacts / 1040 tasks (conversaciones, artifact activo, topologia) y re-renderiza en cada tick del stream -> bloquea el main thread (screenshot, network y page_text del tab dan timeout).
- Las vistas livianas (`/overview`, `/sender-pool`) cargan bien -> el problema es exclusivo del volumen que renderiza `/canvas`.

**NO es el fix de credencial** (`f12dc10`): la seleccion sobre 924 artifacts es de microsegundos. La causa es la **acumulacion sin eviccion** del estado canvas-live — es justo lo que se marco como pendiente en el brief de la credencial tapada ("verificar que la eviccion del canvas-live siga acotada"). Confirmado: **no esta acotada.**

## Stopgap inmediato (para Juanes, ahora)

- **Cerrar/recargar la pestaña trabada de /canvas.** Usar mientras tanto `/overview` y `/sender-pool` (la descarga de credenciales esta en Sender Pool y NO depende de canvas-live).
- **Reiniciar el gateway** (`scripts/gateway-restart.sh`): si el estado canvas-live es en-memoria (Postgres/Redis estan caidos -> solo memoria), el restart lo limpia (924 -> 0) y `/canvas` vuelve a andar temporalmente. **Se re-acumula sin el fix de abajo.**

## Fix (acotar la eviccion, defensa en 3 capas)

1. **Store del servidor (primario):** la fuente del estado canvas-live (`apps/gateway-api/src/services/canvas-live-events.ts`) debe **cap-ear por recencia/LRU**: mantener solo los ultimos N artifacts (p.ej. 50-100) y N tasks, evictando los viejos. Hoy retiene 924/1040 sin tope. (Hubo fixes de memleak en el CLIENTE; el SERVER no esta acotado.)
2. **Endpoint:** `GET /v1/canvas/live/state` debe devolver solo lo reciente/activo (limit), no 3.29 MB. El frontend solo necesita lo activo + reciente.
3. **Cliente (defensivo):** `canvas-live-client.ts` debe acotar lo que retiene/renderiza (ventana de N), por si llega un payload grande; y verificar que la seleccion del preview este memoizada (no recomputar sobre N en cada render sin necesidad).

## Invariantes / NO-regresion (CRITICO)

1. **No perder lo ACTIVO ni lo reciente:** el artifact activo, el preview, las conversaciones recientes y los runs en curso deben seguir mostrandose. Evictar SOLO lo viejo.
2. **No romper el fix `f12dc10`:** el credential reciente debe quedar dentro de la ventana retenida (para que el banner siga ganando sobre el report del mismo turno). La ventana de retencion >= la ventana de correlacion (10 min).
3. **No tocar la descarga de credenciales** (Sender Pool + `/v1/sender-pool/credentials/...`): NO depende de canvas-live, no se toca.
4. **No romper los otros artifacts** (inventory/blacklist/dns_zone/smtp_run/report/proposal) ni la topologia.
5. **Aditivo + reversible;** tag de respaldo; rollback 1 comando.
6. Sin emojis; ASCII en codigo; espanol formal en docs.

## DoD

- `GET /v1/canvas/live/state` devuelve un payload **acotado** (no MB; << 924 artifacts) y `/canvas` **carga y responde** sin congelar, aun tras mucho uso.
- El preview sigue mostrando el banner de credencial (`f12dc10`) para credenciales recientes.
- Conversaciones, runs y artifact activo recientes intactos.
- Vistas livianas (`/overview`, `/sender-pool`) intactas; descarga de credenciales intacta.
- Test de eviccion (el store no supera el cap; el endpoint limita) + `npm test` + `npm run test:admin` verdes.
- Deploy a gateway local + admin. (Hostinger no aplica: el unico script remoto empuja el system-context de OpenClaw.)

## Anclas (verificadas en vivo 2026-06-23)

- Medido en vivo: `GET /v1/canvas/live/state` = 200 / 36ms / **3.29 MB / 924 artifacts / 1040 tasks**.
- Store: `apps/gateway-api/src/services/canvas-live-events.ts`.
- Endpoint: handler de `GET /v1/canvas/live/state` en `apps/gateway-api/src/main.ts`.
- Cliente/render: `apps/admin-panel/src/features/canvas/canvas-live-client.ts` (`latestArtifact` `:534`, retencion de `artifacts`), `CanvasV5Preview.tsx` (render de artifacts + conversaciones, `selectPreviewArtifact` `:612`).
