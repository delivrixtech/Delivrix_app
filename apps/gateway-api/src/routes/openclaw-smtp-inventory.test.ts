import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { handleInspectSmtpInventoryHttp } from "./openclaw-smtp-inventory.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const readToken = "smtp-inventory-read-token";
const fixedNow = new Date("2026-06-30T20:00:00.000Z");

test("inspect_smtp_inventory reports ambiguous configured domains without exposing credentials", async () => {
  const { workspace, response, auditEvents } = await route({
    url: "/v1/openclaw/smtp-inventory?domain=legacy-one.com",
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running", providerId: "webdock" }]
  });
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      {
        serverSlug: "server85",
        domain: "legacy-one.com",
        serverIp: "192.0.2.85",
        selector: "default",
        status: "configured",
        smtpCredential: { hasCredential: true, username: "mailer@legacy-one.com", status: "configured", domain: "legacy-one.com", serverSlug: "server85", host: "smtp.legacy-one.com", updatedAt: fixedNow.toISOString(), credentialId: "cred-1" },
        updatedAt: fixedNow.toISOString()
      },
      {
        serverSlug: "server88",
        domain: "legacy-one.com",
        serverIp: "192.0.2.88",
        selector: "default",
        status: "configured",
        updatedAt: fixedNow.toISOString()
      }
    ]
  }));

  await response.run();

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, false);
  assert.equal(body.totals.ambiguousDomains, 1);
  assert.deepEqual(body.ambiguousDomains[0].configuredServerSlugs, ["server85", "server88"]);
  assert.equal(JSON.stringify(body).includes("smtpCredentialEncrypted"), false);
  assert.equal(body.servers[0].hasCredential, true);
  assert.equal(body.servers.find((server: any) => server.serverSlug === "server88").existsInLiveInventory, true);
  assert.equal(auditEvents[0].type, "oc.smtp_inventory.inspect_read");
});

test("inspect_smtp_inventory rejects invalid read token", async () => {
  const { response } = await route({ headers: { "x-delivrix-token": "nope" } });
  await response.run();
  assert.equal(response.statusCode, 401);
});

test("inspect_smtp_inventory fails closed when live source is missing", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const rootDir = await mkdtemp(join(tmpdir(), "smtp-inventory-route-"));
  const workspace = new OpenClawWorkspace({ rootDir, now: () => fixedNow });
  const response = captureResponse(async () => {
    await handleInspectSmtpInventoryHttp(
      request("/v1/openclaw/smtp-inventory", { "x-delivrix-token": readToken }),
      response as unknown as ServerResponse,
      {
        workspace,
        readBoundaryToken: readToken,
        now: () => fixedNow
      }
    );
  });

  await response.run();

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { error: "smtp_inventory_live_source_missing" });
});

async function route(input: {
  url?: string;
  headers?: Record<string, string>;
  liveServers?: Array<{ serverSlug: string; ipv4?: string; status?: string; providerId?: string }>;
} = {}) {
  resetSensitiveReadAuthBucketsForTests();
  const rootDir = await mkdtemp(join(tmpdir(), "smtp-inventory-route-"));
  const workspace = new OpenClawWorkspace({ rootDir, now: () => fixedNow });
  const auditEvents: Array<Record<string, unknown>> = [];
  const response = captureResponse(async () => {
    await handleInspectSmtpInventoryHttp(
      request(input.url ?? "/v1/openclaw/smtp-inventory", input.headers ?? { "x-delivrix-token": readToken }),
      response as unknown as ServerResponse,
      {
        workspace,
        listLiveServers: async () => input.liveServers ?? [],
        emitAudit: async (event) => { auditEvents.push(event); },
        readBoundaryToken: readToken,
        now: () => fixedNow
      }
    );
  });
  return { workspace, response, auditEvents };
}

function request(url: string, headers: Record<string, string>): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, { method: "GET", url, headers }) as IncomingMessage;
}

function captureResponse(run: () => Promise<void>): {
  statusCode: number;
  body: string;
  run: () => Promise<void>;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
  return {
    statusCode: 0,
    body: "",
    run,
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}
