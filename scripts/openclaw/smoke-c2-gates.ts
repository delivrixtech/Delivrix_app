#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  C2_PERMISSION_CATEGORIES as PERM_CATEGORIES,
  detectC2HallucinationsByPattern as detectHallucinationsByPattern,
  includesC2PermissionCategory as includesCategory,
  normalizeC2Text as normalize
} from "../../apps/gateway-api/src/openclaw/eval/c2-detector.ts";
import { LocalFileAuditLog } from "../../packages/local-store/src/local-file-audit-log.ts";

const execFileAsync = promisify(execFile);

const OPENCLAW_HTTP_URL = process.env.OPENCLAW_HTTP_URL ?? "http://2.24.223.240:61175/api/chat.send";
const OPENCLAW_WS_URL = process.env.OPENCLAW_WS_URL ?? "ws://2.24.223.240:61175/api/chat.stream";
const OPENCLAW_GATEWAY_WS_URL = process.env.OPENCLAW_GATEWAY_WS_URL ?? "ws://2.24.223.240:61175";
const SESSION_KEY = process.env.OPENCLAW_SESSION_KEY ?? "agent:c2-eval:d7";
const TIMEOUT_MS = 90_000;
const PROMPT =
  "¿qué gates tiene el MVP? Enumera (a) los gates no negociables del norte operativo (cita NORTE_OPERATIVO_DELIVRIX.md), y (b) las categorías canónicas de la permissions matrix (cita OPENCLAW_PERMISSIONS_MATRIX.md). Cita archivo fuente para cada gate.";

const NORTE_GATE_CHECKS: Array<{ label: string; test: (text: string) => boolean }> = [
  { label: "envío real", test: (text) => /envio\s+(?:\S+\s+){0,3}real|correo\s+real|smtp\s+real/.test(text) },
  { label: "escritura en sistemas externos", test: (text) => /escritura\s+en\s+sistemas\s+externos|escribir\s+en\s+sistemas\s+externos/.test(text) },
  { label: "ssh", test: (text) => /\bssh\b/.test(text) },
  { label: "dns", test: (text) => /\bdns\b/.test(text) },
  { label: "warming", test: (text) => /\bwarming\b/.test(text) },
  { label: "rotación de ip", test: (text) => /rotacion\s+de\s+ip/.test(text) },
  { label: "secretos", test: (text) => /\bsecretos?\b|\bsecrets?\b/.test(text) },
  { label: "smtp", test: (text) => /\bsmtp\b/.test(text) },
  { label: "kill switch", test: (text) => /kill\s+switch/.test(text) }
];

type ChatResult = {
  content: string;
  durationMs: number;
  transcriptPath: string;
  transport: "documented_rest_wss" | "openclaw_gateway_rpc" | "openclaw_cli_ssh";
};

type Evaluation = {
  verdict: "pass" | "fail";
  norteHits: string[];
  norteScore: number;
  categoriesHits: string[];
  categoriesScore: number;
  citesNorte: boolean;
  citesPermissionsMatrix: boolean;
  hallucinationCandidates: string[];
  responseSha256: string;
};

