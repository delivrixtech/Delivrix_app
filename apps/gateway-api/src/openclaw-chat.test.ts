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
  snapshotState: CanvasLiveStateSnapshot | null = null;

  async emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent> {
    this.events.push(event);
    return event;
  }

  async snapshot(): Promise<CanvasLiveStateSnapshot> {
    return this.snapshotState ?? {
      schemaVersion: "2026-05-25.canvas-live.v1",
      generatedAt: new Date("2026-06-01T12:00:00.000Z").toISOString(),
      tasks: [],
      artifacts: []
    };
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

test("OpenClaw chat send strips legacy operator params and preserves structured metadata", async () => {
  const audit = new MemoryAudit();
  const canvas = new MemoryCanvas();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ msgId: "legacy-wrapper-1", queued: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const proxy = new OpenClawChatProxy(audit, {
    agentHttpUrl: "http://openclaw.test:61175",
    gatewayToken: "secret-gateway-token",
    fetchImpl: fetchImpl as typeof fetch,
    canvasLiveEvents: canvas,
    now: () => new Date("2026-06-04T13:00:00.000Z")
  });

  await proxy.sendOperatorMessage({
    msgId: "legacy-wrapper-1",
    message: [
      "<openclaw_operator_params>",
      "mode: execute",
      "skill_hint: configure_complete_smtp",
      "execution_scope: dry_run",
      "time_budget_minutes: 30",
      "approval_contract: inline contract",
      "</openclaw_operator_params>",
      "",
      "vamos a continuar corriendo el proyecto"
    ].join("\n"),
    operatorParams: {
      mode: "chat",
      skillHint: "auto",
      executionScope: "read_only",
      timeBudgetMinutes: 15,
      approvalContract: "structured contract"
    }
  });

  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.message.content, "vamos a continuar corriendo el proyecto");
  assert.equal(String(body.message.content).includes("<openclaw_operator_params>"), false);
  assert.equal(canvas.events[0].type, "oc.task.declare");
  assert.equal(canvas.events[0].title.includes("<openclaw_operator_params>"), false);
  assert.deepEqual(audit.events[0].metadata.operatorParams, {
    mode: "chat",
    skillHint: "auto",
    executionScope: "read_only",
    timeBudgetMinutes: 15,
    approvalContract: "structured contract"
  });
  assert.equal(audit.events[0].metadata.operatorParamsSource, "legacy_inline+structured");
  assert.equal(audit.events[0].metadata.strippedInlineOperatorParams, true);
  assert.equal(audit.events[0].metadata.length, "vamos a continuar corriendo el proyecto".length);
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

test("OpenClaw chat stream stays connected when local continuity fallback is enabled", () => {
  const audit = new MemoryAudit();
  const client = new MemoryPanelClient();
  const proxy = new OpenClawChatProxy(audit, {
    gatewayToken: "secret-gateway-token",
    localFallbackEnabled: true,
    now: () => new Date("2026-06-04T12:00:00.000Z")
  });

  proxy.addPanelClient(client);

  assert.equal(proxy.connectionState, "connected");
  assert.deepEqual(client.events, [
    { type: "HEARTBEAT", at: "2026-06-04T12:00:00.000Z" }
  ]);
});

test("OpenClaw local continuity fallback surfaces project runtime diagnostics in Canvas", async () => {
  const audit = new MemoryAudit();
  const canvas = new MemoryCanvas();
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
    now: () => new Date("2026-06-04T12:14:26.437Z")
  });

  const response = await proxy.sendOperatorMessage({
    msgId: "fallback-project-001",
    message: "vamos a continuar corriendo el proyecto"
  });

  assert.equal(response.queued, true);
  assert.equal(response.assistant?.source, "delivrix.project_runtime_diagnostics");
  assert.match(response.assistant?.content ?? "", /Diagnostico local del proyecto/);
  assert.deepEqual(response.assistant?.skillsInvoked, [
    "delivrix.project_runtime_diagnostics",
    "delivrix.gateway_local_continuity"
  ]);

  const actions = canvas.events.filter((event): event is Extract<CanvasLiveEvent, { type: "oc.action.now" }> => event.type === "oc.action.now");
  assert.equal(actions.length, 4);
  assert.ok(actions.some((event) => event.kind === "api" && event.url === "/v1/openclaw/chat/stream"));
  assert.ok(actions.some((event) => event.kind === "command" && event.cmd === "local-continuity:verify-openclaw-contract"));
  assert.ok(actions.some((event) => event.kind === "audit" && event.action === "oc.chat.local_fallback"));

  const healthAction = actions.find((event) => event.kind === "api" && event.url === "/health");
  assert.ok(healthAction);
  assert.equal(actions.at(-1), healthAction);
  assert.equal((healthAction.responseBody as { continuity?: string }).continuity, "local_fallback_active");
  assert.equal((healthAction.responseBody as { openClawRemoteReason?: string }).openClawRemoteReason, "openclaw_chat_send_invalid_response");
  assert.ok(canvas.events.some((event) => event.type === "oc.task.update" && event.status === "completed"));
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

test("OpenClaw fallback inherits intent on short continuation (route after dominio)", async () => {
  // Bug del demo viernes: T1 'sugieras dominios' → DNS intent. T2 'seria usar route' → cae a default
  // porque 'route' aislado no matchea regex DNS. Fix: heredar último intent en mensajes cortos.
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
    sessionKey: "session-inherit-test",
    now: () => new Date("2026-05-29T15:40:00.000Z")
  });

  // Turno 1: intent DNS fuerte
  const t1 = await proxy.sendOperatorMessage({
    msgId: "inherit-t1-dns",
    message: "necesito que me sugieras unos dominios para comprar"
  });
  assert.equal(t1.assistant?.source, "delivrix.dns_domain_planner");

  // Turno 2: continuación corta SIN keyword DNS — debe heredar
  const t2 = await proxy.sendOperatorMessage({
    msgId: "inherit-t2-short",
    message: "seria usar route"
  });
  assert.equal(t2.assistant?.source, "delivrix.dns_domain_planner.inherited");
  assert.match(t2.assistant?.content ?? "", /dominios\/DNS/);
});

