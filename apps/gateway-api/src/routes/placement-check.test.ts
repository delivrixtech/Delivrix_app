import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import {
  GmailImapAdapter,
  GmailImapAdapterError,
  type ImapFlowClient,
  type ImapFlowFactory,
  type ClassifyResult
} from "../email-imap/gmail-adapter.ts";
import {
  createGmailImapAdapterFromEnv,
  handlePlacementCheckError,
  handlePlacementCheckHttp
} from "./placement-check.ts";

const validBody = {
  matchBy: "subject" as const,
  matcher: "[delivrix-warmup-abc123]",
  windowMinutes: 30,
  actorId: "codex-smoke"
};

test("POST /v1/openclaw/skills/placement-check classifies and audits", async () => {
  const adapter = mockAdapter({
    matched: 3,
    inbox: 2,
    spam: 1,
    promotions: 0,
    other: 0,
    placementRate: round4(2 / 3),
    elapsedMs: 42,
    samples: [
      { uid: 3, subject: "[delivrix-warmup-abc123] hi", from: "noreply@delivrix-mail.com", messageId: "<m3@x>", folder: "inbox", labels: ["\\Inbox"], receivedAt: "2026-05-28T11:00:03.000Z" },
      { uid: 2, subject: "[delivrix-warmup-abc123] hi", from: "noreply@delivrix-mail.com", messageId: "<m2@x>", folder: "inbox", labels: ["\\Inbox"], receivedAt: "2026-05-28T11:00:02.000Z" },
      { uid: 1, subject: "[delivrix-warmup-abc123] hi", from: "noreply@delivrix-mail.com", messageId: "<m1@x>", folder: "spam", labels: ["\\Junk"], receivedAt: "2026-05-28T11:00:01.000Z" }
    ]
  });

  const harness = await routeHarness();
  const response = await harness.call(validBody, { GMAIL_IMAP_ENABLE: "true", GMAIL_IMAP_USER: "x@gmail.com", GMAIL_IMAP_APP_PASSWORD: "secret" }, adapter);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.matched, 3);
  assert.equal(response.body.inbox, 2);
  assert.equal(response.body.spam, 1);
  assert.equal(response.body.samples.length, 3);
  assert.equal(response.body.meta.matcher, validBody.matcher);
  // password should never appear in body
  assert.equal(JSON.stringify(response.body).includes("secret"), false);

  const events = await harness.auditLog.list();
  const last = events.at(-1);
  assert.equal(last?.action, "oc.placement.checked");
  assert.equal(last?.metadata.matched, 3);
  assert.equal(last?.metadata.inbox, 2);
  assert.equal(last?.metadata.placementRate, round4(2 / 3));
  assert.equal(last?.metadata.matcher, validBody.matcher);
  // password should never appear in audit metadata
  assert.equal(JSON.stringify(last?.metadata).includes("secret"), false);
});

test("POST /v1/openclaw/skills/placement-check returns 409 when imap disabled", async () => {
  const harness = await routeHarness();
  const response = await harness.call(validBody, { GMAIL_IMAP_ENABLE: "false", GMAIL_IMAP_USER: "x@gmail.com", GMAIL_IMAP_APP_PASSWORD: "secret" }, null);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, "imap_disabled");
});

test("POST /v1/openclaw/skills/placement-check returns 409 when credentials missing", async () => {
  const harness = await routeHarness();
  const response = await harness.call(validBody, { GMAIL_IMAP_ENABLE: "true" }, null);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, "credentials_missing");
});

test("POST /v1/openclaw/skills/placement-check returns 502 on imap_connect_failed", async () => {
  const failAdapter = mockAdapter({
    throwError: new GmailImapAdapterError("imap_connect_failed", "ECONNREFUSED")
  });
  const harness = await routeHarness();
  const response = await harness.call(validBody, { GMAIL_IMAP_ENABLE: "true", GMAIL_IMAP_USER: "x@gmail.com", GMAIL_IMAP_APP_PASSWORD: "secret" }, failAdapter);
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, "imap_connect_failed");
  const events = await harness.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.placement.check_failed");
});

test("POST /v1/openclaw/skills/placement-check rejects matcher not matching delivrix regex", async () => {
  const adapter = mockAdapter({ matched: 0, inbox: 0, spam: 0, promotions: 0, other: 0, placementRate: 0, elapsedMs: 0, samples: [] });
  const harness = await routeHarness();
  const response = await harness.call(
    { ...validBody, matcher: "anything goes" },
    { GMAIL_IMAP_ENABLE: "true", GMAIL_IMAP_USER: "x@gmail.com", GMAIL_IMAP_APP_PASSWORD: "secret" },
    adapter
  );
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error, "invalid_matcher");
});

