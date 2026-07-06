import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_DEFINITIONS,
  assertAgentRegistryIntegrity,
  getAgentDefinition,
  listAgentDefinitions
} from "./agent-registry.ts";

test("registry declara los 5 agentes seniors con sus tool counts (16+9+10+8+12)", () => {
  const definitions = listAgentDefinitions();
  assert.equal(definitions.length, 5);
  assert.equal(AGENT_DEFINITIONS.orchestrator.toolNames.length, 16);
  assert.equal(AGENT_DEFINITIONS.dns.toolNames.length, 9);
  assert.equal(AGENT_DEFINITIONS.smtp.toolNames.length, 10);
  assert.equal(AGENT_DEFINITIONS.warmup.toolNames.length, 8);
  assert.equal(AGENT_DEFINITIONS["qa-security"].toolNames.length, 12);
  const total = definitions.reduce((sum, definition) => sum + definition.toolNames.length, 0);
  assert.equal(total, 55);
});

test("solo el orquestador puede delegar; qa-security es read-only", () => {
  for (const definition of listAgentDefinitions()) {
    if (definition.role === "orchestrator") {
      assert.ok(definition.canDelegate);
    } else {
      assert.ok(!definition.canDelegate, `${definition.role} no debe delegar`);
    }
  }
  assert.ok(AGENT_DEFINITIONS["qa-security"].readOnly);
  assert.ok(!AGENT_DEFINITIONS.dns.readOnly);
});

test("cada agente tiene system prompt path en DOCUMENTACION y fallback embebido", () => {
  for (const definition of listAgentDefinitions()) {
    assert.ok(definition.systemPromptPath.includes("DOCUMENTACION"), definition.role);
    assert.ok(definition.fallbackSystemPrompt.length > 40, definition.role);
    assert.ok(definition.maxSessionTokens > 0);
  }
});

test("assertAgentRegistryIntegrity pasa con el registry actual", () => {
  assertAgentRegistryIntegrity();
  assert.equal(getAgentDefinition("dns").displayName, "DNS Senior");
});