test("OpenClaw fallback renders execute CTA when operator says 'hazlo' with intent active", async () => {
  // Bug del demo viernes: 'compralo' / 'ejecutalo' / 'dale' caía a default genérico.
  // Fix: verbos de ejecución sobre último intent activo → CTA accionable.
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
    sessionKey: "session-execute-test",
    now: () => new Date("2026-05-29T15:42:00.000Z")
  });

  // Turno 1: intent DNS
  await proxy.sendOperatorMessage({
    msgId: "exec-t1-dns",
    message: "muestrame opciones de dominios para comprar"
  });

  // Turno 2: verbo de ejecución solo, sin intent propio fuerte
  const t2 = await proxy.sendOperatorMessage({
    msgId: "exec-t2-go",
    message: "dale, ejecutalo"
  });
  assert.equal(t2.assistant?.source, "delivrix.execute_on_last_intent.dns");
  assert.match(t2.assistant?.content ?? "", /3 gates en orden/);
  assert.match(t2.assistant?.content ?? "", /Approval token humano vigente/);
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

test("OpenClaw chat send preserves conversationId and normalized attachments for Bedrock bridge", async () => {
  const audit = new MemoryAudit();
  const sent: unknown[] = [];
  const bridge: OpenClawChatSshBridge = {
    async sendMessage(input) {
      sent.push(input);
      return { msgId: String(input.msgId), queued: true };
    },
    async streamHistory() {
      throw new Error("not reached without panel clients");
    }
  };
  const proxy = new OpenClawChatProxy(audit, {
    bridgeKind: "bedrock",
    sshBridge: bridge
  });

  await proxy.sendOperatorMessage({
    msgId: "attach-bridge-1",
    conversationId: "chat:customer-a",
    message: "revisa estos adjuntos",
    attachments: [
      {
        name: "captura.png",
        mimeType: "image/png",
        dataBase64: "iVBORw0KGgo="
      },
      {
        name: "runbook.md",
        mimeType: "text/markdown",
        dataBase64: Buffer.from("# Runbook\nNo ejecutes nada sin aprobacion.").toString("base64")
      }
    ]
  });

  assert.equal(sent.length, 1);
  const forwarded = sent[0] as { conversationId?: string; attachments?: Array<Record<string, unknown>> };
  assert.equal(forwarded.conversationId, "chat:customer-a");
  assert.equal(forwarded.attachments?.length, 2);
  assert.equal(forwarded.attachments?.[0].kind, "image");
  assert.equal(forwarded.attachments?.[0].mimeType, "image/png");
  assert.equal(forwarded.attachments?.[1].kind, "text");
  assert.equal(forwarded.attachments?.[1].mimeType, "text/markdown");
  assert.equal(String(forwarded.attachments?.[1].text).includes("Runbook"), true);

  const metadata = audit.events[0].metadata as Record<string, unknown>;
  assert.equal(metadata.conversationId, "chat:customer-a");
  assert.equal(metadata.attachmentCount, 2);
  assert.equal(metadata.attachmentBytes, 50);
  assert.deepEqual(metadata.attachmentMimeTypes, ["image/png", "text/markdown"]);
  assert.equal(JSON.stringify(metadata).includes("iVBORw0KGgo"), false);
  assert.equal(JSON.stringify(metadata).includes("Runbook"), false);
});

