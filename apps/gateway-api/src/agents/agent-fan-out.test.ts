import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FAN_OUT_CONCURRENCY,
  MAX_FAN_OUT_CONCURRENCY,
  runFanOut
} from "./agent-fan-out.ts";
import { AgentInvocationFailed, type AgentSessionManager } from "./agent-session-manager.ts";
import type { AgentInvokeInput } from "../../../../packages/domain/src/index.ts";

/**
 * Manager de mentira: solo necesitamos observar concurrencia y propagacion de errores.
 * `invokeAgent` es lo unico que el fan-out toca.
 */
function fakeManager(input: {
  onInvoke?: (invoke: AgentInvokeInput) => Promise<unknown> | unknown;
  delayMs?: number;
}): { manager: AgentSessionManager; calls: AgentInvokeInput[]; maxInFlight: () => number } {
  const calls: AgentInvokeInput[] = [];
  let inFlight = 0;
  let peak = 0;

  const manager = {
    async invokeAgent(_role: string, invoke: AgentInvokeInput) {
      calls.push(invoke);
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      try {
        // Cede el turno para que los workers se solapen de verdad; sin esto el bucle
        // sincronico daria concurrencia 1 y el test pasaria por el motivo equivocado.
        await new Promise((resolve) => setTimeout(resolve, input.delayMs ?? 1));
        await input.onInvoke?.(invoke);
        return { sessionId: `sess-${invoke.taskId}`, result: { status: "completed" } };
      } finally {
        inFlight -= 1;
      }
    }
  } as unknown as AgentSessionManager;

  return { manager, calls, maxInFlight: () => peak };
}

const buildInput = (domain: string): AgentInvokeInput => ({
  taskId: `audit-${domain}`,
  delegatedBy: "supervisor",
  instructions: `Diagnostica ${domain}`
});

test("el semaforo acota la concurrencia real, no solo la declarada", async () => {
  const domains = Array.from({ length: 12 }, (_, i) => `d${i}.com`);
  const { manager, maxInFlight } = fakeManager({ delayMs: 5 });

  const summary = await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: domains,
    buildInput,
    invokedByRole: "orchestrator",
    concurrency: 3
  });

  assert.equal(summary.results.length, 12);
  assert.equal(summary.ok, 12);
  assert.ok(maxInFlight() <= 3, `nunca mas de 3 en vuelo, se observaron ${maxInFlight()}`);
  assert.equal(summary.peakInFlight, maxInFlight(), "el peak reportado coincide con el real");
  assert.ok(summary.peakInFlight > 1, "hubo paralelismo de verdad, no una cola de a uno");
});

test("un item que falla no se lleva puestos a los demas, y el error queda POR ITEM", async () => {
  const domains = Array.from({ length: 10 }, (_, i) => `d${i}.com`);
  const rotos = new Set(["d2.com", "d5.com", "d7.com"]);
  const { manager } = fakeManager({
    onInvoke: (invoke) => {
      const domain = invoke.taskId.replace("audit-", "");
      if (rotos.has(domain)) throw new Error(`ssh_unreachable: ${domain}`);
    }
  });

  const summary = await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: domains,
    buildInput,
    invokedByRole: "orchestrator",
    concurrency: 4
  });

  assert.equal(summary.results.length, 10, "los 10 items reportan, ninguno se pierde");
  assert.equal(summary.ok, 7);
  assert.equal(summary.failed, 3);

  for (const entry of summary.results) {
    if (rotos.has(entry.item)) {
      assert.match(entry.error ?? "", /ssh_unreachable/);
      assert.equal(entry.result, undefined, "un item fallido no trae resultado");
    } else {
      assert.equal(entry.error, undefined);
      assert.ok(entry.sessionId, "un item ok trae su sessionId");
    }
  }
});

test("el resultado sale en orden de ENTRADA, no de finalizacion", async () => {
  // Importa para el reporte: el operador lee la lista contra su inventario.
  const domains = ["lento.com", "rapido.com", "medio.com"];
  const demoras: Record<string, number> = { "lento.com": 20, "rapido.com": 1, "medio.com": 10 };
  const { manager } = fakeManager({
    onInvoke: (invoke) =>
      new Promise((resolve) =>
        setTimeout(resolve, demoras[invoke.taskId.replace("audit-", "")] ?? 1)
      )
  });

  const summary = await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: domains,
    buildInput,
    invokedByRole: "orchestrator",
    concurrency: 3
  });

  assert.deepEqual(summary.results.map((entry) => entry.item), domains);
});

