import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEventInput } from "../../../packages/domain/src/index.ts";
import {
  ChatProxyError,
  normalizeAgentChatEvent,
  OpenClawChatProxy,
  openClawChatReconnectDelayMs,
  type ChatStreamEvent,
  type OpenClawChatPanelClient,
  type OpenClawChatSshBridge
} from "./openclaw-chat.ts";

class MemoryAudit {
  readonly events: AuditEventInput[] = [];

  async append(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

class MemoryPanelClient implements OpenClawChatPanelClient {
  readonly events: ChatStreamEvent[] = [];
  closed = false;

  sendJson(event: ChatStreamEvent): void {
    this.events.push(event);
  }

  close(): void {
    this.closed = true;
  }
}

test("OpenClaw chat send proxies with gateway token and audits operator message", async () => {
  const audit = new MemoryAudit();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ msgId: "018f7b54-7d4d-7cc2-9c90-df7486c5a333", queued: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const proxy = new OpenClawChatProxy(audit, {
    agentHttpUrl: "http://openclaw.test:61175",
    gatewayToken: "secret-gateway-token",
    readBoundaryToken: "read-token",
    delivrixBaseUrl: "http://gateway.test:3000",
    fetchImpl: fetchImpl as typeof fetch
  });

  const result = await proxy.sendOperatorMessage({
    msgId: "018f7b54-7d4d-7cc2-9c90-df7486c5a333",
    message: "¿qué gates tiene el MVP?"
  });

  assert.deepEqual(result, {
    msgId: "018f7b54-7d4d-7cc2-9c90-df7486c5a333",
    queued: true
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://openclaw.test:61175/api/chat.send");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer secret-gateway-token");

  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.sessionKey, "agent:main:operator");
  assert.equal(body.context.delivrix_endpoint_token, "read-token");
  assert.equal(body.message.content, "¿qué gates tiene el MVP?");

  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].action, "oc.chat.operator_message");
  assert.equal(audit.events[0].actorType, "operator");
  assert.equal(audit.events[0].targetId, "agent:main:operator");
  assert.deepEqual(audit.events[0].metadata, {
    msgId: "018f7b54-7d4d-7cc2-9c90-df7486c5a333",
    sessionKey: "agent:main:operator",
    length: "¿qué gates tiene el MVP?".length
  });
});

test("OpenClaw chat send rejects login HTML returned as HTTP 200", async () => {
  const audit = new MemoryAudit();
  const fetchImpl = async () => new Response("<html>login</html>", {
    status: 200,
    headers: { "content-type": "text/html" }
  });
  const proxy = new OpenClawChatProxy(audit, {
    agentHttpUrl: "http://openclaw.test:61175",
    gatewayToken: "secret-gateway-token",
    fetchImpl: fetchImpl as typeof fetch
  });

  await assert.rejects(
    () => proxy.sendOperatorMessage({
      msgId: "018f7b54-7d4d-7cc2-9c90-df7486c5a333",
      message: "diag ping"
    }),
    (error) => {
      assert.ok(error instanceof ChatProxyError);
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, "openclaw_chat_send_invalid_response");
      return true;
    }
  );

  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].action, "oc.chat.operator_message");
  assert.equal(audit.events[0].decision, "reject");
  assert.equal(audit.events[0].rejectReason, "gateway_internal_error");
  assert.deepEqual(audit.events[0].metadata, {
    msgId: "018f7b54-7d4d-7cc2-9c90-df7486c5a333",
    sessionKey: "agent:main:operator",
    length: "diag ping".length,
    upstreamStatus: 200,
    upstreamResponse: "invalid_chat_send_ack"
  });
});

