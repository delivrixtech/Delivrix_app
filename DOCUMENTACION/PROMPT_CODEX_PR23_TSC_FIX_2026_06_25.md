# PROMPT CODEX — Fix tsc PR #23 (tipo del setInterval del poller) ANTES de merge

Auditoria de PR #23 (4 subagentes focalizados, 2026-06-25) = MERGE-READY SIN BLOQUEANTES. Unico fix
antes de mergear: el claim "tsc gateway verde" NO reproduce. El PR introduce 6 errores de tipos NUEVOS,
TODOS en el poller nuevo. CERO impacto en runtime (node --check RC=0, focused 44/44 verdes, admin 70/70),
pero conviene cerrarlos para no normalizar deuda de tipos en un archivo nuevo y para honrar el claim.

ERRORES (verificados):
- `apps/gateway-api/src/infrastructure-health-poller.ts:55` TS2339 Property 'unref' does not exist on
  type 'number | IntervalHandle'.
- `apps/gateway-api/src/infrastructure-health-poller.ts:61` TS2322 return 'number | IntervalHandle' no
  asignable a 'IntervalHandle'.
- `apps/gateway-api/src/infrastructure-health-poller.test.ts:30,58,63,65` TS2349 "not callable"
  (cascada del tipo roto de arriba).

CAUSA RAIZ:
`const setIntervalImpl = deps.setIntervalFn ?? setInterval;` (poller ~linea 53). Bajo
`lib:["ES2024","DOM"]` + `@types/node` v25, el `setInterval` GLOBAL tiene un overload DOM que devuelve
`number`; el `??` ensancha el tipo de retorno a `number | IntervalHandle`, lo que rompe el `.unref?.()`
(:55) y el `return` tipado a `IntervalHandle` (:61). Los pollers existentes (main.ts:1243,
episodic-scratch-ttl.ts:76) llaman `setInterval(...).unref()` directo y NO disparan esto; el patron de
DI con `??` aliased es lo que lo introduce.

FIX (1 linea, tipar el fallback al shape esperado por deps.setIntervalFn):
  `const setIntervalImpl: SetIntervalFn = deps.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));`
(usar el tipo exacto que el poller declare para `deps.setIntervalFn` / `IntervalHandle`; el wrapper debe
devolver un handle con `.unref()`). Alternativa: castear el global a la firma del modulo.

DoD:
- `tsc -p apps/gateway-api/tsconfig.json --noEmit` SIN los 6 errores del poller (los ~120 ambientales
  por `@types/pg` ausente quedan y NO son del PR; opcional: agregar `@types/pg` a devDependencies para
  cerrarlos del todo y que el claim "tsc verde" sea reproducible).
- focused 44/44 + node --check + admin 70/70 siguen verdes. Scope limpio (sin .audit/config/state/runtime).

Los otros 2 hallazgos de la auditoria quedan como issues de seguimiento (NO bloquean, NO incluir aqui):
runbook label fallback de la propuesta de baja, y generalizar la auto-propuesta a VPS providers
(Contabo). Tras este fix, re-verifico y mergeo.
