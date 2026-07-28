import assert from "node:assert/strict";
import test from "node:test";

import { diagnosticToolSpecsForRole, resolveToolSpecs } from "./agent-tool-specs.ts";
import { WARMUP_DIAGNOSTIC_TOOLS } from "./warmup-tool-executor.ts";

/** Env que habilita las 5 tools de lectura del diagnostico. */
function enabledEnv(): Record<string, string | undefined> {
  return {
    OPENCLAW_HMAC_SECRET: "test-secret",
    SMTP_PROVISION_SSH_KEY_PATH: "/tmp/fake-key",
    MXTOOLBOX_API_KEY: "test-mx-key"
  };
}

test("las 5 tools del diagnostico resuelven a specs REALES, con schema", async () => {
  const { specs, missing } = diagnosticToolSpecsForRole("warmup", enabledEnv());

  assert.deepEqual(missing, [], "ninguna de las 5 deberia faltar");
  assert.equal(specs.length, WARMUP_DIAGNOSTIC_TOOLS.length);

  for (const spec of specs) {
    assert.equal(spec.input_schema.type, "object");
    // Lo que hace inejecutable al placeholder: properties vacio.
    assert.ok(
      Object.keys(spec.input_schema.properties).length > 0,
      `${spec.name} tiene que traer properties reales, no un schema vacio`
    );
    assert.ok(spec.description.length > 40, `${spec.name} tiene que traer su descripcion real`);
    assert.equal(
      spec.description.includes("Dispatch real"),
      false,
      `${spec.name} no puede ser el placeholder`
    );
  }
});

test("los params que las tools exigen de verdad viajan en el schema", async () => {
  // Sin esto el agente no puede construir su primera llamada.
  const { specs } = diagnosticToolSpecsForRole("warmup", enabledEnv());
  const byName = new Map(specs.map((spec) => [spec.name, spec]));

  const reach = byName.get("read_smtp_reachability");
  assert.ok(reach);
  assert.deepEqual([...reach.input_schema.required].sort(), ["serverIp", "serverSlug"]);

  const reason = byName.get("read_delivery_reason");
  assert.ok(reason);
  // El messageId es el que obligo a sacarlo del audit log.
  assert.ok(reason.input_schema.required.includes("messageId"));

  const dkim = byName.get("read_dkim_status");
  assert.ok(dkim);
  assert.deepEqual(dkim.input_schema.required, ["domain"]);
});

test("una tool que no existe en el catalogo se OMITE y se reporta, no se declara vacia", async () => {
  // Declararla con schema vacio le enseña al modelo a pedir algo que no puede ejecutar, y el
  // error que recibe no le explica que la tool nunca existio.
  const { specs, missing } = resolveToolSpecs(
    ["read_dkim_status", "start_warmup_seed", "placement_check_gmail"],
    enabledEnv()
  );

  assert.deepEqual(specs.map((spec) => spec.name), ["read_dkim_status"]);
  assert.deepEqual(missing, ["start_warmup_seed", "placement_check_gmail"]);
});

test("una tool apagada por flag no llega al agente", async () => {
  // read_mxtoolbox_health depende de MXTOOLBOX_API_KEY. Sin la key no esta en el catalogo,
  // asi que tampoco puede estar en las specs: el agente no debe verla siquiera.
  const sinKey = { ...enabledEnv(), MXTOOLBOX_API_KEY: undefined };
  const { specs, missing } = diagnosticToolSpecsForRole("warmup", sinKey);

  assert.equal(specs.some((spec) => spec.name === "read_mxtoolbox_health"), false);
  assert.ok(missing.includes("read_mxtoolbox_health"));
  assert.equal(specs.length, WARMUP_DIAGNOSTIC_TOOLS.length - 1, "las otras 4 siguen");
});

test("los roles sin tools reales devuelven specs vacias en vez de placeholders", async () => {
  // Es el estado real de dns, smtp y qa-security. Un agente sin tools falla legible;
  // uno con tools inventadas alucina llamadas.
  for (const role of ["dns", "smtp", "qa-security", "orchestrator"] as const) {
    const { specs, missing } = diagnosticToolSpecsForRole(role, enabledEnv());
    assert.deepEqual(specs, [], `${role} no tiene tools reales todavia`);
    assert.deepEqual(missing, [], `${role} tampoco declara faltantes en el abanico`);
  }
});

test("las specs y el executor declaran EXACTAMENTE la misma lista", async () => {
  // Si divergen, el modelo pide tools que el executor rechaza con tool_not_allowed_for_role
  // y el agente no puede interpretar ese error.
  const { specs } = diagnosticToolSpecsForRole("warmup", enabledEnv());
  assert.deepEqual(
    specs.map((spec) => spec.name).sort(),
    [...WARMUP_DIAGNOSTIC_TOOLS].sort()
  );
});
