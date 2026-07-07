import test from "node:test";
import assert from "node:assert/strict";
import { runAudit } from "./orchestrator.ts";
import { COMMENT_MARKER } from "./report/render.ts";
import type { AuditContext } from "./context/collect.ts";
import type { AnthropicClient } from "./anthropic/client.ts";

const context: AuditContext = {
  kind: "pull_request",
  identifier: "PR #1",
  title: "cambio",
  body: "descripcion",
  author: "juanes",
  changedFileCount: 1,
  includedFiles: ["a.ts"],
  skipped: [],
  truncated: false,
  diffText: "@@ -1 +1 @@\n-old\n+new",
  fileIndex: [{ path: "a.ts", category: "source", status: "modified" }]
};

function fakeAnthropic(behavior: "blocker" | "fail"): AnthropicClient {
  return {
    invokeStructured: async () => {
      if (behavior === "fail") {
        return { ok: false, error: "anthropic_http_500" };
      }
      return {
        ok: true,
        usage: { inputTokens: 10, outputTokens: 5 },
        data: {
          summary: "revisado",
          findings: [
            {
              severity: "blocker",
              category: "secret-exposure",
              title: "Credencial expuesta",
              detail: "detalle",
              evidence: { path: "a.ts", lines: "1-1" },
              recommendation: "rotar",
              confidence: "high"
            }
          ]
        }
      };
    }
  } as unknown as AnthropicClient;
}

test("runAudit agrega los 3 subagentes y bloquea ante un blocker", async () => {
  const outcome = await runAudit({
    context,
    anthropic: fakeAnthropic("blocker"),
    model: "claude-sonnet-4-6",
    maxTokensPerSubagent: 1024,
    failOn: "blocker",
    headSha: "abcdef1",
    dryRun: true,
    now: () => new Date("2026-06-18T00:00:00.000Z")
  });

  assert.equal(outcome.verdict, "blocked");
  assert.equal(outcome.conclusion, "failure");
  // Los 3 subagentes reportan el MISMO punto (a.ts:1-1): collapseByLocation los
  // fusiona en 1 (conserva el mas severo). Antes daba 3 = ruido duplicado.
  assert.equal(outcome.counts.blocker, 1);
  assert.equal(outcome.subagentsOk, 3);
  assert.ok(outcome.report.includes(COMMENT_MARKER));
});

test("runAudit corre en modo degradado si los subagentes fallan", async () => {
  const outcome = await runAudit({
    context,
    anthropic: fakeAnthropic("fail"),
    model: "claude-sonnet-4-6",
    maxTokensPerSubagent: 1024,
    failOn: "blocker",
    headSha: "abcdef1",
    dryRun: true
  });

  assert.equal(outcome.subagentsOk, 0);
  assert.equal(outcome.findings.length, 0);
  assert.equal(outcome.verdict, "clean");
  assert.equal(outcome.conclusion, "success");
  assert.ok(outcome.report.includes("degradado"));
});
