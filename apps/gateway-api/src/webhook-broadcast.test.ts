import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEventInput } from "../../../packages/domain/src/index.ts";
import { EquipoWebhookBroadcaster } from "./webhook-broadcast.ts";

function baseEvent(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actorType: "openclaw",
    actorId: "openclaw-bedrock",
    action: "oc.route53.domain_registered",
    targetType: "domain",
    targetId: "delivrix-test.com",
    riskLevel: "high",
    metadata: { category: "supervised_local_state", domain: "delivrix-test.com" },
    ...overrides
  };
}

async function makeTmpBuffer(): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "webhook-broadcast-"));
  return { path: join(dir, "buffer.jsonl"), dir };
}

function makeFetchOk(): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      body: typeof init?.body === "string" ? init.body : ""
    });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeFetchAlways500(): {
  fetchImpl: typeof fetch;
  calls: number;
} {
  const counter = { n: 0 };
  const fetchImpl: typeof fetch = (async () => {
    counter.n++;
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  return {
    fetchImpl,
    get calls() {
      return counter.n;
    }
  };
}

test("redactSecrets redacta token/password/secret/api_key/bearer", () => {
  const b = new EquipoWebhookBroadcaster();
  const out = b.redactSecrets({
    token: "abc123",
    password: "hunter2",
    SECRET: "topsecret",
    api_key: "k-1",
    apiKey: "k-2",
    bearer: "eyJ...",
    private_key: "----BEGIN----",
    safe: "ok"
  });
  assert.equal(out.token, "[REDACTED]");
  assert.equal(out.password, "[REDACTED]");
  assert.equal(out.SECRET, "[REDACTED]");
  assert.equal(out.api_key, "[REDACTED]");
  assert.equal(out.apiKey, "[REDACTED]");
  assert.equal(out.bearer, "[REDACTED]");
  assert.equal(out.private_key, "[REDACTED]");
  assert.equal(out.safe, "ok");
});

test("redactSecrets recursivo en objetos anidados y arrays", () => {
  const b = new EquipoWebhookBroadcaster();
  const out = b.redactSecrets({
    user: {
      id: "u-1",
      password: "p",
      nested: { api_key: "k" }
    },
    creds: [{ token: "t1" }, { token: "t2", name: "ok" }, "raw-string"]
  });
  const user = out.user as Record<string, unknown>;
  assert.equal(user.id, "u-1");
  assert.equal(user.password, "[REDACTED]");
  const nested = user.nested as Record<string, unknown>;
  assert.equal(nested.api_key, "[REDACTED]");
  const creds = out.creds as Array<Record<string, unknown> | string>;
  assert.equal((creds[0] as Record<string, unknown>).token, "[REDACTED]");
  assert.equal((creds[1] as Record<string, unknown>).token, "[REDACTED]");
  assert.equal((creds[1] as Record<string, unknown>).name, "ok");
  assert.equal(creds[2], "raw-string");
});

test("shouldBroadcast true para oc.route53.domain_registered, false para oc.read.overview", () => {
  const b = new EquipoWebhookBroadcaster();
  assert.equal(
    b.shouldBroadcast(
      baseEvent({ action: "oc.route53.domain_registered", metadata: {} })
    ),
    true
  );
  assert.equal(
    b.shouldBroadcast(baseEvent({ action: "oc.read.overview", metadata: {} })),
    false
  );
  // categoría crítica explícita override
  assert.equal(
    b.shouldBroadcast(
      baseEvent({ action: "oc.read.overview", metadata: { category: "prohibited" } })
    ),
    true
  );
});

test("broadcast con webhookUrl válido + fetch 200 → delivered=true", async () => {
  const { path: bufferPath, dir } = await makeTmpBuffer();
  try {
    const { fetchImpl, calls } = makeFetchOk();
    const b = new EquipoWebhookBroadcaster({
      webhookUrl: "https://hooks.example.com/T/X/Y",
      fetchImpl,
      bufferPath,
      baseDelayMs: 0
    });
    const res = await b.broadcast(baseEvent());
    assert.equal(res.delivered, true);
    assert.equal(res.buffered, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://hooks.example.com/T/X/Y");
    const sent = JSON.parse(calls[0].body) as { meta: { auditId: string } };
    assert.equal(typeof sent.meta.auditId, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("broadcast con webhookUrl válido + fetch 500 N veces → buffered=true tras retries", async () => {
  const { path: bufferPath, dir } = await makeTmpBuffer();
  try {
    const failer = makeFetchAlways500();
    const b = new EquipoWebhookBroadcaster({
      webhookUrl: "https://hooks.example.com/dead",
      fetchImpl: failer.fetchImpl,
      bufferPath,
      maxRetries: 3,
      baseDelayMs: 0
    });
    const res = await b.broadcast(baseEvent());
    assert.equal(res.delivered, false);
    assert.equal(res.buffered, true);
    assert.equal(failer.calls, 3);
    const content = await readFile(bufferPath, "utf-8");
    assert.ok(content.includes("oc.route53.domain_registered"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("broadcast sin webhookUrl → buffered=true inmediato", async () => {
  const { path: bufferPath, dir } = await makeTmpBuffer();
  try {
    const b = new EquipoWebhookBroadcaster({ bufferPath, baseDelayMs: 0 });
    const res = await b.broadcast(baseEvent());
    assert.equal(res.delivered, false);
    assert.equal(res.buffered, true);
    const content = await readFile(bufferPath, "utf-8");
    const parsed = JSON.parse(content.trim()) as {
      bufferedAt: string;
      payload: { meta: { auditId: string } };
    };
    assert.equal(typeof parsed.bufferedAt, "string");
    assert.equal(typeof parsed.payload.meta.auditId, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("broadcast con killSwitch armado → skipped='kill_switch_armed'", async () => {
  const { path: bufferPath, dir } = await makeTmpBuffer();
  try {
    const { fetchImpl, calls } = makeFetchOk();
    const b = new EquipoWebhookBroadcaster({
      webhookUrl: "https://hooks.example.com/x",
      fetchImpl,
      bufferPath,
      killSwitchProvider: async () => true,
      baseDelayMs: 0
    });
    const res = await b.broadcast(baseEvent());
    assert.equal(res.delivered, false);
    assert.equal(res.buffered, false);
    assert.equal(res.skipped, "kill_switch_armed");
    assert.equal(calls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("broadcast ignora eventos no críticos sin tocar webhook ni buffer", async () => {
  const { path: bufferPath, dir } = await makeTmpBuffer();
  try {
    const { fetchImpl, calls } = makeFetchOk();
    const b = new EquipoWebhookBroadcaster({
      webhookUrl: "https://hooks.example.com/x",
      fetchImpl,
      bufferPath,
      baseDelayMs: 0
    });
    const res = await b.broadcast(
      baseEvent({ action: "oc.read.overview", metadata: {} })
    );
    assert.equal(res.delivered, false);
    assert.equal(res.buffered, false);
    assert.equal(res.skipped, "not_critical");
    assert.equal(calls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildPayload incluye audit_id + actor + category en blocks", () => {
  const b = new EquipoWebhookBroadcaster({ panelBaseUrl: "https://panel.delivrix.dev" });
  const payload = b.buildPayload(
    baseEvent({
      metadata: {
        auditId: "audit-42",
        category: "supervised_local_state",
        domain: "ex.com",
        serverSlug: "web-1"
      }
    })
  );
  assert.equal(payload.meta.auditId, "audit-42");
  assert.equal(payload.meta.category, "supervised_local_state");
  assert.equal(payload.meta.domain, "ex.com");
  assert.equal(payload.meta.serverSlug, "web-1");
  assert.equal(payload.meta.actorHuman, "openclaw-bedrock");
  assert.equal(payload.meta.panelUrl, "https://panel.delivrix.dev/audit/audit-42");
  const serialized = JSON.stringify(payload.blocks);
  assert.ok(serialized.includes("audit-42"));
  assert.ok(serialized.includes("openclaw-bedrock"));
  assert.ok(serialized.includes("supervised_local_state"));
});

test("buffer local NO contiene secrets (token/password redactados antes de escribir)", async () => {
  const { path: bufferPath, dir } = await makeTmpBuffer();
  try {
    const b = new EquipoWebhookBroadcaster({ bufferPath, baseDelayMs: 0 });
    await b.broadcast(
      baseEvent({
        metadata: {
          category: "supervised_local_state",
          domain: "ex.com",
          token: "super-secret-token-123",
          nested: { password: "p4ssw0rd-leak" }
        }
      })
    );
    const content = await readFile(bufferPath, "utf-8");
    // Security invariant: raw secrets MUST NOT appear in buffer file.
    assert.ok(!content.includes("super-secret-token-123"));
    assert.ok(!content.includes("p4ssw0rd-leak"));
    // The payload still flows through redactSecrets() — sanity check that
    // domain (a non-secret field) survives so we know the event was buffered.
    assert.ok(content.includes("ex.com"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("webhook payload enviado NO contiene secrets", async () => {
  const { path: bufferPath, dir } = await makeTmpBuffer();
  try {
    const { fetchImpl, calls } = makeFetchOk();
    const b = new EquipoWebhookBroadcaster({
      webhookUrl: "https://hooks.example.com/x",
      fetchImpl,
      bufferPath,
      baseDelayMs: 0
    });
    await b.broadcast(
      baseEvent({
        metadata: {
          category: "supervised_local_state",
          api_key: "AKIA-LEAK-9999",
          bearer: "eyJ-leak-token"
        }
      })
    );
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].body.includes("AKIA-LEAK-9999"));
    assert.ok(!calls[0].body.includes("eyJ-leak-token"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("killSwitchProvider que lanza error es tratado como NO armado", async () => {
  const { path: bufferPath, dir } = await makeTmpBuffer();
  try {
    const { fetchImpl, calls } = makeFetchOk();
    const b = new EquipoWebhookBroadcaster({
      webhookUrl: "https://hooks.example.com/x",
      fetchImpl,
      bufferPath,
      killSwitchProvider: async () => {
        throw new Error("kill switch backend down");
      },
      baseDelayMs: 0
    });
    const res = await b.broadcast(baseEvent());
    assert.equal(res.delivered, true);
    assert.equal(calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
