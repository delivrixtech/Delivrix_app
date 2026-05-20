# OPS — Cleanup 3 _FALLBACK restantes en admin panel

**Fecha:** 2026-05-20
**Worktree:** `feature/cleanup-fallbacks`
**Ejecutor:** Codex
**Decisor humano:** Juanes (operador)
**Esfuerzo estimado:** ~2-3 hrs

## 1. Contexto

Tras Ola 1 + Ola 2 real-time, el cleanup de hardcoded redujo de 5 arrays a 3 _FALLBACK. Estos 3 son defensa cuando los endpoints reales devuelven `[]`. Pero los endpoints SÍ existen — el cableo solo necesita activarlo correctamente.

## 2. Los 3 _FALLBACK

| Archivo | Línea | Const | Endpoint disponible |
|---|---|---|---|
| `apps/admin-panel/src/features/learning/index.tsx` | 643 | `SKILLS_FALLBACK` | `data.readinessSignals.recommendations` (ya parcialmente cableado L578) |
| `apps/admin-panel/src/features/onboarding/index.tsx` | 73 | `ONBOARDING_STEPS_FALLBACK` | `data.onboardingState` (`/v1/openclaw/onboarding/state`) |
| `apps/admin-panel/src/features/safety/index.tsx` | 841 | `AUDIT_ROWS_FALLBACK` | `data.auditEvents` (`/v1/audit-events` — siempre tiene 212+ eventos en MVP) |

## 3. Acción por archivo

### 3.1 `learning/index.tsx` SKILLS_FALLBACK

Hoy:
```tsx
{(skills.length > 0 ? skills : SKILLS_FALLBACK).map(...)}
```

Donde `skills = recs.slice(0, 6).map(...)` y `recs = data.readinessSignals.recommendations ?? []`.

**Si el endpoint readinessSignals devuelve [] sistemáticamente**, ese es el bug raíz — el endpoint debería tener data real. Verificar:
1. `curl http://localhost:3000/v1/openclaw/readiness-signals | jq '.recommendations | length'` — ¿devuelve > 0?
2. Si > 0 pero el panel sigue mostrando fallback, hay bug en el mapping.
3. Si = 0, el builder `buildOpenClawReadinessSignals` necesita data (puede ser que esté hardcoded a [] en alguna condición).

Si tras investigar el endpoint **no se puede llenar con data real**, mantener `SKILLS_FALLBACK` pero **mover los hex hardcoded del array a tokens** (los `#DCFCE7`, `#15803D`, etc. → tokens `$state-success-bg`, `$state-success`). Esto es parte de tokenization cleanup pero conviene hacerlo aquí también.

### 3.2 `onboarding/index.tsx` ONBOARDING_STEPS_FALLBACK

Endpoint `/v1/openclaw/onboarding/state` devuelve estado del onboarding. Verificar shape:
1. `curl http://localhost:3000/v1/openclaw/onboarding/state | jq` — qué tiene.
2. Si retorna lista de steps, mapearlo en `onboarding/index.tsx` consumiendo `data.onboardingState`.
3. Borrar el const `ONBOARDING_STEPS_FALLBACK` o renombrarlo a literal en caso de respuesta vacía explícita.

### 3.3 `safety/index.tsx` AUDIT_ROWS_FALLBACK

Endpoint `/v1/audit-events` siempre tiene data (212+ eventos en chain actual). El panel ya consume `data.auditEvents`. Verificar por qué cae a fallback:
1. `curl http://localhost:3000/v1/audit-events | jq '.events | length'` — > 0 confirmado.
2. Si el panel sigue mostrando fallback, revisar el filter/slice del componente safety que limita por tipo. Posiblemente el filter es muy restrictivo y devuelve [].

Fix sugerido: ajustar filter para que tome últimos N eventos sin filtrar por tipo demasiado estricto. O si la sección requiere tipos específicos, agregar fallback informativo "No hay eventos de tipo X en últimos 7 días" en vez de mock data.

## 4. Verificación

1. `npm test` + `npm run test:admin` verdes.
2. `npm run build` OK.
3. Smoke visual en panel local:
   - Learning → sección Skills muestra recommendations reales (no SKILLS_FALLBACK)
   - Onboarding → steps reales del estado del agente
   - Safety → audit rows reales con 212+ eventos disponibles
4. Test edge: si endpoint devuelve [], renderiza algo informativo (no fallback mock data).

## 5. Restricciones

- **No** tocar Ola 1 Safety realtime cards (compliance, iam roles, iam sessions) — esas ya están bien.
- **No** tocar Ola 2 Learning realtime cards (Bitácora, Evidencia) — esas ya están bien.
- **No** invadir scope tokenization cleanup (worktree separado) excepto el caso §3.1 si SKILLS_FALLBACK no se puede borrar.
- **No** modificar builders en `packages/domain/src/` excepto si hace falta un mapper helper.

## 6. Reporte esperado

```
PANEL CLEANUP FALLBACKS — implementado

learning SKILLS_FALLBACK: <borrado | mantenido con tokens>
onboarding ONBOARDING_STEPS_FALLBACK: <borrado | mantenido informativo>
safety AUDIT_ROWS_FALLBACK: <borrado | mantenido informativo>
tests: N/N verdes
build vite: OK
smoke visual: 3 features renderean data real

next action: operator review
```

## 7. Commits sugeridos

1. `docs: add panel cleanup fallbacks spec`
2. `fix(panel): wire Learning skills to readinessSignals recommendations`
3. `fix(panel): wire Onboarding steps to openclaw onboarding state`
4. `fix(panel): wire Safety audit rows to audit-events endpoint`
5. `chore(panel): replace fallback mock data with informative empty states`

## 8. Referencias

- Hito 5.11.C master: [3667932c-3b42-81e5-b815-d3b527d18f3c](https://www.notion.so/3667932c3b4281e5b815d3b527d18f3c)
- Tokenization cleanup (paralelo, evitar overlap): `DOCUMENTACION/OPS_PANEL_TOKENIZATION_CLEANUP.md`
- Read-boundary: `apps/admin-panel/src/shared/api/read-boundary.ts`