test("OpenClaw chat send falls back to HTTP after consecutive SSH bridge failures", async () => {
  const audit = new MemoryAudit();
  const bridge: OpenClawChatSshBridge = {
    async sendMessage() {
      throw new Error("ssh command timed out");
    },
    async streamHistory() {
      throw new Error("not reached");
    }
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ msgId: "018f7b54-7d4d-7cc2-9c90-df7486c5a333", queued: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const proxy = new OpenClawChatProxy(audit, {
    bridgeKind: "ssh",
    sshBridge: bridge,
    sshBridgeFailureThreshold: 2,
    agentHttpUrl: "http://openclaw.test:61175",
    gatewayToken: "secret-gateway-token",
    fetchImpl: fetchImpl as typeof fetch
  });

  await assert.rejects(
    () => proxy.sendOperatorMessage({
      msgId: "018f7b54-7d4d-7cc2-9c90-df7486c5a333",
      message: "hola"
    }),
    (error) => {
      assert.ok(error instanceof ChatProxyError);
      assert.equal(error.code, "openclaw_ssh_bridge_failed");
      return true;
    }
  );

  const result = await proxy.sendOperatorMessage({
    msgId: "018f7b54-7d4d-7cc2-9c90-df7486c5a333",
    message: "hola"
  });

  assert.deepEqual(result, {
    msgId: "018f7b54-7d4d-7cc2-9c90-df7486c5a333",
    queued: true
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://openclaw.test:61175/api/chat.send");
  assert.equal(audit.events.length, 2);
  assert.equal(audit.events[0].decision, "reject");
  assert.equal(audit.events[0].metadata.bridge, "ssh");
  assert.equal(audit.events[1].decision, "n/a");
});

test("OpenClaw chat send accepts text alias and non-UUID smoke msgId for SSH bridge", async () => {
  const audit = new MemoryAudit();
  const bridge: OpenClawChatSshBridge = {
    async sendMessage(input) {
      assert.deepEqual(input, {
        msgId: "smoke-002",
        actor: "smoke",
        text: "hola desde el gateway",
        message: "hola desde el gateway"
      });
      return { msgId: "smoke-002", queued: true };
    },
    async streamHistory() {
      throw new Error("not reached without panel clients");
    }
  };
  const proxy = new OpenClawChatProxy(audit, {
    bridgeKind: "ssh",
    sshBridge: bridge
  });

  const result = await proxy.sendOperatorMessage({
    msgId: "smoke-002",
    actor: "smoke",
    text: "hola desde el gateway"
  });

  assert.deepEqual(result, {
    msgId: "smoke-002",
    queued: true
  });
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].metadata.msgId, "smoke-002");
  assert.equal(audit.events[0].metadata.bridge, "ssh");
});

test("OpenClaw chat stream normalizes, multiplexes, and audits assistant completion", async () => {
  const audit = new MemoryAudit();
  const proxy = new OpenClawChatProxy(audit, {
    gatewayToken: "",
    webSocketCtor: undefined
  });
  const a = new MemoryPanelClient();
  const b = new MemoryPanelClient();
  proxy.addPanelClient(a);
  proxy.addPanelClient(b);

  const event = await proxy.handleAgentMessage({
    type: "ASSISTANT_DONE",
    msgId: "reply-1",
    assistant: {
      content: "Respuesta completa",
      skillsInvoked: ["delivrix-fleet-ops"],
      proposals: [{ category: "node_pause_proposed" }],
      audit: { tokensUsed: 45, duration_ms: 321 }
    }
  });

  assert.deepEqual(event, {
    type: "ASSISTANT_DONE",
    msgId: "reply-1",
    content: "Respuesta completa",
    audit: {
      skillsInvoked: ["delivrix-fleet-ops"],
      tokensUsed: 45,
      durationMs: 321
    },
    proposals: [{ category: "node_pause_proposed" }]
  });
  assert.equal(a.events.at(-1)?.type, "ASSISTANT_DONE");
  assert.deepEqual(a.events.at(-1), b.events.at(-1));
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].action, "oc.chat.agent_response");
  assert.equal(audit.events[0].actorType, "openclaw");
  assert.equal(audit.events[0].riskLevel, "medium");
  assert.deepEqual(audit.events[0].metadata, {
    msgId: "reply-1",
    sessionKey: "agent:main:operator",
    contentLength: "Respuesta completa".length,
    skillsInvoked: ["delivrix-fleet-ops"],
    tokensUsed: 45,
    durationMs: 321,
    proposalsCount: 1
  });
});

test("OpenClaw chat event parser supports stream delta and backoff schedule", () => {
  assert.deepEqual(normalizeAgentChatEvent({
    type: "ASSISTANT_DELTA",
    msgId: "m1",
    delta: "hola"
  }), {
    type: "ASSISTANT_DELTA",
    msgId: "m1",
    delta: "hola"
  });

  assert.deepEqual(normalizeAgentChatEvent({
    type: "ASSISTANT_TYPING",
    msgId: "m1",
    ts: "2026-05-24T18:00:00.000Z"
  }), {
    type: "ASSISTANT_TYPING",
    msgId: "m1",
    ts: "2026-05-24T18:00:00.000Z"
  });

  assert.deepEqual(normalizeAgentChatEvent({
    type: "ASSISTANT_BLOCKED",
    msgId: "m1",
    reason: "ssh_history_timeout"
  }), {
    type: "ASSISTANT_BLOCKED",
    msgId: "m1",
    reason: "ssh_history_timeout"
  });

  assert.equal(openClawChatReconnectDelayMs(1), 1_000);
  assert.equal(openClawChatReconnectDelayMs(2), 2_000);
  assert.equal(openClawChatReconnectDelayMs(3), 4_000);
  assert.equal(openClawChatReconnectDelayMs(4), 8_000);
  assert.equal(openClawChatReconnectDelayMs(5), 30_000);
});
