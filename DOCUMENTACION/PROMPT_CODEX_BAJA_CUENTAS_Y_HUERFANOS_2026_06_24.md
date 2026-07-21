# PROMPT CODEX (producto) — Baja de cuentas + reporte de huerfanos

Contexto: `DOCUMENTACION/AUDITORIA_OPENCLAW_INVENTARIO_WEBDOCK_V2_2026-06-24.md` (seccion 4 y 6, carril
producto). Gap confirmado: cuando una cuenta Webdock se bloquea/banea, no hay forma de darla de baja
ni reporte de lo que queda huerfano. Este brief es SEPARADO del fix de inventario (PROMPT_CODEX_
OPENCLAW_INVENTARIO_FIX); requiere decision de producto de Juanes antes de implementar.

## PROBLEMA (verificado en codigo)

1. Cuentas = env-driven puro (`createWebdockAdaptersFromEnv`, webdock-real-adapter.ts:929-976, slots
   fijos primary..quinary). No hay estado persistido de cuenta; la unica "baja" es borrar la env var
   + restart. No existe el concepto de cuenta retirada/deshabilitada.
2. No distingue token-expirado de cuenta-suspendida/baneada: ambos -> `responseOk:false` -> status
   "error". El enum `ProviderStatus` (packages/domain/src/infrastructure-inventory.ts:2) solo tiene
   active|paused|error|planned. resolveWebdockProviderStatus en infrastructure.ts:691-702.
3. Sin backoff: el adapter cachea el 401 60s (webdock-real-adapter.ts:176,746-751) y reintenta igual
   para siempre. Sin contador de fallos consecutivos.
4. Cuenta caida -> `visibleServers = responseOk ? servers : []` (infrastructure.ts:221): sus servers
   desaparecen del inventario en silencio, sin diff "tenia N, ahora 0".
5. Sender-nodes/servers huerfanos: el store no tiene delete (packages/local-store/src/local-file-
   sender-node-store.ts; interfaz sender-node-registry.ts:8-11 solo list/upsert). El drift solo emite
   warning (openclaw-rules.ts:145-160) y NI corre en el endpoint multi-cuenta (solo en el legacy
   mono-cuenta, main.ts:1454) -> ademas genera falsos huerfanos.
6. Sin auditoria de la transicion de salud de cuenta (no hay evento account_unhealthy/recovered;
   oc.infrastructure.inventory.fetch solo graba `errorProviderCount` agregado, infrastructure.ts:199-215).
7. El boton "Reautenticar" del panel es decorativo (Infrastructure.tsx:826,875-883, disabled, sin
   onClick). Panel 100% read-only; las mutaciones van por ApprovalGate (POST /v1/openclaw/proposals/
   :id/sign).

## DISENO PROPUESTO (a validar con Juanes)

Reusar el patron existente de retiro de sender-nodes (sender-node-retirement-approval.ts +
runbooks/revert.ts:56 que marca `retired_pending_approval`) elevado a nivel CUENTA. NUNCA borrar
fisico; soft-retire con aprobacion.

### Pieza 1 — Estado fino de cuenta
- Ampliar `ProviderStatus` (o un `accountHealth` paralelo) con: `unauthorized` (401), `suspended`
  (baneada por proveedor), `retired` (dada de baja por operador), ademas de active/paused/planned.
- Capturar el HTTP status real en `WebdockInventorySource` (hoy solo `responseOk` + `errorMessage`
  string, webdock-real-adapter.ts:68-77,312-339). Mapear 401/403 -> unauthorized; distinguir, si se
  puede, token-revocado de cuenta-suspendida sondeando billing/account (un 401 puro no lo dice).
- Backoff: contador de fallos consecutivos por cuenta + TTL escalado para errores; tras N fallos / X
  horas, marcar `candidata a baja`.

### Pieza 2 — Persistencia de cuentas (dejar de derivar todo del env)
- Store de cuentas (`accounts.json` o tabla) con `{id, label, providerKind, status: active|disabled|
  retired, retiredReason?, retiredAt?}`. El env sigue aportando credenciales; el store aporta el
  ESTADO/lifecycle. 
- `createWebdockAdaptersFromEnv` + `dedupeWebdockInventoryAccounts` (infrastructure.ts:164) +
  `buildWebdockCreateRegistry` (webdock-real-adapter.ts:992) deben EXCLUIR cuentas `disabled`/
  `retired` para que no aparezcan ni cuenten ni se elijan para crear.

### Pieza 3 — Accion de baja con ApprovalGate
- Endpoint mutante `POST /v1/infrastructure/accounts/:id/retire` (o categoria de proposal nueva)
  detras del MISMO ApprovalGate/HMAC que el resto de writes (ApprovalGate.tsx categorias :76-91;
  probablemente `future_live_requires_new_phase` o una nueva `supervised_local_state`).
- Marca la cuenta `retired_pending_approval` -> tras firma humana -> `retired`. Audita con
  `accountId` + `reason` + `sideEffects: local-state-only`.
- CTA en el panel "Retirar cuenta" habilitado solo para ese flujo firmado, junto a "Reautenticar"
  (que tambien hay que hacer funcional o quitar el placebo).

### Pieza 4 — Reporte de caidas y huerfanos
- Al detectar una cuenta que pasa a unauthorized/suspended: emitir evento de transicion
  (`oc.webdock.account_unhealthy` con accountId, httpStatus, timestamp) para tener timeline.
- Diff de servers: persistir ultimo snapshot por cuenta y, cuando una cuenta cae, reportar "N
  servers dejaron de verse; pueden seguir existiendo y cobrandose en el proveedor; no fueron
  eliminados". (Hoy desaparecen en items:[] sin aviso.)
- Correr `evaluateWebdockDrift` (o equivalente multi-cuenta) sobre `/v1/infrastructure/inventory`
  con TODAS las cuentas (hoy solo el legacy mono-cuenta), para que el warning de huerfanos sea real
  y no genere falsos positivos.
- Primitiva `prune`/`delete` en el sender-node store + accion firmada para limpiar huerfanos
  confirmados (hoy imposible: el store no borra).

## INVARIANTES
- Aditivo: no romper el flujo single-account ni el create/delete actual. Cuentas activas se
  comportan byte-identico.
- Toda mutacion (retirar cuenta, prune huerfano) pasa por ApprovalGate firmado; nada se ejecuta
  sin firma humana. Coherente con el diseno "panel read-only + mutaciones firmadas".
- NUNCA borrado fisico automatico; soft-retire reversible.

## DoD
- Una cuenta marcada `retired` desaparece del inventario, del conteo y del pool de creacion, sin
  tocar las activas (test).
- Un 401 produce status `unauthorized` distinguible de `suspended` (cuando se pueda sondear) y de
  `paused` (cuenta viva, VPS detenidos).
- El reporte lista cuentas caidas + huerfanos con su timeline, y el operador puede retirarlas con
  firma.
- Audit chain registra la transicion de salud y la baja.

## PENDIENTE DE DECISION (Juanes)
- ¿Soft-retire reversible o baja definitiva? ¿Quien decide suspended vs unauthorized (sondeo billing
  automatico o juicio humano)? ¿La baja libera el slot de env para reasignar (riesgo de mezclar
  identidades en logs/registry) o solo lo oculta?