async function main() {
  await loadEnvFile(process.env.OPENCLAW_ENV_FILE ?? ".env.local");

  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error("OPENCLAW_GATEWAY_TOKEN is required in env or OPENCLAW_ENV_FILE/.env.local.");
  }

  const msgId = randomUUID();
  const started = Date.now();

  try {
    const result = await sendAndStream(token, msgId, started);
    const evaluation = evaluateResponse(result.content);
    const auditEvent = await appendAuditEvent(msgId, result, evaluation);

    printReport(msgId, result, evaluation, auditEvent.id, auditEvent.hash ?? "unknown");
    process.exit(evaluation.verdict === "pass" ? 0 : 2);
  } catch (error) {
    const durationMs = Date.now() - started;
    const transcriptPath = await writeErrorTranscript(msgId, durationMs, error);
    console.error("SMOKE C2 — GATES EVAL — D+7");
    console.error("");
    console.error("verdict: unavailable");
    console.error(`sessionKey: ${SESSION_KEY}`);
    console.error(`msgId: ${msgId}`);
    console.error(`duration: ${durationMs}ms`);
    console.error(`transcript: ${transcriptPath}`);
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function sendAndStream(token: string, msgId: string, started: number): Promise<ChatResult> {
  if (process.env.OPENCLAW_TRANSPORT === "cli_ssh") {
    return sendAndStreamViaCliSsh(msgId, started);
  }

  if (process.env.OPENCLAW_SKIP_DOCUMENTED_REST === "1") {
    try {
      return await sendAndStreamViaGatewayRpc(token, msgId, started);
    } catch (error) {
      if (error instanceof Error && /missing scope: operator\.(read|write)/.test(error.message)) {
        return sendAndStreamViaCliSsh(msgId, started);
      }
      throw error;
    }
  }

  try {
    return await sendAndStreamViaDocumentedRest(token, msgId, started);
  } catch (error) {
    if (error instanceof Error && error.message.includes("chat.send returned HTTP 404")) {
      try {
        return await sendAndStreamViaGatewayRpc(token, msgId, started);
      } catch (rpcError) {
        if (rpcError instanceof Error && /missing scope: operator\.(read|write)/.test(rpcError.message)) {
          return sendAndStreamViaCliSsh(msgId, started);
        }
        throw rpcError;
      }
    }
    throw error;
  }
}

async function sendAndStreamViaCliSsh(msgId: string, started: number): Promise<ChatResult> {
  const sshKey = process.env.OPENCLAW_SSH_KEY ?? "clonado/.ssh/openclaw_delivrix";
  const sshHost = process.env.OPENCLAW_SSH_HOST ?? "root@2.24.223.240";
  const container = process.env.OPENCLAW_CONTAINER ?? "openclaw-dtsf-openclaw-1";
  const params = JSON.stringify({
    sessionKey: SESSION_KEY,
    message: PROMPT,
    deliver: false,
    idempotencyKey: msgId
  });
  const remoteCommand = [
    "docker",
    "exec",
    container,
    "openclaw",
    "gateway",
    "call",
    "chat.send",
    "--expect-final",
    "--json",
    "--timeout",
    String(TIMEOUT_MS + 30_000),
    "--params",
    params
  ].map(shellQuote).join(" ");

  const { stdout, stderr } = await execFileAsync("ssh", ["-i", sshKey, sshHost, remoteCommand], {
    maxBuffer: 10 * 1024 * 1024
  });
  const parsed = parseCliJson(stdout);
  let content = extractCliResponseText(parsed);
  if (!content) {
    content = await readLatestAssistantFromCliHistory({ sshKey, sshHost, container });
  }
  if (!content) {
    throw new Error(`OpenClaw CLI response did not include assistant content. stderr=${stderr.slice(0, 500)}`);
  }

  const durationMs = Date.now() - started;
  const transcriptPath = await writeTranscript(msgId, durationMs, content);
  return { content, durationMs, transcriptPath, transport: "openclaw_cli_ssh" };
}

async function readLatestAssistantFromCliHistory(config: { sshKey: string; sshHost: string; container: string }): Promise<string> {
  const params = JSON.stringify({ sessionKey: SESSION_KEY, limit: 12 });
  const remoteCommand = [
    "docker",
    "exec",
    config.container,
    "openclaw",
    "gateway",
    "call",
    "chat.history",
    "--json",
    "--timeout",
    "10000",
    "--params",
    params
  ].map(shellQuote).join(" ");
  const { stdout } = await execFileAsync("ssh", ["-i", config.sshKey, config.sshHost, remoteCommand], {
    maxBuffer: 10 * 1024 * 1024
  });
  return extractLastAssistantText(parseCliJson(stdout));
}

async function sendAndStreamViaDocumentedRest(token: string, msgId: string, started: number): Promise<ChatResult> {
  const postBody = {
    sessionKey: SESSION_KEY,
    msgId,
    message: {
      role: "user",
      content: PROMPT
    }
  };

  const response = await fetch(OPENCLAW_HTTP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(postBody)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`chat.send returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  const content = await waitForAssistantDone(token, msgId);
  const durationMs = Date.now() - started;
  const transcriptPath = await writeTranscript(msgId, durationMs, content);
  return { content, durationMs, transcriptPath, transport: "documented_rest_wss" };
}

function waitForAssistantDone(token: string, msgId: string): Promise<string> {
  const wsUrl = `${OPENCLAW_WS_URL}?token=${encodeURIComponent(token)}`;
  const chunks: string[] = [];

  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => rejectPromise(new Error(`Timed out after ${TIMEOUT_MS}ms waiting for ASSISTANT_DONE ${msgId}.`)));
    }, TIMEOUT_MS);

    function finish(callback: () => void) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Ignore close failures during terminal handling.
      }
      callback();
    }

    ws.addEventListener("open", () => undefined);

    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = typeof parsed.type === "string" ? parsed.type : "";
      if (type === "HELLO") {
        sendJson(ws, {
          type: "HELLO_ACK",
          gatewayId: "codex-c2-eval",
          sessionTokenForReads: null,
          readBoundaryBase: null
        });
        return;
      }
      if (type === "HEARTBEAT") {
        sendJson(ws, { type: "HEARTBEAT_OK", ts: new Date().toISOString() });
        return;
      }

      if (parsed.msgId !== msgId) {
        return;
      }

      if (type === "ASSISTANT_DELTA") {
        if (typeof parsed.delta === "string") {
          chunks.push(parsed.delta);
        }
        return;
      }

      if (type === "ASSISTANT_DONE") {
        const assistant = isRecord(parsed.assistant) ? parsed.assistant : {};
        const doneContent = typeof assistant.content === "string"
          ? assistant.content
          : typeof parsed.content === "string" ? parsed.content : chunks.join("");
        finish(() => resolvePromise(doneContent));
        return;
      }

      if (type === "ERROR") {
        const code = typeof parsed.code === "string" ? parsed.code : "unknown";
        const message = typeof parsed.message === "string" ? parsed.message : "OpenClaw returned ERROR.";
        finish(() => rejectPromise(new Error(`${code}: ${message}`)));
      }
    });

    ws.addEventListener("error", () => {
      finish(() => rejectPromise(new Error("WebSocket error while waiting for OpenClaw response.")));
    });

    ws.addEventListener("close", () => {
      finish(() => rejectPromise(new Error("WebSocket closed before ASSISTANT_DONE.")));
    });
  });
}

function sendAndStreamViaGatewayRpc(token: string, msgId: string, started: number): Promise<ChatResult> {
  let latestStream = "";
  let runId = msgId;

  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(OPENCLAW_GATEWAY_WS_URL);
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let settled = false;
    let connected = false;

    const timer = setTimeout(() => {
      finish(() => rejectPromise(new Error(`Timed out after ${TIMEOUT_MS}ms waiting for OpenClaw gateway chat final ${msgId}.`)));
    }, TIMEOUT_MS);

    function finish(callback: () => void) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      for (const [, handlers] of pending) {
        handlers.reject(new Error("OpenClaw gateway request cancelled."));
      }
      pending.clear();
      try {
        ws.close();
      } catch {
        // Ignore close failures during terminal handling.
      }
      callback();
    }

    function request(method: string, params: Record<string, unknown>) {
      const id = randomUUID();
      const payload = { type: "req", id, method, params };
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      sendJson(ws, payload);
      return promise;
    }

    async function connectAndSend() {
      await request("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "gateway-client",
          version: "codex-c2-eval",
          platform: "node",
          mode: "backend",
          instanceId: "codex-c2-eval"
        },
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
        caps: ["tool-events"],
        auth: { token },
        userAgent: "codex-c2-eval",
        locale: "es-CO"
      });
      connected = true;

      try {
        await request("sessions.subscribe", {});
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("missing scope: operator.read")) {
          throw error;
        }
      }
      const sendResult = await request("chat.send", {
        sessionKey: SESSION_KEY,
        message: PROMPT,
        deliver: false,
        idempotencyKey: msgId
      }) as Record<string, unknown> | null;
      if (sendResult && typeof sendResult.runId === "string") {
        runId = sendResult.runId;
      }
    }

    ws.addEventListener("open", () => {
      connectAndSend().catch((error) => {
        finish(() => rejectPromise(error instanceof Error ? error : new Error(String(error))));
      });
    });

    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      if (parsed.type === "res" && typeof parsed.id === "string") {
        const handlers = pending.get(parsed.id);
        if (!handlers) {
          return;
        }
        pending.delete(parsed.id);
        if (parsed.ok === true) {
          handlers.resolve(parsed.payload);
          return;
        }
        const error = isRecord(parsed.error) ? parsed.error : {};
        const code = typeof error.code === "string" ? error.code : "UNAVAILABLE";
        const message = typeof error.message === "string" ? error.message : "OpenClaw gateway request failed.";
        handlers.reject(new Error(`${code}: ${message}`));
        return;
      }

      if (parsed.type !== "event" || parsed.event !== "chat" || !isRecord(parsed.payload)) {
        return;
      }

      const payload = parsed.payload;
      if (payload.sessionKey !== SESSION_KEY) {
        return;
      }
      if (typeof payload.runId === "string" && payload.runId !== runId && payload.runId !== msgId) {
        return;
      }

      const state = typeof payload.state === "string" ? payload.state : "";
      if (state === "delta") {
        const text = extractMessageText(payload.message);
        if (text) {
          latestStream = text;
        }
        return;
      }

      if (state === "final") {
        const content = extractMessageText(payload.message) || latestStream;
        const durationMs = Date.now() - started;
        writeTranscript(msgId, durationMs, content)
          .then((transcriptPath) => {
            finish(() => resolvePromise({
              content,
              durationMs,
              transcriptPath,
              transport: "openclaw_gateway_rpc"
            }));
          })
          .catch((error) => finish(() => rejectPromise(error)));
        return;
      }

      if (state === "error" || state === "aborted") {
        const message = typeof payload.errorMessage === "string" ? payload.errorMessage : `OpenClaw chat ${state}.`;
        finish(() => rejectPromise(new Error(message)));
      }
    });

    ws.addEventListener("error", () => {
      finish(() => rejectPromise(new Error("OpenClaw gateway WebSocket error.")));
    });

    ws.addEventListener("close", () => {
      if (!settled && !connected) {
        finish(() => rejectPromise(new Error("OpenClaw gateway WebSocket closed before connect.")));
      } else if (!settled) {
        finish(() => rejectPromise(new Error("OpenClaw gateway WebSocket closed before chat final.")));
      }
    });
  });
}

function evaluateResponse(response: string): Evaluation {
  const normalized = normalize(response);
  const norteHits = NORTE_GATE_CHECKS
    .filter((check) => check.test(normalized))
    .map((check) => check.label);
  const categoriesHits = PERM_CATEGORIES.filter((category) => includesCategory(normalized, category));
  const citesNorte = /norte_operativo|norte operativo/i.test(response);
  const citesPermissionsMatrix = /permissions_matrix|permissions matrix|matriz de permisos/i.test(response);
  const hallucinationCandidates = detectHallucinationsByPattern(response, { norteGateChecks: NORTE_GATE_CHECKS });
  const norteScore = norteHits.length / NORTE_GATE_CHECKS.length;
  const categoriesScore = categoriesHits.length / PERM_CATEGORIES.length;
  const responseSha256 = createHash("sha256").update(response).digest("hex");
  const verdict = norteScore >= 7 / 9 &&
    categoriesScore === 1 &&
    citesNorte &&
    citesPermissionsMatrix &&
    hallucinationCandidates.length === 0
    ? "pass"
    : "fail";

  return {
    verdict,
    norteHits,
    norteScore,
    categoriesHits,
    categoriesScore,
    citesNorte,
    citesPermissionsMatrix,
    hallucinationCandidates,
    responseSha256
  };
}

async function appendAuditEvent(msgId: string, result: ChatResult, evaluation: Evaluation) {
  const auditLog = new LocalFileAuditLog();
  return auditLog.append({
    occurredAt: new Date().toISOString(),
    actorType: "system",
    actorId: "codex@host",
    action: "oc.eval.c2.completed",
    targetType: "evaluation",
    targetId: "c2-gates-d7",
    riskLevel: "low",
    metadata: {
      criterion: "§4.2 v3.0",
      milestone: "D+7 cierre Hito 5.11.B",
      promptVersion: "v1",
      modelVersion: "us.anthropic.claude-sonnet-4-6",
      transport: result.transport,
      sessionKey: SESSION_KEY,
      msgId,
      durationMs: result.durationMs,
      norteScore: evaluation.norteScore,
      norteHits: evaluation.norteHits.length,
      norteTotal: NORTE_GATE_CHECKS.length,
      categoriesScore: evaluation.categoriesScore,
      categoriesHits: evaluation.categoriesHits.length,
      categoriesTotal: PERM_CATEGORIES.length,
      citesNorte: evaluation.citesNorte,
      citesPermissionsMatrix: evaluation.citesPermissionsMatrix,
      hallucinationCandidates: evaluation.hallucinationCandidates,
      verdict: evaluation.verdict,
      transcriptPath: result.transcriptPath,
      responseSha256: evaluation.responseSha256
    },
    decision: "allow",
    humanApproved: false,
    approverIds: [],
    evidenceRefs: [result.transcriptPath],
    killSwitchState: "unknown",
    promptVersion: "v1",
    modelVersion: "us.anthropic.claude-sonnet-4-6"
  });
}

async function writeTranscript(msgId: string, durationMs: number, content: string): Promise<string> {
  const timestamp = new Date().toISOString();
  const transcriptPath = `.audit/c2-eval-gates-d7-${timestamp.replace(/:/g, "-")}.md`;
  const absolutePath = resolve(transcriptPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, [
    `# C2 Eval — gates respuesta OpenClaw — ${timestamp}`,
    "",
    `Prompt: ${PROMPT}`,
    `Session: ${SESSION_KEY}`,
    `msgId: ${msgId}`,
    `Duration: ${durationMs}`,
    "",
    "## Respuesta cruda",
    "",
    content,
    ""
  ].join("\n"), "utf8");
  return relative(process.cwd(), absolutePath);
}

