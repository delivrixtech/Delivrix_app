import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  buildSenderPoolStatus,
  deriveRampSubjectMatcher,
  handleSenderPoolStatusHttp
} from "./sender-pool-status.ts";
import {
  markSmtpCredentialConfigured,
  prepareSmtpCredential,
  saveSmtpCredentialRecord
} from "../smtp-credentials.ts";

const fixedNow = new Date("2026-05-28T20:00:00.000Z");
const credentialEncryptionKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

async function setupWorkspace(): Promise<OpenClawWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "sender-pool-status-"));
  await mkdir(join(root, "inventory"), { recursive: true });
  return new OpenClawWorkspace({ rootDir: root, now: () => fixedNow });
}

async function writeInventory(
  workspace: OpenClawWorkspace,
  name: string,
  payload: unknown
): Promise<void> {
  const path = join(workspace.getRootDir(), "inventory", name);
  await writeFile(path, JSON.stringify(payload, null, 2), "utf-8");
}

test("deriveRampSubjectMatcher produces canonical [delivrix-<12chars>]", () => {
  const rampId = "ramp-abc123def456ghi789";
  const matcher = deriveRampSubjectMatcher(rampId);
  // primeros 12 chars del rampId entre brackets
  assert.equal(matcher, "[delivrix-ramp-abc123d]");
});

test("deriveRampSubjectMatcher handles short rampIds", () => {
  const matcher = deriveRampSubjectMatcher("short");
  assert.equal(matcher, "[delivrix-short]");
});

test("buildSenderPoolStatus returns empty domains when workspace has no inventory", async () => {
  const workspace = await setupWorkspace();
  const result = await buildSenderPoolStatus({ workspace, now: () => fixedNow });
  assert.equal(result.domains.length, 0);
  assert.equal(result.capacity.totalDomains, 0);
  assert.equal(result.capacity.activeDomains, 0);
  assert.equal(result.source.kind, "live");
  assert.equal(result.generatedAt, fixedNow.toISOString());
});

test("buildSenderPoolStatus maps inventory domains without ramps", async () => {
  const workspace = await setupWorkspace();
  await writeInventory(workspace, "domains.json", {
    domains: [
      {
        domain: "delivrix-demo.click",
        registrar: "aws-route53",
        status: "owned",
        registeredAt: "2026-05-28T01:02:15.214Z",
        costUsd: 11
      }
    ]
  });

  const result = await buildSenderPoolStatus({ workspace, now: () => fixedNow });
  assert.equal(result.domains.length, 1);
  const summary = result.domains[0]!;
  assert.equal(summary.domain, "delivrix-demo.click");
  assert.equal(summary.registrar, "aws-route53");
  assert.equal(summary.status, "owned");
  assert.equal(summary.warmupRampActive, false);
  assert.equal(summary.ramp, null);
});

test("buildSenderPoolStatus surfaces active ramp with derived subjectMatcher", async () => {
  const workspace = await setupWorkspace();
  await writeInventory(workspace, "domains.json", {
    domains: [
      { domain: "delivrix-mail.com", registrar: "aws-route53", status: "warming" }
    ]
  });
  await writeInventory(workspace, "warmup-progress.json", {
    ramps: [
      {
        rampId: "ramp-abc123def456ghi",
        domain: "delivrix-mail.com",
        serverSlug: "mail-prod-1",
        serverIp: "192.0.2.10",
        schedule: "demo-fast",
        state: "running",
        recipientPool: ["jectcode+seed1@gmail.com"],
        totalPlanned: 270,
        totalSent: 9,
        totalBounced: 0,
        startedAt: "2026-05-28T19:55:00.000Z",
        updatedAt: "2026-05-28T19:57:00.000Z",
        nextBatchAt: "2026-05-28T20:02:00.000Z",
        batches: [],
        actorId: "operator/juanes",
        approvalToken: "exec-token-1"
      }
    ]
  });

  const result = await buildSenderPoolStatus({ workspace, now: () => fixedNow });
  assert.equal(result.domains.length, 1);
  const summary = result.domains[0]!;
  assert.equal(summary.warmupRampActive, true);
  assert.ok(summary.ramp);
  assert.equal(summary.ramp!.rampId, "ramp-abc123def456ghi");
  assert.equal(summary.ramp!.subjectMatcher, "[delivrix-ramp-abc123d]");
  assert.equal(summary.ramp!.status, "running");
  assert.equal(summary.serverIp, "192.0.2.10");
  assert.equal(result.capacity.activeDomains, 1);
});

