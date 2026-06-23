import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  buildSmtpSaslRetrofitPlan,
  listSmtpSaslRetrofitCandidates,
  runSmtpSaslRetrofitBatch
} from "./smtp-sasl-retrofit.ts";
import type { SmtpSshCommandInput, SmtpSshRunner } from "./smtp-provisioning.ts";

const fixedNow = new Date("2026-06-22T14:00:00.000Z");
const credentialEncryptionKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

test("listSmtpSaslRetrofitCandidates only returns configured SMTPs missing auth credentials", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      legacyServer("server85", "legacy-one.com"),
      {
        ...legacyServer("server88", "ready-one.com"),
        smtpAuthStatus: "configured",
        smtpCredential: { hasCredential: true }
      }
    ]
  }));

  const candidates = await listSmtpSaslRetrofitCandidates(workspace);
  assert.deepEqual(candidates.map((candidate) => candidate.serverSlug), ["server85"]);
  assert.equal(candidates[0]?.reason, "missing_smtp_auth");
});

test("buildSmtpSaslRetrofitPlan is additive, keeps permit_mynetworks, and redacts password from commands", () => {
  const plan = buildSmtpSaslRetrofitPlan({
    domain: "legacy-one.com",
    username: "mailer@legacy-one.com",
    password: "smtp-secret-password"
  });

  assert.equal(plan.some((step) => step.label === "install-dovecot"), true);
  assert.equal(plan.some((step) => step.label === "write-sasl-passdb"), true);
  assert.equal(plan.some((step) => step.label === "patch-postfix-main-cf-sasl"), true);
  assert.equal(plan.some((step) => step.label === "validate-local-smtp-and-submission"), true);
  const postfixPatch = plan.find((step) => step.label === "patch-postfix-main-cf-sasl");
  assert.match(postfixPatch?.command ?? "", /permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination/);
  const passdb = plan.find((step) => step.label === "write-sasl-passdb");
  assert.equal(passdb?.stdin, "smtp-secret-password\n");
  assert.equal(plan.some((step) => step.command.includes("smtp-secret-password")), false);
  assert.equal(plan.some((step) => step.auditCommand.includes("smtp-secret-password")), false);
});

test("runSmtpSaslRetrofitBatch persists configured credentials and continues after per-server failure", async () => {
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      legacyServer("server85", "legacy-one.com"),
      legacyServer("server88", "legacy-two.com")
    ]
  }));
  const commands: SmtpSshCommandInput[] = [];
  const runner: SmtpSshRunner = {
    isConfigured: () => true,
    run: async (input) => {
      commands.push(input);
      if (input.serverSlug === "server88") {
        throw new Error("ssh unavailable");
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    }
  };

  const result = await runSmtpSaslRetrofitBatch({
    workspace,
    auditLog,
    sshRunner: runner,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    actorId: "operator/juanes",
    now: () => fixedNow
  });

  assert.equal(result.candidates, 2);
  assert.equal(result.results.find((entry) => entry.serverSlug === "server85")?.status, "configured");
  assert.equal(result.results.find((entry) => entry.serverSlug === "server88")?.status, "failed");
  assert.equal(commands.some((command) => command.serverSlug === "server85"), true);
  assert.equal(commands.some((command) => command.serverSlug === "server88"), true);

  const provisioning = await workspace.readInventoryJson<{
    servers: Array<{ serverSlug: string; smtpAuthStatus?: string; smtpCredential?: { hasCredential?: boolean } }>;
  }>("smtp-provisioning.json");
  const server85 = provisioning?.servers.find((server) => server.serverSlug === "server85");
  assert.equal(server85?.smtpAuthStatus, "configured");
  assert.equal(server85?.smtpCredential?.hasCredential, true);

  const domains = await workspace.readInventoryJson<unknown>("domains.json");
  const serializedDomains = JSON.stringify(domains);
  assert.match(serializedDomains, /smtpCredentialEncrypted/);
  assert.equal(serializedDomains.includes("smtp-secret-password"), false);
  const audits = await auditLog.list();
  assert.equal(audits.length, 2);
  assert.equal(JSON.stringify(audits).includes("smtp-secret-password"), false);
});

async function setupWorkspace(): Promise<OpenClawWorkspace> {
  const rootDir = await mkdtemp(join(tmpdir(), "smtp-sasl-retrofit-"));
  return new OpenClawWorkspace({ rootDir, now: () => fixedNow });
}

function legacyServer(serverSlug: string, domain: string) {
  return {
    serverSlug,
    domain,
    serverIp: serverSlug === "server85" ? "192.0.2.85" : "192.0.2.88",
    selector: "default",
    status: "configured" as const,
    tlsStatus: "attempted_or_pending_dns" as const,
    configuredAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString()
  };
}