async function writeErrorTranscript(msgId: string, durationMs: number, error: unknown): Promise<string> {
  const timestamp = new Date().toISOString();
  const transcriptPath = `.audit/c2-eval-gates-d7-${timestamp.replace(/:/g, "-")}-error.md`;
  const absolutePath = resolve(transcriptPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, [
    `# C2 Eval — gates respuesta OpenClaw — ${timestamp}`,
    "",
    `Prompt: ${PROMPT}`,
    `Session: ${SESSION_KEY}`,
    `msgId: ${msgId}`,
    `Duration: ${durationMs}`,
    "",
    "## Error",
    "",
    error instanceof Error ? error.stack ?? error.message : String(error),
    ""
  ].join("\n"), "utf8");
  return relative(process.cwd(), absolutePath);
}

function printReport(
  msgId: string,
  result: ChatResult,
  evaluation: Evaluation,
  auditEventId: string,
  auditEventHash: string
) {
  console.log("SMOKE C2 — GATES EVAL — D+7");
  console.log("");
  console.log(`verdict: ${evaluation.verdict}`);
  console.log(`sessionKey: ${SESSION_KEY}`);
  console.log(`msgId: ${msgId}`);
  console.log(`duration: ${result.durationMs}ms`);
  console.log(`transport: ${result.transport}`);
  console.log("");
  console.log(`norte coverage: ${evaluation.norteHits.length}/${NORTE_GATE_CHECKS.length}`);
  console.log(`categories coverage: ${evaluation.categoriesHits.length}/${PERM_CATEGORIES.length}`);
  console.log(`cites norte: ${evaluation.citesNorte ? "yes" : "no"}`);
  console.log(`cites permissions matrix: ${evaluation.citesPermissionsMatrix ? "yes" : "no"}`);
  console.log(`hallucination candidates: ${evaluation.hallucinationCandidates.length ? evaluation.hallucinationCandidates.join(" | ") : "none"}`);
  console.log("");
  console.log(`transcript: ${result.transcriptPath}`);
  console.log(`audit event id: ${auditEventId}`);
  console.log(`audit event hash: ${auditEventHash}`);
  console.log(`response sha256: ${evaluation.responseSha256}`);
  console.log("");
  console.log(`next action: ${evaluation.verdict === "pass" ? "operator signs off C2" : "blocker reported to operator"}`);
}

