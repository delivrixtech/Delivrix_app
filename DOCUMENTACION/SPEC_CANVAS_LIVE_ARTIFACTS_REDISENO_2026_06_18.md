# Canvas Live · Run Artifact — rediseño profesional (spec + auditoría)

Fecha: 2026-06-18 · Autor: Claude (frontend/QA visual) · Insumo: 5 seniors (research Artifacts, diseño visual, UX/UI, frontend, full-stack) · Prototipo: `PROTOTIPO_CANVAS_LIVE_ARTIFACTS_V2.html`.

## Veredicto honesto (mis errores en la v1)
La v1 era una **ficha post-mortem bonita de un solo run feliz**, no una herramienta de supervisión viva. Errores reales encontrados por los seniors:

**Diseño visual**
- **Off-brand:** usé verde como color de marca y propuse morado. Los tokens REALES de Delivrix (`apps/admin-panel/src/app/tokens.css`) son **monocromáticos**: superficies `#050505 / #141414 / #1A1A1A`, bordes `#262626 / #3A3A3A`, texto `#F5F5F5/#B5B5B5/#8A8A8A`, **acento blanco** `#FFFFFF`, y color SOLO para estado semántico. La v2 ya usa estos tokens.
- **El verde hacía 6 trabajos** (marca, acción primaria, success, live, code, valores). Ahora: blanco = acción/activo/foco; verde = SOLO success/salud; ámbar = running/gate; rojo = fallo; azul = DNS/técnico.
- **Type scale arbitrario** (16 tamaños, medios-puntos). Ahora: ~7 escalones, cero `.5px`. Tipografía real: **Funnel Sans** (no "Display"), Geist, IBM Plex Mono.
- `--text3` viejo (`#646C78`) fallaba contraste AA. Corregido a los tokens reales (`#8A8A8A`, pasa).
- Spacing fuera de grilla, 10 radios, tabla DNS sin header, badges duplicados, timeline plano. Todo normalizado en la v2 (grilla 4px, 4 radios, tabla con columnas reales, 2 primitivas de badge).

**UX (lo más grave)**
- **Solo existía el estado COMPLETADO.** El 90% del tiempo el operador mira un run **corriendo** — no estaba diseñado.
- **No existía el estado FALLIDO** (y en el panel real hubo un run "fallida"). Sin error, sin evidencia, sin recuperación.
- **No existía la APROBACIÓN** — siendo que el modelo de Delivrix es "1 firma → run autónomo" y `canvas-v4.tsx` real ya importa `ApprovalGate`.
- **No había navegación entre 38 runs.** Estaba clavado a uno.
- **"Raw = JSON" era el modelo equivocado.** El operador no quiere el `SmtpRunState` serializado; quiere **evidencia tipada** (request HTTP, comando+stdout, archivo+diff, audit+hash).

## Sistema visual corregido (tokens reales)
```
superficies  #050505 (canvas) · #141414 (surface) · #1A1A1A (card) · #202225 (hover)
bordes       #262626 (hairline) · #3A3A3A (elemento)
texto        #F5F5F5 · #B5B5B5 · #8A8A8A · #525252
acento       #FFFFFF (acción/activo/foco) sobre #0A0A0A
semántico    success #3FB950 · info #58A6FF · warn #E3B341 · error #F0696A  (SOLO estado)
tipografía   Funnel Sans (headings) · Geist (UI) · IBM Plex Mono (data)
escala       28/18/14/13/12/11 + mono 12 · spacing 4/8/12/16/20/24/32 · radios 6/8/10/12
elevación    bordes + inset highlight rgba(255,255,255,.035) (sin sombras pesadas)
```

## Modelo de experiencia (lo que cambió de fondo)
**Tres zonas, no dos:** Chat (colapsable) · **Run rail** (lista de 38 runs ordenada por *prioridad de atención*: fallido → esperando firma → corriendo → completado, con dominio/estado/paso/edad y filtros) · Viewport del artifact (expandible).

**El viewport es estado-aware** (un renderer por estado, como Artifacts despacha por `type`):

