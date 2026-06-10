# Codex — FASE 2.5 (OPCIONAL / hardening futuro — NO prerequisito): cerrar el flanco teórico del run-lock cross-proceso

> **LEER PRIMERO — esto NO es urgente y NO bloquea el run fresco.** Una re-auditoría (3 subagentes) concluyó que el "robo-de-lock" **NO es alcanzable en el deployment actual** y **NO causa doble-efecto real**:
> - Hay un **lock in-process** (`smtpRunLocalLocks` Map, `orchestrator-smtp.ts:257,877-878`) que rechaza cualquier 2ª invocación del mismo runId en el mismo proceso al instante, sin mirar el lease. El file-lock con el lease de 40 min solo importa **cross-proceso** (2 gateways / restart-a-mitad), y hoy el gateway es **single-process** (sin cluster/PM2/workers).
> - El step que puede vivir >45 min es **`wait_warmup_initial` (step 13), que es READ-ONLY** (re-ejecutarlo es no-op). Todos los steps mutantes son idempotentes provider-side (register=owned $0 bajo `withRoute53MonthSpendLock`, create=reuse, send=idempotencyKey, warmup=already_started).
> - Un run fresco real dura ~2-3 min de trabajo; nunca cruza los 40 min en la práctica.
> **Conclusión: el run fresco es seguro HOY sin este fix.** Hacé este 2.5 solo cuando haya riesgo real (p.ej. futuro multi-gateway/replicas) o como higiene. **Si se hace, usar Opción C — NO el heartbeat** (el heartbeat tocaba el corazón de la máquina 2.2, con timers y mayor blast radius, descartado).
> **Base:** `produ` `e8fa705`. Rama `codex/fase2.5-lock-leaseuntil`. Subagentes + Auditor. Scope-fence MÍNIMO. Stop-and-report.

## Bug (real pero no-alcanzable hoy)
`smtpRunFileLockExpired` (`orchestrator-smtp.ts:948-955`) chequea expiración contra el **`mtimeMs` del lockDir** (congelado al crear), NO contra el `leaseUntil` que se escribe en `lease.json` (`:926`). Con `smtpRunStateLockLeaseMs=40min` (`:253`) < duración de un run que cruce esperas largas, un segundo PROCESO vería el lock "expirado" y lo robaría (`:936-939`). El step-lease (45min, `:254`) es backstop por-step pero no defiende el run-lock.

## FIX — Opción C (mínima, causa-raíz, bajo blast-radius)
1. **`smtpRunFileLockExpired`: leer `leaseUntil` del `lease.json`, no el mtime.** Parsear `lease.json` del lockDir, comparar `now > Date.parse(leaseUntil)`. Si el archivo falta/corrupto/sin `leaseUntil` legible → tratar como **expirado/liberable** (`return true`) para que un lockDir huérfano no quede trancado para siempre. Esto corrige la causa-raíz (chequear el campo correcto) y vuelve el lock **auto-recuperable** tras crash.
2. **Subir `smtpRunStateLockLeaseMs` (`:253`) de 40 → ~120 min** (worst-case real: registro 30 + propagaciones + warmup, con holgura; NO 3h). Y **mantener `smtpRunStepLeaseMs` (`:254`) ≥ run-lock-lease** (subir a ~135 min) para que el step-lease siga siendo barrera y el invariante sea `step-lease ≥ run-lock-lease ≥ worst-case-run`.
3. (Opcional, defensa en profundidad) **cleanup de `inventory/.locks/` al boot del gateway**: barrer lockDirs cuyo `leaseUntil` ya pasó. No es necesario con (1) (se auto-expiran), pero limpia huérfanos al arranque.

## NO TOCAR (lo confirmó la re-auditoría)
- **NO** heartbeat / timers / renovación periódica del lease (descartado: toca el core, nuevos modos de falla).
- **NO** `acquireSmtpRunStateLock` (`:870-909`), el Map in-process, ni el release en `finally` (`:864-866`).
- **NO** la lógica del step-lease en `markRunStepInFlight`/`findResumableStep` (`:1470-1520`): ya lee `leaseUntil` correctamente — solo cambia el VALOR de la constante.
- **NO** `withRoute53MonthSpendLock` (`domains-purchase.ts:1067`): otro lock, fuera de scope.
- **NO** la espera de registro de Fase 2.4 (correcta), ni PTR/selector/underscore/resume, ni Hostinger.

## Tests (node:test)
- **Expiración por `leaseUntil`:** lockDir con `leaseUntil` pasado → liberable; lockDir sin `lease.json` legible → liberable; lockDir con `leaseUntil` futuro → NO liberable (bloquea). (Hoy NO existe; el test actual solo mira constantes.)
- **Robo cross-proceso simulado:** con `leaseUntil` vigente, una 2ª "invocación" (simular otro proceso) NO roba; con `leaseUntil` pasado SÍ (crash recovery).
- **Actualizar `orchestrator-smtp.test.ts:1060-1093`** a los nuevos valores (run-lock 120 / step 135), manteniendo `stepLease ≥ runLease`.
- No-regresión: "blocks concurrent runs" (Map in-process) sigue verde; resume controlcorpfiling v2 OK; Fase 2.1-2.4 verdes. (El flake `approval-token.test.ts` `/private/tmp` es ambiental, ignorar.)

## Deploy
Código → local + produ + FF. **Push de produ a origin/produ** (la verificación notó produ local ahead +46). Sin cambio de prompt → Hostinger no se toca.

## Hecho cuando
El run-lock expira por `leaseUntil` (no mtime), un lockDir huérfano es auto-liberable, el lease cubre el worst-case real (120 min) con step-lease ≥ run-lock-lease, y el test de expiración (hoy inexistente) pasa de verdad — todo sin heartbeat ni tocar el core del lock. **Recordá: esto es hardening; el run fresco no lo espera.**