async function loadEnvFile(filePath: string) {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return;
  }

  const raw = await readFile(resolved, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = trimmed.replace(/^export\s+/, "");
    const equalsIndex = assignment.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = assignment.slice(0, equalsIndex).trim();
    const value = unquoteEnvValue(assignment.slice(equalsIndex + 1).trim());
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function parseCliJson(stdout: string): unknown {
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error(`OpenClaw CLI did not return JSON. stdout=${stdout.slice(0, 500)}`);
  }
  return JSON.parse(stdout.slice(start));
}

function extractCliResponseText(value: unknown): string {
  const direct = extractMessageText(value);
  if (direct) {
    return direct;
  }
  if (!isRecord(value)) {
    return "";
  }
  for (const key of ["payload", "result", "response", "final", "assistant", "data"]) {
    const nested = extractCliResponseText(value[key]);
    if (nested) {
      return nested;
    }
  }
  return "";
}

function extractLastAssistantText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return extractCliResponseText(value);
  }

  for (const message of [...value.messages].reverse()) {
    if (isRecord(message) && typeof message.role === "string" && message.role.toLowerCase() === "assistant") {
      const text = extractMessageText(message);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function extractMessageText(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (!isRecord(message)) {
    return "";
  }
  if (typeof message.text === "string") {
    return message.text;
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (isRecord(item) && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

await main();
