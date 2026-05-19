# COMMIT FASE H.20 — Wave 3A: backend mocks IAM + compliance + evidence

## Resumen

Cierra el último wave de Hito 5.10 frontend: cablea las 3 secciones que aún
mostraban placeholders hardcoded (Roles · Sesiones · Compliance row · Audit
strip de aprendizaje · Evidencia curada) a 5 contratos GET-only nuevos del
gateway. Sin esto, el panel mostraba datos estáticos en pantallas que el norte
operativo declara como auditables.

## Cambios

### Domain (`packages/domain/src/*`)
- `iam-supervised.ts` (nuevo): tipos `IamRole` / `IamSession` + `buildIamRoles()`,
  `buildIamSessions()`. 4 roles canónicos (Operador, SRE, Auditor externo, Sólo
  lectura) y 3 sesiones representativas con `lastSeenAt` relativo.
- `compliance-status.ts` (nuevo): 3 controles canónicos (GDPR, operativo,
  sin acciones reales) con estados y runbookRef.
- `openclaw-skills-audit.ts` (nuevo): `buildOpenClawSkillsAudit()` (5 eventos
  con hashes sha256:fa07…, 33de…, 7d41…, 1c92…, b0f1…) y `buildOpenClawEvidence()`
  (6 snapshots curados).
- `index.ts`: exporta los 3 módulos nuevos.

### Gateway (`apps/gateway-api/src/main.ts`)
- 5 nuevos handlers GET, todos dentro del read-boundary del MVP:
  - `GET /v1/iam/roles`         → `buildIamRoles()`
  - `GET /v1/iam/sessions`      → `buildIamSessions()`
  - `GET /v1/compliance/status` → `buildComplianceStatus()`
  - `GET /v1/openclaw/skills/audit` → `buildOpenClawSkillsAudit()`
  - `GET /v1/openclaw/evidence` → `buildOpenClawEvidence()`

### Admin panel (`apps/admin-panel/src/*`)
- `shared/api/read-boundary.ts`: agrega los 5 endpoints (ya en disco).
- `shared/api/client.ts`: tipos `IamRole`, `IamSession`, `ComplianceControl`,
  `OpenClawSkillsAuditEvent`, `OpenClawEvidenceItem` + 5 nuevos campos en
  `DashboardData` + parallel fetch en `loadDashboardData()`.
- `shared/api/client.test.ts`: guard enumera 27 endpoints (15/15 tests pass).
- `features/safety/index.tsx`: `RolesCard`, `SesionesCard` y `ComplianceRow`
  consumen `data.iamRoles`, `data.iamSessions`, `data.complianceControls`.
- `features/learning/index.tsx`:
  - `buildLearningAuditLines()` prefiere `data.openClawSkillsAudit`.
  - `EvidenciaCurada({ data })` mapea `data.openClawEvidence` → tabla
    (snapshotId · type · description · actor · capturedAt · mode · impact).

## Validación local (sandbox)

```
npm test                                       # 138 / 138 ok
cd apps/admin-panel && npx tsc --noEmit        # 0 errores
node --test src/shared/api/client.test.ts \
            src/shared/lib/formatters.test.ts \
            src/shared/lib/domain-state-copy.test.ts   # 15 / 15 ok

# Smoke en runtime contra los 5 endpoints nuevos
GATEWAY_PORT=3399 node apps/gateway-api/src/main.ts &
curl -s http://127.0.0.1:3399/v1/iam/roles | jq .roles[0]
curl -s http://127.0.0.1:3399/v1/iam/sessions | jq .sessions[0]
curl -s http://127.0.0.1:3399/v1/compliance/status | jq .controls[0]
curl -s http://127.0.0.1:3399/v1/openclaw/skills/audit | jq .events[0]
curl -s http://127.0.0.1:3399/v1/openclaw/evidence | jq .curated[0]
```

`vite build` no se ejecuta en el sandbox por la limitación FUSE de unlink en
`prepareOutDir`; transformó 2035 módulos antes de fallar al borrar el dist
previo. Correr en host.

## Comando de commit (Codex en host)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"

# Limpia dist previo y compila build real
rm -rf apps/admin-panel/dist
npm test
npm --workspace @delivrix/admin-panel run check

git add \
  packages/domain/src/iam-supervised.ts \
  packages/domain/src/compliance-status.ts \
  packages/domain/src/openclaw-skills-audit.ts \
  packages/domain/src/index.ts \
  apps/gateway-api/src/main.ts \
  apps/admin-panel/src/shared/api/read-boundary.ts \
  apps/admin-panel/src/shared/api/client.ts \
  apps/admin-panel/src/shared/api/client.test.ts \
  apps/admin-panel/src/features/safety/index.tsx \
  apps/admin-panel/src/features/learning/index.tsx \
  COMMIT_FASE_H_20.md

git commit -m "feat(panel): cablear IAM, compliance y evidencia OpenClaw a contratos GET-only

- Nuevos contratos en domain: iam-supervised, compliance-status,
  openclaw-skills-audit. Datos canónicos del MVP, no aleatorios.
- 5 nuevos handlers GET en gateway-api dentro del read-boundary:
  /v1/iam/roles, /v1/iam/sessions, /v1/compliance/status,
  /v1/openclaw/skills/audit, /v1/openclaw/evidence.
- Admin panel: read-boundary, client, parallel fetch y tests guard
  cubren 27 endpoints. Safety y Learning consumen los nuevos campos
  de DashboardData; eliminan placeholders hardcoded.
- 15/15 admin-panel tests · 138/138 domain tests · tsc clean.

Refs: Hito 5.10 Wave 3A · cierra placeholders en Seguridad y
Aprendizaje supervisado.
"
```
