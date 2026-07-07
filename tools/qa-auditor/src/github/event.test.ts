import test from "node:test";
import assert from "node:assert/strict";
import { parseEvent } from "./event.ts";

test("parseEvent normaliza un pull_request", () => {
  const target = parseEvent("pull_request", {
    action: "synchronize",
    pull_request: {
      number: 42,
      title: "Agrega validacion",
      body: "cuerpo",
      user: { login: "juanes" },
      head: { sha: "head123" },
      base: { sha: "base456", ref: "produ" },
      labels: [{ name: "backend" }, { name: "smtp" }]
    }
  });
  assert.equal(target.kind, "pull_request");
  if (target.kind === "pull_request") {
    assert.equal(target.number, 42);
    assert.equal(target.action, "synchronize");
    assert.equal(target.headSha, "head123");
    assert.equal(target.baseSha, "base456");
    assert.deepEqual(target.labels, ["backend", "smtp"]);
  }
});

test("parseEvent normaliza un deployment", () => {
  const target = parseEvent("deployment", {
    deployment: { id: 9, sha: "dep789", ref: "produ", task: "deploy", environment: "production" }
  });
  assert.equal(target.kind, "deployment");
  if (target.kind === "deployment") {
    assert.equal(target.sha, "dep789");
    assert.equal(target.environment, "production");
  }
});

test("parseEvent trata push a una rama como deploy del commit tip", () => {
  const target = parseEvent("push", { after: "push999", ref: "refs/heads/produ" });
  assert.equal(target.kind, "deployment");
  if (target.kind === "deployment") {
    assert.equal(target.sha, "push999");
    assert.equal(target.environment, "produ");
    assert.equal(target.task, "push");
  }
});

test("parseEvent marca eventos no soportados", () => {
  const target = parseEvent("issues", {});
  assert.equal(target.kind, "unsupported");
});
