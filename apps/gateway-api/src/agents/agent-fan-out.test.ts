import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FAN_OUT_CONCURRENCY,
  MAX_FAN_OUT_CONCURRENCY,
  runFanOut
} from "./agent-fan-out.ts";
import type { AgentSessionManager } from "./agent-session-manager.ts";
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
