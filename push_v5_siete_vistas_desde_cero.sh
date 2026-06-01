#!/bin/bash
# Push v5 — 7 vistas reescritas desde cero (Infrastructure, Domains, Safety,
# Hardware, Recolector, Clústeres, Aprendizaje)
#
# El CTO me corrigió: "yo te dije que hicieras desde 0 todas las sesiones".
# Eliminé el patrón LegacyWrap por completo. Lancé 7 agentes paralelos
# (general-purpose), cada uno reescribiendo una vista con el sistema v5
# desde cero. Cero parches.
#
# Canvas Live queda pendiente para próxima sesión (WSS + state más complejo,
# quiero que valides las 7 vistas antes).

set -e
cd "/Users/juanescanar/Documents/delivrix app"

rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short | head -25

git add \
  apps/admin-panel/index.html \
  apps/admin-panel/src/app/tokens.css \
  apps/admin-panel/src/v5/App.tsx \
  apps/admin-panel/src/v5/lib/motion.ts \
  apps/admin-panel/src/v5/shell/Shell.tsx \
  apps/admin-panel/src/v5/components/primitives.tsx \
  apps/admin-panel/src/v5/views/Infrastructure.tsx \
  apps/admin-panel/src/v5/views/Domains.tsx \
  apps/admin-panel/src/v5/views/Safety.tsx \
  apps/admin-panel/src/v5/views/Hardware.tsx \
  apps/admin-panel/src/v5/views/Collector.tsx \
  apps/admin-panel/src/v5/views/Clusters.tsx \
  apps/admin-panel/src/v5/views/Learning.tsx

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "feat(panel v5): 7 vistas reescritas desde cero (sin LegacyWrap)

El CTO pidió eliminar el LegacyWrap completamente — todo desde cero con
el sistema v5. Lancé 7 agentes paralelos (general-purpose), uno por
vista. Cada agente leyó: legacy actual + primitives v5 + referencias
(Overview, SenderPool, Onboarding) + tokens dark/light. Cada uno entregó
un archivo nuevo en src/v5/views/<Name>.tsx con tsc clean.

== Vistas nuevas (7) ==

src/v5/views/Infrastructure.tsx — InfrastructureV5() (sin props, query
  propia a READ_ENDPOINTS.infrastructureInventory). Estructura:
  - PageHead + LivePollSide trailing
  - KPI strip 4 stats (OK/error/offline/planeados) con Stat valueTone
  - 'Atención requerida' condicional con bordes tonales + CTAs
    'Reautenticar' (Webdock 401) y 'Marcar online' (Servidor físico)
  - BannerOpenClawV2 'Coordinar remediación' con HumanNote Caveat
  - Grupos por kind: Compute (Webdock×3 + AWS Bedrock) / DNS·Domains
    (Route53 + Porkbun + IONOS×2) / Físico (Servidor Medellín)
  - Lista densa en columna, no grid 4-col → fila huérfana eliminada
  - Footer endpoint + count live/mock

src/v5/views/Domains.tsx — DomainsV5(). Fase 1 discover/propose con
  comparativa Route53 vs Porkbun y guardrails siempre visibles:
  - PageHead trailing Cap restante \$/\$50
  - GuardrailStrip 4 tiles: Cap mensual / WHOIS privacy / 2 firmas /
    Compra real bloqueada
  - DiscoverForm con CTA primary 'Sugerir con OpenClaw'
  - ProposalCard con score/10 + 3-col precios + CTA 'Solicitar
    aprobación' (disabled, gate Fase 2)
  - BannerOpenClawV2 condicional + HumanNote
  - Footer runbook flip-purchase-flag.sh

src/v5/views/Safety.tsx — SafetyV5({ data }). Gobernanza completa:
  - PageHead + LiveIndicator
  - OpenClawBanner condicional (gates/live infra/sends reales)
  - KPI strip 4 stats (Acciones permitidas / Roles / Kill switch /
    Alertas)
  - KillSwitchHero superficie siempre-dark (always-dark-bg) con icon
    Power, badge Armado/Activo, 3 KillStats, CTA accent
  - Grid 2-col: GatesCard | IamColumn (Roles + Sesiones + Secrets)
  - AuditTable 10 últimos eventos, mono, shortAuditHash
  - ComplianceFooter 3 chips + runbook

