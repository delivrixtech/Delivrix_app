// Integracion del abanico con las piezas REALES: AgentSessionManager + BedrockAgentSession.
//
// Este archivo existe por un error concreto. La primera verificacion end-to-end del abanico uso
// un manager de mentira que salteaba BedrockAgentSession, y reporto "295 llamadas a tools, 0 de
// escritura". Era falso: la sesion real filtra cada tool_use contra `definition.toolNames`
// (bedrock-agent-session.ts:363), que para warmup son los 8 nombres del diseño original — sin
// interseccion con las 5 reales. El abanico habria pagado 59 sesiones de Bedrock, ejecutado
// CERO tools, y reportado "59 ok".
//
// Un doble que saltea la pieza que hace el trabajo no verifica nada. Aca no hay doble del
// manager ni de la sesion: solo del modelo (guionado) y del processor (para no tocar la red).

import assert from "node:assert/strict";
import test from "node:test";

import { runFanOut } from "./agent-fan-out.ts";
import { AGENT_DEFINITIONS } from "./agent-registry.ts";
import { AgentEventBus } from "./agent-event-bus.ts";
import { AgentSessionManager } from "./agent-session-manager.ts";
import { MockAgentModelClient } from "./bedrock-agent-session.ts";
import {
  WARMUP_DIAGNOSTIC_TOOLS,
  diagnosticDefinitionFor,
  warmupDiagnosticToolExecutor,
  type HttpToolUseProcessor
} from "./warmup-tool-executor.ts";

/** Guion: el agente pide las 5 tools y despues cierra. */
const guionDiagnostico = () =>
  new MockAgentModelClient({
    script: [
      ...WARMUP_DIAGNOSTIC_TOOLS.map((toolName) => ({
        kind: "tool_use" as const,
        toolName,
        toolInput: { serverSlug: "server1", serverIp: "192.0.2.1", domain: "x.com", messageId: "<m@x.com>", target: "x.com" }
      })),
      { kind: "text" as const, text: "veredicto: rechazado_por_destino" }
    ]
  });

function managerReal(input: { conDefinicionDelAbanico: boolean; ejecutadas: string[] }) {
  const processor: HttpToolUseProcessor = async ({ toolName }) => {
    input.ejecutadas.push(toolName);
    return { ok: true, status: "executed", result: { tool: toolName, ok: true } };
  };

  return new AgentSessionManager({
    eventBus: new AgentEventBus({ sinks: [] }),
    modelClientFactory: () => guionDiagnostico(),
    toolExecutorFactory: () => warmupDiagnosticToolExecutor(processor),
    toolSpecsForRole: () =>
      WARMUP_DIAGNOSTIC_TOOLS.map((name) => ({
        name,
        description: `spec de ${name}`,
        input_schema: { type: "object" as const, properties: { domain: { type: "string" } }, required: [] }
      })),
    ...(input.conDefinicionDelAbanico
      ? { definitionForRole: (role) => diagnosticDefinitionFor(role, AGENT_DEFINITIONS[role]) }
      : {})
  });
}

test("SIN la definicion del abanico la sesion real rechaza las 5 tools y aun asi reporta ok", async () => {
  // Este es el defecto que el panel de QA encontro. Se deja como test para que no vuelva.
  const ejecutadas: string[] = [];
  const manager = managerReal({ conDefinicionDelAbanico: false, ejecutadas });

  const out = await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: ["uno.com", "dos.com"],
    buildInput: (domain) => ({ taskId: `audit-${domain}`, delegatedBy: "supervisor", instructions: "diagnostica" }),
    invokedByRole: "orchestrator",
    concurrency: 2
  });

  assert.deepEqual(ejecutadas, [], "la sesion filtra TODO: cero tools ejecutadas");
  assert.equal(out.failed, 0, "y sin embargo el abanico no reporta ni una falla");
  assert.equal(out.ok, 2, "reporta 2 ok — el 'todo verde' falso");
});

test("CON la definicion del abanico la sesion real SI ejecuta las 5 tools por dominio", async () => {
  const ejecutadas: string[] = [];
  const manager = managerReal({ conDefinicionDelAbanico: true, ejecutadas });

  const out = await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: ["uno.com", "dos.com", "tres.com"],
    buildInput: (domain) => ({ taskId: `audit-${domain}`, delegatedBy: "supervisor", instructions: "diagnostica" }),
    invokedByRole: "orchestrator",
    concurrency: 2
  });

  assert.equal(out.ok, 3);
  assert.equal(out.failed, 0);
  assert.equal(
    ejecutadas.length,
    3 * WARMUP_DIAGNOSTIC_TOOLS.length,
    "3 dominios x 5 tools, ejecutadas de verdad por el processor"
  );
  assert.deepEqual(
    [...new Set(ejecutadas)].sort(),
    [...WARMUP_DIAGNOSTIC_TOOLS].sort(),
    "y son exactamente las 5, ninguna de mas"
  );
  assert.ok(out.peakInFlight <= 2, "el semaforo sigue acotando con la sesion real");
});

test("la definicion del abanico NO altera a los otros roles", async () => {
  // El camino conversacional del orquestador tiene que seguir con su definicion original.
  for (const role of ["orchestrator", "dns", "smtp", "qa-security"] as const) {
    const efectiva = diagnosticDefinitionFor(role, AGENT_DEFINITIONS[role]);
    assert.deepEqual(
      efectiva.toolNames,
      AGENT_DEFINITIONS[role].toolNames,
      `${role} conserva su definicion del registry`
    );
  }
  // Y warmup si cambia.
  const warmup = diagnosticDefinitionFor("warmup", AGENT_DEFINITIONS.warmup);
  assert.deepEqual([...warmup.toolNames].sort(), [...WARMUP_DIAGNOSTIC_TOOLS].sort());
});

test("ninguna tool de escritura se ejecuta, ni aunque el modelo la pida", async () => {
  const ejecutadas: string[] = [];
  const processor: HttpToolUseProcessor = async ({ toolName }) => {
    ejecutadas.push(toolName);
    return { ok: true, status: "executed", result: {} };
  };
  const manager = new AgentSessionManager({
    eventBus: new AgentEventBus({ sinks: [] }),
    // Un modelo que insiste con tools de escritura.
    modelClientFactory: () =>
      new MockAgentModelClient({
        script: [
          { kind: "tool_use", toolName: "send_real_email", toolInput: {} },
          { kind: "tool_use", toolName: "seed_warmup_pool", toolInput: {} },
          { kind: "tool_use", toolName: "configure_complete_smtp", toolInput: {} },
          { kind: "tool_use", toolName: "read_dkim_status", toolInput: { domain: "x.com" } },
          { kind: "text", text: "listo" }
        ]
      }),
    toolExecutorFactory: () => warmupDiagnosticToolExecutor(processor),
    definitionForRole: (role) => diagnosticDefinitionFor(role, AGENT_DEFINITIONS[role])
  });

  await runFanOut({
    sessionManager: manager,
    role: "warmup",
    items: ["x.com"],
    buildInput: () => ({ taskId: "t", delegatedBy: "supervisor", instructions: "i" }),
    invokedByRole: "orchestrator"
  });

  assert.deepEqual(ejecutadas, ["read_dkim_status"], "solo la de lectura llego al processor");
});