test("OpenClaw chat rejects attachments outside Bedrock bridge", async () => {
  const audit = new MemoryAudit();
  const proxy = new OpenClawChatProxy(audit, {
    bridgeKind: "http",
    gatewayToken: "gateway-token",
    fetchImpl: async () => {
      throw new Error("must not send upstream");
    }
  });

  await assert.rejects(
    () => proxy.sendOperatorMessage({
      msgId: "attach-http-1",
      message: "revisa imagen",
      attachments: [{ name: "captura.png", mimeType: "image/png", dataBase64: "iVBORw0KGgo=" }]
    }),
    (error) => {
      assert.ok(error instanceof ChatProxyError);
      assert.equal(error.code, "chat_attachments_require_bedrock");
      return true;
    }
  );
  assert.equal(audit.events.length, 0);
});

test("OpenClaw chat rejects unsupported or spoofed attachments before bridge send", async () => {
  const audit = new MemoryAudit();
  const bridge: OpenClawChatSshBridge = {
    async sendMessage() {
      throw new Error("must not reach bridge");
    },
    async streamHistory() {
      throw new Error("not reached");
    }
  };
  const proxy = new OpenClawChatProxy(audit, {
    bridgeKind: "bedrock",
    sshBridge: bridge
  });

  await assert.rejects(
    () => proxy.sendOperatorMessage({
      msgId: "attach-svg-1",
      message: "revisa svg",
      attachments: [{
        name: "bad.svg",
        mimeType: "image/svg+xml",
        dataBase64: Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64")
      }]
    }),
    (error) => {
      assert.ok(error instanceof ChatProxyError);
      assert.equal(error.code, "unsupported_attachment_type");
      return true;
    }
  );
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
      proposals: [{ category: "node_pause_proposed" }],
      audit: {
        skillsInvoked: ["delivrix-fleet-ops"],
        tokensUsed: 45,
        input_tokens: 30,
        outputTokens: 15,
        duration_ms: 321,
        model_id: "us.anthropic.claude-sonnet-4-6"
      }
    }
  });

  assert.deepEqual(event, {
    type: "ASSISTANT_DONE",
    msgId: "reply-1",
    content: "Respuesta completa",
    audit: {
      skillsInvoked: ["delivrix-fleet-ops"],
      tokensUsed: 45,
      inputTokens: 30,
      outputTokens: 15,
      durationMs: 321,
      modelId: "us.anthropic.claude-sonnet-4-6"
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
    inputTokens: 30,
    outputTokens: 15,
    modelId: "us.anthropic.claude-sonnet-4-6",
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

test("OpenClaw chat interrupt aborts bridge, audits operator signal, and broadcasts stop event", async () => {
  const audit = new MemoryAudit();
  const canvas = new MemoryCanvas();
  const client = new MemoryPanelClient();
  const interrupted: string[] = [];
  const bridge: OpenClawChatSshBridge = {
    async sendMessage(input) {
      return { msgId: String(input.msgId), queued: true };
    },
    async interrupt(msgId) {
      interrupted.push(msgId);
      return true;
    },
    async streamHistory() {
      await new Promise(() => undefined);
    }
  };
  const proxy = new OpenClawChatProxy(audit, {
    bridgeKind: "bedrock",
    sshBridge: bridge,
    canvasLiveEvents: canvas,
    now: () => new Date("2026-06-01T12:00:00.000Z")
  });
  proxy.addPanelClient(client);

  await proxy.sendOperatorMessage({
    msgId: "interrupt-openclaw-1",
    message: "configure_complete_smtp ahora"
  });
  const response = await proxy.interruptOperatorMessage({
    msgId: "interrupt-openclaw-1"
  });

  assert.deepEqual(response, {
    msgId: "interrupt-openclaw-1",
    interrupted: true,
    bridgeInterrupted: true
  });
  assert.deepEqual(interrupted, ["interrupt-openclaw-1"]);
  assert.equal(client.events.at(-1)?.type, "ASSISTANT_INTERRUPTED");
  assert.equal(audit.events.at(-1)?.action, "oc.chat.operator_interrupt");
  assert.equal(audit.events.at(-1)?.metadata.bridgeInterrupted, true);
  assert.equal(canvas.events.some((event) => event.type === "oc.task.update" && event.status === "failed"), true);
});

test("OpenClaw chat interrupt closes persisted canvas task after gateway restart", async () => {
  const audit = new MemoryAudit();
  const canvas = new MemoryCanvas();
  canvas.snapshotState = {
    schemaVersion: "2026-05-25.canvas-live.v1",
    generatedAt: "2026-06-01T13:00:00.000Z",
    tasks: [
      {
        taskId: "chat-71e7ea5a-20260601123156",
        title: "OpenClaw, ejecuta configure_complete_smtp",
        status: "running",
        createdAt: "2026-06-01T12:31:56.721Z",
        updatedAt: "2026-06-01T12:31:56.721Z",
        actorId: "openclaw/openclaw-hostinger-prod"
      }
    ],
    artifacts: []
  };
  const proxy = new OpenClawChatProxy(audit, {
    bridgeKind: "bedrock",
    sshBridge: null,
    canvasLiveEvents: canvas,
    now: () => new Date("2026-06-01T13:00:00.000Z")
  });

  const response = await proxy.interruptOperatorMessage({
    msgId: "71e7ea5a-0525-4789-8d74-0c145b2825e6"
  });

  assert.equal(response.interrupted, true);
  assert.equal(response.bridgeInterrupted, false);
  assert.deepEqual(canvas.events.at(-1), {
    type: "oc.task.update",
    taskId: "chat-71e7ea5a-20260601123156",
    status: "failed",
    updatedAt: "2026-06-01T13:00:00.000Z"
  });
  assert.equal(audit.events.at(-1)?.action, "oc.chat.operator_interrupt");
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

  assert.deepEqual(normalizeAgentChatEvent({
    type: "ASSISTANT_INTERRUPTED",
    msgId: "m1",
    reason: "operator_interrupt",
    ts: "2026-06-01T12:00:00.000Z"
  }), {
    type: "ASSISTANT_INTERRUPTED",
    msgId: "m1",
    reason: "operator_interrupt",
    ts: "2026-06-01T12:00:00.000Z"
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
