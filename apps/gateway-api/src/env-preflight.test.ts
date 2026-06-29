import assert from "node:assert/strict";
import test from "node:test";
import {
  ENV_PREFLIGHT_CATALOG,
  checkEnvPreflight,
  type EnvVarSpec
} from "./env-preflight.ts";
import { buildToolsForOpenClaw } from "./openclaw-tools-builder.ts";

// Construye un env "sano" a partir del propio catalogo: cada flag en "true",
// cada secret/token con valor real, money/json/csv validos.
function healthyEnvFromCatalog(): Record<string, string> {
  const env: Record<string, string> = { NODE_ENV: "development" };
  for (const spec of ENV_PREFLIGHT_CATALOG) {
    switch (spec.kind) {
      case "flag":
        env[spec.name] = "true";
        break;
      case "money":
        env[spec.name] = "250";
        break;
      case "json-contact":
        env[spec.name] = JSON.stringify({
          FirstName: "Juan",
          LastName: "Canar",
          ContactType: "COMPANY",
          AddressLine1: "Calle 1",
          City: "Bogota",
          CountryCode: "CO",
          ZipCode: "110111",
          PhoneNumber: "+57.3000000000",
          Email: "infra@delivrix.com"
        });
        break;
      case "csv-email":
        env[spec.name] = "a@delivrix.com,b@delivrix.com,c@delivrix.com";
        break;
      case "url":
        env[spec.name] = "https://127.0.0.1:8006/api2/json";
        break;
      case "secret-32-byte":
        env[spec.name] = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        break;
      default:
        // hex realista de 48 chars: presente, sin needles de placeholder
        env[spec.name] = "abcdef0123456789abcdef0123456789abcdef0123456789";
    }
  }
  return env;
}

test("checkEnvPreflight: un entorno sano no reporta fatal ni warnings", () => {
  const result = checkEnvPreflight(healthyEnvFromCatalog());
  assert.equal(result.ok, true);
  assert.deepEqual(result.fatal, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.okCount, result.checkedCount);
});

test("checkEnvPreflight: HMAC ausente es fatal (causa tools:0)", () => {
  const env = healthyEnvFromCatalog();
  delete env.OPENCLAW_HMAC_SECRET;
  const result = checkEnvPreflight(env);
  assert.equal(result.ok, false);
  assert.ok(result.fatal.some((i) => i.name === "OPENCLAW_HMAC_SECRET" && i.reason === "missing"));
});

test("checkEnvPreflight: secret core en placeholder es fatal", () => {
  const env = healthyEnvFromCatalog();
  env.OPENCLAW_GATEWAY_TOKEN = "replace_with_real_token";
  const result = checkEnvPreflight(env);
  assert.equal(result.ok, false);
  assert.ok(result.fatal.some((i) => i.name === "OPENCLAW_GATEWAY_TOKEN" && i.reason === "placeholder"));
});

test("checkEnvPreflight: tokens compartidos (deuda) son warn, no fatal", () => {
  const env = healthyEnvFromCatalog();
  env.DELIVRIX_OPENCLAW_TOKEN = "replace_with_real_token";
  env.DELIVRIX_READ_BOUNDARY_TOKEN = "replace_with_real_token";
  const result = checkEnvPreflight(env);
  assert.equal(result.ok, true); // no rompe el arranque: es deuda conocida, no fatal
  assert.ok(result.warnings.some((i) => i.name === "DELIVRIX_OPENCLAW_TOKEN" && i.reason === "placeholder"));
  assert.ok(result.warnings.some((i) => i.name === "DELIVRIX_READ_BOUNDARY_TOKEN"));
});

test("checkEnvPreflight: flag del flujo SMTP en false es warning invalido", () => {
  const env = healthyEnvFromCatalog();
  env.WEBDOCK_SERVERS_ENABLE_CREATE = "false";
  const result = checkEnvPreflight(env);
  assert.equal(result.ok, true); // sigue arrancando: es warn, no fatal
  assert.ok(
    result.warnings.some((i) => i.name === "WEBDOCK_SERVERS_ENABLE_CREATE" && i.reason === "invalid")
  );
});

