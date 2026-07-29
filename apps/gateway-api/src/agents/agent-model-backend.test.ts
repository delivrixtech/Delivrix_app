// Tests de a que cerebro va cada agente, y del modo ensayo.
//
// Lo que protegen: que un despliegue sin configurar no empiece a gastar, que un typo en una env
// var no sea la razon por la que 59 agentes llaman al modelo, y que el ensayo ejecute las tools
// de verdad — que es lo que el modo mock NO hace.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentModelClientFactory,
  envKeyForRole,
  resolveBackendForRole
} from "./agent-model-backend.ts";
import {
  RehearsalAgentModelClient,
  argsForTool,
  parseDiagnosticFacts
} from "./rehearsal-agent-model-client.ts";
import { MockAgentModelClient } from "./bedrock-agent-session.ts";
import { buildDiagnosticInstructions } from "./warmup-fleet-source.ts";

// --- seleccion de backend --------------------------------------------------

test("resolveBackendForRole: sin configurar, todos en mock", () => {
  for (const role of ["warmup", "smtp", "orchestrator"] as const) {
    assert.deepEqual(resolveBackendForRole(role, {}), { backend: "mock", source: "default" });
  }
});

test("resolveBackendForRole: el override por rol le gana al global", () => {
  // La decision del owner: OpenClaw en Claude, el warmup donde convenga.
  const env = { MULTI_AGENT_MODE: "bedrock", MULTI_AGENT_MODE_WARMUP: "local" };
  assert.deepEqual(resolveBackendForRole("warmup", env), { backend: "local", source: "role_override" });
  assert.deepEqual(resolveBackendForRole("smtp", env), { backend: "bedrock", source: "global" });
});

test("resolveBackendForRole: un valor invalido cae al default seguro y se reporta", () => {
  // Un typo no puede ser la razon por la que el abanico empieza a gastar.
  assert.deepEqual(resolveBackendForRole("warmup", { MULTI_AGENT_MODE: "bedrok" }), {
    backend: "mock",
    source: "default",
    invalidValue: "bedrok"
  });
  assert.deepEqual(resolveBackendForRole("warmup", { MULTI_AGENT_MODE_WARMUP: "claude" }), {
    backend: "mock",
    source: "default",
    invalidValue: "claude"
  });
});

test("envKeyForRole: el guion del rol se vuelve guion bajo", () => {
  assert.equal(envKeyForRole("qa-security"), "MULTI_AGENT_MODE_QA_SECURITY");
  assert.equal(envKeyForRole("warmup"), "MULTI_AGENT_MODE_WARMUP");
});

test("createAgentModelClientFactory: el default construye el mock, sin credenciales", () => {
  const factory = createAgentModelClientFactory({ env: {} });
  assert.equal(factory("warmup") instanceof MockAgentModelClient, true);
});

test("createAgentModelClientFactory: local falla explicito mientras no exista", () => {
  const factory = createAgentModelClientFactory({ env: { MULTI_AGENT_MODE_WARMUP: "local" } });
  assert.throws(
    () => factory("warmup"),
    (error: unknown) => (error as { code?: string }).code === "agent_local_backend_not_wired"
  );
});

test("createAgentModelClientFactory: bedrock sin credenciales falla al construir, no en la primera llamada", () => {
  const factory = createAgentModelClientFactory({
    env: { MULTI_AGENT_MODE: "bedrock", MULTI_AGENT_MODEL_ID: "us.anthropic.claude-sonnet-4-6-v1:0" }
  });
  assert.throws(
    () => factory("warmup"),
    (error: unknown) => (error as { code?: string }).code === "agent_model_credentials_missing"
  );
});

test("createAgentModelClientFactory: cada sesion de ensayo arranca con su propio cursor", () => {
  // Cachear el cliente de ensayo haria que la segunda sesion arranque con las tools consumidas.
  const factory = createAgentModelClientFactory({ env: { MULTI_AGENT_MODE: "rehearsal" } });
  const first = factory("warmup");
  const second = factory("warmup");
  assert.notEqual(first, second);
  assert.equal(first instanceof RehearsalAgentModelClient, true);
});

test("createAgentModelClientFactory: avisa una sola vez por rol donde quedo cada agente", () => {
  const seen: Array<{ role: string; backend: string }> = [];
  const factory = createAgentModelClientFactory({
    env: {},
    onBackendResolved: ({ role, resolved }) => seen.push({ role, backend: resolved.backend })
  });
  factory("warmup");
  factory("warmup");
  factory("smtp");
  assert.deepEqual(seen, [
    { role: "warmup", backend: "mock" },
    { role: "smtp", backend: "mock" }
  ]);
});

// --- lectura de los datos del nodo -----------------------------------------

test("parseDiagnosticFacts: lee lo que buildDiagnosticInstructions escribe", () => {
  // Las dos puntas estan en el repo: si una cambia el formato, este test se pone rojo.
  const instructions = buildDiagnosticInstructions({
    domain: "filing-ops.com",
    serverSlug: "contabo-3-node-7",
    serverIp: "203.0.113.44",
    hasCredential: true,
    recentMessageId: "<delivrix-abc123@filing-ops.com>"
  });

  assert.deepEqual(parseDiagnosticFacts(instructions), {
    domain: "filing-ops.com",
    serverSlug: "contabo-3-node-7",
    serverIp: "203.0.113.44",
    messageId: "<delivrix-abc123@filing-ops.com>"
  });
});

