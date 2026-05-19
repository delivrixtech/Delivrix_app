# Commit script — Fase F (contract-first cleanup, sin modularizar features)

Archivos modificados:

- `apps/admin-panel/src/shared/lib/domain-state-copy.ts` (**NEW**, microcopy centralizado)
- `apps/admin-panel/src/shared/lib/domain-state-copy.test.ts` (**NEW**, 8 tests)
- `apps/admin-panel/src/app/sections.ts` (**NEW**, section manifest con READ_ENDPOINTS)
- `apps/admin-panel/src/features/canvas/blocker-classification.ts` (**NEW**, regex INTERIM)
- `apps/admin-panel/src/features/canvas/blocker-classification.test.ts` (**NEW**, 8 tests)
- `apps/admin-panel/src/features/canvas/root-cause.ts` (**NEW**, microcopy INTERIM)
- `apps/admin-panel/src/features/hardware/readiness-hint.ts` (**NEW**, threshold INTERIM)
- `apps/admin-panel/src/app/App.tsx` (consume nuevos modulos, elimina hardcoded)
- `apps/admin-panel/package.json` (check script incluye nuevos tests)

Validacion ejecutada en sandbox:

```
npx tsc --noEmit                                 OK
node --test 4 archivos                          23/23 pass
npx vite build --outDir /tmp/admin-build-f       OK 47 kB CSS / 616 kB JS
```

Validado en vivo via Claude in Chrome:
- Canvas mantiene la misma UX. Legenda ahora muestra `ready / needs review / blocked / not started` (vocabulario del contract, no hardcoded).
- Hardware mantiene el banner "Inventario pendiente" — ahora driven por `shouldShowInventoryHint` desde feature module.
- Seguridad y Aprendizaje muestran microcopy correctas (`Solo dry-run en MVP`, `Modelo no se auto-asciende`, etc.) derivadas de `pickBinary(safetyCopy.*, value)` y `pickBinary(learningCopy.*, value)`.
- Test scripts del check pasan localmente.

Desde la terminal de macOS, en la carpeta del worktree:

```bash
cd ~/Documents/delivrix\ app/.claude/worktrees/youthful-mirzakhani-c517de

git add \
  apps/admin-panel/src/shared/lib/domain-state-copy.ts \
  apps/admin-panel/src/shared/lib/domain-state-copy.test.ts \
  apps/admin-panel/src/app/sections.ts \
  apps/admin-panel/src/features/canvas/blocker-classification.ts \
  apps/admin-panel/src/features/canvas/blocker-classification.test.ts \
  apps/admin-panel/src/features/canvas/root-cause.ts \
  apps/admin-panel/src/features/hardware/readiness-hint.ts \
  apps/admin-panel/src/app/App.tsx \
  apps/admin-panel/package.json

git commit -m "Implement Hito 5.10 Fase F: contract-first cleanup of hardcoded copy and layout

Apply the FRONTEND_UX_CONTRACT_GUIDE rule (no domain inferences in the UI)
by extracting hardcoded interpretations, classifications and section
metadata out of App.tsx into focused modules.

- shared/lib/domain-state-copy.ts: centralize the UI translation of
  contract booleans (operatingNorth, killSwitch, modelGovernance,
  capacity unknowns, collector policy) into a single lookup table with
  pickBinary / pickCapacityCopy helpers. Adds 8 unit tests covering the
  inversion of self-promote / human-approval tones (the bug fixed in
  Fase B.1) and the symmetry of the safety binary copies.

- app/sections.ts: section manifest with id, label, group, icon,
  eyebrow, title, description and endpoint. Endpoints reference
  READ_ENDPOINTS so the single source of truth is the read-boundary
  module. Sidebar nav and PageHeader for all 7 sections now consume
  the manifest via getSection(id) instead of inline strings.

- features/canvas/blocker-classification.ts: interim classifier moved
  out of App.tsx with explicit TODO pointing to the proper ownership
  (domain layer / OpenClawCanvasPayload.blockedBy[*].category). Adds
  8 unit tests covering keyword recognition and root-cause detection.

- features/canvas/root-cause.ts and features/hardware/readiness-hint.ts:
  notice content and threshold logic that were hardcoded inline now
  live in feature modules with INTERIM comments. When the contract
  exposes readiness.primaryBlocker / recommendedNextStep, these modules
  shrink to a simple payload → StateCopy mapper.

- App.tsx: drop the 5 lucide icon imports (now in sections.ts),
  delete the inline sections/sectionGroupLabels constants, delete the
  inline groupBlockers function, replace the legend's hardcoded labels
  with values derived from ContractStatus + stateTone. CanvasLegend
  now reads 'ready / needs review / blocked / not started' from the
  contract vocabulary instead of literal strings.

- package.json: extend the check script to run the new test suites
  so CI catches future drift.

Backend ownership the frontend is waiting on:
- OpenClawCanvasPayload.blockedBy[*].category (eliminates the regex
  classifier).
- physicalHost.readiness.primaryBlocker / recommendedNextStep
  (eliminates the inventory hint threshold).

Once those exist, the INTERIM modules collapse to direct payload
renderers. The panel remains GET-only. No backend, gateway or runtime
contract changed in this commit."
```

Despues del commit, opcional:

```bash
rm COMMIT_FASE_B.md COMMIT_B1.md COMMIT_FASE_C.md COMMIT_FASE_D.md COMMIT_FASE_C_D_AMEND.md COMMIT_FASE_E.md COMMIT_FASE_F.md
```

## Tareas backend que documenta esta Fase F (para Codex / domain)

Cuando quieran cerrar el loop completamente:

### Tarea 1: anadir `category` a OpenClawCanvasPayload.blockedBy

En `packages/domain/src/openclaw-canvas.ts:393` (funcion `collectBlockers`), reemplazar `string[]` por:

```ts
export interface OpenClawCanvasBlocker {
  code: string;
  label: string;
  category: "hardware" | "openclaw" | "network" | "provider" | "other";
  severity: "warning" | "critical";
}
```

Y en `apps/admin-panel/src/shared/api/client.ts` actualizar `OpenClawCanvasPayload.blockedBy` al mismo shape. El frontend retira `features/canvas/blocker-classification.ts`.

### Tarea 2: anadir `readiness.primaryBlocker` y `recommendedNextStep`

En `packages/domain/src/hardware-inventory.ts` (`buildPhysicalHostSnapshot` o equivalente), agregar:

```ts
readiness: {
  status: ContractStatus;
  blockers: string[];
  warnings: string[];
  requiredHumanInputs: string[];
  primaryBlocker?: string;        // p.ej. "inventory_snapshot_missing"
  recommendedNextStep?: {
    label: string;                 // p.ej. "Ingestar snapshot manual"
    endpoint: string;              // p.ej. "POST /v1/devops/collector/manual-snapshots/ingest"
    severity: "info" | "warning" | "critical";
  };
}
```

El frontend retira `features/hardware/readiness-hint.ts` y la UI renderiza directo `readiness.recommendedNextStep` si existe.

### Tarea 3 (post-MVP): descripciones de seccion en backend

Hoy `sections.ts` tiene las descripciones de las 7 pantallas hardcoded en frontend. Es UX, no dominio, asi que esta bien por ahora. Si el dominio quiere ser dueno, exponer `GET /v1/admin/sections-manifest` con `{ id, eyebrow, title, description, endpoint }[]`.
