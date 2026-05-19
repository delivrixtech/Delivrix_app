# Commit Fase H.16 — Wave 2A: audit events reales

Ejecutar desde host (Codex) en el worktree
`.claude/worktrees/youthful-mirzakhani-c517de`.

## Validar

```bash
cd apps/admin-panel
npx tsc --noEmit
node --test src/shared/api/client.test.ts src/shared/lib/formatters.test.ts src/shared/lib/domain-state-copy.test.ts
# build opcional
npx vite build
```

Resultado esperado:
- tsc verde
- 15/15 tests pass
- build con advertencia de chunk grande (esperable)

## Commit

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
git add apps/admin-panel/src/shared apps/admin-panel/src/features DOCUMENTACION/BACKLOG_CONTRATOS_5_11.md
git status
git commit -m "admin: Fase H.16 — Wave 2A, audit events reales en 5 pantallas

El panel consumía el endpoint /v1/admin/overview que trae los 5 audit events
más recientes embebidos, pero las pantallas Hardware, Recolector, Aprendizaje
y Seguridad tenían tablas de audit hardcoded con timestamps falsos.

Esta fase cablea el endpoint dedicado /v1/audit-events que el gateway ya
expone (auditLog.list()) y elimina las filas hardcoded:

- shared/api/read-boundary.ts agrega auditEvents al manifest GET-only.
- shared/api/client.ts tipa AuditEvent, AuditEventsPayload, AuditActorType,
  AuditRiskLevel y los suma a DashboardData.auditEvents.
- shared/api/client.test.ts actualiza el guard que enumera endpoints aprobados.
- shared/lib/formatters.ts agrega filterAuditEvents(events, keywords, limit),
  formatTimeOnly, formatDateTimeIso y shortAuditHash.
- features/hardware/index.tsx · AuditFooter ahora lee filterAuditEvents con
  keywords [physical-host, hardware, telemetry, snapshot, collector] y muestra
  empty state honesto cuando el backend no registra eventos de hardware.
- features/collector/index.tsx · AuditSection con keywords [collector,
  snapshot, source, manual_snapshot, ingestion, supervised].
- features/learning/index.tsx · Audit strip dark con keywords [openclaw,
  learning, lesson, skill, evaluation, feedback, promote]; muestra mensaje
  cuando el contrato no expone audit de aprendizaje todavía.
- features/safety/index.tsx · Audit log con keywords [kill_switch, gate,
  role, permission, approval, denied]; mapea riskLevel del audit al pill
  color del diseño.
- features/clusters/index.tsx · AuditLogCard del side pane filtra por
  [cluster, sender_node, provisioning, topology, warming, reputation].

Adicional:
- DOCUMENTACION/BACKLOG_CONTRATOS_5_11.md documenta 8 contratos backend
  pendientes (IAM, compliance, hardware audit filter, OpenClaw skills audit,
  onboarding knownInputs detallado, sender nodes detallados, operational
  summary deltas, suppression list panel) para Hito 5.11. Cada item incluye
  shape sugerido, origen probable y bloqueador.

tsc --noEmit verde, 15/15 tests pass. Las 5 secciones renderizan audit log
real del gateway en lugar de los timestamps 2026-05-16 hardcoded del .pen.

Refs: HITO_5_10 (Wave 2A), futuro HITO_5_11_BACKEND_CONTRACTS_SHRINK."
```

Si tsc o tests fallan, abrir un canal con el asistente antes del commit.
