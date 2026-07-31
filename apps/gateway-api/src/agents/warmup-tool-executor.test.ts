import assert from "node:assert/strict";
import test from "node:test";

import {
  WARMUP_DIAGNOSTIC_TOOLS,
  createAgentToolExecutor,
  diagnosticToolsForRole,
  warmupDiagnosticToolExecutor,
  type HttpToolUseProcessor
} from "./warmup-tool-executor.ts";
import type { BedrockAgentSession } from "./bedrock-agent-session.ts";

function fakeSession(sessionId = "sess-1"): BedrockAgentSession {
  return {
    sessionId,
    definition: { role: "warmup" }
  } as unknown as BedrockAgentSession;
}

function recordingProcessor(
  reply: Awaited<ReturnType<HttpToolUseProcessor>> | ((toolName: string) => Awaited<ReturnType<HttpToolUseProcessor>>)
): { processor: HttpToolUseProcessor; calls: Array<{ toolName: string; chatSessionId: string; timeoutMs?: number }> } {
  const calls: Array<{ toolName: string; chatSessionId: string; timeoutMs?: number }> = [];
  const processor: HttpToolUseProcessor = async (input) => {
    calls.push({
      toolName: input.toolName,
      chatSessionId: input.chatSession.id,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
    });
    return typeof reply === "function" ? reply(input.toolName) : reply;
  };
  return { processor, calls };
}

test("una tool fuera del alcance del rol no llega al processor", async () => {
  // Segunda barrera: la sesion ya corta por spec, pero el spec sale de config y esto del
  // codigo. Si divergen, gana el mas restrictivo.
  const { processor, calls } = recordingProcessor({ ok: true, status: "executed", result: {} });
  const executor = warmupDiagnosticToolExecutor(processor);

  const outcome = await executor({
    session: fakeSession(),
    toolUseId: "tu-1",
    toolName: "send_real_email",
    toolInput: {}
  });

  assert.equal(outcome.success, false);
  assert.match(outcome.error ?? "", /tool_not_allowed_for_role/);
  assert.match(outcome.error ?? "", /send_real_email/);
  assert.equal(calls.length, 0, "no debio tocar el processor");
});

test("las 5 tools de diagnostico si pasan, con el sessionId del agente como actor", async () => {
  const { processor, calls } = recordingProcessor({
    ok: true,
    status: "executed",
    result: { verdict: "ok" }
  });
  const executor = warmupDiagnosticToolExecutor(processor);

  for (const toolName of WARMUP_DIAGNOSTIC_TOOLS) {
    const outcome = await executor({
      session: fakeSession("sess-abanico-7"),
      toolUseId: `tu-${toolName}`,
      toolName,
      toolInput: { domain: "x.com" }
    });
    assert.equal(outcome.success, true, `${toolName} deberia pasar`);
  }

  assert.equal(calls.length, WARMUP_DIAGNOSTIC_TOOLS.length);
  // El actor es el agente, no un chat: es lo que permite separar quien hizo que en el audit.
  assert.ok(calls.every((call) => call.chatSessionId === "sess-abanico-7"));
});

test("un error del processor vuelve como tool_result de error, no como excepcion", async () => {
  // El kill switch armado llega por aca: processToolUse devuelve ok:false antes de la red.
  const { processor } = recordingProcessor({ ok: false, error: "kill_switch_armed" });
  const executor = warmupDiagnosticToolExecutor(processor);

  const outcome = await executor({
    session: fakeSession(),
    toolUseId: "tu-2",
    toolName: "read_dkim_status",
    toolInput: { domain: "x.com" }
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.error, "kill_switch_armed");
});

test("una excepcion del processor no tumba la sesion del agente", async () => {
  // Sin esto, un ECONNREFUSED contra el gateway mata al agente entero en vez de darle la
  // chance de cerrar con la evidencia que ya junto.
  const executor = warmupDiagnosticToolExecutor(async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:3000");
  });

  const outcome = await executor({
    session: fakeSession(),
    toolUseId: "tu-3",
    toolName: "read_delivery_reason",
    toolInput: {}
  });

  assert.equal(outcome.success, false);
  assert.match(outcome.error ?? "", /tool_execution_threw/);
  assert.match(outcome.error ?? "", /ECONNREFUSED/);
});

test("el resultado se serializa para el modelo, y un string se pasa tal cual", async () => {
  const objeto = warmupDiagnosticToolExecutor(async () => ({
    ok: true,
    status: "executed",
    result: { reason: "550-5.7.1 unsolicited", ip: "192.0.2.1" }
  }));
  const conObjeto = await objeto({
    session: fakeSession(),
    toolUseId: "tu-4",
    toolName: "read_delivery_reason",
    toolInput: {}
  });
  assert.equal(conObjeto.success, true);
  assert.deepEqual(JSON.parse(conObjeto.content), {
    reason: "550-5.7.1 unsolicited",
    ip: "192.0.2.1"
  });

  const texto = warmupDiagnosticToolExecutor(async () => ({
    ok: true,
    status: "executed",
    result: "sin entregas en las ultimas 24h"
  }));
  const conTexto = await texto({
    session: fakeSession(),
    toolUseId: "tu-5",
    toolName: "read_delivery_reason",
    toolInput: {}
  });
  // Serializarlo lo dejaria con comillas escapadas adentro y el modelo lo lee peor.
  assert.equal(conTexto.content, "sin entregas en las ultimas 24h");
});

test("las tools de escritura NO estan en el alcance del diagnostico", async () => {
  // Es la garantia de que la Fase 1 no manda correo. Si alguien las agrega, este test cae.
  for (const prohibida of ["send_real_email", "seed_warmup_pool", "start_warmup_ramp", "configure_complete_smtp"]) {
    assert.equal(
      (WARMUP_DIAGNOSTIC_TOOLS as readonly string[]).includes(prohibida),
      false,
      `${prohibida} no puede estar en el abanico de diagnostico`
    );
  }
  assert.equal(WARMUP_DIAGNOSTIC_TOOLS.length, 7);
});

test("los roles que todavia no tienen tools reales quedan sin alcance", async () => {
  assert.deepEqual([...diagnosticToolsForRole("warmup")], [...WARMUP_DIAGNOSTIC_TOOLS]);
  for (const role of ["dns", "smtp", "qa-security", "orchestrator"] as const) {
    assert.deepEqual(diagnosticToolsForRole(role), [], `${role} no tiene tools reales todavia`);
  }
});

test("el timeout por tool se propaga al processor", async () => {
  const { processor, calls } = recordingProcessor({ ok: true, status: "executed", result: {} });
  const executor = createAgentToolExecutor({
    processor,
    allowedTools: ["read_dkim_status"],
    timeoutMs: 1234
  });

  await executor({
    session: fakeSession(),
    toolUseId: "tu-6",
    toolName: "read_dkim_status",
    toolInput: {}
  });

  assert.equal(calls[0]?.timeoutMs, 1234);
});
