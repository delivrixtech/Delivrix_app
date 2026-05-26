# Auditoría panel admin — 2026-05-26

**Estado global:** 85% creíble. Canvas v4 + Overview + Safety consolidados. Learning/Collector en transición a real-time. **6 P0 críticos** + 12 P1 que degradan UX + 8 P2 polish.

---

## Top 6 P0 — bloquean confianza del operador

| # | Archivo | Gap | Fix |
|---|---|---|---|
| 1 | `overview/index.tsx` ~L700 | ApprovalRow renderiza IDs crudos (`warming_gate`, `dns_drift`, `ssh_gate`) sin humanizar | Aplicar `humanize(id)` en title prop |
| 2 | `onboarding/index.tsx` ~L200 | Form display-only pero UI sugiere editable | Overlay readonly + chips "Solo lectura" sobre FieldRow |
| 3 | `clusters/index.tsx` ~L150 | LiveIndicator timestamp hardcoded "hace 14s" desde mount, no refleja último fetch | Usar `data.operationalSummary.lastUpdatedAt` |
| 4 | `canvas/canvas-v4.tsx` ~L300 | Tabs Terminal/Diff/Files con mock data, confunden operador | Empty state explícito "Mock data MVP · backend Fase 2" |
| 5 | `safety/index.tsx` ~L120 | LiveIndicator countdown inicia desde mount, no del último fetch real | Usar `data.safetyRealtime.lastUpdatedAt` |
| 6 | `infrastructure/index.tsx` ~L450 | `brandName()` heurística string-matching frágil si backend renames slugs | Agregar `providerType` enum al contrato + lookup |

---

## Por feature (10 secciones)

### Overview
**Función:** dashboard raíz · 4 KPIs (Nodos/Warming/Reputación/Gates) + Pipeline 5 stages + Aprobaciones pendientes + System Health.
**Estado:** live + parcial.
**Endpoints:** sender-nodes, operational-summary, send-results, operating-north, ip-reputation/reports.
**Botones:** "Abrir canvas" cableado · BannerOpenClawV2 CTAs huérfanos.
**Gaps:** ApprovalRow IDs crudos (P0), Gate counter sin feedback live degradación (P0), KPI tooltips overflow mobile (P1), Pipeline chevrons hidden md:flex sin sustituto (P1).
**Prioridad:** P0.

### Onboarding
**Función:** wizard 6 pasos + 3 form cards + OpenClaw side column + Gates strip + ActionBar.
**Estado:** parcial live.
**Endpoints:** openclaw/onboarding/state, manual-snapshots/ingest.
**Botones:** Exportar JSON ✓, Refrescar ✓, Solicitar evaluación POST ✓ (disabled si hay blockers), BannerOpenClawV2 huérfanos.
**Gaps:** Form aparenta editable pero es readonly (P0), BlockersList sin enum detalles (P0), GateCard iconos de "peligro" para DNS/SSH (P1).
**Prioridad:** P0.

### Canvas (5 tabs detalladas abajo)
**Función:** agent-in-action viewport con tabs Live/Files/Terminal/Diff/Topología.
**Estado:** Live tab real-time real. Files/Terminal/Diff stub. Topología stub polished.
**Endpoints:** openclaw/live-canvas (poll 5s), WSS /openclaw/canvas/stream, audit-events.
**Botones:** 5 tabs cableados, Approve/Reject POST funcional, cluster selector, time range, zoom.
**Gaps:** Stubs en 3 tabs confunden (P0), topología overlap mobile (P0), filter sin feedback visual (P1), JSON raw sin formatter (P2).
**Prioridad:** P0.

### Hardware
**Función:** telemetría servidor físico · HostCard hero + Inventario 7 rows + Historial 3 charts + AuditFooter.
**Estado:** live + parcial fallback.
**Endpoints:** sender-nodes, telemetry/cpu|memory|temperature, manual-snapshots/ingest.
**Botones:** "Solicitar snapshot manual" modal POST ✓, OpenClaw CTAs huérfanos.
**Gaps:** "Datos faltantes" impact heurístico count×3 sin contract base (P0), ManualSnapshotModal JSON help inline sin docs link (P0), charts fallback bars genéricas (P1), Hash chip pseudo-hash (`#cpu—`) (P1).
**Prioridad:** P0.

### Collector
**Función:** fuentes supervisadas + captura manual + accepted fields tabla + audit.
**Estado:** parcial live.
**Endpoints:** supervised-collector/sources, snapshot-ingestion/accepted-fields, manual-snapshots/ingest.
**Botones:** tabs cableados, ingestar snapshot POST ✓, copy CLI clipboard ✓, BannerOpenClawV2 huérfanos.
**Gaps:** Tabs tight spacing mobile <640px (P1), status color mapping hardcoded (P1), accepted-fields tabla sin scroll indicator mobile (P2).
**Prioridad:** P1.

