# Overview Dashboard — spec literal Pencil (`e1ashz`)

Frame 1440x1371, fill `#FFFBF5`. Sidebar 240w `#F7F2EA` + Main column.

## Topbar `U7pIqs`
- Container: fill `#FFFBF5`, padding `[16, 28]`, gap `16`, border-bottom `#EAE0CE` thickness 1.
- Row layout: breadcrumb + spacer + read-only badge + env chip + user chip.

### Breadcrumb `erl5D`
gap 8, items inline:
1. "Operar" — Inter 12 normal `#8A8073`
2. icon `chevron-right` 12px `#8A8073`
3. "Vista general" — Geist 13 weight 600 `#1A1410`

### Read-only badge `RQRjS`
cornerRadius 4, fill `#DBEAFE`, padding `[6, 10]`, gap 6.
- icon `eye` 12px `#1D4ED8`
- "Solo lectura · GET-only" — Inter 11 weight 600 `#1D4ED8`

### Env chip `kr0Lk`
cornerRadius 4, fill `#F7F2EA`, padding `[6, 10]`, gap 6, border `#EAE0CE` 1.
- icon `flask-conical` 12px `#5C544A`
- "mvp.local" — IBM Plex Mono 11 normal `#5C544A`

### User chip `x6uvI3`
cornerRadius 18, fill `#F7F2EA`, padding `[4, 10, 4, 4]`, gap 8, border `#EAE0CE` 1.
- Avatar 24x24 cornerRadius 12 fill `#EA580C`, justifyContent center: "J" — Funnel Sans 11 weight 700 `#FFFBF5`
- "operador" — Geist 12 weight 500 `#1A1410`

## Sidebar `jEU4h` (sbOver)
240w, fill `#F7F2EA`, padding `[20, 16]`, gap 24, border-right `#EAE0CE` 1, vertical.

### sbBrand `NLxTW`
padding `[4, 4, 16, 4]`, gap 10, alignItems center.
- BrandMark 32x32 cornerRadius 8, gradient 135deg `#FACC15 → #F59E0B → #EA580C`, justifyContent center: "D" — Funnel Sans 18 weight 700 `#FFFBF5`.
- BrandText vertical:
  - "Delivrix" — Funnel Sans 16 weight 700 `#1A1410`
  - "plataforma de control" — Inter 11 normal `#8A8073` letterSpacing 0.4

### sbNav `Z002l`
vertical, gap 4. Group label inline + items.

Group label: `"  OPERAR"` Inter 10 weight 600 `#8A8073` letterSpacing 1.2 (NOTE: two leading spaces).

#### sbItem active (e.g. overview `gUJsk`)
cornerRadius 6, fill `#FFFFFF`, padding `[10, 12]`, gap 10, border `#EAE0CE` 1.
- icon lucide 16px `#EA580C`
- label Geist 13 weight 600 `#1A1410`
- spacer fill_container
- dot 6x6 cornerRadius 3 fill `#F59E0B` (enabled)

#### sbItem inactive
No fill, no border, padding `[10, 12]`, gap 10.
- icon lucide 16px `#5C544A`
- label Geist 13 weight 500 `#5C544A`
- dot disabled

#### Nav items + icons (Pencil shows 8)
| Item | Icon (lucide) | Status (Overview screen) |
|---|---|---|
| Vista general | layout-dashboard | active |
| Onboarding | compass | inactive |
| Canvas | workflow | inactive |
| Hardware | cpu | inactive |
| Recolector | database | inactive |
| Clústeres | server | inactive |
| Aprendizaje | graduation-cap | inactive |
| Seguridad | shield-check | inactive |

> Nota re-arq: en la fase H colapsamos a 5 secciones. Mantener visual de 8 items rompería la re-arq, así que renderizo los 5 reales con el mismo styling (active/inactive).

