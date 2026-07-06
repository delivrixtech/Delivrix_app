import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_ROLES,
  DNS_SENIOR_TOOL_NAMES,
  ORCHESTRATOR_TOOL_NAMES,
  QA_SECURITY_TOOL_NAMES,
  SMTP_SENIOR_TOOL_NAMES,
  TOTAL_AGENT_TOOL_COUNT,
  WARMUP_SENIOR_TOOL_NAMES,
  isAgentRole,
  isToolAllowedForRole,
  toolNamesForRole
} from "./multi-agent.ts";

test("declara los 5 roles canonicos de la spec", () => {
  assert.deepEqual(AGENT_ROLES, ["orchestrator", "dns", "smtp", "warmup", "qa-security"]);
  assert.ok(isAgentRole("qa-security"));
  assert.ok(!isAgentRole("qa_security"));
  assert.ok(!isAgentRole(""));
});

test("los tool counts por rol son 16+9+10+8+12 = 55", () => {
  assert.equal(ORCHESTRATOR_TOOL_NAMES.length, 16);
  assert.equal(DNS_SENIOR_TOOL_NAMES.length, 9);
  assert.equal(SMTP_SENIOR_TOOL_NAMES.length, 10);
  assert.equal(WARMUP_SENIOR_TOOL_NAMES.length, 8);
  assert.equal(QA_SECURITY_TOOL_NAMES.length, 12);
  const total =
    ORCHESTRATOR_TOOL_NAMES.length +
    DNS_SENIOR_TOOL_NAMES.length +
    SMTP_SENIOR_TOOL_NAMES.length +
    WARMUP_SENIOR_TOOL_NAMES.length +
    QA_SECURITY_TOOL_NAMES.length;
  assert.equal(total, TOTAL_AGENT_TOOL_COUNT);
  assert.equal(total, 55);
});

test("no hay tool names duplicados dentro de un rol ni entre roles", () => {
  const all: string[] = [];
  for (const role of AGENT_ROLES) {
    const names = toolNamesForRole(role);
    assert.equal(new Set(names).size, names.length, `duplicados dentro de ${role}`);
    all.push(...names);
  }
  assert.equal(new Set(all).size, all.length, "duplicados entre roles");
});

test("la matriz rol → tool rechaza tools fuera de scope", () => {
  assert.ok(isToolAllowedForRole("orchestrator", "delegate_to_dns"));
  assert.ok(isToolAllowedForRole("dns", "register_domain_route53"));
  assert.ok(isToolAllowedForRole("qa-security", "produce_qa_report"));
  // Escalation de privilegios: un especialista no tiene tools de otro rol.
  assert.ok(!isToolAllowedForRole("dns", "install_smtp_stack"));
  assert.ok(!isToolAllowedForRole("smtp", "delegate_to_dns"));
  assert.ok(!isToolAllowedForRole("warmup", "register_domain_route53"));
  // Solo el orquestador delega.
  for (const role of ["dns", "smtp", "warmup", "qa-security"] as const) {
    for (const tool of toolNamesForRole(role)) {
      assert.ok(!tool.startsWith("delegate_to_"), `${role} no debe poder delegar (${tool})`);
    }
  }
});

test("todas las tools de QA/Security son de lectura o reporte (sin efectos de infraestructura)", () => {
  const writeVerbs = ["install", "configure", "create", "delete", "upsert", "register", "restart", "start", "resume", "obtain", "bind"];
  for (const tool of QA_SECURITY_TOOL_NAMES) {
    for (const verb of writeVerbs) {
      assert.ok(!tool.startsWith(`${verb}_`), `tool QA con verbo de escritura: ${tool}`);
    }
  }
});