test("checkEnvPreflight: CREDENTIAL_ENCRYPTION_KEY faltante o invalida es warning, no fatal", () => {
  const missing = healthyEnvFromCatalog();
  delete missing.CREDENTIAL_ENCRYPTION_KEY;
  const missingResult = checkEnvPreflight(missing);
  assert.equal(missingResult.ok, true);
  assert.ok(
    missingResult.warnings.some((i) => i.name === "CREDENTIAL_ENCRYPTION_KEY" && i.reason === "missing")
  );

  const invalid = healthyEnvFromCatalog();
  invalid.CREDENTIAL_ENCRYPTION_KEY = "too-short";
  const invalidResult = checkEnvPreflight(invalid);
  assert.equal(invalidResult.ok, true);
  assert.ok(
    invalidResult.warnings.some((i) => i.name === "CREDENTIAL_ENCRYPTION_KEY" && i.reason === "invalid")
  );
});

test("checkEnvPreflight: CREDENTIAL_ENCRYPTION_KEY acepta hex de 32 bytes", () => {
  const env = healthyEnvFromCatalog();
  env.CREDENTIAL_ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const result = checkEnvPreflight(env);
  assert.equal(
    result.warnings.some((i) => i.name === "CREDENTIAL_ENCRYPTION_KEY"),
    false
  );
});

test("checkEnvPreflight: anyOf se satisface con un alias (WEBDOCK_API_KEY)", () => {
  const env = healthyEnvFromCatalog();
  delete env.WEBDOCK_API_KEY_PRIMARY;
  delete env.WEBDOCK_API_KEY_OPS;
  env.WEBDOCK_API_KEY = "abcdef0123456789abcdef0123456789abcdef0123456789";
  const result = checkEnvPreflight(env);
  assert.equal(
    result.warnings.some((i) => i.name === "WEBDOCK_API_KEY_PRIMARY" || i.name === "WEBDOCK_API_KEY_OPS"),
    false
  );
});

test("checkEnvPreflight: cap monetario invalido se detecta", () => {
  const env = healthyEnvFromCatalog();
  env.AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD = "0";
  const result = checkEnvPreflight(env);
  assert.ok(
    result.warnings.some((i) => i.name === "AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD" && i.reason === "invalid")
  );
});

test("checkEnvPreflight: admin contact JSON incompleto se detecta", () => {
  const env = healthyEnvFromCatalog();
  env.DELIVRIX_ADMIN_CONTACT_JSON = JSON.stringify({ FirstName: "Juan" });
  const result = checkEnvPreflight(env);
  assert.ok(
    result.warnings.some((i) => i.name === "DELIVRIX_ADMIN_CONTACT_JSON" && i.reason === "invalid")
  );
});

test("checkEnvPreflight: el reporte es ASCII sin emojis", () => {
  const env = healthyEnvFromCatalog();
  delete env.OPENCLAW_HMAC_SECRET;
  const result = checkEnvPreflight(env);
  // ASCII puro: ningun codepoint > 127
  assert.equal(/[^\x00-\x7F]/.test(result.report), false);
  assert.match(result.report, /FATAL/);
});

// Consistencia con la fuente de verdad: si el catalogo SMTP esta completo, el
// builder real debe habilitar configure_complete_smtp. Si el codigo agrega un
// flag nuevo a alguna sub-tool y no se anade al catalogo, este test falla.
test("consistencia: el catalogo sano habilita configure_complete_smtp en el builder real", () => {
  const tools = buildToolsForOpenClaw(healthyEnvFromCatalog());
  const names = tools.map((t) => t.name);
  assert.ok(
    names.includes("configure_complete_smtp"),
    `configure_complete_smtp deberia estar habilitado; tools: ${names.join(", ")}`
  );
});
