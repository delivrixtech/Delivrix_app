# OPS Codex HOTFIX URGENT — Orquestador no emite canvas-live + diagnóstico stuck

**Fecha:** 2026-05-31 domingo 7:45 PM COT.
**Severidad:** P0 BLOQUEANTE Fase C smoke E2E.
**Owner:** Codex backend senior + sub-agente AI auditor en paralelo.
**PM:** Claude.

## Síntoma observado

Proposal `3f2fd6bd-cf31-4d1d-8d5d-3507c745f426` (configure_complete_smtp) firmada exitosamente:

```json
{
  "status": "executing",
  "signedAt": "2026-06-01T00:41:53.886Z",
  "executionOk": false,
  "outcome": null,
  "executionCompletedAt": null
}
```

Audit chain subió +16 events. Pero:

1. **Frontend Canvas Live** muestra `SIN PROPUESTA AÚN` + `API · SIN ACTIVIDAD` aunque hay actividad real backend.
2. **NO hay propuestas pendientes nuevas** en cascada (orquestador debería haber generado paso 2 `register_domain_route53` pero no aparece).
3. **Tareas listadas** muestran "OpenClaw, ejecuta Fase C" como `en curso · hace 22m` (sin progreso visible).

## Bug raíz a identificar (sub-agente AI auditor)

Investigar en paralelo:

### Sub-agente A — Orquestador `configure_complete_smtp`

Leer `apps/gateway-api/src/routes/orchestrator-smtp.ts` y trazar:
- ¿Llamó a `invokeSkill('suggest_safe_domain', ...)` post-firma?
- ¿Recibió respuesta o se quedó en await?
- ¿Generó la propuesta de step 2 (`submitProposal('register_domain_route53', ...)`)?
- ¿Hay try/catch silencioso que swallow errors?

### Sub-agente B — Canvas live emit

Leer `apps/gateway-api/src/services/canvas-live-events.ts` + `routes/orchestrator-smtp.ts` y verificar:
- ¿Orquestador llama `emitTaskUpdate`, `emitApiAction`, `emitFileAction` durante cada step?
- ¿`safeEmit` swallow errors? (recordatorio: `safeEmit` retorna `void` y catch silencioso — si emit falla, NO se entera)
- ¿Hay eventos canvas-live tipo `oc.orchestrator.step_started` definidos?

### Sub-agente C — WSS frontend

Leer `apps/admin-panel/src/features/canvas/canvas-live-client.ts` + `canvas-v4.tsx`:
- ¿Hay reconexión automática si WSS se cae?
- ¿El URL `/v1/canvas/live/stream` está bien conectado?
- ¿Filter por `taskId` o `agentId` puede estar excluyendo events del orquestador?

### Sub-agente D — Status endpoint

Leer `apps/gateway-api/src/routes/proposals-sign.ts`:
- ¿El status endpoint actualiza `outcome` en proposalsStore durante el run, o solo al final?
- ¿Hay polling del frontend que debería detectar status="executing"?

## Hotfix esperado

1. **Si A revela orquestador stuck en await sin timeout** → agregar timeout 60s por step + log explícito de cada step + emit canvas event antes/después.
2. **Si B revela emit silente** → cambiar `safeEmit` para que log el error a stderr al menos.
3. **Si C revela WSS desconectado** → reconexión automática + heartbeat ping.
4. **Si D revela falta de polling frontend** → frontend debe hacer polling /status cada 5s cuando hay propuesta `executing`.

## Tareas concretas

### TAREA 1 (P0) — Diagnosticar dónde está el orquestador

```bash
cd /tmp/delivrix-orchestrator-debug
git clone /Users/juanescanar/Documents/delivrix\ app .
git pull origin main

# Instrumentar orquestador con logs verbose
# Buscar TODOS los await del orquestador y agregar console.log antes/después con timestamps
# Restart gateway con instrumented version
# Esperar a que se ejecute la próxima propuesta master
# Revisar logs para identificar dónde stuck
```

### TAREA 2 (P0) — Fix emit canvas events del orquestador

El orquestador debe emitir:
- `oc.orchestrator.run_started` al inicio
- `oc.orchestrator.step_started` antes de cada step
- `oc.orchestrator.step_completed` después de cada step exitoso
- `oc.orchestrator.step_failed` si step falla
- `oc.orchestrator.run_completed` al final

Estos events alimentan canvas-live state que el frontend renderiza.

### TAREA 3 (P0) — Frontend polling fallback

Si WSS se cae o no recibe events, frontend debe hacer polling:
- `GET /v1/openclaw/proposals/{id}/status` cada 3s mientras hay propuesta `executing` visible
- `GET /v1/canvas/live/state` cada 5s
- Mostrar última actualización en UI con timestamp + spinner si más de 30s sin update

### TAREA 4 (Opcional, post-hotfix) — Mejorar safeEmit

Cambiar `safeEmit` para que loggee a stderr cuando emit falla:

```typescript
async function safeEmit(service, event) {
  if (!service) return;
  try {
    await service.emit(event);
  } catch (err) {
    console.error('[canvas-live] emit failed for event', event.type, err.message);
  }
}
```

## Sign-off requerido

- [ ] Sub-agentes A+B+C+D reportan findings al PM en menos de 20 min.
- [ ] Hotfix pusheado con SHA + tests verdes.
- [ ] Restart gateway + re-firma de nueva propuesta master → orquestador progresa visible en canvas live.
- [ ] Primer step (`suggest_safe_domain` o `register_domain_route53`) genera propuesta nueva en panel.
- [ ] PM Claude valida diff antes de merge.

## NO HACER

- NO matar el gateway corriendo el orquestador HOY hasta entender qué hizo (puede tener side-effects en curso). Si necesario matar, hacerlo después de capturar logs + workspace state.
- NO rollback al SHA pre-Fase B (8h de trabajo) — solo hotfix puntual al bug de sync.

---

— Claude PM