| Estado | Qué muestra | Acción |
|---|---|---|
| running (default) | barra de progreso, paso activo con halo + sub-acción viva, datos pendientes como skeletons, **costo/budget**, gates marcados ("esperar es normal") | Pausar / Abortar |
| awaiting_approval | **tarjeta de plan firmable** (provider, dominio, budget, pasos, recipient) | Aprobar y firmar / Editar / Rechazar |
| failed | banner rojo (paso N · skill · razón) + **evidencia del fallo** (stderr/audit) + aviso de recursos | Reintentar (nuevo runId+firma) / Cambiar cuenta / Logs |
| completed | ficha completa: identidad, zona DNS (tabla real), DKIM (fila colapsada), reputación con timestamp+fuente, smoke test | Exportar / .md |

**Toggle Vista / Evidence** (no "Raw/JSON"): Vista = ficha renderizada; Evidence = feed tipado de acciones (api/command/file/audit). El JSON crudo queda como un "copiar estado" secundario.

**Patrones de Artifacts aplicados:** render-por-default (raw escondido), identidad estable por `runId`, un renderer por tipo de estado, evidencia accionable in-panel (los botones arman el mensaje al agente, cero bash al operador), chat↔artifact con chips clicables que seleccionan el run.

## Los cables (plan para Codex — backend)
Root cause de "todo es mock/JSON": el run se aplana en **una** función.

1. **Truncamiento #1 (root cause):** `apps/gateway-api/src/routes/orchestrator-smtp.ts:1339` `smtpRunStateToProgress` proyecta `SmtpRunState` a solo `{step, skill, status}`. Dominio, IP, smtpHost, **DKIM público**, registros DNS, delivery — todo existe en disco (`inventory/smtp-runs/<runId>.json`) y se descarta acá. **Fix:** poblar un objeto `identity` desde `state` (es lectura, los datos ya están en memoria).
2. **Contrato:** `packages/domain/src/canvas-live.ts:182` `CanvasLiveRunProgress` no tiene dónde poner lo rico. **Fix:** agregar `identity?` + campos por step (`label/startedAt/completedAt/durationMs/error`), todos **opcionales** (backward-compat). Reusa el canal `progress[]` que ya fluye por snapshot + WSS → cero plumbing nuevo de transporte.
3. **Redacción:** pasar `identity` por el sanitizador existente (`canvas-live-events.ts` allowlist). El DKIM **público** es un TXT, no secreto; validar que la privada no se cuele (ya están separadas en `smtp-provisioning.ts:450`).
4. **Artifact de chat (opcional, 2ª iteración):** `extractOpenClawArtifact` está construido y cableado SOLO al bridge SSH muerto (`openclaw-chat.ts:958`). El bridge de producción (Bedrock) nunca emite `oc.artifact.*`. **Fix:** portar la materialización al bridge Bedrock en la rama de respuesta final (`openclaw-bedrock-bridge.ts:397-421`), ~30 líneas reusando el extractor ya testeado.
5. **Workspace API:** `/v1/openclaw/workspace/tree|file` es real y read-only pero el panel usa mock y `inventory/` no está en la allowlist. **Fix:** enchufar el panel Files al API real.

**Recomendación:** Cambios 1+2 primero (80% del valor, bajo riesgo, reusa canal existente → desbloquea identidad+duración+DKIM+DNS+delivery). Artifact dedicado streameado (3-4) como 2ª capa.

## Reparto
- **Claude (frontend):** porto la v2 a componentes React reales en `features/canvas/` con los tokens/`shared/ui/v2` existentes (renderers por estado, rail, evidence, tabla DNS, ficha). QA visual.
- **Codex (backend):** los cables (truncamiento + contrato + redacción + emisión). Brief aparte si lo aprobás.

## Referencias (archivo:línea)
- Contrato/estados/aprobación: `packages/domain/src/canvas-live.ts`
- Proyección que trunca: `apps/gateway-api/src/routes/orchestrator-smtp.ts:1339`
- Progreso/gates vivos: `apps/admin-panel/src/features/canvas/smtp-live-progress.ts`
- Panel real (importa ApprovalGate/Maximize2/LiveTool): `apps/admin-panel/src/features/canvas/canvas-v4.tsx`
- Tokens reales: `apps/admin-panel/src/app/tokens.css`
