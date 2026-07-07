import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentEvent,
  AuditEventInput,
  CanvasLiveEvent
} from "../../../../packages/domain/src/index.ts";
import { AgentEventBus, agentEventToCanvasLiveEvents, canvasTaskIdForAgent } from "./agent-event-bus.ts";

function startedEvent(): AgentEvent {
  return {
    type: "agent.started",
    agentRole: "dns",
    taskId: "task-001",
    sessionId: "sess-abc",
    occurredAt: "2026-07-06T10:00:00.000Z",
    modelId: "mock/dry-run"
  };
}

test("publish notifica a los suscriptores y proyecta a canvas-live y audit", async () => {
  const canvasEvents: CanvasLiveEvent[] = [];
  const auditEvents: AuditEventInput[] = [];
  const seen: AgentEvent[] = [];
  const bus = new AgentEventBus({
    canvasLive: { emit: async (event) => { canvasEvents.push(event); } },
    auditLog: { append: async (event) => { auditEvents.push(event); } }
  });
  bus.subscribe((event) => seen.push(event));

  await bus.publish(startedEvent());

  assert.equal(seen.length, 1);
  assert.equal(canvasEvents.length, 1);
  assert.equal(canvasEvents[0].type, "oc.task.declare");
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].action, "oc.agent.started");
  assert.equal(auditEvents[0].actorId, "openclaw-agent/dns");
});

test("los sinks que fallan no rompen el publish (fail-soft, filosofía Bloque 8)", async () => {
  const errors: string[] = [];
  const bus = new AgentEventBus({
    canvasLive: { emit: async () => { throw new Error("gateway offline"); } },
    auditLog: { append: async () => { throw new Error("audit offline"); } },
    logError: (message) => errors.push(message)
  });
  await bus.publish(startedEvent());
  assert.equal(errors.length, 2);
});

test("mapping agent.* → oc.*: especialista declara subtarea colgando del task del orquestador", () => {
  const events = agentEventToCanvasLiveEvents(startedEvent(), "openclaw-multi-agent");
  assert.equal(events.length, 1);
  const declared = events[0];
  assert.equal(declared.type, "oc.task.declare");
  if (declared.type === "oc.task.declare") {
    assert.equal(declared.taskId, "task-001--dns");
    assert.equal(declared.parentTaskId, "task-001");
    assert.ok(declared.title.includes("DNS Senior"));
    assert.equal(declared.status, "running");
  }
});

test("mapping: el orquestador usa el taskId raíz sin sufijo", () => {
  assert.equal(canvasTaskIdForAgent({ agentRole: "orchestrator", taskId: "task-9" }), "task-9");
  assert.equal(canvasTaskIdForAgent({ agentRole: "warmup", taskId: "task-9" }), "task-9--warmup");
});

test("mapping: completed/failed/awaiting_signature actualizan el estado de la tarea canvas", () => {
  const completed = agentEventToCanvasLiveEvents({
    type: "agent.completed",
    agentRole: "orchestrator",
    taskId: "task-2",
    sessionId: "sess-2",
    occurredAt: "2026-07-06T10:05:00.000Z",
    resultSummary: "listo",
    auditChainHashes: []
  }, "actor");
  assert.deepEqual(completed.map((event) => event.type), ["oc.task.update"]);

  const failed = agentEventToCanvasLiveEvents({
    type: "agent.failed",
    agentRole: "smtp",
    taskId: "task-3",
    sessionId: "sess-3",
    occurredAt: "2026-07-06T10:06:00.000Z",
    reason: "boom",
    evidenceRefs: []
  }, "actor");
  assert.deepEqual(failed.map((event) => event.type), ["oc.action.now", "oc.task.update"]);

  const awaiting = agentEventToCanvasLiveEvents({
    type: "agent.awaiting_signature",
    agentRole: "dns",
    taskId: "task-4",
    sessionId: "sess-4",
    occurredAt: "2026-07-06T10:07:00.000Z",
    auditId: "audit-1",
    expiresAt: "2026-07-06T11:00:00.000Z"
  }, "actor");
  const update = awaiting.find((event) => event.type === "oc.task.update");
  assert.ok(update && update.type === "oc.task.update" && update.status === "awaiting_approval");
});

test("mapping tool_use: no filtra el toolInput crudo al audit sink (solo el shape)", async () => {
  const auditEvents: AuditEventInput[] = [];
  const bus = new AgentEventBus({
    auditLog: { append: async (event) => { auditEvents.push(event); } }
  });
  await bus.publish({
    type: "agent.tool_use",
    agentRole: "smtp",
    taskId: "task-5",
    sessionId: "sess-5",
    occurredAt: "2026-07-06T10:08:00.000Z",
    toolName: "configure_postfix",
    toolInput: { serverSlug: "node-1", password: "hunter2" }
  });
  assert.equal(auditEvents.length, 1);
  const metadata = auditEvents[0].metadata;
  assert.equal(metadata.toolInput, undefined);
  assert.deepEqual(metadata.toolInputKeys, ["serverSlug", "password"]);
});