test("cada item recibe su propio taskId: sin colision entre agentes", async () => {
  const domains = ["a.com", "b.com", "c.com"];
  const { manager, calls } = fakeManager({});

  await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: domains,
    buildInput,
    invokedByRole: "orchestrator",
    concurrency: 2
  });

  const taskIds = calls.map((call) => call.taskId);
  assert.equal(new Set(taskIds).size, domains.length, "los taskId son unicos");
});

test("la concurrencia se topea y se valida", async () => {
  const { manager, maxInFlight } = fakeManager({ delayMs: 2 });
  const domains = Array.from({ length: 20 }, (_, i) => `d${i}.com`);

  // Pedir 99 no abre 99 sesiones ssh contra la flota.
  const summary = await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: domains,
    buildInput,
    invokedByRole: "orchestrator",
    concurrency: 99
  });
  assert.ok(maxInFlight() <= MAX_FAN_OUT_CONCURRENCY, `topeado en ${MAX_FAN_OUT_CONCURRENCY}`);
  assert.equal(summary.ok, 20);

  for (const invalida of [0, -1, 2.5]) {
    await assert.rejects(
      () =>
        runFanOut({
          sessionManager: manager,
          role: "warmup",
          items: ["x.com"],
          buildInput,
          invokedByRole: "orchestrator",
          concurrency: invalida
        }),
      /fan_out_concurrency_invalid/
    );
  }
});

test("sin items no invoca a nadie", async () => {
  const { manager, calls } = fakeManager({});

  const summary = await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: [],
    buildInput,
    invokedByRole: "orchestrator"
  });

  assert.equal(calls.length, 0);
  assert.equal(summary.results.length, 0);
  assert.equal(summary.peakInFlight, 0);
  assert.equal(DEFAULT_FAN_OUT_CONCURRENCY, 4, "el default arranca bajo a proposito");
});

test("onItemSettled reporta progreso sin esperar al abanico entero", async () => {
  const domains = ["a.com", "b.com", "c.com", "d.com"];
  const vistos: string[] = [];
  const { manager } = fakeManager({ delayMs: 2 });

  const summary = await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: domains,
    buildInput,
    invokedByRole: "orchestrator",
    concurrency: 2,
    onItemSettled: (entry) => vistos.push(entry.item)
  });

  assert.equal(vistos.length, domains.length);
  assert.deepEqual([...vistos].sort(), [...domains].sort());
  assert.equal(summary.ok, 4);
});

// --- lo que la auditoria adversarial encontro --------------------------------

/** Manager que devuelve el status que se le pida, o tira con gasto ya hecho. */
function managerWithOutcomes(outcome: (domain: string) =>
  | { kind: "result"; status: "completed" | "failed" | "paused"; inputTokens?: number }
  | { kind: "throw"; spentInput: number; spentOutput: number }
): AgentSessionManager {
  return {
    async invokeAgent(_role: string, invoke: AgentInvokeInput) {
      const domain = invoke.taskId.replace("audit-", "");
      const out = outcome(domain);
      if (out.kind === "throw") {
        throw new AgentInvocationFailed(
          `sess-${domain}`,
          {
            sessionId: `sess-${domain}`,
            agentRole: "warmup",
            taskId: invoke.taskId,
            status: "failed",
            modelId: "m",
            startedAt: "",
            updatedAt: "",
            inputTokens: out.spentInput,
            outputTokens: out.spentOutput,
            estimatedCostUsd: 0.5
          },
          new Error("agent_usage_missing")
        );
      }
      return {
        sessionId: `sess-${domain}`,
        result: {
          status: out.status,
          resultSummary: "veredicto",
          inputTokens: out.inputTokens ?? 100,
          outputTokens: 10,
          estimatedCostUsd: 0.01,
          pricingKnown: true
        }
      };
    }
  } as unknown as AgentSessionManager;
}

test("una sesion pausada por el cap de tokens NO cuenta como ok", async () => {
  // invokeAgent no tira cuando la sesion se pausa por el cap de 50.000 tokens: devuelve normal.
  // Contando por "devolvio algo", esas sesiones —las MAS caras— entraban como exito y el
  // operador leia "59 ok, 0 failed" con nodos sin diagnosticar.
  const summary = await runFanOut({
    sessionManager: managerWithOutcomes((d) =>
      d === "b.com" ? { kind: "result", status: "paused" } : { kind: "result", status: "completed" }
    ),
    role: "warmup",
    items: ["a.com", "b.com", "c.com"],
    buildInput,
    invokedByRole: "supervisor"
  });

  assert.equal(summary.ok, 2);
  assert.equal(summary.failed, 1);
});

