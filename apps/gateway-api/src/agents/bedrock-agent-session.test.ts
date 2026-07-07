import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../../../packages/domain/src/index.ts";
import { AGENT_DEFINITIONS } from "./agent-registry.ts";
import { AgentEventBus } from "./agent-event-bus.ts";
import {
  AgentSessionError,
  BedrockAgentSession,
  MockAgentModelClient,
  createAgentModelClient,
  resolveMultiAgentRuntimeMode
} from "./bedrock-agent-session.ts";

function errorWithCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AgentSessionError && error.code === code;
}

function collectBus(): { bus: AgentEventBus; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const bus = new AgentEventBus({});
  bus.subscribe((event) => events.push(event));
  return { bus, events };
}

test("sesión mock completa: started → thinking → heartbeat → completed", async () => {
  const { bus, events } = collectBus();
  const session = new BedrockAgentSession({
    definition: AGENT_DEFINITIONS.dns,
    taskId: "task-dns-1",
    delegatedBy: "openclaw-orchestrator",
    modelClient: new MockAgentModelClient(),
    eventBus: bus
  });

  const result = await session.run("Verifica la propagación DNS de ejemplo.com");

  assert.equal(result.status, "completed");
  assert.ok(result.resultSummary.includes("[dry-run]"));
  assert.deepEqual(
    events.map((event) => event.type),
    ["agent.started", "agent.thinking", "agent.heartbeat", "agent.completed"]
  );
  assert.equal(session.currentStatus, "completed");
  assert.ok(session.tokensUsed > 0);
  assert.ok(session.estimatedCostUsd > 0);
});

test("tool_use guionado dentro de scope pasa por el toolExecutor y emite tool_result", async () => {
  const { bus, events } = collectBus();
  const executed: string[] = [];
  const session = new BedrockAgentSession({
    definition: AGENT_DEFINITIONS.dns,
    taskId: "task-dns-2",
    delegatedBy: "openclaw-orchestrator",
    modelClient: new MockAgentModelClient({
      script: [
        { kind: "tool_use", toolName: "dns_propagation_verify", toolInput: { domain: "ejemplo.com" } },
        { kind: "text", text: "Propagación verificada." }
      ]
    }),
    eventBus: bus,
    toolExecutor: async ({ toolName }) => {
      executed.push(toolName);
      return { success: true, content: JSON.stringify({ ok: true, propagated: true }) };
    }
  });

  const result = await session.run("Verifica propagación");

  assert.equal(result.status, "completed");
  assert.deepEqual(executed, ["dns_propagation_verify"]);
  const toolResult = events.find((event) => event.type === "agent.tool_result");
  assert.ok(toolResult && toolResult.type === "agent.tool_result" && toolResult.success);
});

test("tool fuera del scope del rol se rechaza sin ejecutar (matriz de permisos)", async () => {
  const { bus, events } = collectBus();
  const executed: string[] = [];
  const session = new BedrockAgentSession({
    definition: AGENT_DEFINITIONS.dns,
    taskId: "task-dns-3",
    delegatedBy: "openclaw-orchestrator",
    modelClient: new MockAgentModelClient({
      script: [
        { kind: "tool_use", toolName: "install_smtp_stack", toolInput: {} },
        { kind: "text", text: "fin" }
      ]
    }),
    eventBus: bus,
    toolExecutor: async ({ toolName }) => {
      executed.push(toolName);
      return { success: true, content: "{}" };
    }
  });

  await session.run("Intento de escalation");

  assert.deepEqual(executed, [], "el executor no debe correr para tools fuera de scope");
  const toolResult = events.find((event) => event.type === "agent.tool_result");
  assert.ok(toolResult && toolResult.type === "agent.tool_result");
  if (toolResult.type === "agent.tool_result") {
    assert.equal(toolResult.success, false);
    assert.ok(toolResult.error?.includes("tool_out_of_scope"));
  }
});

test("hard cap de tokens: la sesión se auto-pausa y avisa (kill switch suave)", async () => {
  const { bus, events } = collectBus();
  const session = new BedrockAgentSession({
    definition: { ...AGENT_DEFINITIONS.smtp, maxSessionTokens: 500 },
    taskId: "task-smtp-1",
    delegatedBy: "openclaw-orchestrator",
    modelClient: new MockAgentModelClient({
      inputTokensPerCall: 400,
      outputTokensPerCall: 200
    }),
    eventBus: bus
  });

  const result = await session.run("Instala el stack");

  assert.equal(result.status, "paused");
  assert.ok(result.resultSummary.includes("token_hard_cap"));
  assert.equal(session.currentStatus, "paused");
  const failed = events.find((event) => event.type === "agent.failed");
  assert.ok(failed && failed.type === "agent.failed" && failed.reason.includes("token_hard_cap"));
});

test("una sesión no es reutilizable: segunda run lanza error explícito", async () => {
  const { bus } = collectBus();
  const session = new BedrockAgentSession({
    definition: AGENT_DEFINITIONS.warmup,
    taskId: "task-warmup-1",
    delegatedBy: "openclaw-orchestrator",
    modelClient: new MockAgentModelClient(),
    eventBus: bus
  });
  await session.run("primera");
  await assert.rejects(() => session.run("segunda"), errorWithCode("agent_session_already_used"));
});

test("el costo estimado usa pricing de la spec ($3/M input, $15/M output)", async () => {
  const { bus } = collectBus();
  const session = new BedrockAgentSession({
    definition: AGENT_DEFINITIONS.warmup,
    taskId: "task-warmup-2",
    delegatedBy: "openclaw-orchestrator",
    modelClient: new MockAgentModelClient({ inputTokensPerCall: 1_000_000, outputTokensPerCall: 0 }),
    eventBus: bus
  });
  // 1M input tokens supera el cap default (50K) → paused, pero el costo se calcula igual.
  const result = await session.run("costos");
  assert.equal(result.inputTokens, 1_000_000);
  assert.equal(result.estimatedCostUsd, 3);
});

test("createAgentModelClient: default mock, modo bedrock sin factory falla explícito", () => {
  assert.equal(resolveMultiAgentRuntimeMode({}), "mock");
  assert.equal(resolveMultiAgentRuntimeMode({ MULTI_AGENT_MODE: "bedrock" }), "bedrock");

  const mock = createAgentModelClient({ env: {} });
  assert.equal(mock.modelId, "mock/dry-run");

  assert.throws(
    () => createAgentModelClient({ env: { MULTI_AGENT_MODE: "bedrock" } }),
    errorWithCode("bedrock_agent_client_not_wired")
  );
});

test("snapshot expone tokens, costo y último evento para el panel", async () => {
  const { bus } = collectBus();
  const session = new BedrockAgentSession({
    definition: AGENT_DEFINITIONS["qa-security"],
    taskId: "task-qa-1",
    parentTaskId: "task-root",
    delegatedBy: "openclaw-orchestrator",
    modelClient: new MockAgentModelClient(),
    eventBus: bus
  });
  await session.run("Audita el dry-run audit-77");
  const snapshot = session.snapshot();
  assert.equal(snapshot.agentRole, "qa-security");
  assert.equal(snapshot.parentTaskId, "task-root");
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.lastEventType, "agent.completed");
  assert.ok(snapshot.inputTokens > 0);
  assert.ok(snapshot.estimatedCostUsd >= 0);
});