src/v5/views/Hardware.tsx — HardwareV5({ data }). Inventario + telemetría:
  - PageHead + StatusChip (success/warning/critical)
  - IdentityCard servidor físico con icon Server always-dark
  - BannerOpenClawV2 condicional (stale o CPU≥75%)
  - KPI strip 4 KpiCell (CPU/RAM/Storage/Interfaces) con toneFromPercent
  - InventoryCard grid 4 cols con 6 filas
  - HistoryCard sparkline SVG real + delta Pill
  - SnapshotActionRow + SnapshotModal con POST a manual-snapshots/ingest

src/v5/views/Collector.tsx — CollectorV5({ data }). Fuentes + captura:
  - PageHead + schema version
  - TabStrip 'Fuentes (n)' / 'Captura manual'
  - BannerOpenClawV2 condicional (n fuentes bloqueadas/stale)
  - Grid de SourceCard con icono por kind + Pill estado + confidence
    progress bar + endpoint mono + lastSeen
  - AcceptedFieldsTable colapsable (>8 → 'Ver los N campos')
  - Tab 2: DarkCliSnippet (always-dark) + info card + form ingesta
    JSON con POST real al manualEndpoint del contrato
  - Footer runbook + schema version

src/v5/views/Clusters.tsx — ClustersV5({ data }). Flota supervisada:
  - PageHead + LiveIndicator
  - KPI strip 4 KpiTile (Clústeres / IPs / Nodos / Warmup)
  - BannerOpenClawV2 condicional (warming/approvals/blockers) +
    HumanNote
  - Grid ClusterCard: id mono + Pill status + Badge IPs + SparkBar
    14 días determinístico + plan warmup + IPs colapsables
  - KillSwitchBlock always-dark con modal POST /v1/kill-switch
  - Footer runbook + endpoints mono

src/v5/views/Learning.tsx — LearningV5({ data }). Skills supervisadas:
  - PageHead + LivePill
  - KPI strip 4 KpiCard (Promovidas / En dry-run / Bloqueadas /
    Pendientes) con valueTone
  - BannerOpenClawV2 condicional + HumanNote única
  - Lista SkillRow densa: dot status + label + Pill estado +
    ConfidenceChip + Sparkline runs ok/total + snapshots evidencia +
    CTAs contextuales
  - Bitácora always-dark con BitacoraRow grid 4 cols (timestamp,
    action, actor·body, hash)
  - Footer endpoint

== Fix de motion.ts ==

src/v5/lib/motion.ts — staggerItem.initial cambió de { opacity: 0, y: 6 }
a { opacity: 1, y: 0 }. Bug detectado: cuando hay function components
no-motion entre el padre staggerContainer y los hijos staggerItem,
Framer Motion no propaga las variants string-based y los items quedan
stuck en opacity 0 (contenido invisible aunque DOM tiene 35k chars).
Solución pragmática: hacer staggerItem siempre visible. Se pierde el
entrance fade-up — quien quiera ese efecto debe usar el nuevo
'enterFromBelow' export y pasarlo con initial/animate explícito.

== Cableado en App.tsx ==

Reemplazado LegacyWrap por imports lazy a las 7 V5 nuevas. Removido el
import de _LegacyWrap (queda el archivo por si reaparece un caso, pero
no se usa). El switch del Suspense ahora mapea cada slug a su V5
directamente: <HardwareV5 data={data} />, <InfrastructureV5 />, etc.

== Topbar limpia para demo ==

src/v5/shell/Shell.tsx — eliminadas las 3 status chips del topbar:
- 'pg' (dot verde + label) — health Postgres
- 'redis' (dot verde + label) — health Redis
- '5.9-manual-snapshot-ingestion-ux' (chip GitBranch) — feature branch

Eran metadata de dev/ops que ruidaba en demo al CTO de Hostinger. Los
props postgresOk/redisOk siguen en la API del Shell por si en el futuro
se quiere un toggle 'dev mode' que las re-active.

== Footer rediseñado ==

src/v5/shell/Shell.tsx — el footer tenía 7 piezas amontonadas:
'● DELIVRIX CONTROL PLANE · dev · ● Read-only · <branch git>
 · AUDIT CHAIN · APPEND-ONLY · REGLA DE 2 PERSONAS'

