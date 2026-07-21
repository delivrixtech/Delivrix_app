# BRIEF CODEX — Delivrix Artifacts tipados: que el agente "piense/haga/sea" como Artifacts de Claude

Fecha: 2026-06-19 · Auditado en código por Claude (grounded, archivo:línea) · Ejecuta: **Codex con subagentes** · Rama base: `produ` (ya tiene los cables del PR #4, commit cb34b83). Frontend (renderers por tipo) lo hace Claude en paralelo en `feature/canvas-v5-preview`.

## Objetivo (el "norte")
Que el preview del Canvas de Delivrix funcione como los **Artifacts de Claude**, aplicado a un agente de operaciones. Los 5 principios, que son el contrato de diseño:
1. **Decide cuándo abrir** — el panel aparece SOLO cuando el output amerita (un entregable/resultado estructurado), no para cada turno de chat. Una charla queda en el chat; un inventario, un reporte de blacklist, un run, un plan → abren artifact.
2. **Renderiza, no crudo** — el artifact lleva **payload estructurado tipado**; el frontend lo renderiza rico (tabla de inventario, ficha de run, reporte). El JSON crudo queda detrás del toggle.
3. **Despacha por TIPO** — un `kind` → un renderizador. Igual que Claude: código→editor, HTML→iframe, mermaid→diagrama. Acá: inventario→tabla, run→ficha, blacklist→reporte, dns→zona.
4. **Streamea en vivo** — declare → block/streaming (ya existe el canal).
5. **Identidad estable + versiones** — `artifactId` estable por objeto lógico; re-emitir actualiza el mismo artifact (no duplica).

## Estado actual (VERIFICADO 2026-06-19, archivo:línea — no re-investigar lo confirmado)
- **Kinds hoy:** `CanvasLiveArtifactKind = "plan" | "proposal" | "template" | "report"` (`packages/domain/src/canvas-live.ts:9`). Block kinds: `step | title | paragraph | table_row | code` (`:10`). **No hay** `smtp_run`, `inventory`, `blacklist_report`, `dns_zone`. **No hay payload estructurado** — solo bloques de markdown (`content: string`).
- **Quién emite artifacts hoy (los 601):** `openclaw-domain-chat-skill.ts:113` (inventario/dominios), `routes/onboard-flow.ts:492` (onboarding), `main.ts:662/3727/3748` (proposals-sign vía `upsertArtifactSnapshot`). El servicio: `services/canvas-live-events.ts:277` (`upsertArtifactSnapshot`).
- **El bridge Bedrock del chat NO emite artifacts.** `extractOpenClawArtifact` (`openclaw-artifact-extractor.ts:20`, **construido + testeado**) solo se llama desde el bridge SSH muerto (`openclaw-chat.ts:958`). El bridge de producción (`openclaw-bedrock-bridge.ts`) emite `oc.task.*` y `oc.action.now`, nunca `oc.artifact.*`. Por eso una respuesta del chat (ej. "9 SMTPs" vía `read_webdock_servers`) queda en texto, sin panel.
- **OJO (verificado, NO re-investigar): `extractOpenClawArtifact` NO decide "esto amerita panel".** SIEMPRE devuelve un artifact: `detectArtifactKind` solo elige el `kind` y su fallback final es `return "report"` (`:100`); si no hay bloques mete un párrafo fallback (`:30-34`). Es decir, "¿qué es FCrDNS?" igual produciría un `report`. **El gate del principio #1 NO existe — hay que construirlo** (ver Fase 2.B). El extractor sirve para PARTIR el texto en bloques y tipar prosa, no para decidir si abrir.
- **El bridge YA tiene en mano lo necesario (verificado):** el mensaje del operador es `latestUserTurnContent(turns)` (existe, usado en `:351`/`:357`); la respuesta final es `response.text` (`:414`); el outcome de cada tool está disponible en el hook `emitCanvasToolAction({ ..., result })` (`:477`, fase `completed`); el emisor `this.canvasLiveEvents` ya está inyectado (`main.ts:402`).
- **Tools que devuelven data estructurada y NO se materializan como artifact:** `read_webdock_servers` (inventario), `read_mxtoolbox_health` (blacklist/reputación), `configure_complete_smtp` (run, ya tiene `identity` por los cables del PR #4). Pasan por `tool-use-processor.ts`.

## FASE 1 — Diagnóstico (subagente, read-only)
Confirmar runtime + cerrar lo que no se ve en el repo:
1. De los 601 artifacts en `/v1/canvas/live/state`, ¿qué `kind` tienen y de qué flujo salen? (domain-skill vs onboard vs proposals). Reportar distribución.
2. (YA verificado por Claude — no re-investigar, solo confirmar runtime si querés) `extractOpenClawArtifact` NO gatea entregable-vs-charla: siempre extrae, fallback `report`. El gate del principio #1 hay que **construirlo** (Fase 2.B). Reusar los primitivos que YA viven en ese archivo (`isMarkdownTableStart`, el check de ```` ``` ````, `isHeading`, `hasNumberedStepList`) para el gate, en vez de heurística nueva.
3. ¿`upsertArtifactSnapshot` versiona o pisa? (para el principio #5). Leer `canvas-live-events.ts:277`. Confirmar que upsertea por `artifactId` (clave estable) y no por id aleatorio.

## FASE 2 — Backend (el cambio)

### A. Extender el contrato con tipos + payload estructurado (`packages/domain/src/canvas-live.ts`)
- `CanvasLiveArtifactKind` += `"smtp_run" | "inventory" | "blacklist_report" | "dns_zone"`. (Mantener los 4 existentes; NO agregar un kind genérico tipo `agent_markdown`: la prosa-entregable ya cae en `plan|proposal|template|report` que el extractor produce. Los 4 kinds nuevos son EXCLUSIVOS para payload estructurado.) Regla del contrato: un artifact lleva **o** `blocks` (prosa markdown, kinds viejos) **o** `payload` (estructurado, kinds nuevos) — el frontend despacha por `kind`.
- Agregar un canal de **payload estructurado opcional** al artifact (sibling de `blocks`, NO romper blocks):
  ```ts
  export type CanvasLiveArtifactPayload =
    | { kind: "smtp_run"; runId: string; identity: CanvasLiveRunIdentity; steps: CanvasLiveRunProgressStep[] }
    | { kind: "inventory"; servers: Array<{ slug; domain?; ipv4?; provider?; status; accountId? }> }
    | { kind: "blacklist_report"; target: string; source: string; evaluatedAt: string; checks: Array<{ list; status: "pass"|"listed"|"na"; note? }> }
    | { kind: "dns_zone"; domain: string; records: Array<{ name; type; value }> };
  ```
  El artifact gana `payload?: CanvasLiveArtifactPayload` (opcional → backward-compat; los 601 viejos siguen parseando con sus blocks). Reusar `CanvasLiveRunIdentity` de los cables. **Mirror en `apps/admin-panel/src/features/canvas/live-tool-types.ts`** (Claude lo consume).

### B. "Decide cuándo abrir" (principio #1) + emitir prosa-entregable desde el bridge Bedrock
El extractor NO gatea (ver Estado actual). Hay que **construir el gate** y solo entonces emitir.
1. **Construir `shouldOpenArtifact(text): boolean`** (en el extractor, junto a los helpers que ya existen). Abre SOLO si el texto final es un entregable estructurado/sustancial, NO charla. Señales (reusar los primitivos del propio archivo): tiene tabla markdown (`isMarkdownTableStart`), **o** un fenced code block (```` ``` ````), **o** un heading (`isHeading`) + lista/pasos de >=3 ítems, **o** `hasNumberedStepList` (>=2), **o** longitud >= ~600 chars con multi-sección. Si es prosa corta de una sola respuesta sin estructura -> `false` (queda en el chat). Cubrir con tests unitarios (charla -> false; plan/tabla/código -> true).
2. **Emitir solo si `shouldOpenArtifact` es true**: en `openclaw-bedrock-bridge.ts`, rama de respuesta final (`toolUses.length === 0`, ya emite `oc.task.update completed`, ~`:397-421`): llamar `extractOpenClawArtifact(response.text, latestUserTurnContent(turns))` (helpers ya verificados como existentes) y emitir `oc.artifact` + blocks por `this.canvasLiveEvents`. Kind = el que devuelve el extractor (`plan|proposal|template|report`).
3. **Dedupe con el path C (anti doble-emit):** llevar un flag por turno (p.ej. `let emittedTypedArtifact = false` en `invokeBedrock`, set en true cuando C emite un artifact tipado desde un tool-result). En la rama final, **si `emittedTypedArtifact` es true, NO emitir** el report de prosa (la pregunta "cuántos SMTPs" ya abrió el `inventory`; no la dupliques con un `report`). Solo emite prosa cuando el turno no produjo artifact tipado.

### C. Emitir artifacts TIPADOS desde los tool-results (el corazón del type→renderer)
**Dónde (verificado):** el path del chat tiene el outcome de cada tool en mano en el bridge, en el hook `emitCanvasToolAction({ ..., result })` de `openclaw-bedrock-bridge.ts` (`:477`, fase `completed`) — ese es el sitio natural para el chat. `tool-use-processor.ts` es el procesador compartido si querés centralizarlo, pero el `result` ya llega tipado al bridge. Emitir con `this.canvasLiveEvents.upsertArtifactSnapshot(...)` y **marcar `emittedTypedArtifact = true`** (el flag de la Fase 2.B para el dedupe). Mapear por `toolUse.name` cuando `result.ok`:
- `read_webdock_servers` → `kind:"inventory"`, payload `servers[]` (de su outcome). artifactId estable `inventory-webdock`.
- `read_mxtoolbox_health` → `kind:"blacklist_report"`, payload `target/checks[]`. artifactId `blacklist-<target>`.
- `configure_complete_smtp` (run) → `kind:"smtp_run"`, payload `identity + steps` (ya existe `identity` por los cables; reusar `smtpRunStateToProgress`). artifactId `run-<runId>`.
- DNS derivado del run → `kind:"dns_zone"` (o dentro del smtp_run, como ya lo deriva el frontend).
**Sanitización:** pasar todo payload por el mismo allowlist/redactor de los cables (`canvas-live-events.ts`, allowlist sensible; nunca DKIM privada, tokens, secrets) — igual que se validó en el PR #4.

### D. Identidad estable + versiones (principio #5)
- `artifactId` estable por objeto lógico (`inventory-webdock`, `run-<runId>`, `blacklist-<target>`) → re-emitir **actualiza** el mismo artifact, no duplica. Confirmar que `upsertArtifactSnapshot` upsertea por `artifactId` (Fase 1.3); si pisa sin versionar, agregar `version`/`updatedAt`.

## FASE 3 — Frontend (Claude, NO Codex — para que sepas el contrato)
Claude hace el **dispatcher type→renderer** en `CanvasV5Preview.tsx`: lee `artifact.kind` + `payload` y renderiza — `smtp_run`→ficha (ya está), `inventory`→tabla de servers, `blacklist_report`→ficha-reporte, `dns_zone`→zona DNS, `plan/proposal/report`→markdown. Toggle Vista/Crudo. Por eso el contrato (A) debe quedar firme y mirroreado.

## DoD (verificable, sin adivinar)
- Pregunta "cuántos SMTPs" en el chat → el gateway emite `oc.artifact kind:"inventory"` con los servers reales → aparece en `/v1/canvas/live/state` con payload tipado.
- Un blacklist check → `oc.artifact kind:"blacklist_report"`. Un run → `kind:"smtp_run"`.
- Charla conceptual ("¿qué es FCrDNS?") → **NO** emite artifact (principio #1).
- Re-preguntar lo mismo → actualiza el mismo `artifactId`, no duplica.
- `node --test` de gateway-api verde + build. Nunca exponer secretos/DKIM privada.

## Cómo (profesional)
- **Subagentes:** (1) diagnóstico runtime + heurística del extractor; (2) contrato + payload + sanitización; (3) emisión tipada en bridge + tool-processor; (4) tests/QA. 
- **Anclar por NOMBRE de símbolo, no por línea** (Codex y otros editan estos archivos; las líneas se corren).
- Backward-compat: todo opcional, los 601 artifacts viejos siguen funcionando.
- Coordinación: el frontend (Claude) va en `feature/canvas-v5-preview`; vos en `produ`. El contrato (Fase 2.A) es la interfaz — fijémoslo primero y avisás cuando esté mergeado para que Claude cablee los renderers contra lo real.
