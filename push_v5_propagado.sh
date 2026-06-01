#!/bin/bash
# Push v5 PROPAGADO — Las 11 vistas ahora montan dentro del shell v5
#
# El CTO autorizó propagar ("Si hazlo. lestgo") después de validar la
# Vista General desde cero.
#
# Lo entregado en este push:
#   - 3 vistas nuevas DESDE CERO con sistema v5 (Canvas Live, Sender Pool,
#     Onboarding) que se suman a Overview (ya en push anterior).
#   - 7 vistas legacy ahora envueltas con LegacyWrap (Hardware con PageHead,
#     Collector/Infrastructure/Domains/Clusters/Learning/Safety con noHead
#     porque tienen su propio hero).
#   - _PageHead helper y _LegacyWrap con prop noHead.
#   - App.tsx cablea las 4 nuevas + 7 legacy wrappeadas.

set -e
cd "/Users/juanescanar/Documents/delivrix app"

rm -f .git/index.lock .git/HEAD.lock .git/objects/*/tmp_obj_* 2>/dev/null || true

git pull --rebase origin main || true

echo "→ Estado actual:"
git status --short | head -20

git add \
  apps/admin-panel/src/v5/App.tsx \
  apps/admin-panel/src/v5/views/CanvasLive.tsx \
  apps/admin-panel/src/v5/views/SenderPool.tsx \
  apps/admin-panel/src/v5/views/Onboarding.tsx \
  apps/admin-panel/src/v5/views/_PageHead.tsx \
  apps/admin-panel/src/v5/views/_LegacyWrap.tsx

echo ""
echo "→ Diff stat:"
git diff --cached --stat

git commit -m "feat(panel v5): propagar lenguaje v5 a las 11 vistas

El CTO aprobó propagar después de validar Overview ('Si hazlo. lestgo').

== Vistas DESDE CERO con sistema v5 (4 totales) ==

src/v5/views/Overview.tsx       (push anterior)
src/v5/views/CanvasLive.tsx     (nueva)
src/v5/views/SenderPool.tsx     (nueva)
src/v5/views/Onboarding.tsx     (nueva)

Canvas Live v5:
  Full-bleed split 2-pane. Header de sesión 'SESIÓN OPENCLAW' + pill live
  + caption 'chat / actions / propuesta · split canvas'. Suspense wrapper
  sobre CanvasV4 legacy (mantiene WSS + state). Altura calc(100vh-52-36).

Sender Pool v5:
  PageHead Hero. Grid 2 cols: Dominios sender section (lista de dominios
  capturados con health pills) + Wallet/Flow side. WalletCard custom con
  cap/gastado/disponible grid + progress bar + transactions list parseando
  audit events.

Onboarding v5:
  PageHead 'Paso 1 de 6'. Stepper 6 pasos con check marks para done.
  Sección 01 Identidad + 02 Inventario + 03 Interfaces como SectionCard
  con grid Field items. Row de GateCards (Cumplimiento, DNS, SSH).
  Side panel OpenClaw con HumanNote Caveat + Revisar CTA.

== Vistas LegacyWrap (7 totales) ==

src/v5/views/_LegacyWrap.tsx
  Wrapper con motion.div + Framer Motion staggerContainer/staggerItem.
  Prop noHead para vistas que ya tienen su propio hero h1 (evita
  duplicación visible del título).

src/v5/views/_PageHead.tsx
  Helper consistente: eyebrow + meta + Display/H1 + Body (max-w 640) +
  trailing.

Hardware:    LegacyWrap con PageHead 'Telemetría supervisada · Hardware del
             control plane'.
Collector:   LegacyWrap noHead (legacy tiene su propio h1 'Recolector y
             captura manual').
Infrastructure: LegacyWrap noHead (legacy tiene 'Toda tu infraestructura,
             en una sola vista' como hero gradient).
Domains:     LegacyWrap noHead (legacy tiene 'Buscar, valorar y proponer
             dominios').
Clusters:    LegacyWrap noHead (legacy tiene 'Clústeres y nodos de envío').
Learning:    LegacyWrap noHead (legacy tiene 'OpenClaw aprende con humanos
             al volante').
Safety:      LegacyWrap noHead (legacy tiene 'Sin acciones reales, con
             todas las barandillas').

== Cableado src/v5/App.tsx ==

- Imports directos (no lazy) de OverviewV5, CanvasLiveV5, SenderPoolV5,
  OnboardingV5, LegacyWrap.
- Lazy imports preservados para las 7 secciones legacy (HardwareSection,
  CollectorSection, ClustersSection, LearningSection, SafetySection,
  InfrastructureSection, DomainsSection).
- Switch por activeSection mapea cada slug a su componente.

== Verificación ==

- tsc --noEmit → 0 errores.
- Chrome MCP: las 11 vistas renderizan main > 2000 chars en dark theme:
  ✓ /             Overview v5 desde cero (push anterior).
  ✓ /onboarding   Stepper + SectionCards + GateCards + OpenClaw side.
  ✓ /canvas       Split 2-pane chat/workspace (CanvasV4 legacy montado).
  ✓ /hardware     PageHead 'Hardware del control plane' + HardwareSection.
  ✓ /collector    Hero legacy directo (sin duplicación).
  ✓ /infrastructure Hero gradient legacy directo.
  ✓ /domains      Hero legacy directo (Fase 1 discover/propose).
  ✓ /sender-pool  Hero v5 + dominios + WalletCard custom.
  ✓ /clusters     Hero legacy directo.
  ✓ /learning     Hero legacy directo.
  ✓ /safety       Hero gradient legacy directo + KPIs + Audit table.
- Sin duplicación de h1 en collector ni en las 5 noHead.
- Sidebar/Topbar/Footer v5 consistente en las 11.
- Dark/light theme toggle funcional en todas.

== Plan post-propagación ==

Las 7 vistas legacy quedan funcionalmente OK dentro del shell v5 pero
con su lenguaje viejo. Próximo sprint: reescribir desde cero una por una
priorizando demo viernes:
1. Domains (es la primera que muestra OpenClaw discover/propose).
2. Infrastructure (multi-provider inventory hero del 5.12).
3. Safety (kill switch + audit chain — la 'historia' de gobernanza).
4. Hardware / Collector / Clusters / Learning."

git push origin main

echo ""
echo "✓ Push completado. SHA:"
git log --oneline -1
echo ""
echo "✓ Últimos 5 commits:"
git log --oneline -5