test("una sesion muerta por max_iterations tampoco cuenta como ok", async () => {
  const summary = await runFanOut({
    sessionManager: managerWithOutcomes(() => ({ kind: "result", status: "failed" })),
    role: "warmup",
    items: ["a.com", "b.com"],
    buildInput,
    invokedByRole: "supervisor"
  });

  assert.equal(summary.ok, 0);
  assert.equal(summary.failed, 2);
});

test("lo que gasto una sesion que tiro no se pierde: Bedrock ya lo facturo", async () => {
  const summary = await runFanOut({
    sessionManager: managerWithOutcomes(() => ({ kind: "throw", spentInput: 4_000, spentOutput: 300 })),
    role: "warmup",
    items: ["a.com"],
    buildInput,
    invokedByRole: "supervisor"
  });

  assert.equal(summary.ok, 0);
  assert.deepEqual(summary.results[0]?.spent, {
    inputTokens: 4_000,
    outputTokens: 300,
    estimatedCostUsd: 0.5
  });
  assert.equal(summary.results[0]?.sessionId, "sess-a.com");
});

// --- cortacircuitos: una falla de infraestructura no se muele 59 veces ------

test("cinco fallas consecutivas iguales cortan el abanico: el resto queda cancelled, no failed", async () => {
  // Caso real del 2026-07-30: el modelo local se descargo a mitad de corrida y los 49 dominios
  // restantes devolvieron el mismo HTTP 400 uno por uno. Cinco minutos, cero diagnosticos, y 49
  // items marcados como si los dominios estuvieran rotos.
  const manager = {
    async invokeAgent(_role: string, invoke: AgentInvokeInput) {
      throw new Error('El modelo local devolvio HTTP 400: {"error":{"message":"No models loaded"}}');
    }
  } as unknown as AgentSessionManager;

  const summary = await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: Array.from({ length: 20 }, (_, i) => `d${i}.com`),
    buildInput,
    invokedByRole: "supervisor",
    concurrency: 1
  });

  assert.equal(summary.aborted, true);
  assert.match(summary.circuitReason ?? "", /fan_out_circuit_open/);
  // 5 se despacharon y fallaron; los 15 restantes no se tocaron.
  assert.equal(summary.failed, 5);
  assert.equal(summary.cancelled, 15);
  // La distincion importa: cancelled = nadie los miro, failed = se probaron y fallaron.
  assert.equal(summary.results[19]?.cancelled, true);
  assert.equal(summary.results[19]?.error, undefined);
});

test("fallas de causas DISTINTAS no abren el cortacircuitos", async () => {
  // Nodos puntualmente rotos son el caso normal del diagnostico: no pueden cortar la corrida.
  let n = 0;
  const manager = {
    async invokeAgent() {
      n += 1;
      throw new Error(`falla distinta numero ${n}: causa_${n}`);
    }
  } as unknown as AgentSessionManager;

  const summary = await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: Array.from({ length: 12 }, (_, i) => `d${i}.com`),
    buildInput,
    invokedByRole: "supervisor",
    concurrency: 1
  });

  assert.equal(summary.aborted, false);
  assert.equal(summary.circuitReason, undefined);
  assert.equal(summary.failed, 12, "todos se intentaron");
});

test("un exito en el medio resetea la racha", async () => {
  let n = 0;
  const manager = {
    async invokeAgent(_role: string, invoke: AgentInvokeInput) {
      n += 1;
      if (n === 4) {
        return {
          sessionId: "s",
          result: { status: "completed", resultSummary: "v", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, pricingKnown: true, toolCallCount: 4 }
        };
      }
      throw new Error("mismo error siempre: infra");
    }
  } as unknown as AgentSessionManager;

  const summary = await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: Array.from({ length: 8 }, (_, i) => `d${i}.com`),
    buildInput,
    invokedByRole: "supervisor",
    concurrency: 1
  });

  // 3 fallas, 1 ok (resetea), y recien a la 5ta falla seguida corta.
  assert.equal(summary.ok, 1);
  assert.equal(summary.aborted, false, "el ok del medio evito el corte");
});
