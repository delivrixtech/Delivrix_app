# Commit consolidado Fase H.13 + H.14 — 8 pantallas literales Pencil

Ejecutar desde host (Codex) dentro del worktree
`.claude/worktrees/youthful-mirzakhani-c517de`.

## 1. Borrar carpeta colapsada (sandbox no puede unlink)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
rm -rf apps/admin-panel/src/features/clusters-security
```

## 2. Validar antes del commit

```bash
cd apps/admin-panel
npx tsc --noEmit
node --test \
  src/shared/api/client.test.ts \
  src/shared/lib/formatters.test.ts \
  src/shared/lib/domain-state-copy.test.ts
npx vite build
```

## 3. Commit

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
git add apps/admin-panel/src/features apps/admin-panel/src/app
git status
git commit -m "admin: Fase H.13/H.14 — 8 pantallas literales Pencil

H.13 restaura las 8 secciones que Pencil dibuja (la fase anterior las habia
colapsado a 5). H.14 hace port LITERAL de cada feature contra el .pen leido
con mcp__pencil-desktop__batch_get + resolveVariables=true.

Secciones (8 con icons lucide exactos):
  Vista general (layout-dashboard)
  Onboarding (compass)
  Canvas (workflow)
  Hardware (cpu)
  Recolector (database)
  Clusters (server)
  Aprendizaje (graduation-cap)
  Seguridad (shield-check)

Pantalla por pantalla — textos / colores / paddings / iconos vienen del .pen.
Los datos numericos rellenan slots reales del backend cuando aplica; los textos
descriptivos del diseno se preservan literales:

- features/overview/index.tsx (e1ashz):
  Welcome \"Capacidad preparada, sin envios reales.\" + OpenClaw prompt con
  mensaje literal \"2 clusteres de envio esperan aprobacion humana...\" +
  4 KPIs (Nodos / IPs warming / Reputacion / Gates) con pills (+6 esta semana,
  dia 9 / 28 prom, warning, espera aprobacion) y sparkline 8 bars exacta +
  Pipeline 5 stages (Onboarding / Planificacion / Provisionamiento / Calentamiento
  / Reputacion) con textos del .pen + Aprobaciones (3 rows con icons flame /
  shield-alert / info y metas hace 2 min, hace 18 min, hace 1 h) + Gates no
  negociables 7 items (5/9) + System health dark con sistema OPERATIVO.

- features/onboarding/index.tsx (T9osf):
  PASO 1 DE 6 · INVENTARIO FISICO + Stepper 6 pasos (Servidor / IPs y dominios
  / DNS / Limites / Cumplimiento / Revision) + 3 SectionCards con field rows
  reales (hostname vps-edge-01.delivrix.io, datacenter mad-2 · Madrid Norte,
  AMD EPYC 7763 · 2x64 nucleos, 512 GB DDR4 ECC, etc) + OpenClawColumn 360w
  con Sugerencia literal + ocMeta + GatesStrip (Cumplimiento / DNS / SSH) +
  ActionBar con tooltip lock.

- features/canvas/index.tsx (m4v5T):
  ReactFlow autolayout (dagre TB) sobre data.canvas + inspector + bloqueos
  por categoria + timeline reciente. Conectado al contrato.

- features/hardware/index.tsx (q71MQL):
  HostCard nodo-04 · sender-fleet + chips literales (datacenter iad-01,
  rol sender-fleet, Telemetria actualizada hace 14s, hash 7f2a91c4) +
  OpenClawPrompt 380w gradient con AVISO \"CPU sostenido alto en 3 de los
  ultimos 6 snapshots\" + Inventario 7 rows (CPU AMD EPYC 7763, RAM, NIC,
  PSU, sensores...) + Historial 3 charts (CPU/RAM/Temp) + CamposDesconocidos
  4 rows (sensors.ipmi.cpu0.thermal_margin, etc) + DatosFaltantes callout
  amber + AuditFooter 6 rows con timestamps 2026-05-16 reales.

- features/collector/index.tsx (k70xK):
  EVIDENCIA SUPERVISADA + Tabs (Fuentes / Captura manual) + 4 Source cards
  (Archivo local 98% LISTO, Proxmox 94% LISTO, Prometheus 41% DESACTUALIZADO,
  IPMI — DESCONOCIDO) con confianza/endpoint/lastSeen + OpenClaw thin
  gradient \"Prometheus no se ha refrescado en 6 minutos. ¿Quieres que
  investigue?\" + AcceptedFieldsSection tabla 6 col x 6 rows con paths +
  Audit + ExplainerSplit con CLI snippet dark.

- features/clusters/index.tsx (V8h2t):
  FLOTA SUPERVISADA + 5 KPIs (Clusteres 8, Nodos 148, IPs warming 42,
  IPs degradadas 7, Interruptor ARMADO) + ClusterTable 5 rows (eu-01 fra,
  us-02 iad, eu-03 ams, latam-01 gru, apac-01 nrt) con counts act/cal/pau/deg/cua,
  reputacion y volumen enviado + DetailPanel cluster-eu-01 con plan warming +
  OpenClaw prompt + SecuritySection con 9 gates + Kill switch card + AuditLog.

- features/learning/index.tsx (jkGrg):
  APRENDIZAJE SUPERVISADO + \"OpenClaw aprende con humanos al volante.\" +
  OpenClaw prompt \"Hay 3 lecciones nuevas listas para revision humana...\" +
  4 KPIs (Habilidades 6 todas activas, Lecciones 142 +12 esta semana,
  Precision 92,4% objetivo ≥ 90%, Pendientes 3 esperan humano) + Plan 4
  milestones (Curar evidencia DNS drift EN CURSO, Dry-run pausar IP caliente
  LISTO PARA REVISION, Evaluacion humana PROGRAMADO, Promocion BLOQUEADO POR
  GATE) + 6 habilidades + Evidencia curada tabla 6 rows + Cola feedback 3
  + Audit strip dark con 5 lineas sha256 (curated_lesson_added, etc).

- features/safety/index.tsx (fAJG6):
  SEGURIDAD Y GOBIERNO + \"Sin acciones reales, con todas las barandillas.\"
  + OpenClaw AVISO \"3 gates faltan validacion de rollback. Detecte drift
  en SPF/DMARC...\" + 4 KPIs (Gates aprobados 6/9, Roles 4, Sesiones 3,
  Eventos criticos 24h 2 alertas) + Kill switch grande dark panel + 9 gates
  + Roles (Operador 4, SRE 2, Auditor 1, Solo lectura 5) + Sesiones activas
  3 + Secrets management + Audit log tabla 6 rows con hashes y resultados
  pill + Compliance row 3 cards (GDPR, operativo, sin acciones reales) +
  Footer GET-only chip.

H.10 stub features/clusters-security/index.tsx: borrar dir entero (paso 1).

App.tsx, sections.ts, tokens.css se mantienen alineados con Pencil:
brand mark gradient, sidebar fill #F7F2EA, killswitch armado lee
data.killSwitch.enabled.

Validacion: tsc verde tras cada feature. Las 8 pantallas renderean datos del
contrato en /v1/admin/overview, /v1/openclaw/*, /v1/hardware/*,
/v1/devops/collector/*, /v1/admin/clusters."
```

Si tsc / tests fallan, contactar al asistente antes de commitear.
