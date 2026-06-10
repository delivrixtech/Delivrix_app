# Codex — FIX `compact_intent` 400 (camino chat-compaction) — conformar `errorMessage` + `outcomeData` en el productor del agente

> **Estado: VERIFICADO GO en worktree aislado (HEAD `79171f2`, 2026-06-08).** Auditado 2 veces + re-implementado y probado. La 1ª versión (machine-code de `errorMessage` SOLO, en la ruta) resultó **INCOMPLETA** — `outcomeData` free-text es un 2º tripwire del gate. Esta versión conforma **AMBOS** campos en el parser **productor del agente** (`skill-schemas.ts`), dejando la **ruta `/v1/openclaw/compact-intent` y el write-gate 100% intactos** (así el test de inyección `:323` sigue verde y no se debilita la seguridad). **Aplicá EXACTAMENTE estos 3 cambios + 3 tests. No re-derivar ni "mejorar".** **Subagentes OBLIGATORIO:** un subagente implementa y otro subagente Auditor INDEPENDIENTE revisa ANTES del commit (confirma: que NO se tocó la ruta `openclaw-compact-intent.ts`, NI el gate, NI la lógica de `machineErrorCode`; que el import es por ruta relativa y no `@delivrix/storage`; y que las 5 suites + 3 tests quedan verdes). Stop-and-report si algo no aplica limpio.
>
> Resultado de la verificación (5 suites, worktree): storage `episodic-scratch` 31/31 · `skill-schemas` 1→**4/4** (+3 nuevos) · `openclaw-episodic-memory` 13/13 (con `:323` rechazando inyección) · `tool-use-processor` 30/30 · `orchestrator-smtp` **61/61** (tras mover el helper). 0 errores `tsc` nuevos. Conform probado **load-bearing** (el payload crudo tira 400 en el gate; el conformado pasa). Árbol compartido intacto.

## Causa raíz (verificada con evidencia del `.audit` + worktree)
Cada run, el agente compacta su PROPIA sesión de chat (`intentId` `chat:…`) llamando `compact_intent`. Sus params los **arma el LLM** (no el servidor): `compactIntentParamSchema.safeParse` (`apps/gateway-api/src/skill-schemas.ts`, ~:476) → `validation.data` → `invokeMemoryToolOverHttp` (`tool-use-processor.ts:745`, exclusivo de compact_intent) los reenvía **verbatim** → POST `/v1/openclaw/compact-intent` → write-gate de storage.

El gate (`packages/storage/src/episodic-scratch.ts`) rechaza con HTTP 400 dos cosas que el agente puede mandar como texto libre:
- **`errorMessage`** que no sea código-máquina (regex `/^[a-z0-9_.:-]+$/i`, `:1004`; chequeado en `:692`, PRIMERO). ← el 400 observado hoy (`memory_payload_free_text_forbidden`, `intentId` `chat:…`).
- **`outcomeData`** con strings free-text o de inyección bajo claves no-allowlist (`assertStructuredOutcomeData` / `:1117`, chequeado en `:701`, DESPUÉS). ← **2º tripwire latente**: si el agente manda `outcomeData: { note: "domain not registered" }`, el run vuelve a 400 aunque `errorMessage` esté arreglado. (Por esto la versión "errorMessage solo" era incompleta.)

El productor del **orquestador** (`orchestrator-smtp.ts`) conforma LOS DOS campos (`machineErrorCode` + `compactOutcomeData`→`conformOutcomeData` en `:2481`) → por eso su camino PASA (Fase 2.6 `79171f2`, desplegada). El productor del **agente** (`skill-schemas.ts`) no conforma NINGUNO. **Fix: conformar ambos en el productor del agente, espejo exacto del orquestador.**

**Por qué NO en la ruta:** conformar `outcomeData` en `openclaw-compact-intent.ts` rompería `openclaw-episodic-memory.test.ts:323` ("rejects poisoned outcomeData" espera `memory_payload_instruction_injection`) y debilitaría el gate para llamadores directos. La ruta y el gate son el backstop estricto y se quedan IGUAL; el agente conforma antes de cruzar el borde HTTP. (Verificado: con la ruta intacta, `:323` sigue rechazando.)

## Los 3 cambios EXACTOS (verificados)

### 1) `packages/storage/src/episodic-scratch.ts` — exportar `machineErrorCode`
Mover `machineErrorCode` desde `apps/gateway-api/src/routes/orchestrator-smtp.ts:2485-2494` hacia `episodic-scratch.ts` (cuerpo **byte-idéntico**), justo después de `conformOutcomeData` (~:1229), y exportarla:
```ts
export function machineErrorCode(value: string): string {
  const firstToken = value.trim().split(/\s+/)[0] ?? "";
  const code = firstToken
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z0-9_.:-]+$/i.test(code) && code.length > 0
    ? code.slice(0, 200)
    : "operation_failed";
}
```
(`conformOutcomeData` ya está exportada en `:1226`. El barrel `packages/storage/src/index.ts` hace `export *`, así ambas quedan disponibles vía `index.ts`.)

