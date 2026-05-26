import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  AwsRoute53DnsChangeResult,
  AwsRoute53DnsRecordInput,
  AwsRoute53DnsSource
} from "../../../../packages/adapters/src/index.ts";
import type {
  CanvasLiveEvent,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  buildEmailAuthRecords,
  handleEmailAuthConfigureHttp,
  handleEmailAuthError,
  type EmailAuthDnsAdapter
} from "./domains-email-auth.ts";

const fixedNow = new Date("2026-05-27T15:00:00.000Z");

test("buildEmailAuthRecords creates SPF, DKIM, and DMARC records with p=none default", () => {
  const records = buildEmailAuthRecords({
    domain: "delivrix-mail.com",
    mxServerIp: "192.0.2.10",
    selector: "default",
    dmarcPolicy: "none",
    dkimPublicKey: "PUBLICKEY"
  });

  assert.deepEqual(records, [
    {
      name: "delivrix-mail.com.",
      type: "TXT",
      ttl: 300,
      values: ["v=spf1 ip4:192.0.2.10 -all"]
    },
    {
      name: "default._domainkey.delivrix-mail.com.",
      type: "TXT",
      ttl: 300,
      values: ["v=DKIM1; k=rsa; p=PUBLICKEY"]
    },
    {
      name: "_dmarc.delivrix-mail.com.",
      type: "TXT",
      ttl: 300,
      values: [
        "v=DMARC1; p=none; rua=mailto:dmarc-reports@delivrix.com; ruf=mailto:dmarc-forensics@delivrix.com; fo=1"
      ]
    }
  ]);
});

test("POST /v1/domains/auth/configure blocks without zone, live writes, and approval", async () => {
  const route = await routeHarness({
    adapter: mockAdapter({ isLive: () => false, isWriteEnabled: () => false }),
    canvasState: canvasState([])
  });

  const response = await route({
    domain: "delivrix-mail.com",
    mxServerIp: "192.0.2.10",
    actorId: "operator/juanes",
    approvalToken: "exec-missing",
    taskId: "task-auth-blocked"
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers.sort(), [
    "approval_not_found_or_expired",
    "aws_route53_dns_credentials_missing",
    "dns_write_flag_disabled",
    "route53_zone_missing"
  ].sort());
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.email_auth.configure_blocked");
});

test("POST /v1/domains/auth/configure publishes records and saves DKIM private key in workspace", async () => {
  const upserts: AwsRoute53DnsRecordInput[] = [];
  const route = await routeHarness({
    adapter: mockAdapter({
      isLive: () => true,
      isWriteEnabled: () => true,
      upsertRecord: async (_zoneId, record) => {
        upserts.push(record);
        return { changeId: `C${upserts.length}` };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-auth-plan",
      executionId: "exec-auth-123",
      approvedAt: "2026-05-27T14:58:00.000Z"
    }])
  });
  await route.workspace.updateInventoryJson("domains.json", () => ({
    dnsZones: [{
      domain: "delivrix-mail.com",
      zoneId: "Z123",
      nameServers: ["ns-1.awsdns.com"],
      updatedAt: fixedNow.toISOString(),
      records: []
    }]
  }));
  await appendApproval(route.auditLog, "artifact-auth-plan", "exec-auth-123");

  const response = await route({
    domain: "Delivrix-Mail.COM.",
    mxServerIp: "192.000.002.010",
    actorId: "operator/juanes",
    approvalToken: "exec-auth-123",
    taskId: "task-auth-configure"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.zoneId, "Z123");
  assert.equal(response.body.selector, "default");
  assert.equal(upserts.length, 3);
  assert.deepEqual(upserts.map((record) => record.name), [
    "delivrix-mail.com.",
    "default._domainkey.delivrix-mail.com.",
    "_dmarc.delivrix-mail.com."
  ]);
  assert.match(upserts[1].values[0], /^v=DKIM1; k=rsa; p=[A-Za-z0-9+/]+=*$/);

  const privateKey = await readFile(join(route.workspace.getRootDir(), response.body.dkimPrivateKeyPath), "utf8");
  assert.match(privateKey, /BEGIN PRIVATE KEY/);

  const events = await route.auditLog.list();
  const configured = events.at(-1);
  assert.equal(configured?.action, "oc.email_auth.configured");
  assert.equal(configured?.metadata.recordCount, 3);
  assert.equal(JSON.stringify(configured?.metadata).includes("BEGIN PRIVATE KEY"), false);

  const inventory = await route.workspace.readInventoryJson<{ emailAuth: Array<{ domain: string; dkimPrivateKeyPath: string }> }>("domains.json");
  assert.equal(inventory?.emailAuth[0].domain, "delivrix-mail.com");
  assert.equal(inventory?.emailAuth[0].dkimPrivateKeyPath, response.body.dkimPrivateKeyPath);
  assert.ok(route.canvasEvents.some((event) => event.type === "oc.action.now" && event.kind === "command"));
});

async function routeHarness(input: {
  adapter: EmailAuthDnsAdapter;
  canvasState: CanvasLiveStateSnapshot;
}) {
  const dir = await mkdtemp(join(tmpdir(), "email-auth-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  const canvasEvents: CanvasLiveEvent[] = [];

  const route = async (body: unknown): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleEmailAuthConfigureHttp({
        request: requestWithJson(body),
        response: response as unknown as ServerResponse,
        auditLog,
        dnsAdapter: input.adapter,
        workspace,
        canvasLiveEvents: {
          emit: async (event) => {
            canvasEvents.push(event);
            return event;
          }
        },
        readCanvasState: () => input.canvasState,
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleEmailAuthError(error, response as unknown as ServerResponse)) {
        throw error;
      }
    }
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body)
    };
  };
  return Object.assign(route, { auditLog, workspace, canvasEvents });
}

function mockAdapter(overrides: Partial<EmailAuthDnsAdapter> = {}): EmailAuthDnsAdapter {
  return {
    isLive: () => true,
    isWriteEnabled: () => false,
    currentSource: (responseOk = true, errorMessage?: string): AwsRoute53DnsSource => ({
      kind: "live",
      region: "us-east-1",
      apiBase: "https://route53.amazonaws.com",
      fetchedAt: fixedNow.toISOString(),
      responseOk,
      ...(errorMessage ? { errorMessage } : {}),
      writeEnabled: false
    }),
    upsertRecord: async (): Promise<AwsRoute53DnsChangeResult> => {
      throw new Error("upsertRecord mock not implemented");
    },
    ...overrides
  };
}

async function appendApproval(
  auditLog: LocalFileAuditLog,
  artifactId: string,
  executionId: string
): Promise<void> {
  await auditLog.append({
    occurredAt: "2026-05-27T14:58:00.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: artifactId,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: { executionId, blockCount: 1 }
  });
}

function canvasState(approvals: Array<{
  artifactId: string;
  executionId: string;
  approvedAt: string;
}>): CanvasLiveStateSnapshot {
  return {
    schemaVersion: "2026-05-25.canvas-live.v1",
    generatedAt: fixedNow.toISOString(),
    tasks: [],
    artifacts: approvals.map((approval) => ({
      artifactId: approval.artifactId,
      taskId: "task-auth-plan",
      kind: "proposal",
      title: "Configurar autenticación",
      editable: true,
      createdAt: "2026-05-27T14:57:00.000Z",
      updatedAt: approval.approvedAt,
      approvalStatus: "approved",
      approvedBy: "operator/juanes",
      approvedAt: approval.approvedAt,
      executionId: approval.executionId,
      blocks: []
    }))
  };
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/domains/auth/configure",
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function captureResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}
