# Decisión: skip Notion side-effect del Hito 5.11.B

Fecha: 2026-05-18
Decisor: Juanes (operador)
Audit: oc.scope.notion_deferred

## Decisión

Skipear el side-effect a Notion del set quirúrgico Hito 5.11.B. Mantener
las skills `delivrix-alert-ops` y `delivrix-report-ops` con su fallback
declarado: cuando `NOTION_API_KEY` no está presente, audit el motivo y
seguir funcional sin el side-effect.

## Razones

1. **Bloqueo de Notion**: el operador no es Workspace Owner del
   workspace Delivrix SMTP Operations donde viven Task Board, Bugs &
   Blockers y Daily Standup. Notion exige rol Owner para crear
   integrations internas con Token de acceso.
2. **Proyecto unipersonal**: hoy no hay equipo no-técnico que esté
   revisando Notion buscando alertas del agente. El operador (Juanes)
   es técnico y consume directamente el chat de OpenClaw + audit
   JSONL.
3. **MVP day ~19/30**: el cronograma tiene 11 días restantes con
   milestones críticos pendientes (drift-monitor + canvas.prompt,
   permissions pipeline HMAC, audit chain, runbooks). Notion no aporta
   a la demo del MVP.
4. **Capa 3 era valor agregado, no fundación**. Capa 2 (Gateway
   JSONL) sigue siendo la fuente de verdad para compliance y
   auditoría externa.

## Impacto en el cronograma

- **D+3 AM** queda funcionalmente cerrado con el plugin `alert-ops`
  cargado y su fallback honesto.
- **D+4 PM** (skill `delivrix-report-ops`) se ajusta para que el
  reporte diario salga como respuesta al chat de OpenClaw, no a Notion.
  Plugin se modifica para detectar `NOTION_API_KEY` ausente y omitir
  side-effect.
- **Doc 8 §8 Routing a Notion** queda como **futuro Hito 5.12** cuando
  el operador tenga rol Owner del workspace correcto o cuando crezca
  el equipo.

## Lo que NO cambia

- Plugin `alert-ops` queda cargado como está. Si en el futuro se
  inyecta `NOTION_API_KEY`, el side-effect se activa automáticamente
  sin redeploy.
- Audit local Capa 2 (Gateway JSONL) sigue capturando todos los
  eventos con `oc.skill.alert_ops.invoke`, `oc.skill.report_ops.invoke`
  con metadata completa.
- La doctrina de los 8 docs queda intacta. Doc 8 §8 sigue documentando
  el comportamiento esperado de Notion, solo que se posterga su
  implementación.

## Reactivación futura

Cuando el operador resuelva el rol Owner del workspace o cuando crezca
el equipo y haya gente no-técnica que consume Notion:

1. Crear integration `delivrix-openclaw-agent` desde la cuenta Owner.
2. Conectar a las 2 DBs (Bugs & Blockers, Daily Standup).
3. Inyectar `NOTION_API_KEY` al container OpenClaw (paso 3 del OPS
   original).
4. Reload del agente con `kill -HUP`.
5. Smoke real: pedir `alert-ops` con critical presente → tarjeta
   aparece en Notion.

Tiempo estimado de reactivación: ~5 minutos.