### sbKillSwitch `z0dLBo`
cornerRadius 8, fill `#FFFFFF`, padding 14, gap 10, border `#EAE0CE` 1, shadow `blur 3 #0000000a y=1`.
- ksHead `ZiAfw`: gap 8, icon `power` 14px `#15803D` + "Interruptor de corte" Geist 12 weight 600 `#1A1410`
- ksStatus `uCkC6`: gap 8, alignItems center
  - pill ARMADO: cornerRadius 4 fill `#DCFCE7` padding `[2, 6]`, text "ARMADO" Inter 9 weight 700 `#15803D` letterSpacing 0.6
  - spacer
  - "hace 14 min" IBM Plex Mono 10 normal `#8A8073`
- "Prueba en modo simulado" IBM Plex Mono 10 normal `#8A8073`
- "Requiere regla de 2 personas" Inter 10 normal `#5C544A`

## Content `C0Z82g`
fill `#FFFBF5`, padding `[24, 28, 32, 28]`, gap 20, vertical.

### Header row `l4eQl`
gap 20, horizontal. Left col 598w + Right col 523w.

#### Welcome `r5ubD` (598w)
gap 6 vertical.
- welcomeMeta `sGEMH`: gap 8 inline
  - "INICIO OPERATIVO" Inter 11 weight 700 `#EA580C` letterSpacing 1.2
  - dot 4x4 cornerRadius 2 `#8A8073`
  - "Actualizado hace 14s" IBM Plex Mono 11 normal `#8A8073`
- Title "Capacidad preparada, sin envíos reales." Funnel Sans 28 weight 700 `#1A1410` letterSpacing -0.4 (NO GRADIENT — sólido `#1A1410`).
- Description Geist 14 normal `#5C544A` lineHeight 1.5.

#### OpenClaw prompt `h9kYtq` (523w)
cornerRadius 12, padding 2, fill linear gradient 135deg `#FACC15 → #F59E0B → #EA580C`, shadow `blur 18 color #92400e22 y=6`.

Inner `Hxx8t`: cornerRadius 10, fill `#FFFFFF`, padding 16, gap 12, vertical.
- ocHead `GfUvw`: alignItems center, gap 10
  - Avatar 32x32 cornerRadius 8 gradient (same), justifyContent center: icon `sparkles` 16px `#FFFBF5`
  - Title vertical:
    - "OpenClaw" Funnel Sans 14 weight 700 `#1A1410`
    - "Operador supervisado" Inter 10 normal `#8A8073` letterSpacing 0.4
  - Read mode chip al final
- Message `w0uH8y` Geist 13 normal `#1A1410` lineHeight 1.45
- ocInput `bYnbS`: cornerRadius 8 fill `#F7F2EA` padding `[10, 12]` gap 8 border `#EAE0CE` 1
- ocActions `ibsh1`: gap 8 inline botones

### KPI row `OTmCH`
gap 14, height 177, horizontal. 4 columns, fill_container each.

Common KPI card shell:
- cornerRadius 8, fill `#FFFFFF`, padding 16, gap 12, vertical, border `#EAE0CE` 1, shadow `blur 3 #0000000a y=1`.
- Header row: label Inter 11 weight 600 `#5C544A` letterSpacing 0.4 + spacer + colored pill (cornerRadius 4, padding `[2, 6]`).
- Value: IBM Plex Mono 32 weight 700 `#1A1410` letterSpacing -0.6.

#### KPI 1 — Nodos de envío (success pill `#DCFCE7`)
- value "148"
- detail row: icon `trending-up` 12px `#15803D` + "+6 esta semana" Mono 11 weight 600 `#15803D` + spacer + "/v1/sender-nodes" Mono 10 normal `#8A8073`
- sparkline `cWXGj`: gap 3, height 36, alignItems end. 8 bars width fill, cornerRadius 2:
  - h18 opacity 0.35 `#FACC15`
  - h24 op 0.45 `#FACC15`
  - h20 op 0.40 `#FACC15`
  - h28 op 0.55 `#F59E0B`
  - h30 op 0.70 `#F59E0B`
  - h24 op 0.60 `#F59E0B`
  - h32 op 0.80 `#EA580C`
  - h36 op 1.00 `#EA580C`