### 2) `apps/gateway-api/src/routes/orchestrator-smtp.ts` — importar en vez de definir
Borrar la función local `machineErrorCode` (`:2485-2494`) e importarla del storage **extendiendo su import relativo existente** (NO el bare specifier `@delivrix/storage` — no existe en el repo):
```ts
import { conformOutcomeData, machineErrorCode } from "../../../../packages/storage/src/episodic-scratch.ts";
```
(Los 2 call-sites en `:2415` / `:2463` quedan igual; comportamiento idéntico → `orchestrator-smtp.test.ts` debe seguir 61/61.)

### 3) `apps/gateway-api/src/skill-schemas.ts` — conformar AMBOS campos en el productor del agente
Agregar el import (ruta **RELATIVA**, igual que `tool-use-processor.ts:15` — **no** `@delivrix/storage`), tras `import { createHash } from "node:crypto";`:
```ts
import { conformOutcomeData, machineErrorCode } from "../../../packages/storage/src/index.ts";
```
En `compactIntentParamSchema`, dentro del `.map` de `steps`, cambiar las dos líneas (`outcomeData` ~:491 y `errorMessage` ~:493):
```diff
- ...(item.outcomeData === undefined || item.outcomeData === null ? {} : { outcomeData: object(item.outcomeData, `steps[${index}].outcomeData`) }),
+ ...(item.outcomeData === undefined || item.outcomeData === null ? {} : { outcomeData: conformOutcomeData(object(item.outcomeData, `steps[${index}].outcomeData`)) as Record<string, unknown> }),
  ...(item.errorClass === undefined || item.errorClass === null ? {} : { errorClass: boundedText(item.errorClass, `steps[${index}].errorClass`, 1, 128) }),
- ...(item.errorMessage === undefined || item.errorMessage === null ? {} : { errorMessage: boundedText(item.errorMessage, `steps[${index}].errorMessage`, 1, 2000) }),
+ ...(item.errorMessage === undefined || item.errorMessage === null ? {} : { errorMessage: machineErrorCode(boundedText(item.errorMessage, `steps[${index}].errorMessage`, 1, 2000)) }),
```
(`conformOutcomeData` sobre un objeto siempre devuelve objeto; un `{}` resultante es gate-safe. El cast `as Record<string, unknown>` typechequea limpio.)

### NO TOCAR (lo descartó la auditoría)
- **NO** la ruta `apps/gateway-api/src/routes/openclaw-compact-intent.ts` (conformar `outcomeData` ahí rompería `:323` + debilita el gate para llamadores directos).
- **NO** la lógica del write-gate en `episodic-scratch.ts` (guardrail de seguridad: regex `:1004`, `assertStructuredOutcomeData`, allowlists `:193/252`, `injectionPattern`).
- **NO** la lógica de `machineErrorCode` (la comparten el orquestador + sus 61 tests).
- **NO** usar el bare specifier `@delivrix/storage` (no resuelve bajo NodeNext en este repo — usar rutas relativas a `packages/storage/src/...`).