test("parseDiagnosticFacts: sin messageId no inventa uno", () => {
  const instructions = buildDiagnosticInstructions({
    domain: "a.com",
    serverSlug: "nodo-1",
    serverIp: "198.51.100.9",
    hasCredential: false
  });

  const facts = parseDiagnosticFacts(instructions);
  assert.equal(facts.messageId, undefined);
  assert.equal(facts.domain, "a.com");
});

test("argsForTool: si falta un requerido devuelve null en vez de completar con cualquier cosa", () => {
  const schema = { properties: { serverSlug: {}, serverIp: {}, messageId: {} }, required: ["serverSlug", "serverIp", "messageId"] };

  assert.equal(argsForTool(schema, { serverSlug: "n1", serverIp: "1.2.3.4" }), null);
  assert.deepEqual(argsForTool(schema, { serverSlug: "n1", serverIp: "1.2.3.4", messageId: "<m@a>" }), {
    serverSlug: "n1",
    serverIp: "1.2.3.4",
    messageId: "<m@a>"
  });
});

// --- el ensayo recorre de verdad -------------------------------------------

const DIAGNOSTIC_TOOLS = [
  { name: "read_smtp_reachability", description: "", input_schema: { type: "object", properties: { serverSlug: {}, serverIp: {} }, required: ["serverSlug", "serverIp"] } },
  { name: "read_delivery_reason", description: "", input_schema: { type: "object", properties: { serverSlug: {}, serverIp: {}, messageId: {} }, required: ["serverSlug", "serverIp", "messageId"] } },
  { name: "read_dkim_status", description: "", input_schema: { type: "object", properties: { domain: {}, expectedSelector: {} }, required: ["domain"] } },
  { name: "read_mxtoolbox_health", description: "", input_schema: { type: "object", properties: { target: {}, type: {} }, required: ["target"] } },
  { name: "inspect_smtp_inventory", description: "", input_schema: { type: "object", properties: { domain: {}, serverSlug: {}, status: {} }, required: [] } }
];

async function walk(client: RehearsalAgentModelClient, instructions: string): Promise<{ names: string[]; finalText: string }> {
  const names: string[] = [];
  let finalText = "";
  for (let i = 0; i < 10; i += 1) {
    const result = await client.invoke({
      system: "s",
      messages: [{ role: "user", content: instructions }],
      tools: DIAGNOSTIC_TOOLS
    });
    if (result.stopReason !== "tool_use") { finalText = result.text; break; }
    names.push(result.toolUses[0]!.toolName);
  }
  return { names, finalText };
}

test("ensayo: ejecuta las 5 tools reales, una por turno — lo que el mock NO hace", async () => {
  // El contraste es el punto. MockAgentModelClient cierra en la iteracion 0 con cero tools.
  const mock = await new MockAgentModelClient().invoke({ system: "s", messages: [{ role: "user", content: "x" }], tools: DIAGNOSTIC_TOOLS });
  assert.equal(mock.stopReason, "end_turn");
  assert.equal(mock.toolUses.length, 0, "el mock no ejecuta ni una tool");

  const instructions = buildDiagnosticInstructions({
    domain: "filing-ops.com",
    serverSlug: "contabo-3-node-7",
    serverIp: "203.0.113.44",
    hasCredential: true,
    recentMessageId: "<delivrix-abc@filing-ops.com>"
  });

  const { names } = await walk(new RehearsalAgentModelClient(), instructions);
  assert.deepEqual(names, [
    "read_smtp_reachability",
    "read_delivery_reason",
    "read_dkim_status",
    "read_mxtoolbox_health",
    "inspect_smtp_inventory"
  ]);
});

test("ensayo: sin messageId saltea read_delivery_reason en vez de inventarlo", async () => {
  const instructions = buildDiagnosticInstructions({
    domain: "a.com",
    serverSlug: "nodo-1",
    serverIp: "198.51.100.9",
    hasCredential: true
  });

  const { names, finalText } = await walk(new RehearsalAgentModelClient(), instructions);
  assert.equal(names.includes("read_delivery_reason"), false);
  assert.equal(names.length, 4);
  assert.match(finalText, /Salteadas por falta de datos del nodo: read_delivery_reason/);
});

test("ensayo: los parametros salen de los datos del nodo, no inventados", async () => {
  const instructions = buildDiagnosticInstructions({
    domain: "filing-ops.com",
    serverSlug: "contabo-3-node-7",
    serverIp: "203.0.113.44",
    hasCredential: true
  });

  const client = new RehearsalAgentModelClient();
  const first = await client.invoke({ system: "s", messages: [{ role: "user", content: instructions }], tools: DIAGNOSTIC_TOOLS });

  assert.deepEqual(first.toolUses[0]!.toolInput, { serverSlug: "contabo-3-node-7", serverIp: "203.0.113.44" });
});

test("ensayo: reporta cero tokens y dice que no es un diagnostico", async () => {
  // Cero modelo, cero tokens: el costo estimado de la sesion tiene que dar 0, no un numero
  // de mentira con precio de Sonnet.
  const client = new RehearsalAgentModelClient();
  const result = await client.invoke({ system: "s", messages: [{ role: "user", content: "sin datos" }], tools: [] });

  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
  assert.match(result.text, /ENSAYO/);
  assert.match(result.text, /no es un diagnostico/);
});