### Clusters
**Función:** flota envíos · KPI row 5 + tabla 9 cols + DetailPanel + SecuritySection (Gates 9 + KillSwitch).
**Estado:** live + derivado.
**Endpoints:** admin/clusters, sender-nodes, send-results, ip-reputation/reports, kill-switch.
**Botones:** rows clickables, KillSwitch modal con regla 2 personas ✓, GatesCard dinámica.
**Gaps:** Hero timestamp hardcoded (P0), Kill switch KPI value size 24px vs 32px estándar (P0), reputation chart bars fake (P1), humanize() no cubre todos snake_case 90+ chars (P1).
**Prioridad:** P0.

### Learning
**Función:** aprendizaje supervisado · 4 KPIs + Plan/Skills + Evidencia 7 cols + Cola feedback + AuditStrip.
**Estado:** parcial real-time (poll 30s).
**Endpoints:** openclaw/skills-audit, openclaw/evidence.
**Botones:** BannerOpenClawV2 huérfanos.
**Gaps:** EvidenciaCurada empty state genérico (P1), AuditStrip `shortAuditHash()` sin explicación (P1), ColaRetroalimentacion 3 sugerencias hardcoded (P2).
**Prioridad:** P1.

### Safety
**Función:** seguridad y gobierno · 4 KPIs + KillSwitchGrande + Gates + IAM + Sessions + Secrets + Compliance + Audit.
**Estado:** live + realtime pulse.
**Endpoints:** operating-north, iam/roles, iam/sessions, compliance/controls, kill-switch.
**Botones:** KillSwitchGrande modal ✓, BannerOpenClawV2 huérfanos.
**Gaps:** LiveIndicator countdown desincronizado con poll real (P0), ComplianceRow placeholders sin datos (P1), Kpi text hardcoded (P2).
**Prioridad:** P0.

### Infrastructure
**Función:** multi-provider inventory · grid 5 providers (Webdock×3 + AWS + IONOS + Físico) + drilldown.
**Estado:** live si backend expone.
**Endpoints:** infrastructure/inventory (poll 30s).
**Botones:** provider cards clickables, "Ver detalles" placeholder.
**Gaps:** brandName/accountSuffix heurística frágil (P0), drilldown sin collapse UX (P1), SkeletonKpiGrid placeholder genérico no refleja schema (P2).
**Prioridad:** P1.

### Domains
**Función:** discover/propose Route53 + Porkbun · SearchHero + Suggestions + OwnedDomains + ProposalQueue Fase 2 + PricesPanel + AskOpenClawCard.
**Estado:** live.
**Endpoints:** domains/availability, suggestions, prices, owned, compare.
**Botones:** SearchHero input debounced, suggestions cards clickables, BannerOpenClawV2 huérfanos.
**Gaps:** isPlausibleDomain regex no ICANN-compliant (P1), Fase 1 hardcoded sin CTA Fase 2 (P1), OwnedDomainsSection empty state placeholder (P2).
**Prioridad:** P2.

---

## Canvas v4 — 5 tabs

| Tab | Estado | Endpoints | Gaps |
|---|---|---|---|
| **Live** | Live real | openclaw/live-canvas + WSS | Filter por actor sin feedback visual |
| **Files** | Stub | none | Sin data real, sin preview |
| **Terminal** | Stub | none | Mock 12 comandos confunde, sin sandbox real |
| **Diff** | Stub | none | Mock commit fake, sin plan delta real |
| **Topología** | Stub polished | none | Drag funcional, overlap nodos mobile <600px |

---

## Distribución por criticidad

- **P0 (bloquea MVP creíble):** 6 items · ApprovalRow IDs crudos, Onboarding form readonly ambiguo, Clusters timestamp fake, Canvas tabs stub, Safety countdown desync, Infrastructure heurística string.
- **P1 (degrada UX):** 12 items · modales mobile, charts fallback confusos, JSON raw, topología mobile, gates copy, scroll indicators, heurísticas.
- **P2 (polish):** 8 items · empty states genéricos, placeholders, docstrings, responsive spacing.

---

## Recomendación de ataque

**Sprint inmediato (1 día Claude):**
- P0 #1 ApprovalRow humanize (15 min)
- P0 #2 Onboarding readonly chips (45 min)
- P0 #4 Canvas stubs empty state honesto (30 min)

**Sprint Codex paralelo (2-3 días):**
- P0 #3 + #5 timestamps reales en contract → desbloquea sync LiveIndicators
- P0 #6 providerType enum en contract Infrastructure
- Endpoints faltantes para Files/Terminal/Diff backend real

**Sprint polish (después):**
- P1 12 items en sweep
- P2 cuando MVP creíble
