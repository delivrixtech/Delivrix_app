# Amend script — reetiquetar commit 095fa7e (Fase C + Fase D)

El commit `095fa7e` se etiqueto como "Fase C" pero captura ambos sets de cambios (Fase C + Fase D) porque `git add apps/admin-panel/src/app/App.tsx` recogio el archivo completo despues de que Claude habia aplicado tambien los edits de Fase D. El codigo es correcto y esta validado en vivo; solo falta corregir el mensaje del commit.

Como la rama `claude/youthful-mirzakhani-c517de` aun no esta publicada, el amend es seguro.

Desde la terminal de macOS, en la carpeta del worktree:

```bash
cd ~/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de

git commit --amend -m "Implement Hito 5.10 Fases C+D: six remaining screens migrated

Migrate Canvas, Hardware, Collector (Fase C) and Ruta, Clusters, Aprendizaje
(Fase D) to the Tailwind+shadcn stack. Combined with the Seguridad migration
in Fase B, all seven admin panel sections now use the new component library.

New deps (Fase C):
- @dagrejs/dagre 3 (Canvas autolayout)
- @radix-ui/react-tabs (Collector tabs)
- @radix-ui/react-accordion (Canvas blockers, future grouped lists)
- @radix-ui/react-collapsible (held for Fase E)

New primitives in shared/ui/ (Fase C):
- Tabs, TabsList, TabsTrigger, TabsContent (Stripe-style underline)
- Accordion, AccordionItem, AccordionTrigger, AccordionContent
- NoticeBanner (info / warning / critical)
- DefinitionList (compact / comfortable density)

Canvas (Fase C): replace the index-matrix layout with dagre TB autolayout.
Add an Inspector side panel that reacts to node click with summary, metrics,
incoming/outgoing dependencies (click-through). Replace the wall of 32
blockers with an Accordion that groups by category (hardware / openclaw /
network / provider / other). Drop MiniMap. labelBgStyle keeps edge labels
from overlapping nodes. RootCauseBanner surfaces 'ingest snapshot manual'
when hardware blockers dominate.

Hardware (Fase C): PageHeader + NoticeBanner when inventory is mostly
unknown. Four KPIs with semantic microcopy (Esperando snapshot manual,
Snapshot vigente). Cards with DefinitionList replace the legacy chip grids.
Collector DevOps badge shows status instead of duplicating the page-level
mock indicator.

Collector (Fase C): Tabs split content into Fuentes, Ingesta manual,
Politica. Source cards use tone'd left borders and a clean DefinitionList
plus inline-code blocks for endpoint/command previews. Ingesta manual
surfaces the contract and field-to-target mapping. Politica groups gates,
next safe actions, blocked actions.

Ruta (Fase D): progress strip global (counts ready / needs_review /
blocked / not_started) plus filter chips (Todos / Pendientes / Bloqueados).
Workflow steps now render as tone'd Cards with statusReason elevated under
the title — it used to be buried at the bottom in muted gray. Data sources
render as <code> mono chips, evidence as Badge neutral. Frontera de lectura
moves to its own Card at the bottom with the 17 allowed endpoints.

Clusters (Fase D): KPIs read named fields from clusters.totals (no more
Object.entries.slice). Each cluster Card holds a real <table> with Nodo /
Estado / Salud columns; sender nodes get separate badges for status and
healthSeverity (they were indistinguishable before). Adds nextActions
panel.

Aprendizaje (Fase D): Readiness signals use a dot-by-status pattern with
humanized keys. Stages render as a numbered list with tone'd border-left,
showing stage.title via the B.1 fallback. Adds Gobierno del modelo panel
exposing modelMode / modelVersion / promptVersion plus an explanation that
flips copy when canSelfPromote is true.

globals.css: add .delivrix-node styles for new canvas nodes and a
line-clamp-2 helper.

styles.css legacy still loads but no section references it anymore. Fase E
will remove it and add sidebar sticky, dark mode pass, responsive tuning,
empty/loading/error states.

The panel remains GET-only. No backend, gateway or runtime contract
changed. Validated in vivo via Claude in Chrome on the dev server."
```

Despues del amend, opcionalmente borrar los archivos de scratch que ya cumplieron su funcion (estan untracked):

```bash
rm COMMIT_FASE_B.md COMMIT_B1.md COMMIT_FASE_C.md COMMIT_FASE_D.md COMMIT_FASE_C_D_AMEND.md
```

O dejarlos como historico — son ~50 KB total y no tocan ningun build.
