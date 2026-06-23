import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenClawWorkspace } from "./openclaw-workspace.ts";

const fixedNow = new Date("2026-05-29T11:02:03.000Z");

test("OpenClawWorkspace writes skills, executions, learnings, and inventory", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "openclaw-workspace-"));
  const workspace = new OpenClawWorkspace({
    rootDir,
    now: () => fixedNow
  });

  const skill = await workspace.writeSkillDefinition(
    "register_domain_route53",
    "# register_domain_route53\n"
  );
  const execution = await workspace.writeExecutionRecord({
    skill: "register_domain_route53",
    params: { domain: "delivrix-mail.com", years: 1 },
    outcome: "success",
    durationMs: 42,
    evidence: { operationId: "op-123" }
  });
  const learning = await workspace.writeLearning({
    skill: "register_domain_route53",
    title: "route53 confirmation delay",
    content: "# Route53 confirmation delay\n"
  });
  const inventory = await workspace.updateInventoryJson<{ domains: string[] }>(
    "domains.json",
    (current) => ({
      domains: [...(current?.domains ?? []), "delivrix-mail.com"]
    })
  );
  const dkimKey = await workspace.writeWorkspaceFile(
    "inventory/dkim-keys/delivrix-mail.com/default.private",
    "private-key"
  );

  assert.equal(skill.path, "skills/register_domain_route53.v1.md");
  assert.equal(execution.path, "executions/2026-05-29/110203-register_domain_route53-delivrix-mail.com-success.md");
  assert.equal(learning.path, "learnings/2026-05-29-register_domain_route53-route53-confirmation-delay.md");
  assert.equal(inventory.path, "inventory/domains.json");
  assert.equal(dkimKey.path, "inventory/dkim-keys/delivrix-mail.com/default.private");
  assert.match(await readFile(execution.absolutePath, "utf8"), /op-123/);
  assert.equal(await workspace.readWorkspaceFile(dkimKey.path), "private-key");

  const learnings = await workspace.readLearnings("register_domain_route53");
  assert.equal(learnings.length, 1);
  assert.equal(learnings[0].path, learning.path);

  const snapshot = await workspace.snapshot();
  assert.deepEqual(snapshot.files, [
    execution.path,
    dkimKey.path,
    inventory.path,
    learning.path,
    skill.path
  ]);
});

test("OpenClawWorkspace refuses to overwrite corrupt inventory as empty", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "openclaw-workspace-corrupt-"));
  const workspace = new OpenClawWorkspace({
    rootDir,
    now: () => fixedNow
  });
  await workspace.ensureBase();
  const inventoryPath = join(rootDir, "inventory", "domains.json");
  await writeFile(inventoryPath, "{\"domains\":[\"keep-me\"]", "utf8");

  await assert.rejects(
    () => workspace.updateInventoryJson<{ domains: string[] }>(
      "domains.json",
      (current) => ({ domains: [...(current?.domains ?? []), "new-domain.com"] })
    ),
    /could not be read safely/
  );

  assert.equal(await readFile(inventoryPath, "utf8"), "{\"domains\":[\"keep-me\"]");
});

test("OpenClawWorkspace serializes concurrent inventory read-modify-write updates", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "openclaw-workspace-lock-"));
  const workspace = new OpenClawWorkspace({
    rootDir,
    now: () => fixedNow
  });

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      workspace.updateInventoryJson<{ domains: string[] }>(
        "domains.json",
        (current) => ({
          domains: [...(current?.domains ?? []), `domain-${index}.com`]
        })
      )
    )
  );

  const inventory = await workspace.readInventoryJson<{ domains: string[] }>("domains.json");
  assert.equal(inventory?.domains.length, 20);
  assert.equal(new Set(inventory?.domains).size, 20);
});
