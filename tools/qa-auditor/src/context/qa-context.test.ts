import test from "node:test";
import assert from "node:assert/strict";
import { loadQaContext, DEFAULT_QA_CONTEXT, QA_CONTEXT_PATH } from "./qa-context.ts";
import type { GithubClient } from "../github/client.ts";

function fakeClient(fileContent: string | null): GithubClient {
  return {
    getFileContent: async (path: string, _ref: string) => {
      assert.equal(path, QA_CONTEXT_PATH);
      return fileContent;
    }
  } as unknown as GithubClient;
}

test("loadQaContext usa el default embebido si el repo no tiene QA_CONTEXT.md", async () => {
  const ctx = await loadQaContext(fakeClient(null), "base-sha");
  assert.equal(ctx, DEFAULT_QA_CONTEXT);
  assert.match(ctx, /Politica de severidad/);
  assert.match(ctx, /[Pp]rocedencia/);
});

test("loadQaContext usa el override del repo cuando existe", async () => {
  const override = "# Politica propia del equipo\nReglas...";
  const ctx = await loadQaContext(fakeClient(override), "base-sha");
  assert.equal(ctx, override);
});

test("loadQaContext cae al default si el override esta vacio o no hay ref", async () => {
  assert.equal(await loadQaContext(fakeClient("   "), "base-sha"), DEFAULT_QA_CONTEXT);
  assert.equal(await loadQaContext(fakeClient("algo"), ""), DEFAULT_QA_CONTEXT);
});
