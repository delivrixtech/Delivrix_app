import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPsqlInvocation,
  defaultPostgresContainer,
  postgresConfig
} from "./common.mjs";

test("postgresConfig uses the local compose container when POSTGRES_URL is omitted", () => {
  const config = postgresConfig({});

  assert.equal(config.mode, "container");
  assert.equal(config.container, defaultPostgresContainer);
  assert.equal(config.user, "delivrix");
  assert.equal(config.database, "delivrix_mailops");
});

test("postgresConfig treats compose service hosts as container targets", () => {
  const config = postgresConfig({
    POSTGRES_URL: "postgres://delivrix:secret@postgres:5432/delivrix_mailops"
  });

  assert.equal(config.mode, "container");
  assert.equal(config.container, defaultPostgresContainer);
});

test("postgresConfig refuses to combine POSTGRES_CONTAINER with a remote POSTGRES_URL", () => {
  assert.throws(
    () => postgresConfig({
      POSTGRES_URL: "postgres://remote:secret@db.example.com:6543/delivrix_mailops",
      POSTGRES_CONTAINER: "delivrix-postgres"
    }),
    /POSTGRES_CONTAINER=.*local\/container POSTGRES_URL/
  );
});

test("buildPsqlInvocation honors non-container POSTGRES_URL with direct psql", () => {
  const invocation = buildPsqlInvocation(
    "SELECT 1;",
    { command: true, tuplesOnly: true },
    {
      POSTGRES_URL: "postgres://remote:secret@db.example.com:6543/delivrix_mailops"
    }
  );

  assert.equal(invocation.command, "psql");
  assert.equal(invocation.args[0], "postgres://remote@db.example.com:6543/delivrix_mailops");
  assert.ok(invocation.args.includes("-At"));
  assert.equal(invocation.execOptions.env.PGPASSWORD, "secret");
  assert.equal(invocation.args.join(" ").includes("secret"), false);
});