test("buildSenderPoolStatus shows paused ramp as active so panel keeps mounted", async () => {
  const workspace = await setupWorkspace();
  await writeInventory(workspace, "domains.json", {
    domains: [{ domain: "delivrix-mail.com", status: "warming" }]
  });
  await writeInventory(workspace, "warmup-progress.json", {
    ramps: [
      {
        rampId: "ramp-paused-1",
        domain: "delivrix-mail.com",
        serverSlug: "mail-prod-1",
        serverIp: "192.0.2.10",
        schedule: "demo-fast",
        state: "paused",
        recipientPool: [],
        totalPlanned: 270,
        totalSent: 12,
        totalBounced: 0,
        startedAt: "2026-05-28T19:55:00.000Z",
        updatedAt: "2026-05-28T19:58:00.000Z",
        batches: [],
        actorId: "operator/juanes",
        approvalToken: "exec-token-2"
      }
    ]
  });

  const result = await buildSenderPoolStatus({ workspace, now: () => fixedNow });
  assert.equal(result.domains[0]!.warmupRampActive, true);
  assert.equal(result.domains[0]!.ramp!.status, "paused");
});

test("buildSenderPoolStatus surfaces orphan ramps not yet in inventory", async () => {
  const workspace = await setupWorkspace();
  // domains.json existe pero NO incluye el dominio del ramp
  await writeInventory(workspace, "domains.json", {
    domains: [{ domain: "other-domain.com", status: "owned" }]
  });
  await writeInventory(workspace, "warmup-progress.json", {
    ramps: [
      {
        rampId: "ramp-orphan-1",
        domain: "delivrix-orphan.com",
        serverSlug: "mail-edge-1",
        serverIp: "192.0.2.99",
        schedule: "demo-fast",
        state: "running",
        recipientPool: [],
        totalPlanned: 270,
        totalSent: 3,
        totalBounced: 0,
        startedAt: "2026-05-28T19:55:00.000Z",
        updatedAt: "2026-05-28T19:55:00.000Z",
        batches: [],
        actorId: "operator/juanes",
        approvalToken: "exec-token-3"
      }
    ]
  });

  const result = await buildSenderPoolStatus({ workspace, now: () => fixedNow });
  assert.equal(result.domains.length, 2);
  const orphan = result.domains.find((d) => d.domain === "delivrix-orphan.com");
  assert.ok(orphan);
  assert.equal(orphan!.warmupRampActive, true);
  assert.equal(orphan!.status, "warming");
});

test("buildSenderPoolStatus uses bind serverIp when inventory lacks one", async () => {
  const workspace = await setupWorkspace();
  await writeInventory(workspace, "domains.json", {
    domains: [{ domain: "delivrix-bound.com", status: "owned" }],
    binds: [
      {
        domain: "delivrix-bound.com",
        serverSlug: "mail-prod-2",
        serverIp: "192.0.2.20",
        boundAt: "2026-05-28T01:13:00.000Z"
      }
    ]
  });

  const result = await buildSenderPoolStatus({ workspace, now: () => fixedNow });
  assert.equal(result.domains[0]!.serverIp, "192.0.2.20");
});

test("buildSenderPoolStatus accepts bindings and exposes SMTP credential metadata without secrets", async () => {
  const workspace = await setupWorkspace();
  await writeInventory(workspace, "domains.json", {
    domains: [{ domain: "delivrix-auth.com", status: "owned" }],
    bindings: [
      {
        domain: "delivrix-auth.com",
        serverSlug: "mail-prod-auth",
        serverIpV4: "192.0.2.55",
        boundAt: "2026-05-28T01:13:00.000Z"
      }
    ],
    emailAuth: [
      {
        domain: "delivrix-auth.com",
        selector: "default",
        dkimPrivateKeyPath: "inventory/dkim-keys/delivrix-auth.com/default.private"
      }
    ]
  });
  const material = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "delivrix-auth.com",
    serverSlug: "mail-prod-auth",
    host: "smtp.delivrix-auth.com",
    now: () => fixedNow,
    passwordFactory: () => "smtp-secret-password"
  });
  await saveSmtpCredentialRecord(workspace, markSmtpCredentialConfigured(material.record, fixedNow));

  const result = await buildSenderPoolStatus({ workspace, now: () => fixedNow });
  const summary = result.domains[0]!;
  assert.equal(summary.serverIp, "192.0.2.55");
  assert.equal(summary.serverSlug, "mail-prod-auth");
  assert.equal(summary.authComplete, true);
  assert.equal(summary.hasCredential, true);
  assert.equal(summary.smtpCredential?.username, "mailer@delivrix-auth.com");
  assert.equal(summary.smtpCredential?.host, "smtp.delivrix-auth.com");
  assert.equal(summary.smtpCredential?.ports.submission, 587);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("smtp-secret-password"), false);
  assert.equal(serialized.includes("ciphertext"), false);
  assert.equal(serialized.includes("authTag"), false);
});

test("handleSenderPoolStatusHttp returns 200 with payload on success", async () => {
  const workspace = await setupWorkspace();
  await writeInventory(workspace, "domains.json", { domains: [] });
  const { status, body } = await handleSenderPoolStatusHttp({
    workspace,
    now: () => fixedNow
  });
  assert.equal(status, 200);
  assert.ok("domains" in body);
});
