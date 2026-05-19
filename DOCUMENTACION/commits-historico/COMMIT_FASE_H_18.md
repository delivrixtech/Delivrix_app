# Commit Fase H.18 — Wave 2B: cablear 5 endpoints existentes

## Validar

```bash
cd apps/admin-panel
npx tsc --noEmit
node --test src/shared/api/client.test.ts src/shared/lib/formatters.test.ts src/shared/lib/domain-state-copy.test.ts
```

Resultado esperado: tsc verde, 15/15 tests pass.

## Commit

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
git add apps/admin-panel/src
git status
git commit -m "admin: Fase H.18 — Wave 2B, cablear 5 endpoints existentes

El gateway ya expone /v1/sender-nodes, /v1/ip-reputation/reports,
/v1/send-results, /v1/stuck-jobs y /v1/operational-summary pero el panel no
los consumía. Esta fase los suma al manifest, los tipa y reemplaza varios
slots hardcoded en Clústeres y Overview por datos reales.

Backend → tipos del frontend:
- /v1/sender-nodes → SenderNodeContract[] (wrap {nodes})
- /v1/ip-reputation/reports → IpReputationReport[] (wrap {reports})
- /v1/send-results → SendResult[] (wrap {results})
- /v1/stuck-jobs → StuckJobsPayload directo
- /v1/operational-summary → OperationalSummary (wrap {summary})

DashboardData ahora incluye senderNodes, ipReputationReports, sendResults,
stuckJobs y operationalSummary.

Cableado pantalla por pantalla:
- features/clusters/index.tsx
  · buildClusterRows derrita REP = promedio de scores de
    ipReputationReports asociados a sender nodes del cluster
  · total = suma de sendResults por sender node ('N envíos') o fallback a
    'N nodos' cuando no hay tráfico
  · counts act/cal/pau/deg/cua derivados de senderNodes[*].status real
  · KpiRow prefiere data.senderNodes.length sobre fallbacks
  · warming/quarantined desde operationalSummary.senderNodesByStatus
- features/overview/index.tsx
  · SystemHealthDark agrega fila 'Cola del worker' con jobsTotal del
    operationalSummary + stuckCount de stuckJobs (color cambia si > 0)
  · KpiRow toma sender total de data.senderNodes.length real

src/shared/api/client.test.ts actualiza el guard que enumera endpoints
aprobados a 22 entradas.

tsc --noEmit verde, 15/15 tests pass. Pantalla Clústeres ahora muestra:
- 3 clusters reales (manual-sender-node-cluster, proxmox-sender-node-cluster,
  webdock-sender-node-cluster) con providers reales.
- REP 60.0 / 85.0 / 63.3 derivadas del contrato (no 94.2/96.7/etc Pencil).
- Counts dinámicos por status del array senderNodes real.

Refs: HITO_5_10 Wave 2B; siguiente: H.19 cuando se aterricen los contratos
backend del BACKLOG_CONTRATOS_5_11.md."
```