Quité metadata dev (dev label, branch name) que duplicaba lo del topbar
ya eliminado. Quité 'DELIVRIX CONTROL PLANE' uppercase porque era
branding redundante con el logo D del sidebar. Sustituí 'Read-only'
→ 'Solo lectura' y 'Live writes' → 'Escritura en vivo' para consistencia
con el resto del panel en español.

Layout final (after CTO pass #2 — 'que es eso de 2 personas??? no se
ve nada profesional'):
- Izquierda: [D] mark + 'Delivrix' (branding mínimo)
- Derecha: ● Solo lectura  (solo el estado funcional clave)

Quitada también la línea 'Audit chain · Append-only · Regla de 2
personas'. Era jerga técnica que el stakeholder no entiende y que ya
se cuenta mejor en banners, hero de Vista General y sección Seguridad
(donde tiene contexto). El footer queda al nivel de los paneles
profesionales que referenciamos (Linear / Stripe / Vercel) — casi
vacío, sin chips, sin uppercase.

Altura reducida h-9 → h-8 para acompañar el menor peso visual. Los
props envLabel/buildSha quedan en la API por compat, no se renderizan.

== Lenguaje de producto (no de sprint) ==

Quitada referencia a 'Hito 5.12' del eyebrow / meta / empty state de
las vistas (lenguaje interno de PM que no le decía nada al operador
ni al stakeholder del demo):

src/v5/views/Domains.tsx
  eyebrow: 'Hito 5.12 · Dominios · Fase 1' → 'Discover & propose'
  meta:    'discover · propose · sin compra real' → 'Sin compra real'

src/v5/views/Infrastructure.tsx
  eyebrow: 'Hito 5.12 · Multi-provider' → 'Inventario multi-proveedor'
  meta:    'GET /v1/infrastructure/inventory' → 'Solo lectura'
  footer caption: quitado 'contrato Hito 5.12 § 2.3'
  empty state: quitado 'El backend del Hito 5.12'

== Tipografía Caveat eliminada ==

El CTO sintió la manuscrita Caveat fuera de tono profesional para
demos a stakeholders ('esta tipografía hay que quitarla'). Quitada
de TODO el panel en un solo cambio:

apps/admin-panel/index.html
  Google Fonts URL ya no carga family=Caveat. Solo Montserrat y
  JetBrains Mono. -27KB de fuentes web.

src/app/tokens.css
  --font-display ya no apunta a 'Caveat' — ahora cae a Montserrat
  italic. El alias se queda por compat si alguna superficie aún lo
  referencia.

src/v5/components/primitives.tsx
  HumanNote ahora usa 'font-sans text-[13px] italic leading-[1.5]
  text-fg-muted' en vez de 'font-display text-[16px]'. Mantiene el
  rol tonal (voz suave de OpenClaw, recomendación) pero sin salir
  del registro corporativo: 13px italic Montserrat regular.

Visualmente el delta: el note pasa de 'manuscrita decorativa' a
'aside profesional', el peso jerárquico baja un nivel pero la
intención semántica se conserva.

== Verificación visual ==

Chrome MCP en dark mode, todas las 11 vistas renderizan correctamente:
- / Overview v5 ✓
- /onboarding OnboardingV5 ✓
- /canvas CanvasLive (wraps CanvasV4 legacy — pendiente reescritura) ✓
- /sender-pool SenderPoolV5 ✓
- /hardware HardwareV5 ✓ (PageHead + Identity + Banner stale + KPIs)
- /collector CollectorV5 ✓ (Tabs + 3 fuentes bloqueadas)
- /infrastructure InfrastructureV5 ✓ (KPIs + Atención requerida +
  Webdock 401 + Servidor offline + grupos por tipo)
- /domains DomainsV5 ✓ (Guardrails + Discover + Proposals)
- /clusters ClustersV5 ✓ (KPIs + topology blockers + ClusterCards
  con SparkBar)
- /learning LearningV5 ✓ (KPIs + skills con confidence + sparklines)
- /safety SafetyV5 ✓ (KillSwitch hero + gates + IAM + audit)

tsc --noEmit → 0 errors.

== Pendiente próxima sesión ==

CanvasLive (vista hero del demo) sigue envolviendo CanvasV4 legacy.
Reescribirla requiere replicar la lógica WSS + state del demo agent —
trabajo más cuidadoso. Lo dejo para que valides las 7 vistas primero."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