test("POST /v1/openclaw/skills/placement-check rejects windowMinutes out of range", async () => {
  const adapter = mockAdapter({ matched: 0, inbox: 0, spam: 0, promotions: 0, other: 0, placementRate: 0, elapsedMs: 0, samples: [] });
  const harness = await routeHarness();
  const response = await harness.call(
    { ...validBody, windowMinutes: 999 },
    { GMAIL_IMAP_ENABLE: "true", GMAIL_IMAP_USER: "x@gmail.com", GMAIL_IMAP_APP_PASSWORD: "secret" },
    adapter
  );
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error, "invalid_window_minutes");
});

test("createGmailImapAdapterFromEnv returns null when disabled", () => {
  const adapter = createGmailImapAdapterFromEnv({
    GMAIL_IMAP_ENABLE: "false",
    GMAIL_IMAP_HOST: "imap.gmail.com",
    GMAIL_IMAP_PORT: "993",
    GMAIL_IMAP_USER: "x@gmail.com",
    GMAIL_IMAP_APP_PASSWORD: "secret"
  });
  assert.equal(adapter, null);
});

test("createGmailImapAdapterFromEnv returns null when password missing", () => {
  const adapter = createGmailImapAdapterFromEnv({
    GMAIL_IMAP_ENABLE: "true",
    GMAIL_IMAP_HOST: "imap.gmail.com",
    GMAIL_IMAP_PORT: "993",
    GMAIL_IMAP_USER: "x@gmail.com",
    GMAIL_IMAP_APP_PASSWORD: ""
  });
  assert.equal(adapter, null);
});

test("createGmailImapAdapterFromEnv builds adapter when configured", () => {
  const adapter = createGmailImapAdapterFromEnv({
    GMAIL_IMAP_ENABLE: "true",
    GMAIL_IMAP_HOST: "imap.gmail.com",
    GMAIL_IMAP_PORT: "993",
    GMAIL_IMAP_USER: "x@gmail.com",
    GMAIL_IMAP_APP_PASSWORD: "secret"
  });
  assert.ok(adapter);
  assert.equal(adapter?.isConfigured(), true);
});

/* ============================================================
 * Harness
 * ============================================================ */

async function routeHarness() {
  const dir = await mkdtemp(join(tmpdir(), "placement-check-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));

  const call = async (
    body: unknown,
    env: Record<string, string | undefined>,
    adapter: GmailImapAdapter | null
  ) => {
    const response = captureResponse();
    try {
      await handlePlacementCheckHttp({
        request: requestWithJson(body),
        response: response as unknown as ServerResponse,
        auditLog,
        adapter,
        env,
        now: () => new Date("2026-05-28T11:30:00.000Z")
      });
    } catch (error) {
      if (!handlePlacementCheckError(error, response as unknown as ServerResponse)) {
        throw error;
      }
    }
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body) as Record<string, never>
    };
  };

  return { call, auditLog };
}

function mockAdapter(
  result: Partial<ClassifyResult> & { throwError?: GmailImapAdapterError }
): GmailImapAdapter {
  const factory: ImapFlowFactory = () => {
    const client: ImapFlowClient = {
      connect: async () => {},
      logout: async () => {},
      getMailboxLock: async () => ({ release: () => {} }),
      search: async () => [],
      fetchOne: async () => undefined
    };
    return client;
  };
  const adapter = new GmailImapAdapter({
    host: "imap.gmail.com",
    port: 993,
    user: "x@gmail.com",
    pass: "secret",
    imapFactory: factory
  });
  // Override classify with the desired result
  const fixed: ClassifyResult = {
    matched: result.matched ?? 0,
    inbox: result.inbox ?? 0,
    spam: result.spam ?? 0,
    promotions: result.promotions ?? 0,
    other: result.other ?? 0,
    placementRate: result.placementRate ?? 0,
    samples: result.samples ?? [],
    elapsedMs: result.elapsedMs ?? 0
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as unknown as { classify: typeof adapter.classify }).classify = async () => {
    if (result.throwError) throw result.throwError;
    return fixed;
  };
  return adapter;
}

function captureResponse() {
  let statusCode = 0;
  let body = "";
  return {
    statusCode,
    body,
    writeHead(code: number, _headers?: unknown) {
      statusCode = code;
      // capture into the outer closure
      this.statusCode = code;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      this.body = body;
    }
  };
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/openclaw/skills/placement-check",
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
