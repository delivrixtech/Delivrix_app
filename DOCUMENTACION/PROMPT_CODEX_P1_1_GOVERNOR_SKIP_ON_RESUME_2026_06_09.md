# Codex — P1.1 (fix quirúrgico): el governor de creación NO debe bloquear un RESUME cuyo step 4 ya está hecho

> **Estado:** defecto confirmado leyendo el código real (Claude, 2026-06-09) en el commit P1 `7568c2b`. **No es un rediseño** — es un guard de ~5 líneas + 1 test. **Subagentes** (worker + auditor). NO tocar la lógica del governor ni el resto del flujo. Stop-and-report si algo no aplica limpio.

## El bug (verificado)
`ensureCreationBudgetForAccount` (`apps/gateway-api/src/routes/orchestrator-smtp.ts:2800`) se invoca en `:626` **incondicionalmente, ANTES** del `runMutatingStepWithState({ step: 4, skill: "create_webdock_server" })` de `:634`. Esa función **no recibe `runState`** y por eso **no sabe si el step 4 ya se completó**.

Consecuencia en un **resume**: el flujo lineal de `configureCompleteSmtp` se re-ejecuta de arriba abajo (cada `runMutatingStepWithState` hace skip-done internamente, pero el governor de `:626` es una llamada suelta y **vuelve a correr**). En el resume, el governor lee el inventario y **cuenta el VPS que esa misma corrida ya creó**; si la ventana está en el cap (p.ej. 4/24h), **bloquea el resume** — aunque el step 4 ya está hecho y el skip-done NO crearía nada. Resultado: una corrida que ya creó su server no puede terminar (steps 5-14) hasta que pase la ventana o se firme un override.

**Por qué es urgente:** P0 (commit `481406a`) hace que el FCrDNS del bind pueda quedar "pending" → la corrida necesita **resume**. Una corrida que creó su server (step 4) y quedó pending en el bind caería justo en este bloqueo si la ventana está llena. Es un falso-bloqueo de una corrida legítima.

## El fix (mínimo)
El governor debe **gatear solo cuando el step 4 realmente va a CREAR** un server. Si el step 4 ya está hecho (resume), **saltar el governor**.

1. **Pasar el estado de "step 4 hecho" a `ensureCreationBudgetForAccount`.** En el call site `:626`, pasar `runState` (o un booleano `stepAlreadyCompleted` derivado con la MISMA detección que usa `skipDoneStep` para considerar un step `done`). Confirmá cómo `skipDoneStep`/`runState` marcan un step como completado (revisá `SmtpRunState` ~`:278` y `skipDoneStep`) y reutilizá esa condición exacta — NO inventes una nueva.
2. **Guard al inicio de `ensureCreationBudgetForAccount`** (después del check de flag, antes de leer inventario): si el step 4 ya está `done` en `runState`, `return` temprano. **El guard es SOLO para `status === "done"`** — un step 4 `in_flight` con lease expirado SÍ puede re-ejecutar y crear de verdad (skipDoneStep devuelve null en ese caso), así que ahí el governor DEBE seguir gateando. Emitir audit `oc.orchestrator.creation_rate_skipped_resume` (info) — obligatorio, no silencioso: todos los demás caminos del governor auditan (allowed loguea, exceeded/read_failed auditan).
3. **No cambiar** nada más: la lógica de conteo/cap/fail-open/override/selector/no-op-flag queda **idéntica**. Solo se agrega el short-circuit de resume.

## PROHIBIDO
- Tocar `creation-rate-governor.ts` (el módulo puro está bien) salvo que necesites un tipo para el guard — preferí pasar el booleano desde el orquestador.
- Cambiar el comportamiento en una corrida **fresca** (step 4 NO hecho): ahí el governor debe seguir contando y gateando EXACTAMENTE como hoy.
- Tocar routing/dispatcher/idempotencia/rollback/warmup/selectSenderNode ni el flag/fail-mode.
- Re-introducir el doble-conteo o saltarte el gate en fresco.

## DoD
1. Worker + auditor (subagentes).
2. **Tests nuevos (los que faltan):** (a) resume con step 4 ya `done` + inventario en/por encima del cap → `ensureCreationBudgetForAccount` **NO bloquea**, la corrida procede a steps 5-14; (b) en **fresco** con la ventana en cap **sí** bloquea (no regresión del gate — ya existe test, verificá que sigue verde); (c) **step 4 `in_flight` con lease expirado + ventana en cap → el governor SÍ bloquea** (el guard NO debe saltar el gate en in_flight — ese camino re-crea de verdad). Reutilizá los fakes de `orchestrator-smtp.test.ts` que ya simulan `creationServers` + runState resumible.
3. Suite verde: `npm test` (debe subir de 934 con el test nuevo), panel `check`, `node --test` focal governor/orchestrator. `node --check`/gateway build verde. (tsc global rojo por deuda previa = no bloqueante.)
4. Commit atómico: "Skip creation-rate governor when step 4 already completed on resume (no false block)". Deploy: gateway restart + push `origin produ` (+ Hostinger si aplica).

## Contexto que debés saber (NO es parte de tu scope — no lo "arregles")
- `resolveCreationRateOverride` **NO está cableado en `main.ts`** (verificado 2026-06-09): en producción no existe camino de override — un bloqueo del governor es muro duro hasta que la ventana libere o se apague el flag. Eso hace P1.1 más urgente, pero cablear el override es **P1.2 aparte si el CTO lo pide** — NO lo agregues en este commit.
- Los docs v2.9/v2.5 dicen "override humano auditado" como si existiera operativamente; tampoco lo toques en P1.1.
- **Limitación conocida de P1.1 (aceptada, NO la resuelvas acá):** este guard solo cubre resume con el MISMO runId (steps persistidos). Un "resume" con runId NUEVO arranca con steps vacíos → el guard no aplica y el governor cuenta el server ya creado (el create en sí sería no-op por idempotencia de hostname en `webdock-servers.ts:240`, pero el gate corre antes). Cubrir eso requeriría matchear hostname contra inventario — decisión de diseño para P1.2/P2, fuera de este hotfix.
- Auditoría adversarial 2026-06-09 confirmó el invariante del guard contra 6 vectores (excepciones, status exótico, drift de hash, mutación concurrente in-process, robo de lock cross-process, rollback): con step 4 `done`, `skipDoneStep` retorna o lanza y `markRunStepInFlight` lanza `step_already_done` — el guard jamás habilita una creación sin gate.

## Reportá
SHA + EXIT tests + confirmación de: (a) en resume con step 4 hecho NO bloquea; (b) en fresco con ventana llena SÍ bloquea (gate intacto); (c) no tocaste el módulo puro ni el resto del flujo; (d) cómo detectaste "step 4 done" (misma condición que skipDoneStep). Pendiente QA-Juanes: un build real que cree server y luego resuma (p.ej. tras FCrDNS pending de P0) no debe quedar trabado por el governor.
