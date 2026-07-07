import assert from "node:assert/strict";
import test from "node:test";
import { AgentEventBus } from "./agent-event-bus.ts";
import { AgentSessionManager } from "./agent-session-manager.ts";
import { AgentSessionError, MockAgentModelClient } from "./bedrock-agent-session.ts";

function errorWithCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AgentSessionError && error.code === code;
}

function makeManager(overrides: Partial<ConstructorParameters<typeof AgentSessionManager>[0]> = {}): AgentSessionManager {
  return new AgentSessionManager({
    eventBus: new AgentEventBus({}),
    modelClientFactory: () => new MockAgentModelClient(),
    ...overrides
  });
}

test("el operador solo puede invocar al orquestador", async () => {
  const manager = makeManager();
  await assert.rejects(
    () => manager.invokeAgent("dns", {
      taskId: "t1",
      delegatedBy: "operator/juanes",
      instructions: "registra dominio"
    }, { invokedByRole: "operator" }),
    errorWithCode("agent_invoke_forbidden")
  );

  const { result } = await manager.invokeAgent("orchestrator", {
    taskId: "t2",
    delegatedBy: "operator/juanes",
    instructions: "coordina la compra del dominio"
  }, { invokedByRole: "operator" });
  assert.equal(result.status, "completed");
});

test("un especialista no puede invocar a otro agente (ni a QA)", async () => {
  const manager = makeManager();
  for (const target of ["dns", "smtp", "warmup", "qa-security", "orchestrator"] as const) {
    await assert.rejects(
      () => manager.invokeAgent(target, {
        taskId: `t-${target}`,
        delegatedBy: "openclaw-dns",
        instructions: "x"
      }, { invokedByRole: "dns" }),
      errorWithCode("agent_invoke_forbidden")
    );
  }
});

test("el orquestador puede delegar a especialistas pero no a sí mismo", async () => {
  const manager = makeManager();
  const { result } = await manager.invokeAgent("smtp", {
    taskId: "t-smtp",
    delegatedBy: "openclaw-orchestrator",
    instructions: "verifica el stack"
  }, { invokedByRole: "orchestrator", taskChain: ["t-root"] });
  assert.equal(result.status, "completed");

  await assert.rejects(
    () => manager.invokeAgent("orchestrator", {
      taskId: "t-orch",
      delegatedBy: "openclaw-orchestrator",
      instructions: "delégate"
    }, { invokedByRole: "orchestrator" }),
    errorWithCode("agent_invoke_forbidden")
  );
});

test("detección de ciclos por cadena de taskIds y profundidad máxima", async () => {
  const manager = makeManager({ maxDelegationDepth: 2 });

  await assert.rejects(
    () => manager.invokeAgent("dns", {
      taskId: "t-a",
      delegatedBy: "openclaw-orchestrator",
      instructions: "x"
    }, { invokedByRole: "orchestrator", taskChain: ["t-root", "t-a"] }),
    errorWithCode("agent_delegation_cycle")
  );

  await assert.rejects(
    () => manager.invokeAgent("dns", {
      taskId: "t-b",
      delegatedBy: "openclaw-orchestrator",
      instructions: "x"
    }, { invokedByRole: "orchestrator", taskChain: ["t-1", "t-2"] }),
    errorWithCode("agent_delegation_too_deep")
  );
});

test("pauseAll bloquea nuevas sesiones hasta resumeAll", async () => {
  const manager = makeManager();
  manager.pauseAll();
  assert.ok(manager.isPaused);
  await assert.rejects(
    () => manager.invokeAgent("orchestrator", {
      taskId: "t-paused",
      delegatedBy: "operator/juanes",
      instructions: "x"
    }, { invokedByRole: "operator" }),
    errorWithCode("multi_agent_runtime_paused")
  );
  manager.resumeAll();
  const { result } = await manager.invokeAgent("orchestrator", {
    taskId: "t-resumed",
    delegatedBy: "operator/juanes",
    instructions: "x"
  }, { invokedByRole: "operator" });
  assert.equal(result.status, "completed");
});

test("rol desconocido se rechaza y listSessions expone los snapshots", async () => {
  const manager = makeManager();
  await assert.rejects(
    () => manager.invokeAgent("dns-senior", {
      taskId: "t-x",
      delegatedBy: "operator/juanes",
      instructions: "x"
    }, { invokedByRole: "operator" }),
    errorWithCode("agent_role_unknown")
  );

  await manager.invokeAgent("orchestrator", {
    taskId: "t-snap",
    delegatedBy: "operator/juanes",
    instructions: "snapshot"
  }, { invokedByRole: "operator" });
  const sessions = manager.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agentRole, "orchestrator");
  assert.equal(sessions[0].status, "completed");
});
