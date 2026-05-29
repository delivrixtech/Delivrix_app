import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEventInput, CanvasLiveEvent, CanvasLiveStateSnapshot } from "../../../packages/domain/src/index.ts";
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

class MemoryCanvas {
  readonly events: CanvasLiveEvent[] = [];

  async emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent> {
    this.events.push(event);
    return event;
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

test("OpenClaw chat send uses local continuity fallback when enabled", async () => {
  const audit = new MemoryAudit();
  const client = new MemoryPanelClient();
  const fetchImpl = async () => new Response("<html>login</html>", {
    status: 200,
    headers: { "content-type": "text/html" }
  });
  const proxy = new OpenClawChatProxy(audit, {
    agentHttpUrl: "http://openclaw.test:61175",
    gatewayToken: "secret-gateway-token",
    fetchImpl: fetchImpl as typeof fetch,
    localFallbackEnabled: true,
    now: () => new Date("2026-05-29T14:30:00.000Z")
  });
  proxy.addPanelClient(client);

  const response = await proxy.sendOperatorMessage({
    msgId: "fallback-001",
    message: "Ya funcionas openclaw?"
  });

  assert.equal(response.msgId, "fallback-001");
  assert.equal(response.queued, true);
  assert.equal(response.assistant?.source, "delivrix.gateway_local_continuity");
  assert.match(response.assistant?.content ?? "", /modo continuidad local/);
  assert.equal(client.events.some((event) => event.type === "ASSISTANT_DONE"), true);
  assert.equal(audit.events.some((event) => event.action === "oc.chat.local_fallback"), true);
  const fallbackAudit = audit.events.find((event) => event.action === "oc.chat.local_fallback");
  assert.equal(fallbackAudit?.metadata.upstreamErrorCode, "openclaw_chat_send_invalid_response");
});

test("OpenClaw local continuity fallback answers VPS intents with real gates", async () => {
  const audit = new MemoryAudit();
  const fetchImpl = async () => new Response("<html>login</html>", {
    status: 200,
    headers: { "content-type": "text/html" }
  });
  const proxy = new OpenClawChatProxy(audit, {
    agentHttpUrl: "http://openclaw.test:61175",
    gatewayToken: "secret-gateway-token",
    fetchImpl: fetchImpl as typeof fetch,
    localFallbackEnabled: true,
    now: () => new Date("2026-05-29T14:35:00.000Z")
  });

  const response = await proxy.sendOperatorMessage({
    msgId: "fallback-vps-001",
    message: "Podemos crear un vps?"
  });

  assert.equal(response.queued, true);
  assert.equal(response.assistant?.source, "delivrix.webdock_vps_planner");
  assert.match(response.assistant?.content ?? "", /POST \/v1\/webdock\/servers\/create/);
  assert.match(response.assistant?.content ?? "", /approvalToken humano reciente/);
  assert.match(response.assistant?.content ?? "", /WEBDOCK_SERVERS_ENABLE_CREATE=true/);
  assert.deepEqual(response.assistant?.skillsInvoked, [
    "delivrix.webdock_vps_planner",
    "provision_webdock_vps"
  ]);
});

test("OpenClaw local continuity fallback answers SMTP intents with current canvas gates", async () => {
  const audit = new MemoryAudit();
  const canvas = new MemoryCanvas() as MemoryCanvas & { snapshot: () => Promise<CanvasLiveStateSnapshot> };
  canvas.snapshot = async () => ({
    schemaVersion: "2026-05-25.canvas-live.v1",
    generatedAt: "2026-05-29T14:42:00.000Z",
    tasks: [{
      taskId: "task-b8b9-t5-smtp-opendkim-fix",
      title: "SMTP stack · delivrix-demo-d10-20260527.click",
      status: "completed",
      createdAt: "2026-05-28T01:12:00.000Z",
      updatedAt: "2026-05-28T01:13:08.000Z",
      actorId: "juanescanar-cto",
      lastAction: {
        type: "oc.action.now",
        taskId: "task-b8b9-t5-smtp-opendkim-fix",
        kind: "audit",
        action: "oc.smtp.provisioned",
        targetType: "webdock_server",
        targetId: "server69",
        riskLevel: "critical",
        occurredAt: "2026-05-28T01:13:08.000Z"
      }
    }],
    artifacts: [{
      artifactId: "artifact-b8b9-finish-20260527",
      taskId: "task-b8b9-finish-20260527",
      kind: "proposal",
      title: "Approve B8/B9 finish",
      editable: true,
      createdAt: "2026-05-28T01:12:11.000Z",
      updatedAt: "2026-05-28T01:12:11.000Z",
      approvalStatus: "approved",
      approvedBy: "juanescanar-cto",
      approvedAt: "2026-05-28T01:12:30.000Z",
      executionId: "exec-e3d1a72c",
      blocks: [{
        blockId: "scope",
        order: 1,
        kind: "paragraph",
        content: "Approve B8/B9 finish: retry SMTP provisioning on server69 for delivrix-demo-d10-20260527.click after timeout/OpenDKIM PID fix.",
        editable: true,
        status: "complete",
        updatedAt: "2026-05-28T01:12:11.000Z"
      }]
    }]
  });
  const fetchImpl = async () => new Response("<html>login</html>", {
    status: 200,
    headers: { "content-type": "text/html" }
  });
  const proxy = new OpenClawChatProxy(audit, {
    agentHttpUrl: "http://openclaw.test:61175",
    gatewayToken: "secret-gateway-token",
    fetchImpl: fetchImpl as typeof fetch,
    canvasLiveEvents: canvas,
    localFallbackEnabled: true,
    now: () => new Date("2026-05-29T14:42:00.000Z")
  });

  const response = await proxy.sendOperatorMessage({
    msgId: "fallback-smtp-001",
    message: "necesito configurar el smtp nuevo que tenemos. hazlo."
  });

  assert.equal(response.queued, true);
  assert.equal(response.assistant?.source, "delivrix.smtp_provisioning_planner");
  assert.match(response.assistant?.content ?? "", /POST \/v1\/servers\/:serverSlug\/provision-smtp/);
  assert.match(response.assistant?.content ?? "", /server69/);
  assert.match(response.assistant?.content ?? "", /delivrix-demo-d10-20260527\.click/);
  assert.match(response.assistant?.content ?? "", /exec-e3d1a72c/);
  assert.deepEqual(response.assistant?.skillsInvoked, [
    "delivrix.smtp_provisioning_planner",
    "install_smtp_stack",
    "start_warmup_seed"
  ]);
});

test("OpenClaw chat send falls back to local continuity when SSH bridge returns invalid ack", async () => {
  const audit = new MemoryAudit();
  const client = new MemoryPanelClient();
  const bridge: OpenClawChatSshBridge = {
    async sendMessage() {
      const error = new Error("OpenClaw SSH chat.send did not return status=started.") as Error & { code?: string };
      error.code = "invalid_chat_send_ack";
      error.name = "OpenClawSshBridgeError";
      throw error;
    },
    async streamHistory() {
      throw new Error("not reached");
    }
  };
  const proxy = new OpenClawChatProxy(audit, {
    bridgeKind: "ssh",
    sshBridge: bridge,
    sshBridgeFailureThreshold: 3,
    localFallbackEnabled: true,
    now: () => new Date("2026-05-29T15:00:00.000Z")
  });
  proxy.addPanelClient(client);

  const response = await proxy.sendOperatorMessage({
    msgId: "fallback-ssh-ack-001",
    message: "Ya funcionas openclaw?"
  });

  assert.equal(response.msgId, "fallback-ssh-ack-001");
  assert.equal(response.queued, true);
  assert.equal(response.assistant?.source, "delivrix.gateway_local_continuity");
  assert.match(response.assistant?.content ?? "", /modo continuidad local/);
  assert.equal(client.events.some((event) => event.type === "ASSISTANT_DONE"), true);

  const bridgeDegraded = audit.events.find((event) => event.action === "oc.chat.bridge_degraded");
  assert.ok(bridgeDegraded, "expected oc.chat.bridge_degraded audit event");
  assert.equal(bridgeDegraded?.metadata.bridgeError, "openclaw_ssh_bridge_failed");
  assert.equal(bridgeDegraded?.metadata.bridgeDegradedReason, "invalid_chat_send_ack");
  assert.equal(bridgeDegraded?.metadata.bridge, "ssh");

  const localFallback = audit.events.find((event) => event.action === "oc.chat.local_fallback");
  assert.ok(localFallback, "expected oc.chat.local_fallback audit event");
  assert.equal(localFallback?.metadata.upstreamErrorCode, "openclaw_ssh_bridge_failed");
  assert.equal(localFallback?.metadata.bridgeDegradedReason, "invalid_chat_send_ack");
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

test("OpenClaw chat send creates canvas task and artifact without panel clients", async () => {
  const audit = new MemoryAudit();
  const canvas = new MemoryCanvas();
  const bridge: OpenClawChatSshBridge = {
    async sendMessage(input) {
      return { msgId: String(input.msgId), queued: true };
    },
    async streamHistory(msgId, callbacks) {
      callbacks.onDone?.({
        type: "ASSISTANT_DONE",
        msgId,
        content: [
          "# Propuesta: delivrix-mail.com",
          "",
          "Compra real bloqueada por doble aprobación.",
          "",
          "| Campo | Valor |",
          "| --- | --- |",
          "| Registro | USD 15 |"
        ].join("\n"),
        audit: { skillsInvoked: ["route53domains"] }
      });
    }
  };
  const proxy = new OpenClawChatProxy(audit, {
    bridgeKind: "ssh",
    sshBridge: bridge,
    canvasLiveEvents: canvas,
    now: () => new Date("2026-05-26T14:00:00.000Z")
  });

  await proxy.sendOperatorMessage({
    msgId: "smoke-proposal-001",
    message: "proponer compra de delivrix-mail.com"
  });
  await waitFor(() => canvas.events.some((event) => event.type === "oc.task.update" && event.status === "completed"));

  assert.equal(canvas.events[0].type, "oc.task.declare");
  assert.equal(canvas.events[0].taskId.includes("smoke-pr"), true);
  const artifact = canvas.events.find((event) => event.type === "oc.artifact.declare");
  assert.equal(artifact?.kind, "proposal");
  assert.equal(artifact?.editable, true);
  assert.equal(canvas.events.some((event) => event.type === "oc.artifact.block"), true);
  assert.equal(canvas.events.at(-1)?.type, "oc.task.update");
  assert.equal(canvas.events.at(-1)?.status, "completed");
});

test("OpenClaw chat stream materializes orphan assistant response as report artifact", async () => {
  const audit = new MemoryAudit();
  const canvas = new MemoryCanvas();
  const proxy = new OpenClawChatProxy(audit, {
    gatewayToken: "",
    webSocketCtor: undefined,
    canvasLiveEvents: canvas,
    now: () => new Date("2026-05-26T14:00:00.000Z")
  });

  await proxy.handleAgentMessage({
    type: "ASSISTANT_DONE",
    msgId: "orphan-1",
    content: "Hola, estoy listo para ayudarte."
  });

  const task = canvas.events.find((event) => event.type === "oc.task.declare");
  const artifact = canvas.events.find((event) => event.type === "oc.artifact.declare");
  assert.equal(task?.taskId.includes("orphan-1"), true);
  assert.equal(artifact?.kind, "report");
  assert.equal(artifact?.editable, false);
});

test("OpenClaw chat skips canvas extraction for messages already materialized by a gateway skill", async () => {
  const audit = new MemoryAudit();
  const canvas = new MemoryCanvas();
  const proxy = new OpenClawChatProxy(audit, {
    gatewayToken: "",
    webSocketCtor: undefined,
    canvasLiveEvents: canvas
  });

  proxy.markCanvasMaterialized("domain-skill-1");
  await proxy.handleAgentMessage({
    type: "ASSISTANT_DONE",
    msgId: "domain-skill-1",
    content: "Inventario de dominios ya emitido por skill."
  });

  assert.equal(canvas.events.length, 0);
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true);
}
