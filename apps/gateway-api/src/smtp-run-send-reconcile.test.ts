import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import { reconcileSmtpRunStatesAfterRealSend } from "./smtp-run-send-reconcile.ts";

const fixedNow = new Date("2026-07-09T12:00:00.000Z");

function makeWorkspace(): OpenClawWorkspace {
  return new OpenClawWorkspace({
    rootDir: mkdtempSync(join(tmpdir(), "smtp-run-reconcile-test-")),
    now: () => fixedNow
  });
}

async function writeRunState(workspace: OpenClawWorkspace, runId: string, state: Record<string, unknown>): Promise<void> {
  await workspace.writeWorkspaceFileAtomic(`inventory/smtp-runs/${runId}.json`, `${JSON.stringify({
    schemaVersion: "smtp-run-state/v1",
    runId,
    lastCompletedStep: 13,
    steps: {},
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...state
  }, null, 2)}\n`);
}

async function readRunState(workspace: OpenClawWorkspace, runId: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(workspace.getRootDir(), "inventory", "smtp-runs", `${runId}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

test("reconcilia un run failed del dominio a completed con marcador reconciledBy", async () => {
  const workspace = makeWorkspace();
  await writeRunState(workspace, "run-ghost", {
    status: "failed",
    chosenDomain: "sender.example",
    retryableFailure: true,
    failureCategory: "send_retry_exhausted",
    failureRetryAfterMs: 300000
  });

  const reconciled = await reconcileSmtpRunStatesAfterRealSend({
    workspace,
    fromDomain: "Sender.Example.",
    messageId: "<delivrix-x@sender.example>",
    deliveryStatus: "sent",
    sendEventId: "audit-77",
    now: fixedNow
  });

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].runId, "run-ghost");
  assert.equal(reconciled[0].previousStatus, "failed");

  const raw = await readRunState(workspace, "run-ghost");
  assert.equal(raw.status, "completed");
  assert.equal(raw.retryableFailure, undefined);
  assert.equal(raw.failureCategory, undefined);
  assert.equal(raw.failureRetryAfterMs, undefined);
  assert.equal(raw.finalEmailMessageId, "<delivrix-x@sender.example>");
  assert.equal(raw.finalDeliveryStatus, "delivered");
  assert.deepEqual(raw.reconciledBy, {
    source: "send_real_email",
    sendEventId: "audit-77",
    occurredAt: fixedNow.toISOString()
  });
  assert.equal(raw.updatedAt, fixedNow.toISOString());
});

test("no toca runs running ni runs de otros dominios", async () => {
  const workspace = makeWorkspace();
  await writeRunState(workspace, "run-active", { status: "running", chosenDomain: "sender.example" });
  await writeRunState(workspace, "run-otro", { status: "failed", chosenDomain: "otro.example" });

  const reconciled = await reconcileSmtpRunStatesAfterRealSend({
    workspace,
    fromDomain: "sender.example",
    deliveryStatus: "sent",
    now: fixedNow
  });

  assert.equal(reconciled.length, 0);
  assert.equal((await readRunState(workspace, "run-active")).status, "running");
  assert.equal((await readRunState(workspace, "run-otro")).status, "failed");
});

test("un JSON corrupto no rompe la reconciliación del resto", async () => {
  const workspace = makeWorkspace();
  const dir = join(workspace.getRootDir(), "inventory", "smtp-runs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "corrupto.json"), "{not-json", "utf8");
  await writeRunState(workspace, "run-ghost", { status: "failed", chosenDomain: "sender.example" });

  const reconciled = await reconcileSmtpRunStatesAfterRealSend({
    workspace,
    fromDomain: "sender.example",
    deliveryStatus: "queued",
    now: fixedNow
  });

  assert.equal(reconciled.length, 1);
  const raw = await readRunState(workspace, "run-ghost");
  assert.equal(raw.status, "completed");
  assert.equal(raw.finalDeliveryStatus, "queued");
});

test("sin directorio de runs devuelve vacío sin lanzar", async () => {
  const workspace = makeWorkspace();
  const reconciled = await reconcileSmtpRunStatesAfterRealSend({
    workspace,
    fromDomain: "sender.example",
    now: fixedNow
  });
  assert.deepEqual(reconciled, []);
});