#### KPI 2 — IPs en calentamiento (info pill `#DBEAFE`)
- value "42"
- detail: icon `flame` `#EA580C` + "día 9 / 28 prom" Mono 11 weight 600 `#EA580C` + spacer + "/v1/warming" Mono 10 `#8A8073`
- bar `pIAAD`: cornerRadius 3, fill `#F7F2EA`, height 6, contains 3 horizontal gradient fills 48w each (`#FACC15 → #EA580C` 90deg).

#### KPI 3 — Índice de reputación (warning pill `#FEF3C7`)
- valueRow alignItems end: "94,2" Mono 32 weight 700 + "/ 100" Mono 14 normal `#8A8073`
- detail: icon `trending-down` `#B45309` + "-1,4 vs 24h" Mono 11 weight 600 `#B45309` + spacer + "/v1/reputation" Mono 10
- bar: cornerRadius 3 fill `#F7F2EA` height 6, fill bar `#B45309` height 8 width 249 (out of full ≈275 → ~94%).

#### KPI 4 — Gates abiertos (critical pill `#FEE2E2`)
- value "3"
- detail: icon `shield-alert` 12px `#B91C1C` + "espera aprobación" Mono 11 weight 600 `#B91C1C` + spacer + "/v1/gates" Mono 10
- chips row `J2et5d`: gap 6, 3 chips cornerRadius 4 fill `#FEE2E2` padding `[3, 8]`.

### Pipeline `W1dhKm`
cornerRadius 8, fill `#FFFFFF`, padding 20, gap 16, border `#EAE0CE` 1, shadow.

pipeHead `Eh1Fl`: gap 12 horizontal.
- pipeTitle vertical, gap 2:
  - "Flujo operativo" Funnel Sans 16 weight 700 `#1A1410`
  - subtitle Geist 12 normal `#5C544A`
- spacer
- pipeLink: button cornerRadius 6 padding `[6, 10]` border `#D4C5A8` 1 gap 6: "Abrir canvas" Geist 12 weight 600 + icon arrow-right 13px (both `#1A1410`).

Stages row `u7kmJ`: alignItems center, fill_container row of 5 stage cards + 4 connectors (chevron-right 14px `#8A8073` in 18w x 22h frame).

#### Stage card shell
cornerRadius 8, padding 14, gap 10, vertical, border 1 (color varies).

Variants (Light theme):
| Stage | fill | border |
|---|---|---|
| Onboarding (Cu0Bz) | `#DCFCE7` | `#15803D` |
| Planning (UrM0u) | `#DCFCE7` | `#15803D` |
| Provisioning (DgGHF) | linear 135deg `#FACC15 → #EA580C` opacity 0.2 | `#EA580C` |
| Warming (ERGfi) | `#FEF3C7` | `#B45309` |
| Reputation (XYvcK) | `#F5F5F4` | `#EAE0CE` |

Stage body:
- Header row: small leading dot/icon, title Geist 11 weight ?
- Text Geist 11 normal `#1A1410` lineHeight 1.4
- Footer text IBM Plex Mono 10 normal `#5C544A` (or other tone fg for warning)

### Bottom row `t06Ap`
gap 16, horizontal.

#### Activity & approvals `y827y4` (left, flex)
cornerRadius 8 fill `#FFFFFF` border `#EAE0CE` shadow. Vertical:
- acHead: padding `[16, 18, 14, 18]`, gap 12, border-bottom `#EAE0CE`, alignItems center
  - acTitle vertical gap 2 (label + subtitle)
  - spacer
  - acHeadPill: cornerRadius 4 fill `#FEE2E2` padding `[3, 8]` (count)
- acList: 3 Approval rows, each padding `[14, 18]`, gap 12, border-bottom (except last)

#### Side pane `FjlGZ` (380w)
gap 16 vertical.

Gates `xm9H3`: cornerRadius 8 fill `#FFFFFF` padding 18 gap 12 border `#EAE0CE` shadow.

System health `NOTkr` (DARK PANEL): cornerRadius 8 fill `#1A1410` padding 18 gap 14 shadow `blur 18 #00000022 y=6`. Vertical.
- shHead: gap 8
- Title "Todos los gateways responden." Funnel Sans 16 weight 600 `#FFFBF5` letterSpacing -0.2
- shGrid: vertical gap 8 (rows of metric labels + values)
