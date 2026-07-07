import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, AgentRole, CanvasLiveEvent } from "../../../../packages/domain/src/index.ts";
import { MockAgentModelClient, type MockScriptStep } from "./bedrock-agent-session.ts";
import { createMultiAgentRuntime, declaredToolSpecsForRole } from "./multi-agent-runtime.ts";

function runtimeWithScripts(scripts: Partial<Record<AgentRole, MockScriptStep[]>>, extra: {
  canvasEvents?: CanvasLiveEvent[];
} = {}) {
  return createMultiAgentRuntime({
    env: {},
    ...(extra.canvasEvents
      ? { canvasLive: { emit: async (event: CanvasLiveEvent) => { extra.canvasEvents!.push(event); } } }
      : {}),
    modelClientFactory: (role) => new MockAgentModelClient({ script: scripts[role] ?? [] })
  });
}

test("flujo E2E mock: operador → orquestador delega a DNS → resultado vuelve al orquestador", async () => {
  const canvasEvents: CanvasLiveEvent[] = [];
  const runtime = runtimeWithScripts({
    orchestrator: [
      { kind: "tool_use", toolName: "delegate_to_dns", toolInput: { task: "registra delivrix-prod-001.com con DNS completo" } },
      { kind: "text", text: "DNS Senior terminó; dominio en curso." }
    ],
    dns: [
      { kind: "text", text: "[dns-senior] dry-run de registro listo, requiere firma." }
    ]
  }, { canvasEvents });

  const outcome = await runtime.orchestrator.handleOperatorInstruction(
    "Compra el dominio delivrix-prod-001.com y déjalo con DNS completo"
  );

  assert.equal(outcome.result.status, "completed");
  assert.equal(outcome.delegations.length, 1);
  assert.equal(outcome.delegations[0].role, "dns");
  assert.equal(outcome.delegations[0].status, "completed");
  assert.ok(outcome.delegations[0].resultSummary.includes("dns-senior"));

  // Dos sesiones vivas registradas: orquestador + dns.
  const roles = runtime.sessionManager.listSessions().map((session) => session.agentRole).sort();
  assert.deepEqual(roles, ["dns", "orchestrator"]);

  // El canvas recibió la task raíz y la subtarea del especialista.
  const declares = canvasEvents.filter((event) => event.type === "oc.task.declare");
  assert.ok(declares.some((event) => event.type === "oc.task.declare" && event.taskId === outcome.taskId));
  assert.ok(declares.some((event) =>
    event.type === "oc.task.declare" && event.parentTaskId === outcome.delegations[0].taskId
  ));
});

test("los 5 agentes están declarados con sus tool specs (16+9+10+8+12)", () => {
  const runtime = runtimeWithScripts({});
  assert.equal(runtime.mode, "mock");
  assert.equal(declaredToolSpecsForRole("orchestrator").length, 16);
  assert.equal(declaredToolSpecsForRole("dns").length, 9);
  assert.equal(declaredToolSpecsForRole("smtp").length, 10);
  assert.equal(declaredToolSpecsForRole("warmup").length, 8);
  assert.equal(declaredToolSpecsForRole("qa-security").length, 12);
});

test("register_task y update_task_status mantienen el tablero del orquestador", async () => {
  const runtime = runtimeWithScripts({
    orchestrator: [
      { kind: "tool_use", toolName: "register_task", toolInput: { taskId: "sub-1", title: "Plan warmup", priority: "high" } },
      { kind: "tool_use", toolName: "update_task_status", toolInput: { taskId: "sub-1", status: "completed", note: "hecho" } },
      { kind: "text", text: "Tablero actualizado." }
    ]
  });

  await runtime.orchestrator.handleOperatorInstruction("Organiza el warmup");

  const subTask = runtime.orchestrator.listTasks().find((task) => task.taskId === "sub-1");
  assert.ok(subTask);
  assert.equal(subTask.status, "completed");
  assert.deepEqual(subTask.notes, ["hecho"]);
});

test("escalate_to_operator queda registrado en el outcome", async () => {
  const runtime = runtimeWithScripts({
    orchestrator: [
      { kind: "tool_use", toolName: "escalate_to_operator", toolInput: { severity: "high", message: "bounce rate 8%" } },
      { kind: "text", text: "Escalado." }
    ]
  });
  const outcome = await runtime.orchestrator.handleOperatorInstruction("Revisa el warmup");
  assert.equal(outcome.escalations.length, 1);
  assert.equal(outcome.escalations[0].severity, "high");
});

test("pause_all_agents bloquea delegaciones posteriores dentro del mismo run", async () => {
  const runtime = runtimeWithScripts({
    orchestrator: [
      { kind: "tool_use", toolName: "pause_all_agents", toolInput: {} },
      { kind: "tool_use", toolName: "delegate_to_smtp", toolInput: { task: "instala stack" } },
      { kind: "text", text: "fin" }
    ]
  });

  const outcome = await runtime.orchestrator.handleOperatorInstruction("Pausa todo y luego intenta delegar");

  assert.equal(outcome.delegations.length, 0);
  assert.ok(runtime.sessionManager.isPaused);
});

test("delegate sin task devuelve error explícito al modelo (no delega)", async () => {
  const events: AgentEvent[] = [];
  const runtime = runtimeWithScripts({
    orchestrator: [
      { kind: "tool_use", toolName: "delegate_to_warmup", toolInput: {} },
      { kind: "text", text: "fin" }
    ]
  });
  runtime.eventBus.subscribe((event) => events.push(event));

  const outcome = await runtime.orchestrator.handleOperatorInstruction("Delegación vacía");

  assert.equal(outcome.delegations.length, 0);
  const toolResult = events.find((event) => event.type === "agent.tool_result" && event.agentRole === "orchestrator");
  assert.ok(toolResult && toolResult.type === "agent.tool_result");
  if (toolResult.type === "agent.tool_result") {
    assert.equal(toolResult.success, false);
    assert.ok(toolResult.error?.includes("delegation_instructions_required"));
  }
});

test("tools aún no cableadas responden not_wired sin romper la sesión", async () => {
  const runtime = runtimeWithScripts({
    orchestrator: [
      { kind: "tool_use", toolName: "request_signature", toolInput: { auditId: "a-1" } },
      { kind: "text", text: "Cierro sin firma." }
    ]
  });
  const outcome = await runtime.orchestrator.handleOperatorInstruction("Pide firma");
  assert.equal(outcome.result.status, "completed");
});