## Tests nuevos — en `apps/gateway-api/src/skill-schemas.test.ts`, pegar verbatim
Import (tras el import existente de `compactIntentParamSchema`):
```ts
import {
  EpisodicScratchValidationError,
  validateEpisodicEntryInput,
  type InsertEntryInput
} from "../../../packages/storage/src/index.ts";
```
Los 3 tests:
```ts
test("compactIntentParamSchema machine-codes free-text errorMessage at the agent producer", () => {
  const parsed = compactIntentParamSchema.safeParse({
    intentId: "intent-1",
    finalStatus: "failed",
    decision: "stored",
    steps: [{
      step: 1,
      tool: "register_domain",
      inputHash: "a".repeat(64),
      outcome: "failed",
      errorMessage: "Step failed: domain not registered."
    }]
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join(", "));
  const errorMessage = parsed.data.steps[0].errorMessage;
  assert.equal(typeof errorMessage, "string");
  assert.match(errorMessage as string, /^[a-z0-9_.:-]+$/);
});

test("compactIntentParamSchema conforms free-text outcomeData at the agent producer", () => {
  const parsed = compactIntentParamSchema.safeParse({
    intentId: "intent-1",
    finalStatus: "failed",
    decision: "stored",
    steps: [{
      step: 1,
      tool: "register_domain",
      inputHash: "a".repeat(64),
      outcome: "failed",
      outcomeData: { note: "domain not registered" }
    }]
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join(", "));
  const outcomeData = parsed.data.steps[0].outcomeData;
  assert.ok(outcomeData && typeof outcomeData === "object");
  // The non-allowlisted free-text key is dropped, leaving a gate-safe object.
  assert.equal(Object.prototype.hasOwnProperty.call(outcomeData, "note"), false);
  assert.deepEqual(outcomeData, {});
});

test("agent producer output passes the storage write-gate where raw free-text would 400", () => {
  const rawErrorMessage = "Step failed: domain not registered.";
  const rawOutcomeData = { note: "domain not registered" };

  // The raw, un-conformed payload is rejected by the storage write-gate (would 400).
  const rawEntry: InsertEntryInput = {
    intentId: "intent-1",
    step: 1,
    tool: "register_domain",
    inputHash: "a".repeat(64),
    outcome: "failed",
    outcomeData: { ...rawOutcomeData },
    errorMessage: rawErrorMessage,
    source: "openclaw"
  };
  assert.throws(
    () => validateEpisodicEntryInput(rawEntry),
    (error: unknown) => error instanceof EpisodicScratchValidationError && error.code === "memory_payload_free_text_forbidden"
  );

  // The agent producer conforms both fields, so the same forwarded payload is gate-safe (would 200).
  const parsed = compactIntentParamSchema.safeParse({
    intentId: "intent-1",
    finalStatus: "failed",
    decision: "stored",
    steps: [{
      step: 1,
      tool: "register_domain",
      inputHash: "a".repeat(64),
      outcome: "failed",
      outcomeData: { ...rawOutcomeData },
      errorMessage: rawErrorMessage
    }]
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join(", "));

  const step = parsed.data.steps[0];
  const conformedEntry: InsertEntryInput = {
    intentId: parsed.data.intentId,
    step: step.step,
    tool: step.tool,
    inputHash: step.inputHash,
    outcome: step.outcome,
    ...(step.outcomeData === undefined ? {} : { outcomeData: step.outcomeData }),
    ...(step.errorClass === undefined ? {} : { errorClass: step.errorClass }),
    ...(step.errorMessage === undefined ? {} : { errorMessage: step.errorMessage }),
    source: "openclaw"
  };
  assert.doesNotThrow(() => validateEpisodicEntryInput(conformedEntry));
});
```

## DoD (Codex)
1. Aplicar los 3 cambios + los 3 tests exactos.
2. `node --test` verde en: `packages/storage/src/episodic-scratch.test.ts` (31/31) · `apps/gateway-api/src/skill-schemas.test.ts` (→4/4 con los nuevos) · `apps/gateway-api/src/routes/openclaw-episodic-memory.test.ts` (13/13, `:323` sigue rechazando inyección) · `apps/gateway-api/src/tool-use-processor.test.ts` (30/30) · `apps/gateway-api/src/routes/orchestrator-smtp.test.ts` (61/61). Luego `npm test` (nota: `apps/gateway-api/src/security/approval-token.test.ts` falla SOLO por `/private/tmp` EACCES — artefacto ambiental del sandbox, **NO** regresión; en el Mac de Juanes ≥node24 corre).
3. **Commit atómico:** "Conform agent compact_intent errorMessage+outcomeData at producer (fix chat-compaction 400)".
4. **Deploy** disciplina estándar Delivrix: gateway local restart + `produ` + `push origin produ` (FF). Si este gateway corre también en el deploy Hostinger, sincronizar ahí (no congelar el remoto). Vos conocés la topología.
5. **Re-check funcional:** disparar un run SMTP y confirmar en `.audit/audit-events.jsonl` que la compactación del chat del agente emite `oc.episodic.intent_compacted` (decision=allow, `intentId` `chat:…`) y NO `oc.episodic.compaction_rejected`.

## Nota (fuera de alcance, NO arreglar acá)
`errorClass` (parseado `boundedText` 1..128) **NO es riesgo de 400** — verificado contra el gate: lo valida solo por tipo+longitud (nunca machine-code ni injection-check), y valores benignos e inyección-like ambos PASAN. Tras este fix, **ningún campo del camino chat puede tirar 400**. Queda un hueco LATENTE de content-safety (texto libre/inyección podría persistirse en la columna `errorClass`), pero es content-safety, NO availability/400 → otro backlog, no este fix. La simetría `boundedText`↔`boundedString` ruta/schema es intencional.

## Reportá
SHA del commit + EXIT/counts de las 5 suites + `npm test` + confirmación de deploy/push, y que NO tocaste la ruta, NI el gate, NI la lógica de `machineErrorCode`, NI usaste `@delivrix/storage`.
