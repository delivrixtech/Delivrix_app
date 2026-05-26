/**
 * Canvas v4 — Agent-in-action viewport
 *
 * Paradigma: chat (operador ↔ OpenClaw) a la izquierda + feed de acciones del agente
 * a la derecha. El operador VE al agente leer archivos, detectar problemas, llamar
 * APIs, generar diffs, ejecutar comandos, esperar aprobación.
 *
 * Referencias visuales: Cursor Composer, Claude.ai con artifacts, Bolt.new, v0,
 * Railway deploys, Replit Ghostwriter.
 *
 * MVP con mock data + dev server hot reload. Conectar al WSS real (Codex Tarea 2,
 * commit 52a451d) es la fase siguiente.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Box,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleCheck,
  ExternalLink,
  FileText,
  FolderTree,
  GitGraph,
  GitPullRequest,
  Globe,
  Hand,
  Info,
  Loader,
  Maximize2,
  Pause,
  Paperclip,
  Play,
  Radio,
  Settings2,
  ShieldAlert,
  Slash,
  Sparkles,
  Terminal,
  TriangleAlert,
  WandSparkles
} from "lucide-react";
import {
  chatClient,
  useChatStream,
  type ChatConnection
} from "../../shared/api/chat-client.ts";
import {
  getJson,
  type AuditEvent,
  type AuditEventsPayload,
  type OpenClawCanvasPayload
} from "../../shared/api/client.ts";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary.ts";
import { MarkdownText, useConsumeIntentOnMount, useOpenClawIntent, useToast } from "../../shared/ui/v2/index.ts";
import { CanvasFlow } from "./canvas-flow.tsx";
import { useDemoAgentRun, useDemoLiveState, type DemoAction } from "./demo-agent-run.ts";
import { LiveTool } from "./live-tool.tsx";
import { useLiveCanvasStream } from "./canvas-live-client.ts";

/* ============================================================
 * MOCK DATA — reemplazable por WSS stream cuando esté conectado
 * ============================================================ */

type ActionKind = "read" | "detect" | "http" | "diff" | "command" | "await";

interface BaseAction {
  id: string;
  ts: string;
  kind: ActionKind;
}

interface ReadAction extends BaseAction {
  kind: "read";
  path: string;
  totalLines: number;
  snippet: Array<{ num: number; code: string; highlight?: boolean }>;
}

interface DetectAction extends BaseAction {
  kind: "detect";
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  refs: Array<{ kind: "runbook" | "evidence" | "audit"; label: string }>;
}

interface HttpAction extends BaseAction {
  kind: "http";
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  status: number;
  durationMs: number;
  body: string[];
}

interface DiffAction extends BaseAction {
  kind: "diff";
  path: string;
  added: number;
  removed: number;
  lines: Array<{ num: number; sign: " " | "+" | "-"; code: string }>;
  hashShort: string;
}

interface CommandAction extends BaseAction {
  kind: "command";
  cmd: string;
  output: string[];
  status: "running" | "ok" | "error";
}

interface AwaitAction extends BaseAction {
  kind: "await";
  title: string;
  body: string;
}

type Action = ReadAction | DetectAction | HttpAction | DiffAction | CommandAction | AwaitAction;

/* MOCK_ACTIONS eliminado — el Canvas v4 ahora muestra empty state real cuando
 * el gateway no devuelve audit events. Sin datos quemados. */

/* ============================================================
 * Helpers
 * ============================================================ */

function classNames(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(" ");
}

/* ============================================================
 * <CanvasV4> root
 * ============================================================ */

export function CanvasV4() {
  // Auto-connect del chat WSS al montar el Canvas. Antes vivía sólo cuando se abría el drawer.
  useEffect(() => {
    chatClient.connect();
    return () => {
      chatClient.disconnect();
    };
  }, []);

  const chatState = useChatStream(chatClient);
  const { actions, lastUpdateAt, source, errorMessage } = useAgentActions(3_000);

  return (
    <div
      className="flex flex-col"
      style={{ height: "calc(100vh - 64px)", background: "var(--color-bg)" }}
    >
      <CanvasTopbar connection={chatState.connection} lastUpdateAt={lastUpdateAt} />
      <div className="flex flex-1 min-h-0" style={{ borderTop: "1px solid var(--color-border)" }}>
        <ChatPanel />
        <AgentViewport actions={actions} source={source} errorMessage={errorMessage} />
      </div>
    </div>
  );
}

/* ============================================================
 * useAgentActions — hook que polls /v1/audit-events y mapea a Actions
 * ============================================================ */

type AgentSource = "live" | "empty" | "loading" | "error";

function useAgentActions(pollMs: number): {
  actions: Action[];
  lastUpdateAt: number;
  source: AgentSource;
  errorMessage: string | null;
} {
  const [actions, setActions] = useState<Action[]>([]);
  const [lastUpdateAt, setLastUpdateAt] = useState<number>(Date.now());
  const [source, setSource] = useState<AgentSource>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      try {
        const payload = await getJson<AuditEventsPayload>(READ_ENDPOINTS.auditEvents);
        if (cancelled) return;
        // Modo "agente en acción": filtra audit events para mostrar SOLO lo que
        // OpenClaw está haciendo AHORA. 3 criterios combinados:
        //
        //  1. actor: openclaw/* (excluye system/gateway-api, operator manual).
        //  2. tiempo: últimos AGENT_RECENT_WINDOW_MS (default 10 min). El backend
        //     siempre devuelve los últimos N del audit chain incluyendo histórico,
        //     así que filtramos por timestamp para evitar smoke tests viejos.
        //  3. excluir patterns de test/smoke (audit_smoke:*, healthcheck, etc.).
        //
        // Resultado: cuando OpenClaw NO esté trabajando → empty state limpio.
        // Cuando le pidas algo → cards aparecen en orden cronológico real.
        const AGENT_RECENT_WINDOW_MS = 10 * 60_000; // 10 min
        const cutoff = Date.now() - AGENT_RECENT_WINDOW_MS;
        const TEST_PATTERN = /(audit_smoke|smoke_valid|healthcheck|self_test|warmup_check)/i;
        const agentEvents = (payload.events ?? []).filter((ev) => {
          const actorType = (ev.actorType ?? "").toLowerCase();
          const actorId = (ev.actorId ?? "").toLowerCase();
          const isAgent = actorType === "openclaw" || actorId.startsWith("openclaw");
          if (!isAgent) return false;
          // Excluir tests legacy
          const action = (ev.action ?? "").toLowerCase();
          const targetId = (ev.targetId ?? "").toLowerCase();
          if (TEST_PATTERN.test(action) || TEST_PATTERN.test(targetId)) return false;
          // Filtro temporal: solo events recientes
          const occurredAt = new Date(ev.occurredAt).getTime();
          if (Number.isNaN(occurredAt)) return false;
          return occurredAt >= cutoff;
        });
        const mapped = agentEvents
          .slice(0, 25)
          .map(auditToAction)
          .filter(Boolean) as Action[];
        setActions(mapped.reverse()); // chronological asc, último al final
        setSource(mapped.length > 0 ? "live" : "empty");
        setLastUpdateAt(Date.now());
        setErrorMessage(null);
      } catch (e) {
        if (cancelled) return;
        setActions([]);
        setSource("error");
        setErrorMessage(e instanceof Error ? e.message : "no se pudo cargar audit-events");
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(tick, pollMs);
        }
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [pollMs]);

  return { actions, lastUpdateAt, source, errorMessage };
}

function auditToAction(ev: AuditEvent): Action | null {
  const ts = formatTs(ev.occurredAt);
  const action = ev.action.toLowerCase();
  const target = `${ev.targetType}:${ev.targetId}`;
  const meta = ev.metadata ?? {};

  // oc.chat.agent_response — la respuesta del agente al chat. Antes mostraba
  // msgId/sessionKey crudos lo cual es metadata interna sin valor para el
  // operador. Ahora extraemos info útil del metadata (longitud, tokens,
  // duración) y mostramos una card limpia.
  if (action === "oc.chat.agent_response" || action.includes("agent_response")) {
    const chars = typeof meta.responseChars === "number" ? meta.responseChars : null;
    const tokens = typeof meta.tokens === "number" ? meta.tokens : null;
    const duration = typeof meta.durationMs === "number" ? meta.durationMs : null;
    const hints: string[] = [];
    if (chars != null) hints.push(`${formatBytes(chars)} enviados`);
    if (tokens != null) hints.push(`${tokens} tokens`);
    if (duration != null) hints.push(`${duration}ms`);
    return {
      id: ev.id,
      ts,
      kind: "command",
      cmd: "skill · publish_chat_response",
      status: "ok",
      output:
        hints.length > 0
          ? ["→ WSS oc.chat.agent_response", `✓ respuesta entregada · ${hints.join(" · ")}`]
          : ["→ WSS oc.chat.agent_response", "✓ respuesta entregada al operador"]
    };
  }

  // oc.chat.operator_message — el operador escribió en el chat. No es
  // "trabajo del agente" propiamente; lo mostramos como pequeña detección
  // info para anclar el contexto.
  if (action === "oc.chat.operator_message" || action.includes("operator_message")) {
    const preview = typeof meta.preview === "string" ? meta.preview : null;
    return {
      id: ev.id,
      ts,
      kind: "detect",
      severity: "info",
      title: "Solicitud del operador",
      body: preview ? `"${preview.slice(0, 140)}${preview.length > 140 ? "…" : ""}"` : "Nuevo mensaje del operador en chat.",
      refs: [{ kind: "audit", label: "oc.chat.operator_message" }]
    };
  }

  // command-ish: skill execution
  if (action.includes("skill") || action.includes("runbook") || action.includes("exec") || action.includes("run")) {
    // Construimos output con narrativa, no con actor/target crudos. Si el
    // metadata trae claves útiles (count, status, summary, duration) las
    // priorizamos; lo demás queda fuera para no llenar de ruido.
    const output: string[] = [];
    if (typeof meta.skill === "string") output.push(`→ ${meta.skill}`);
    else output.push(`→ ${ev.action}`);
    if (typeof meta.summary === "string") output.push(`✓ ${meta.summary}`);
    if (typeof meta.count === "number") output.push(`${meta.count} items procesados`);
    if (typeof meta.durationMs === "number") output.push(`duración ${meta.durationMs}ms`);
    if (output.length < 2) {
      // Fallback mínimo: al menos un confirmador para que la card no se vea vacía.
      output.push("✓ ejecución completada");
    }
    return {
      id: ev.id,
      ts,
      kind: "command",
      cmd: typeof meta.skill === "string" ? `skill · ${meta.skill}` : ev.action,
      status: ev.riskLevel === "critical" || ev.riskLevel === "error" ? "error" : "ok",
      output
    };
  }

  // diff-ish
  if (action.includes("diff") || action.includes("patch") || action.includes("change")) {
    return {
      id: ev.id,
      ts,
      kind: "diff",
      path: typeof meta.path === "string" ? meta.path : target,
      added: typeof meta.added === "number" ? meta.added : 0,
      removed: typeof meta.removed === "number" ? meta.removed : 0,
      hashShort: typeof meta.hash === "string" ? meta.hash.slice(0, 8) : ev.id.slice(0, 8),
      lines: Array.isArray(meta.lines)
        ? (meta.lines as Array<{ num: number; sign: " " | "+" | "-"; code: string }>)
        : [{ num: 1, sign: " ", code: ev.action }]
    };
  }

  // http-ish
  if (action.includes("http") || action.includes("request") || action.includes("api")) {
    const method = (typeof meta.method === "string" ? meta.method : "GET").toUpperCase() as "GET" | "POST" | "PUT" | "DELETE";
    return {
      id: ev.id,
      ts,
      kind: "http",
      method,
      url: typeof meta.url === "string" ? meta.url : `internal://${target}`,
      status: typeof meta.status === "number" ? meta.status : 200,
      durationMs: typeof meta.durationMs === "number" ? meta.durationMs : 0,
      body: typeof meta.body === "string" ? [meta.body] : [JSON.stringify(meta, null, 2)]
    };
  }

  // read-ish
  if (action.includes("read") || action.includes("fetch") || action.includes("get")) {
    return {
      id: ev.id,
      ts,
      kind: "read",
      path: typeof meta.path === "string" ? meta.path : target,
      totalLines: typeof meta.totalLines === "number" ? meta.totalLines : 0,
      snippet: Array.isArray(meta.snippet)
        ? (meta.snippet as Array<{ num: number; code: string; highlight?: boolean }>)
        : [{ num: 1, code: `${ev.actorType}/${ev.actorId} · ${ev.action}` }]
    };
  }

  // await/approval
  if (action.includes("await") || action.includes("approval") || action.includes("pending") || action.includes("proposal")) {
    return {
      id: ev.id,
      ts,
      kind: "await",
      title: ev.action,
      body: `target ${target} · actor ${ev.actorType}/${ev.actorId}`
    };
  }

  // Heurística mejorada de severity: el riskLevel del backend tiene prioridad,
  // pero si está vacío o "low", el action mismo da pistas. Audit chain meta
  // (oc.audit.smoke_valid, batch_received, chain_started) son INFO, no warning.
  const looksLikeOkEvent =
    /(\.valid|\.ok|\.completed|\.received|\.started|\.persisted|\.acknowledged|\.fresh)/.test(action) ||
    action.startsWith("oc.audit.");
  const looksLikeCritical = /(kill_switch|hallucination|blocked|critical|breach|incident)/.test(action);

  let severity: "info" | "warning" | "critical" = "info";
  if (ev.riskLevel === "critical" || looksLikeCritical) severity = "critical";
  else if (ev.riskLevel === "high" || ev.riskLevel === "warning" || ev.riskLevel === "error") severity = "warning";
  else if (looksLikeOkEvent) severity = "info";
  else severity = "info"; // default: info, no alarmar al usuario

  // Body humano: si el metadata trae `summary` o `description`, los usamos.
  // Si no, generamos algo narrativo desde la acción + target sin mostrar
  // los IDs internos del actor.
  const humanBody =
    typeof meta.summary === "string"
      ? meta.summary
      : typeof meta.description === "string"
        ? meta.description
        : ev.targetType && ev.targetId
          ? `Acción sobre ${ev.targetType.replace(/_/g, " ")}: ${ev.targetId}`
          : "Evento del agente registrado.";

  // Title humano: convertir `oc.chat.thing_happened` → "Thing happened".
  const humanTitle = humanizeActionName(ev.action);

  return {
    id: ev.id,
    ts,
    kind: "detect",
    severity,
    title: humanTitle,
    body: humanBody,
    refs: Object.entries(meta)
      .filter(([k]) => k !== "msgId" && k !== "sessionKey" && k !== "actorId")
      .slice(0, 2)
      .map(([k, v]) => ({
        kind: "audit" as const,
        label: `${k}: ${typeof v === "object" ? "{…}" : String(v).slice(0, 32)}`
      }))
  };
}

function humanizeActionName(action: string): string {
  // oc.chat.agent_response → "Respuesta del agente"
  // oc.audit.smoke_valid → "Smoke valid"
  // oc.eval.c2.operator_override → "Operator override"
  const tail = action.split(".").slice(-1)[0] ?? action;
  return tail
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatBytes(chars: number): string {
  if (chars < 1024) return `${chars} chars`;
  return `${(chars / 1024).toFixed(1)} KB`;
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("es-CO", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso.slice(11, 19);
  }
}

/* ============================================================
 * highlightJson — syntax highlighting básico (sin lib externa)
 * keys → naranja, strings → verde cream, numbers → cyan, booleans → púrpura
 * ============================================================ */

const JSON_TOKEN_REGEX = /("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlightJson(line: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(JSON_TOKEN_REGEX);
  let key = 0;
  while ((match = re.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <span key={`p${key++}`} style={{ color: "#8b949e" }}>
          {line.slice(lastIndex, match.index)}
        </span>
      );
    }
    const tok = match[0];
    let color = "#e6edf3";
    if (tok.endsWith(":") || tok.endsWith(": ")) color = "#f59e0b"; // key
    else if (tok.startsWith('"')) color = "#a5d6a7"; // string
    else if (tok === "true" || tok === "false" || tok === "null") color = "#c4b5fd"; // bool/null
    else color = "#7dd3fc"; // number
    parts.push(
      <span key={`t${key++}`} style={{ color }}>
        {tok}
      </span>
    );
    lastIndex = match.index + tok.length;
  }
  if (lastIndex < line.length) {
    parts.push(
      <span key={`p${key++}`} style={{ color: "#e6edf3" }}>
        {line.slice(lastIndex)}
      </span>
    );
  }
  return parts.length > 0 ? parts : <span style={{ color: "#e6edf3" }}>{line}</span>;
}

/* ============================================================
 * Topbar
 * ============================================================ */

function CanvasTopbar({
  connection,
  lastUpdateAt
}: {
  connection: ChatConnection;
  lastUpdateAt: number;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);
  const ago = Math.max(0, Math.floor((Date.now() - lastUpdateAt) / 1000));
  return (
    <header
      className="flex items-center"
      style={{
        gap: 16,
        padding: "12px 24px",
        background: "var(--color-surface)",
        borderBottom: "1px solid var(--color-border)"
      }}
    >
      <div className="flex items-center" style={{ gap: 10 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "var(--color-accent-tertiary)",
            color: "#e6edf3"
          }}
        >
          <Sparkles size={16} strokeWidth={1.75} />
        </span>
        <div className="flex flex-col" style={{ gap: 0 }}>
          <div className="flex items-center" style={{ gap: 8 }}>
            <span
              className="font-[family-name:var(--font-heading)] font-bold"
              style={{ fontSize: 15, color: "var(--color-text-primary)" }}
            >
              OpenClaw
            </span>
            <LivePill connection={connection} />
          </div>
          <span
            className="font-[family-name:var(--font-mono)]"
            style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
          >
            operador supervisado · agent:main:operator · feed actualizado hace {ago}s
          </span>
        </div>
      </div>

      <span className="flex-1" />

      {/* ThinkingChip reactivo se renderiza dentro del componente vía useChatStream */}
      <ThinkingChip />
    </header>
  );
}

function LivePill({ connection }: { connection?: ChatConnection } = {}) {
  const tone =
    connection === "connected"
      ? { bg: "var(--color-success-soft)", fg: "var(--color-success)", label: "Live", animate: true }
      : connection === "reconnecting"
        ? { bg: "var(--color-warning-soft)", fg: "var(--color-warning)", label: "Reconectando", animate: true }
        : connection === "offline"
          ? { bg: "var(--color-critical-soft)", fg: "var(--color-critical)", label: "Offline", animate: false }
          : { bg: "var(--color-success-soft)", fg: "var(--color-success)", label: "Live", animate: true };
  return (
    <span
      className="inline-flex items-center"
      style={{ gap: 5, padding: "2px 8px", borderRadius: 9999, background: tone.bg }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: tone.fg,
          animation: tone.animate ? "live-indicator-ring 1.6s cubic-bezier(0.4,0,0.6,1) infinite" : "none"
        }}
      />
      <span
        className="font-[family-name:var(--font-caption)] font-bold"
        style={{ fontSize: 10, color: tone.fg }}
      >
        {tone.label}
      </span>
    </span>
  );
}

function ThinkingChip() {
  // Reactivo al stream del chatClient: muestra "Pensando…" sólo cuando el
  // agente está streameando una respuesta (state.streaming !== null) o cuando
  // hay un mensaje user pendiente (queuedCount > 0). En idle no se muestra.
  const state = useChatStream(chatClient);
  const active = state.streaming !== null || state.queuedCount > 0;
  if (!active) {
    return (
      <span
        className="inline-flex items-center"
        style={{
          gap: 6,
          padding: "6px 10px",
          borderRadius: 8,
          background: "var(--color-surface-sunken)",
          border: "1px solid var(--color-border)"
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--color-text-tertiary)"
          }}
        />
        <span
          className="font-[family-name:var(--font-body)] font-medium"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
        >
          Idle
        </span>
      </span>
    );
  }
  const label = state.streaming ? "Pensando…" : "Enviando";
  return (
    <span
      className="inline-flex items-center"
      style={{
        gap: 6,
        padding: "6px 10px",
        borderRadius: 8,
        background: "var(--color-warning-soft)"
      }}
    >
      <Loader
        size={12}
        strokeWidth={1.75}
        style={{ color: "var(--color-warning)", animation: "spin 1.4s linear infinite" }}
      />
      <span
        className="font-[family-name:var(--font-body)] font-semibold"
        style={{ fontSize: 11, color: "var(--color-warning)" }}
      >
        {label}
      </span>
    </span>
  );
}


/* ============================================================
 * ChatPanel (mock)
 * ============================================================ */

function ChatPanel() {
  return (
    <aside
      className="flex flex-col"
      style={{
        width: 560,
        flexShrink: 0,
        background: "var(--color-surface)",
        borderRight: "1px solid var(--color-border)"
      }}
    >
      <ChatMessages />
      <ChatInput />
    </aside>
  );
}

function ChatMessages() {
  const state = useChatStream(chatClient);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [state.messages, state.streaming]);

  const hasContent = state.messages.length > 0 || state.streaming;

  return (
    <div
      ref={scrollRef}
      className="flex flex-col overflow-y-auto"
      style={{ flex: 1, padding: "24px 24px 16px 24px", gap: 24 }}
    >
      {!hasContent ? (
        <EmptyChatState connection={state.connection} />
      ) : null}

      {state.messages.map((m) => {
        if (m.role === "user") {
          return (
            <UserMessage key={`${m.role}-${m.msgId}`} who="Juanes" timeAgo={relativeTime(m.timestamp)}>
              {m.content}
            </UserMessage>
          );
        }
        return (
          <AssistantMessage key={`${m.role}-${m.msgId}`} timeAgo={relativeTime(m.timestamp)}>
            {m.content}
          </AssistantMessage>
        );
      })}

      {state.streaming ? (
        <AssistantMessage timeAgo="ahora" streaming>
          {state.streaming.deltaSoFar || "…"}
        </AssistantMessage>
      ) : null}

      {state.lastError ? (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            background: "var(--color-warning-soft)",
            color: "var(--color-warning-fg)",
            fontFamily: "var(--font-mono)",
            fontSize: 11
          }}
        >
          {state.lastError}
        </div>
      ) : null}
    </div>
  );
}

function EmptyChatState({ connection }: { connection: ChatConnection }) {
  return (
    <div className="flex flex-col items-start" style={{ gap: 12 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{ width: 24, height: 24, borderRadius: 6, background: "var(--color-accent-tertiary)", color: "#fffbf5" }}
        >
          <Sparkles size={11} strokeWidth={1.75} />
        </span>
        <span
          className="font-[family-name:var(--font-caption)] font-semibold"
          style={{ fontSize: 11, color: "var(--color-text-secondary)" }}
        >
          OpenClaw {connection === "connected" ? "está listo" : connection === "reconnecting" ? "está reconectando" : "está offline"}
        </span>
      </div>
      <p
        className="m-0 font-[family-name:var(--font-body)]"
        style={{ fontSize: 14, lineHeight: 1.55, color: "var(--color-text-primary)" }}
      >
        {connection === "connected"
          ? "Pregunta lo que necesites o usa el viewport derecho para ver qué está haciendo el agente en tiempo real."
          : "Esperando conexión con el agente. El viewport derecho sigue mostrando audit events del gateway."}
      </p>
    </div>
  );
}

function relativeTime(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 5_000) return "ahora";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `hace ${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `hace ${m}m`;
    const h = Math.floor(m / 60);
    return `hace ${h}h`;
  } catch {
    return "—";
  }
}

function AssistantMessage({
  children,
  timeAgo,
  streaming
}: {
  children: React.ReactNode;
  timeAgo: string;
  streaming?: boolean;
}) {
  // Si children es string, renderiza con MarkdownText (OpenClaw devuelve
  // markdown via Bedrock). Si es otro tipo (ReactNode complejo, mocks), deja
  // pasar tal cual para no romper.
  const isString = typeof children === "string";
  return (
    <article className="flex flex-col" style={{ gap: 6 }}>
      <header className="flex items-center" style={{ gap: 8 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: "var(--color-accent-tertiary)",
            color: "#e6edf3"
          }}
        >
          <Sparkles size={11} strokeWidth={1.75} />
        </span>
        <span
          className="font-[family-name:var(--font-caption)] font-semibold"
          style={{ fontSize: 11, color: "var(--color-text-secondary)" }}
        >
          OpenClaw
        </span>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>·</span>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {timeAgo}
        </span>
        {streaming ? (
          <span className="inline-flex items-center" style={{ gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>·</span>
            <Loader
              size={10}
              strokeWidth={1.75}
              style={{ color: "var(--color-accent-tertiary)", animation: "spin 1.4s linear infinite" }}
            />
            <span
              className="font-[family-name:var(--font-caption)] italic"
              style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
            >
              escribiendo
            </span>
          </span>
        ) : null}
      </header>
      <div
        className="font-[family-name:var(--font-body)]"
        style={{ fontSize: 14, lineHeight: 1.55, color: "var(--color-text-primary)" }}
      >
        {isString ? (
          <MarkdownText fontSize={14}>{children as string}</MarkdownText>
        ) : (
          children
        )}
        {streaming ? (
          <span
            aria-hidden="true"
            className="inline-block align-middle"
            style={{
              width: 8,
              height: 14,
              marginLeft: 2,
              background: "var(--color-accent-tertiary)",
              animation: "blink 1s steps(2) infinite"
            }}
          />
        ) : null}
      </div>
    </article>
  );
}

function UserMessage({
  children,
  who,
  timeAgo
}: {
  children: React.ReactNode;
  who: string;
  timeAgo: string;
}) {
  return (
    <article className="flex flex-col items-end" style={{ gap: 6 }}>
      <header className="flex items-center" style={{ gap: 8 }}>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {timeAgo}
        </span>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>·</span>
        <span
          className="font-[family-name:var(--font-caption)] font-semibold"
          style={{ fontSize: 11, color: "var(--color-text-primary)" }}
        >
          {who}
        </span>
        <span
          aria-hidden="true"
          className="grid place-items-center font-[family-name:var(--font-heading)] font-bold"
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: "var(--color-surface-sunken)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-primary)",
            fontSize: 11
          }}
        >
          {who.charAt(0).toUpperCase()}
        </span>
      </header>
      <div
        className="font-[family-name:var(--font-body)]"
        style={{
          maxWidth: "82%",
          padding: "10px 14px",
          borderRadius: 12,
          background: "var(--color-surface-sunken)",
          fontSize: 14,
          lineHeight: 1.5,
          color: "var(--color-text-primary)"
        }}
      >
        {children}
      </div>
    </article>
  );
}

function ProposalCard({
  title,
  subtitle,
  severity,
  body,
  quorum,
  rollbackMinutes
}: {
  title: string;
  subtitle: string;
  severity: "low" | "medium" | "high" | "critical";
  body: string;
  quorum: { current: number; required: number; mode: string };
  rollbackMinutes: number;
}) {
  const { toast } = useToast();
  const intent = useOpenClawIntent();
  const sevTone =
    severity === "critical" || severity === "high"
      ? { fg: "var(--color-critical)", bg: "var(--color-critical-soft)", border: "var(--color-critical-border)" }
      : severity === "medium"
        ? { fg: "var(--color-warning)", bg: "var(--color-warning-soft)", border: "var(--color-warning-border)" }
        : { fg: "var(--color-success)", bg: "var(--color-success-soft)", border: "var(--color-success-border)" };

  return (
    <article
      className="flex flex-col"
      style={{
        gap: 12,
        padding: 16,
        borderRadius: 14,
        background: "var(--color-surface)",
        border: `1px solid ${sevTone.border}`,
        boxShadow: "var(--shadow-sm)"
      }}
    >
      <header className="flex items-start" style={{ gap: 12 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: sevTone.bg,
            color: sevTone.fg,
            flexShrink: 0
          }}
        >
          <WandSparkles size={14} strokeWidth={1.75} />
        </span>
        <div className="flex flex-col flex-1 min-w-0" style={{ gap: 2 }}>
          <span
            className="font-[family-name:var(--font-heading)] font-semibold"
            style={{ fontSize: 14, color: "var(--color-text-primary)" }}
          >
            {title}
          </span>
          <span
            className="font-[family-name:var(--font-mono)]"
            style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
          >
            {subtitle}
          </span>
        </div>
        <span
          className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold"
          style={{
            padding: "3px 10px",
            borderRadius: 6,
            background: sevTone.bg,
            border: `1px solid ${sevTone.border}`,
            color: sevTone.fg,
            fontSize: 10
          }}
        >
          {severity}
        </span>
      </header>

      <p
        className="m-0 font-[family-name:var(--font-body)]"
        style={{ fontSize: 13, lineHeight: 1.55, color: "var(--color-text-secondary)" }}
      >
        {body}
      </p>

      <div
        className="flex items-center"
        style={{
          gap: 12,
          padding: "8px 12px",
          borderRadius: 8,
          background: "var(--color-surface-sunken)",
          fontSize: 11
        }}
      >
        <span
          className="font-[family-name:var(--font-body)] font-semibold"
          style={{ color: "var(--color-text-primary)" }}
        >
          Quorum {quorum.current}/{quorum.required}
        </span>
        <span style={{ color: "var(--color-text-tertiary)" }}>·</span>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {quorum.mode} · firmaste ✓
        </span>
        <span className="flex-1" />
        <span
          className="inline-flex items-center font-[family-name:var(--font-mono)] font-semibold"
          style={{ gap: 4, color: "var(--color-success)", fontSize: 10 }}
        >
          rollback armado {rollbackMinutes}min
        </span>
      </div>

      <div className="flex items-center" style={{ gap: 8 }}>
        <button
          type="button"
          onClick={() => {
            const prompt = `Por favor procede a aprobar el dry-run de la propuesta:\n\n· Título: ${title}\n· Subtítulo: ${subtitle}\n· Severidad: ${severity}\n· Quorum actual: ${quorum.current}/${quorum.required} (${quorum.mode})\n\nDescripción: ${body}\n\nEjecuta el skill correspondiente y reporta el audit event.`;
            intent.sendIntent(prompt, `proposal:approve-dry-run`);
            toast.info("Aprobación enviada a OpenClaw", {
              description: "Revisa el prompt en el chat y confirma con Enter.",
              duration: 2500
            });
          }}
          className="inline-flex items-center transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          style={{
            gap: 6,
            padding: "9px 14px",
            borderRadius: 8,
            background: "var(--color-accent-tertiary)",
            color: "var(--color-on-dark-strong)",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600
          }}
        >
          Aprobar dry-run
          <ArrowRight size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => {
            const prompt = `Muéstrame el diff completo de la propuesta "${title}". Incluye archivos afectados, hunks con line numbers, y riesgo de cada cambio.`;
            intent.sendIntent(prompt, `proposal:view-diff`);
          }}
          className="inline-flex items-center transition-colors hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          style={{
            gap: 6,
            padding: "9px 14px",
            borderRadius: 8,
            background: "transparent",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text-primary)",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600
          }}
        >
          Ver diff
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            const prompt = `Pospón la propuesta "${title}" hasta la próxima ventana de revisión. Mantén la propuesta en la cola y agrega un audit event con el motivo de la posposición.`;
            intent.sendIntent(prompt, `proposal:postpone`);
          }}
          className="inline-flex items-center transition-colors hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          style={{
            gap: 4,
            padding: "9px 8px",
            borderRadius: 6,
            background: "transparent",
            color: "var(--color-text-tertiary)",
            cursor: "pointer",
            fontSize: 12
          }}
        >
          Posponer
        </button>
      </div>
    </article>
  );
}

function ChatInput() {
  const [draft, setDraft] = useState("");
  const state = useChatStream(chatClient);
  const { toast } = useToast();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize del textarea: ajusta height al scrollHeight cada vez que el
  // draft cambia. min 24px (1 línea), max ~220px (≈10 líneas) y después
  // permite scroll interno.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 220);
    el.style.height = `${Math.max(24, next)}px`;
  }, [draft]);

  // Consume el intent pendiente disparado desde otro botón del panel
  // (banners OpenClaw, cards de propuestas, etc.) y pre-llena el textarea.
  useConsumeIntentOnMount((prompt) => {
    setDraft(prompt);
    // Pequeño delay para que el textarea esté en el DOM antes del focus.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(prompt.length, prompt.length);
        el.scrollTop = el.scrollHeight;
      }
    });
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    await chatClient.sendMessage(content);
  }

  function handleKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      const form = event.currentTarget.form;
      if (form) form.requestSubmit();
    }
  }

  const offline = state.connection !== "connected";

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col"
      style={{
        gap: 8,
        padding: "16px 24px 20px 24px",
        borderTop: "1px solid var(--color-border)",
        background: "var(--color-surface)"
      }}
    >
      <div
        className="flex flex-col"
        style={{
          gap: 8,
          padding: "12px 14px",
          borderRadius: 12,
          background: "var(--color-surface)",
          border: "1px solid var(--color-border-strong)"
        }}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          rows={1}
          maxLength={1200}
          placeholder="Pregunta a OpenClaw, pide evidencia o usa / para skills…"
          className="resize-none bg-transparent outline-none placeholder:text-[var(--color-text-tertiary)]"
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 14,
            lineHeight: 1.5,
            color: "var(--color-text-primary)",
            border: "none",
            overflow: "auto",
            transition: "height 80ms ease-out",
            minHeight: 24
          }}
        />
        <div className="flex items-center" style={{ gap: 8 }}>
          <button
            type="button"
            onClick={() =>
              toast.info("Adjuntar evidencia", {
                description: "Para adjuntar un snapshot o evidencia, usa la sección Recolector → Captura manual.",
                duration: 4000
              })
            }
            className="inline-flex items-center transition-colors hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            style={{
              gap: 4,
              padding: "4px 8px",
              borderRadius: 6,
              background: "var(--color-surface-sunken)",
              color: "var(--color-text-secondary)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 500
            }}
          >
            <Paperclip size={11} strokeWidth={1.75} />
            evidencia
          </button>
          <button
            type="button"
            onClick={() => setDraft((current) => (current.startsWith("/") ? current : `/${current}`))}
            className="inline-flex items-center transition-colors hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            style={{
              gap: 4,
              padding: "4px 8px",
              borderRadius: 6,
              background: "var(--color-surface-sunken)",
              color: "var(--color-text-secondary)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 500
            }}
          >
            <Slash size={11} strokeWidth={1.75} />
            skill
          </button>
          <span className="flex-1" />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="grid place-items-center transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "var(--color-accent-tertiary)",
              color: "#fffbf5",
              cursor: "pointer",
              border: "none"
            }}
            aria-label="Enviar"
          >
            <ArrowUp size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="flex items-center" style={{ gap: 6 }}>
        <Info size={10} strokeWidth={1.75} style={{ color: "var(--color-text-tertiary)" }} />
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {offline
            ? `Sin conexión · ${state.queuedCount} mensajes en cola`
            : "Cada mensaje queda en audit chain · oc.chat.operator_message"}
        </span>
        <span className="flex-1" />
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {draft.length}/1200 · ⌘ Enter para enviar
        </span>
      </div>
    </form>
  );
}

/* ============================================================
 * AgentViewport con tabs + filtros + feed
 * ============================================================ */

type ViewportTab = "live" | "files" | "terminal" | "diff" | "topology";

function AgentViewport({
  actions,
  source,
  errorMessage
}: {
  actions: Action[];
  source: AgentSource;
  errorMessage: string | null;
}) {
  const [tab, setTab] = useState<ViewportTab>("live");
  return (
    <section
      className="flex flex-col flex-1 min-w-0"
      style={{ background: "var(--color-surface-sunken)" }}
    >
      <ViewportTabs active={tab} onChange={setTab} actions={actions} />
      {tab === "live" ? <LiveTab actions={actions} source={source} errorMessage={errorMessage} /> : null}
      {tab === "files" ? <FilesTab actions={actions} /> : null}
      {tab === "terminal" ? <TerminalTab actions={actions} source={source} /> : null}
      {tab === "diff" ? <DiffTab actions={actions} /> : null}
      {tab === "topology" ? <TopologyTab /> : null}
    </section>
  );
}

interface TabConfig {
  id: ViewportTab;
  label: string;
  icon: React.ReactNode;
  count?: number;
  badge?: string;
  countTone?: "warning";
  dot?: boolean;
}

function buildTabConfig(actions: Action[]): TabConfig[] {
  const filesCount = new Set(
    actions.filter((a) => a.kind === "read").map((a) => (a as ReadAction).path)
  ).size;
  const diffCount = actions.filter((a) => a.kind === "diff").length;
  return [
    { id: "live", label: "Live", icon: <Radio size={14} strokeWidth={1.75} />, dot: true },
    { id: "files", label: "Files", icon: <FolderTree size={14} strokeWidth={1.75} />, count: filesCount },
    { id: "terminal", label: "Terminal", icon: <Terminal size={14} strokeWidth={1.75} />, badge: "stream" },
    {
      id: "diff",
      label: "Diff",
      icon: <GitPullRequest size={14} strokeWidth={1.75} />,
      count: diffCount,
      countTone: diffCount > 0 ? "warning" : undefined
    },
    { id: "topology", label: "Topología", icon: <GitGraph size={14} strokeWidth={1.75} /> }
  ];
}

function ViewportTabs({ active, onChange, actions }: { active: ViewportTab; onChange: (t: ViewportTab) => void; actions: Action[] }) {
  const TAB_CONFIG = useMemo(() => buildTabConfig(actions), [actions]);
  return (
    <div
      className="flex items-center"
      style={{
        padding: "0 20px",
        background: "var(--color-surface)",
        borderBottom: "1px solid var(--color-border)"
      }}
    >
      {TAB_CONFIG.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className="inline-flex items-center transition-colors"
            style={{
              gap: 8,
              padding: "14px 12px",
              background: "transparent",
              borderBottom: isActive ? "2px solid var(--color-accent-tertiary)" : "2px solid transparent",
              color: isActive ? "var(--color-text-primary)" : "var(--color-text-secondary)",
              fontFamily: "var(--font-body)",
              fontSize: 13,
              fontWeight: isActive ? 600 : 500,
              cursor: "pointer"
            }}
          >
            <span
              className="inline-flex items-center"
              style={{ gap: 4, color: isActive ? "var(--color-accent-tertiary)" : "var(--color-text-tertiary)" }}
            >
              {t.icon}
              {t.dot ? (
                <span
                  aria-hidden="true"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "var(--color-success)",
                    animation: "live-indicator-ring 1.6s cubic-bezier(0.4,0,0.6,1) infinite"
                  }}
                />
              ) : null}
            </span>
            {t.label}
            {t.count != null ? (
              <span
                className="inline-flex items-center font-[family-name:var(--font-mono)] font-bold"
                style={{
                  padding: "1px 6px",
                  borderRadius: 4,
                  background:
                    t.countTone === "warning"
                      ? "var(--color-warning-soft)"
                      : isActive
                        ? "var(--color-accent-tertiary)"
                        : "var(--color-surface-sunken)",
                  color:
                    t.countTone === "warning"
                      ? "var(--color-warning)"
                      : isActive
                        ? "var(--color-text-inverse)"
                        : "var(--color-text-tertiary)",
                  fontSize: 10
                }}
              >
                {t.count}
              </span>
            ) : null}
            {t.badge ? (
              <span
                className="inline-flex items-center font-[family-name:var(--font-mono)] font-semibold"
                style={{
                  padding: "1px 6px",
                  borderRadius: 4,
                  background: "var(--color-success-soft)",
                  color: "var(--color-success)",
                  fontSize: 9
                }}
              >
                {t.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * LiveTab — Canvas Live v6 (2026-05-25).
 *
 * Reemplaza el feed de cards anterior con el componente LiveTool
 * (3 zonas: tareas + Postman view + plan editable). Mientras Codex
 * entrega el backend (OPS Bloque 7), usa el dataset demo. Cuando
 * el endpoint /v1/canvas/live/stream esté live, este wrapper se
 * conecta al WSS y descarta el dataset.
 *
 * Los props `actions/source/errorMessage` del wrapper antiguo siguen
 * llegando pero ya no se usan — son fallback histórico mientras Codex
 * no entrega el nuevo stream. Quedan documentados para revisitar al
 * mergear el OPS Bloque 7.
 */
function LiveTab(_props: {
  actions: Action[];
  source: AgentSource;
  errorMessage: string | null;
}) {
  void _props;
  // Demo mode default OFF ahora que Bloque 7 está live. Persiste decisión
  // del operador en localStorage.
  const [demoMode, setDemoMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem("delivrix.canvas.demo") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("delivrix.canvas.demo", demoMode ? "1" : "0");
    } catch {
      // private mode etc — silencioso.
    }
  }, [demoMode]);

  // Las 2 fuentes corren independientes según el toggle. Cuando demoMode=true,
  // useLiveCanvasStream queda en `offline` (no abre WSS) y useDemoLiveState
  // entrega el dataset simulado. Al revés cuando demoMode=false.
  const demoState = useDemoLiveState(demoMode);
  const liveStream = useLiveCanvasStream(!demoMode);

  // Una única fuente efectiva. Si demo está ON, usa el dataset; si OFF, el
  // WSS real.
  const tasks = demoMode ? demoState.tasks : liveStream.tasks;
  const fallbackActiveId = demoMode ? demoState.activeTaskId : liveStream.activeTaskId;

  const [localActiveId, setLocalActiveId] = useState<string | null>(null);
  const activeTaskId = localActiveId ?? fallbackActiveId;

  useEffect(() => {
    // Si el operador no eligió manualmente, sigue el activo "natural" del stream.
    if (!localActiveId && fallbackActiveId) {
      // noop — derivado.
    }
  }, [localActiveId, fallbackActiveId]);

  const handleSelectTask = useCallback((id: string) => {
    setLocalActiveId(id);
    if (!demoMode) liveStream.setActiveTaskId(id);
  }, [demoMode, liveStream]);

  const currentAction = demoMode
    ? (activeTaskId && demoState.currentAction?.taskId === activeTaskId
        ? demoState.currentAction
        : demoState.currentAction ?? null)
    : liveStream.currentAction;
  const artifact = demoMode
    ? (activeTaskId && demoState.artifact?.taskId === activeTaskId
        ? demoState.artifact
        : demoState.artifact ?? null)
    : liveStream.artifact;
  const isConnected = demoMode ? demoState.isConnected : liveStream.connection === "connected";

  const { toast } = useToast();
  const [actionPending, setActionPending] = useState<"approve" | "reject" | null>(null);

  const handleEditBlock = useCallback(
    async (blockId: string, content: string) => {
      if (demoMode) {
        // eslint-disable-next-line no-console
        console.log("[LiveTool · demo] edit block", blockId, content);
        return;
      }
      try {
        await liveStream.patchBlock(blockId, content);
        toast.info("Bloque actualizado", {
          description: "El cambio quedó en audit chain. OpenClaw lo verá la próxima vez que lea el plan.",
          duration: 2000
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[LiveTool] patchBlock error", err);
        toast.error("No se pudo guardar el bloque", {
          description: err instanceof Error ? err.message : "error desconocido"
        });
      }
    },
    [demoMode, liveStream, toast]
  );
  const handleApprove = useCallback(async () => {
    if (demoMode) {
      toast.info("Demo · plan aprobado", {
        description: "En modo demo no se ejecuta. Apaga Demo para usar el plan real.",
        duration: 2500
      });
      return;
    }
    if (actionPending) return;
    setActionPending("approve");
    try {
      await liveStream.approveArtifact();
      toast.success("Plan aprobado", {
        description: "OpenClaw ejecuta los pasos. Audit chain firmado como acción crítica.",
        duration: 3500
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[LiveTool] approve error", err);
      toast.error("No se pudo aprobar el plan", {
        description: err instanceof Error ? err.message : "error desconocido"
      });
    } finally {
      setActionPending(null);
    }
  }, [demoMode, liveStream, toast, actionPending]);
  const handleReject = useCallback(async () => {
    if (demoMode) {
      toast.info("Demo · plan rechazado", {
        description: "En modo demo no se ejecuta. Apaga Demo para enviar el rechazo real.",
        duration: 2500
      });
      return;
    }
    if (actionPending) return;
    setActionPending("reject");
    try {
      await liveStream.rejectArtifact();
      toast.success("Plan rechazado", {
        description: "OpenClaw recibirá la señal y propondrá otro plan o pedirá detalle.",
        duration: 3500
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[LiveTool] reject error", err);
      toast.error("No se pudo rechazar el plan", {
        description: err instanceof Error ? err.message : "error desconocido"
      });
    } finally {
      setActionPending(null);
    }
  }, [demoMode, liveStream, toast, actionPending]);

  return (
    <div className="flex flex-col" style={{ flex: 1, minHeight: 0 }}>
      <div
        className="flex items-center"
        style={{
          padding: "8px 16px",
          background: "var(--color-surface)",
          borderBottom: "1px solid var(--color-border)",
          gap: 10
        }}
      >
        <span
          className="font-[family-name:var(--font-caption)] font-semibold uppercase"
          style={{
            fontSize: 10,
            letterSpacing: "0.6px",
            color: "var(--color-text-tertiary)"
          }}
        >
          Canvas Live v6 · herramienta funcional
        </span>
        {!demoMode && liveStream.connection !== "connected" ? (
          <span
            className="font-[family-name:var(--font-mono)]"
            style={{
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 999,
              background: liveStream.connection === "offline"
                ? "var(--color-critical-soft)"
                : "var(--color-warning-soft)",
              color: liveStream.connection === "offline"
                ? "var(--color-critical)"
                : "var(--color-warning)",
              fontWeight: 500
            }}
          >
            {liveStream.connection}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setDemoMode((v) => !v)}
          title={
            demoMode
              ? "Apagar demo · conectar al WSS real del gateway"
              : "Encender demo · simular auditoría IONOS sin backend"
          }
          className="inline-flex items-center transition-colors"
          style={{
            gap: 4,
            padding: "4px 8px",
            borderRadius: 9999,
            background: demoMode ? "var(--color-info-soft)" : "var(--color-surface-sunken)",
            border: demoMode ? "none" : "1px solid var(--color-border)",
            color: demoMode ? "var(--color-info)" : "var(--color-text-secondary)",
            cursor: "pointer",
            fontSize: 10,
            fontFamily: "var(--font-caption)",
            fontWeight: 600
          }}
        >
          Demo {demoMode ? "ON" : "OFF"}
        </button>
      </div>
      <LiveTool
        tasks={tasks}
        activeTaskId={activeTaskId}
        onSelectTask={handleSelectTask}
        currentAction={currentAction}
        artifact={artifact}
        onEditBlock={handleEditBlock}
        onApprove={handleApprove}
        onReject={handleReject}
        isConnected={isConnected}
        actionPending={actionPending}
      />
    </div>
  );
}

function LiveEmptyOrError({
  source,
  errorMessage,
  filterActive,
  demoMode
}: {
  source: AgentSource;
  errorMessage: string | null;
  filterActive: boolean;
  demoMode: boolean;
}) {
  // Si demo está ON pero cursor aún no empezó (0 cards), mostramos un
  // mensaje específico — evita confundir "demo activado pero todavía nada"
  // con "agente real idle". Las cards van a aparecer en 1.2s.
  if (demoMode && !filterActive) {
    return (
      <div
        className="flex flex-col items-center justify-center"
        style={{ flex: 1, gap: 14, padding: 40, color: "var(--color-text-tertiary)", textAlign: "center" }}
      >
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background: "var(--color-info-soft)",
            color: "var(--color-info)"
          }}
        >
          <Sparkles size={26} strokeWidth={1.5} />
        </span>
        <div className="flex flex-col" style={{ gap: 6, maxWidth: 440 }}>
          <span
            className="font-[family-name:var(--font-sans)] font-semibold"
            style={{ fontSize: 15, color: "var(--color-text-primary)", letterSpacing: "var(--tracking-tight)" }}
          >
            Demo cargando…
          </span>
          <span style={{ fontSize: 12, fontFamily: "var(--font-body)", lineHeight: 1.55 }}>
            En segundos vas a ver al agente ejecutar un flujo simulado de búsqueda
            de dominios. Las cards aparecen progresivamente para mostrar cómo se
            vería el viewport con eventos reales intermedios.
          </span>
        </div>
      </div>
    );
  }
  if (source === "loading") {
    return (
      <div
        className="flex flex-col items-center justify-center"
        style={{ flex: 1, gap: 10, padding: 32, color: "var(--color-text-tertiary)" }}
      >
        <Loader size={28} strokeWidth={1.25} style={{ animation: "spin 1.4s linear infinite" }} />
        <span style={{ fontSize: 12, fontFamily: "var(--font-body)" }}>
          Cargando audit-events del gateway…
        </span>
      </div>
    );
  }
  if (source === "error") {
    return (
      <div
        className="flex flex-col items-center justify-center"
        style={{ flex: 1, gap: 12, padding: 32, color: "var(--color-text-tertiary)", textAlign: "center" }}
      >
        <AlertTriangleIcon />
        <div className="flex flex-col" style={{ gap: 4, maxWidth: 420 }}>
          <span
            className="font-[family-name:var(--font-heading)] font-semibold"
            style={{ fontSize: 14, color: "var(--color-warning)" }}
          >
            Sin conexión con el gateway
          </span>
          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", opacity: 0.7 }}>
            {errorMessage ?? "GET /v1/audit-events falló. Verificá que el gateway esté arriba en :3000."}
          </span>
        </div>
      </div>
    );
  }
  if (filterActive) {
    return (
      <div
        className="flex flex-col items-center justify-center"
        style={{ flex: 1, gap: 8, padding: 32, color: "var(--color-text-tertiary)" }}
      >
        <Circle size={24} strokeWidth={1.25} />
        <span style={{ fontSize: 12, fontFamily: "var(--font-body)" }}>
          Sin eventos del agente para este filtro.
        </span>
      </div>
    );
  }
  // source === "empty"
  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ flex: 1, gap: 14, padding: 40, color: "var(--color-text-tertiary)", textAlign: "center" }}
    >
      <span
        aria-hidden="true"
        className="grid place-items-center"
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          background: "var(--color-surface-sunken)",
          color: "var(--color-accent-tertiary)"
        }}
      >
        <Sparkles size={26} strokeWidth={1.5} />
      </span>
      <div className="flex flex-col" style={{ gap: 6, maxWidth: 440 }}>
        <span
          className="font-[family-name:var(--font-sans)] font-semibold"
          style={{ fontSize: 15, color: "var(--color-text-primary)", letterSpacing: "var(--tracking-tight)" }}
        >
          OpenClaw idle · esperando próxima acción
        </span>
        <span style={{ fontSize: 12, fontFamily: "var(--font-body)", lineHeight: 1.55 }}>
          Cuando le pidas algo en el chat, vas a ver aquí en tiempo real cada lectura,
          comando, detección, diff o llamada HTTP que el agente ejecute mientras razona.
        </span>
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--color-text-tertiary)",
            marginTop: 4
          }}
        >
          actor filter: <code>openclaw/*</code> · audit chain completo en Seguridad
        </span>
      </div>
    </div>
  );
}

function AlertTriangleIcon() {
  return (
    <span
      style={{
        display: "grid",
        placeItems: "center",
        width: 40,
        height: 40,
        borderRadius: 999,
        background: "var(--color-warning-soft)",
        color: "var(--color-warning)"
      }}
    >
      <TriangleAlert size={22} strokeWidth={1.5} />
    </span>
  );
}

const FILTER_OPTS: Array<{ id: "all" | ActionKind; label: string; icon: React.ReactNode; tone?: "warning" }> = [
  { id: "all", label: "Todo", icon: null },
  { id: "read", label: "Lecturas", icon: <FileText size={11} strokeWidth={1.75} /> },
  { id: "command", label: "Comandos", icon: <Terminal size={11} strokeWidth={1.75} /> },
  { id: "detect", label: "Detecciones", icon: <TriangleAlert size={11} strokeWidth={1.75} />, tone: "warning" },
  { id: "diff", label: "Diffs", icon: <GitPullRequest size={11} strokeWidth={1.75} />, tone: "warning" },
  { id: "http", label: "HTTP", icon: <Globe size={11} strokeWidth={1.75} /> }
];

function LiveFilters({
  actions,
  value,
  onChange,
  autoScroll,
  onAutoScroll,
  source,
  demoMode,
  onDemoToggle,
  demoProgress,
  demoRunning
}: {
  actions: Action[];
  value: "all" | ActionKind;
  onChange: (v: "all" | ActionKind) => void;
  autoScroll: boolean;
  onAutoScroll: (v: boolean) => void;
  source: AgentSource | "demo";
  demoMode: boolean;
  onDemoToggle: (v: boolean) => void;
  demoProgress: { current: number; total: number };
  demoRunning: boolean;
}) {
  return (
    <div
      className="flex items-center flex-wrap"
      style={{
        gap: 8,
        padding: "12px 20px",
        background: "var(--color-surface)",
        borderBottom: "1px solid var(--color-border)"
      }}
    >
      {FILTER_OPTS.map((f) => {
        const isActive = f.id === value;
        const count = f.id === "all" ? actions.length : actions.filter((a) => a.kind === f.id).length;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onChange(f.id)}
            className="inline-flex items-center transition-colors"
            style={{
              gap: 6,
              padding: "4px 10px",
              borderRadius: 9999,
              background: isActive ? "var(--color-text-primary)" : "var(--color-surface-sunken)",
              border: isActive ? "none" : "1px solid var(--color-border)",
              color: isActive ? "var(--color-text-inverse)" : f.tone === "warning" ? "var(--color-warning)" : "var(--color-text-secondary)",
              cursor: "pointer",
              fontSize: 11,
              fontFamily: "var(--font-caption)",
              fontWeight: 600
            }}
          >
            {f.icon}
            {f.label}
            <span
              className="font-[family-name:var(--font-mono)]"
              style={{
                fontSize: 10,
                opacity: isActive ? 0.7 : 1,
                color: isActive ? "var(--color-text-inverse)" : "var(--color-text-tertiary)"
              }}
            >
              {count}
            </span>
          </button>
        );
      })}
      <span className="flex-1" />
      <span
        className="inline-flex items-center"
        style={{
          gap: 4,
          padding: "3px 8px",
          borderRadius: 9999,
          background:
            source === "live"
              ? "var(--color-success-soft)"
              : source === "demo"
                ? "var(--color-info-soft)"
                : source === "error"
                  ? "var(--color-critical-soft)"
                  : source === "empty"
                    ? "var(--color-warning-soft)"
                    : "var(--color-surface-sunken)",
          color:
            source === "live"
              ? "var(--color-success)"
              : source === "demo"
                ? "var(--color-info)"
                : source === "error"
                  ? "var(--color-critical)"
                  : source === "empty"
                    ? "var(--color-warning)"
                    : "var(--color-text-tertiary)",
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          fontWeight: 600
        }}
        title={
          source === "live"
            ? "Feed alimentado por /v1/audit-events real del gateway"
            : source === "demo"
              ? "Modo demo · dataset simulado para validar diseño"
              : source === "error"
                ? "Sin conexión con el gateway"
                : source === "empty"
                  ? "Gateway responde pero el agente no ha emitido eventos"
                  : "Cargando…"
        }
      >
        {source === "live"
          ? "● live"
          : source === "demo"
            ? `▶ demo ${demoProgress.current}/${demoProgress.total}${demoRunning ? "" : " ✓"}`
            : source === "error"
              ? "✕ offline"
              : source === "empty"
                ? "○ silent"
                : "…"}
      </span>
      <button
        type="button"
        onClick={() => onDemoToggle(!demoMode)}
        title={
          demoMode
            ? "Apagar modo demo · vuelve al feed real de /v1/audit-events"
            : "Encender modo demo · simula al agente trabajando para validar diseño"
        }
        className="inline-flex items-center transition-colors"
        style={{
          gap: 4,
          padding: "4px 8px",
          borderRadius: 9999,
          background: demoMode ? "var(--color-info-soft)" : "var(--color-surface-sunken)",
          border: demoMode ? "none" : "1px solid var(--color-border)",
          color: demoMode ? "var(--color-info)" : "var(--color-text-secondary)",
          cursor: "pointer",
          fontSize: 10,
          fontFamily: "var(--font-caption)",
          fontWeight: 600
        }}
      >
        <Sparkles size={10} strokeWidth={2} />
        Demo {demoMode ? "ON" : "OFF"}
      </button>
      <button
        type="button"
        onClick={() => onAutoScroll(!autoScroll)}
        className="inline-flex items-center transition-colors"
        style={{
          gap: 4,
          padding: "4px 8px",
          borderRadius: 9999,
          background: autoScroll ? "var(--color-success-soft)" : "var(--color-surface-sunken)",
          border: autoScroll ? "none" : "1px solid var(--color-border)",
          color: autoScroll ? "var(--color-success)" : "var(--color-text-secondary)",
          cursor: "pointer",
          fontSize: 10,
          fontFamily: "var(--font-caption)",
          fontWeight: 600
        }}
      >
        <ArrowDown size={10} strokeWidth={2} />
        Auto-scroll {autoScroll ? "ON" : "OFF"}
      </button>
    </div>
  );
}

/* ============================================================
 * Action cards
 * ============================================================ */

function ActionCard({ action }: { action: Action }) {
  switch (action.kind) {
    case "read":
      return <ReadCard action={action} />;
    case "detect":
      return <DetectCard action={action} />;
    case "http":
      return <HttpCard action={action} />;
    case "diff":
      return <DiffCard action={action} />;
    case "command":
      return <CommandCard action={action} />;
    case "await":
      return <AwaitCard action={action} />;
  }
}

function ActionHeader({
  icon,
  iconColor,
  verb,
  detail,
  badge,
  ts
}: {
  icon: React.ReactNode;
  iconColor?: string;
  verb: string;
  detail?: React.ReactNode;
  badge?: React.ReactNode;
  ts: string;
}) {
  return (
    <header className="flex items-center" style={{ gap: 8 }}>
      <span style={{ color: iconColor ?? "var(--color-text-secondary)" }}>{icon}</span>
      <span
        className="font-[family-name:var(--font-body)] font-semibold"
        style={{ fontSize: 12, color: "var(--color-text-primary)" }}
      >
        {verb}
      </span>
      {detail ? (
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-secondary)" }}
        >
          {detail}
        </span>
      ) : null}
      {badge}
      <span className="flex-1" />
      <span
        className="font-[family-name:var(--font-mono)]"
        style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
      >
        {ts}
      </span>
    </header>
  );
}

function ReadCard({ action }: { action: ReadAction }) {
  const { toast } = useToast();
  return (
    <article className="flex flex-col v4-slide-in v4-hoverable" style={{ gap: 8 }}>
      <ActionHeader
        icon={<FileText size={14} strokeWidth={1.75} />}
        verb="Leyendo"
        detail={<span style={{ color: "var(--color-accent-tertiary)" }}>{action.path}</span>}
        ts={action.ts}
      />
      <div
        className="flex flex-col"
        style={{
          gap: 2,
          padding: 14,
          borderRadius: 10,
          background: "#0d1117",
          fontFamily: "var(--font-mono)"
        }}
      >
        {action.snippet.map((s) => (
          <div key={s.num} className="flex items-center" style={{ gap: 12 }}>
            <span style={{ fontSize: 11, color: "#8b949e" }}>
              {s.num}
            </span>
            <span
              style={{
                fontSize: 11,
                color: s.highlight ? "var(--color-warning)" : "var(--color-text-inverse)",
                opacity: s.highlight ? 1 : 0.85,
                fontWeight: s.highlight ? 600 : 400
              }}
            >
              {s.code}
            </span>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          toast.info(`Archivo · ${action.path}`, {
            description: `${action.totalLines} líneas. Cambia al tab 'Files' del viewport para ver el árbol completo y agrupar lecturas por path.`,
            duration: 4500
          })
        }
        className="inline-flex items-center self-start transition-colors hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        style={{
          gap: 4,
          padding: "4px 6px",
          borderRadius: 4,
          background: "transparent",
          color: "var(--color-text-secondary)",
          cursor: "pointer",
          fontFamily: "var(--font-body)",
          fontSize: 11
        }}
      >
        <ExternalLink size={10} strokeWidth={1.75} />
        ver archivo completo ({action.totalLines} líneas)
      </button>
    </article>
  );
}

function DetectCard({ action }: { action: DetectAction }) {
  /* slide-in + hover lift se aplica al wrapper article */
  const tone =
    action.severity === "critical"
      ? "var(--color-critical)"
      : action.severity === "warning"
        ? "var(--color-warning)"
        : "var(--color-info)";
  const toneBg =
    action.severity === "critical"
      ? "var(--color-critical-soft)"
      : action.severity === "warning"
        ? "var(--color-warning-soft)"
        : "var(--color-info-soft)";
  // Icono según severity: alarmas solo si es warning/critical real. Para
  // audit events normales (smoke_valid, batch_received, chain_started) usamos
  // CheckCircle2 que comunica "todo OK, esto es informativo".
  const Icon =
    action.severity === "critical"
      ? ShieldAlert
      : action.severity === "warning"
        ? TriangleAlert
        : CheckCircle2;
  return (
    <article className="flex flex-col v4-slide-in v4-hoverable" style={{ gap: 8 }}>
      <ActionHeader
        icon={<Icon size={14} strokeWidth={1.75} />}
        iconColor={tone}
        verb={action.title}
        ts={action.ts}
      />
      <div
        className="flex flex-col"
        style={{ gap: 10, padding: 12, borderRadius: 10, background: toneBg }}
      >
        <p
          className="m-0 font-[family-name:var(--font-body)]"
          style={{ fontSize: 12, lineHeight: 1.5, color: "var(--color-text-primary)" }}
        >
          {action.body}
        </p>
        <div className="flex items-center flex-wrap" style={{ gap: 12 }}>
          {action.refs.map((r) => (
            <span
              key={r.label}
              className="inline-flex items-center font-[family-name:var(--font-mono)] font-medium"
              style={{ gap: 4, fontSize: 10, color: tone }}
            >
              {r.kind === "runbook" ? <FileText size={11} strokeWidth={1.75} /> : r.kind === "evidence" ? <Paperclip size={11} strokeWidth={1.75} /> : <Info size={11} strokeWidth={1.75} />}
              {r.label}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

function HttpCard({ action }: { action: HttpAction }) {
  const okStatus = action.status >= 200 && action.status < 300;
  return (
    <article className="flex flex-col v4-slide-in v4-hoverable" style={{ gap: 8 }}>
      <ActionHeader
        icon={<Globe size={14} strokeWidth={1.75} />}
        iconColor="var(--color-info)"
        verb={action.method}
        detail={action.url}
        badge={
          <>
            <span
              className="inline-flex items-center font-[family-name:var(--font-mono)] font-bold"
              style={{
                padding: "1px 6px",
                borderRadius: 4,
                background: okStatus ? "var(--color-success-soft)" : "var(--color-critical-soft)",
                color: okStatus ? "var(--color-success)" : "var(--color-critical)",
                fontSize: 10
              }}
            >
              {action.status}
            </span>
            <span
              className="font-[family-name:var(--font-mono)]"
              style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
            >
              {action.durationMs} ms
            </span>
          </>
        }
        ts={action.ts}
      />
      <div
        style={{
          padding: 14,
          borderRadius: 10,
          background: "#0d1117",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          overflowX: "auto",
          lineHeight: 1.6
        }}
      >
        {action.body.map((line, i) => (
          <div key={i} style={{ whiteSpace: "pre" }}>
            {highlightJson(line)}
          </div>
        ))}
      </div>
    </article>
  );
}

function DiffCard({ action }: { action: DiffAction }) {
  const { toast } = useToast();
  return (
    <article className="flex flex-col v4-slide-in v4-hoverable" style={{ gap: 8 }}>
      <ActionHeader
        icon={<GitPullRequest size={14} strokeWidth={1.75} />}
        iconColor="var(--color-accent-tertiary)"
        verb="Generando diff"
        detail={action.path}
        badge={
          <span
            className="inline-flex items-center font-[family-name:var(--font-mono)] font-bold"
            style={{
              padding: "1px 6px",
              borderRadius: 4,
              background: "var(--color-warning-soft)",
              color: "var(--color-warning)",
              fontSize: 10
            }}
          >
            +{action.added} −{action.removed}
          </span>
        }
        ts={action.ts}
      />
      <div
        className="flex flex-col overflow-hidden"
        style={{ borderRadius: 10, background: "#0d1117" }}
      >
        {action.lines.map((l, i) => {
          const bg = l.sign === "-" ? "rgba(239, 68, 68, 0.15)" : l.sign === "+" ? "rgba(34, 197, 94, 0.15)" : "transparent";
          const fg = l.sign === "-" ? "#fca5a5" : l.sign === "+" ? "#86efac" : "var(--color-text-inverse)";
          return (
            <div
              key={i}
              className="flex items-center"
              style={{ gap: 12, padding: "2px 14px", background: bg, fontFamily: "var(--font-mono)" }}
            >
              <span style={{ fontSize: 11, color: "#8b949e", width: 24 }}>
                {l.num}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: fg, opacity: l.sign === " " ? 0.4 : 1, width: 12 }}>
                {l.sign}
              </span>
              <span style={{ fontSize: 11, color: fg, opacity: l.sign === " " ? 0.7 : 1 }}>{l.code}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center" style={{ gap: 8 }}>
        <button
          type="button"
          onClick={() =>
            toast.info("Aplicar dry-run del diff", {
              description: `Backend POST /v1/agent/diffs/${action.hashShort}/apply (pendiente). Cuando exista, ejecuta el diff sin tocar producción y muestra el resultado.`,
              duration: 4500
            })
          }
          className="inline-flex items-center transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          style={{
            gap: 6,
            padding: "6px 12px",
            borderRadius: 6,
            background: "var(--color-accent-tertiary)",
            color: "var(--color-on-dark-strong)",
            cursor: "pointer",
            fontFamily: "var(--font-body)",
            fontSize: 11,
            fontWeight: 600
          }}
        >
          <Play size={11} strokeWidth={1.75} />
          Aplicar dry-run
        </button>
        <button
          type="button"
          onClick={() =>
            toast.info(`Diff completo · ${action.hashShort}`, {
              description: "Cambia al tab 'Diff' del viewport derecho para ver todos los hunks con syntax highlight.",
              duration: 4000
            })
          }
          className="inline-flex items-center transition-colors hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          style={{
            gap: 6,
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid var(--color-border)",
            background: "transparent",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
            fontFamily: "var(--font-body)",
            fontSize: 11,
            fontWeight: 500
          }}
        >
          <Maximize2 size={11} strokeWidth={1.75} />
          Ver completo
        </button>
        <span className="flex-1" />
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          sha={action.hashShort}
        </span>
      </div>
    </article>
  );
}

function CommandCard({ action }: { action: CommandAction }) {
  return (
    <article className="flex flex-col v4-slide-in v4-hoverable" style={{ gap: 8 }}>
      <ActionHeader
        icon={<Terminal size={14} strokeWidth={1.75} />}
        iconColor="var(--color-accent-tertiary)"
        verb="Ejecutando"
        detail={<span style={{ color: "var(--color-accent-tertiary)" }}>{action.cmd.split(" ")[0]}</span>}
        badge={
          action.status === "running" ? (
            <span
              className="inline-flex items-center font-[family-name:var(--font-mono)] font-semibold"
              style={{
                gap: 4,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--color-warning-soft)",
                color: "var(--color-warning)",
                fontSize: 10
              }}
            >
              <Loader size={9} strokeWidth={1.75} style={{ animation: "spin 1.4s linear infinite" }} />
              en curso
            </span>
          ) : action.status === "ok" ? (
            <span
              className="inline-flex items-center font-[family-name:var(--font-mono)] font-bold"
              style={{
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--color-success-soft)",
                color: "var(--color-success)",
                fontSize: 10
              }}
            >
              ok
            </span>
          ) : null
        }
        ts={action.ts}
      />
      <div
        className="flex flex-col"
        style={{
          gap: 2,
          padding: 14,
          borderRadius: 10,
          background: "#0d1117",
          fontFamily: "var(--font-mono)"
        }}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--color-success)" }}>$</span>
          <span style={{ fontSize: 11, color: "#e6edf3" }}>{action.cmd}</span>
        </div>
        {action.output.map((line, i) => (
          <div key={i} className="flex items-center" style={{ gap: 8 }}>
            <span style={{ fontSize: 11, color: "#6e7681" }}>›</span>
            <span style={{ fontSize: 11, color: "#e6edf3" }}>{line}</span>
          </div>
        ))}
        {action.status === "running" ? (
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 8,
              height: 13,
              background: "var(--color-success)",
              animation: "blink 1s steps(2) infinite",
              marginTop: 4
            }}
          />
        ) : null}
      </div>
    </article>
  );
}

function AwaitCard({ action }: { action: AwaitAction }) {
  return (
    <article
      className="flex items-center v4-slide-in v4-hoverable"
      style={{
        gap: 12,
        padding: "12px 14px",
        borderRadius: 10,
        background: "var(--color-warning-soft)",
        border: "1px solid var(--color-warning-border)"
      }}
    >
      <Hand size={16} strokeWidth={1.75} style={{ color: "var(--color-warning)" }} />
      <div className="flex flex-col flex-1 min-w-0" style={{ gap: 2 }}>
        <span
          className="font-[family-name:var(--font-body)] font-semibold"
          style={{ fontSize: 13, color: "var(--color-warning)" }}
        >
          {action.title}
        </span>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-secondary)" }}
        >
          {action.body}
        </span>
      </div>
      <span
        className="font-[family-name:var(--font-mono)]"
        style={{ fontSize: 10, color: "var(--color-warning)" }}
      >
        {action.ts}
      </span>
      <button
        type="button"
        onClick={() => {
          // Scrollea al input del chat para que el operador pueda responder.
          const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="OpenClaw"]');
          if (textarea) {
            textarea.focus();
            textarea.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }}
        className="inline-flex items-center transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        style={{
          gap: 4,
          padding: "6px 12px",
          borderRadius: 6,
          background: "var(--color-warning)",
          color: "var(--color-on-dark-strong)",
          cursor: "pointer",
          fontFamily: "var(--font-body)",
          fontSize: 11,
          fontWeight: 600
        }}
      >
        <ArrowLeft size={11} strokeWidth={2} />
        Ir al chat
      </button>
    </article>
  );
}

/* ============================================================
 * FilesTab — paths únicos que aparecen en lecturas, agrupados
 * ============================================================ */

function FilesTab({ actions }: { actions: Action[] }) {
  const fileMap = useMemo(() => {
    const m = new Map<string, ReadAction[]>();
    for (const a of actions) {
      if (a.kind !== "read") continue;
      const r = a as ReadAction;
      const existing = m.get(r.path) ?? [];
      existing.push(r);
      m.set(r.path, existing);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [actions]);

  const [selected, setSelected] = useState<string | null>(null);
  const activePath = selected ?? fileMap[0]?.[0] ?? null;

  if (fileMap.length === 0) {
    return (
      <EmptyState
        icon={<FolderTree size={28} strokeWidth={1} />}
        title="Sin archivos leídos por el agente"
        body="Cuando el agente OpenClaw lea un archivo (skill read_file, snapshot, runbook lookup), aparecerá acá agrupado por path. La lista se actualiza cada 3s desde /v1/audit-events."
      />
    );
  }

  const activeReads = activePath ? fileMap.find(([p]) => p === activePath)?.[1] ?? [] : [];

  return (
    <div className="flex flex-1 min-h-0">
      <aside
        className="flex flex-col overflow-y-auto"
        style={{
          width: 320,
          flexShrink: 0,
          background: "var(--color-surface)",
          borderRight: "1px solid var(--color-border)",
          padding: "12px 8px"
        }}
      >
        <div
          className="flex items-center"
          style={{ gap: 6, padding: "4px 12px 12px 12px", color: "var(--color-text-tertiary)" }}
        >
          <FolderTree size={12} strokeWidth={1.75} />
          <span
            className="font-[family-name:var(--font-caption)] font-semibold uppercase"
            style={{ fontSize: 10, letterSpacing: 0.6 }}
          >
            Archivos tocados · {fileMap.length}
          </span>
        </div>
        {fileMap.map(([path, reads]) => {
          const isActive = path === activePath;
          return (
            <button
              key={path}
              type="button"
              onClick={() => setSelected(path)}
              className="flex flex-col text-left transition-colors"
              style={{
                gap: 2,
                padding: "8px 12px",
                borderRadius: 6,
                background: isActive ? "var(--color-surface-sunken)" : "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--color-text-primary)",
                marginBottom: 2
              }}
            >
              <span
                className="font-[family-name:var(--font-mono)] truncate"
                style={{
                  fontSize: 12,
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? "var(--color-accent-tertiary)" : "var(--color-text-primary)"
                }}
              >
                {path}
              </span>
              <span
                className="font-[family-name:var(--font-mono)]"
                style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
              >
                {reads.length} {reads.length === 1 ? "lectura" : "lecturas"} · última {reads[reads.length - 1]?.ts}
              </span>
            </button>
          );
        })}
      </aside>
      <div className="flex flex-col flex-1 min-w-0 overflow-y-auto" style={{ padding: 20, gap: 16 }}>
        {activePath ? (
          <>
            <header className="flex items-center" style={{ gap: 8 }}>
              <FileText size={14} strokeWidth={1.75} style={{ color: "var(--color-accent-tertiary)" }} />
              <span
                className="font-[family-name:var(--font-mono)] font-semibold"
                style={{ fontSize: 13, color: "var(--color-text-primary)" }}
              >
                {activePath}
              </span>
              <span className="flex-1" />
              <span
                className="font-[family-name:var(--font-mono)]"
                style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
              >
                {activeReads.length} eventos
              </span>
            </header>
            {activeReads.slice(-8).reverse().map((r) => (
              <ActionCard key={r.id} action={r} />
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ============================================================
 * TerminalTab — tail -f del audit stream
 * ============================================================ */

function TerminalTab({ actions, source }: { actions: Action[]; source: AgentSource }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [actions, paused]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        className="flex items-center"
        style={{
          gap: 12,
          padding: "10px 20px",
          background: "var(--color-surface)",
          borderBottom: "1px solid var(--color-border)"
        }}
      >
        <Terminal size={13} strokeWidth={1.75} style={{ color: "var(--color-text-secondary)" }} />
        <span
          className="font-[family-name:var(--font-mono)] font-semibold"
          style={{ fontSize: 12, color: "var(--color-text-primary)" }}
        >
          tail -f /v1/audit-events
        </span>
        <span
          className="inline-flex items-center font-[family-name:var(--font-mono)]"
          style={{
            gap: 4,
            padding: "2px 8px",
            borderRadius: 9999,
            background:
              source === "live"
                ? "var(--color-success-soft)"
                : source === "error"
                  ? "var(--color-critical-soft)"
                  : "var(--color-warning-soft)",
            color:
              source === "live"
                ? "var(--color-success)"
                : source === "error"
                  ? "var(--color-critical)"
                  : "var(--color-warning)",
            fontSize: 10,
            fontWeight: 600
          }}
        >
          {source === "live"
            ? "● live"
            : source === "error"
              ? "✕ offline"
              : source === "empty"
                ? "○ silent"
                : "…"}
        </span>
        <span className="flex-1" />
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {actions.length} eventos
        </span>
        <button
          type="button"
          onClick={() => setPaused(!paused)}
          className="inline-flex items-center transition-colors hover:bg-[var(--color-surface-sunken)]"
          style={{
            gap: 4,
            padding: "4px 10px",
            borderRadius: 6,
            background: paused ? "var(--color-warning-soft)" : "var(--color-surface-sunken)",
            border: "1px solid var(--color-border)",
            color: paused ? "var(--color-warning)" : "var(--color-text-secondary)",
            cursor: "pointer",
            fontFamily: "var(--font-caption)",
            fontSize: 11,
            fontWeight: 600
          }}
        >
          {paused ? "Reanudar ▶" : "Pausar ⏸"}
        </button>
      </div>
      <div
        ref={scrollRef}
        className="flex flex-col overflow-y-auto"
        style={{
          flex: 1,
          padding: "12px 20px",
          background: "#0d1117",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          gap: 2
        }}
      >
        {actions.length === 0 ? (
          <span style={{ color: "#6e7681", textAlign: "center", padding: 32 }}>
            Sin eventos. Esperando audit stream…
          </span>
        ) : null}
        {actions.map((a) => (
          <TerminalLine key={a.id} action={a} />
        ))}
        {!paused ? (
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 8,
              height: 13,
              background: "var(--color-success)",
              animation: "blink 1s steps(2) infinite",
              marginTop: 4
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function TerminalLine({ action }: { action: Action }) {
  const verb =
    action.kind === "read"
      ? "READ "
      : action.kind === "detect"
        ? "DETECT"
        : action.kind === "http"
          ? "HTTP "
          : action.kind === "diff"
            ? "DIFF "
            : action.kind === "command"
              ? "EXEC "
              : "AWAIT";
  const verbColor =
    action.kind === "detect"
      ? "#f59e0b"
      : action.kind === "http"
        ? "#3b82f6"
        : action.kind === "diff"
          ? "#a78bfa"
          : action.kind === "command"
            ? "#34d399"
            : action.kind === "await"
              ? "#fbbf24"
              : "#8b949e";
  const detail =
    action.kind === "read"
      ? action.path
      : action.kind === "detect"
        ? action.title
        : action.kind === "http"
          ? `${action.method} ${action.url} → ${action.status}`
          : action.kind === "diff"
            ? `${action.path} (+${action.added} -${action.removed})`
            : action.kind === "command"
              ? action.cmd
              : action.title;
  return (
    <div className="flex items-center" style={{ gap: 10 }}>
      <span style={{ color: "#6e7681" }}>{action.ts}</span>
      <span style={{ color: verbColor, fontWeight: 700 }}>{verb}</span>
      <span style={{ color: "#e6edf3" }}>{detail}</span>
    </div>
  );
}

/* ============================================================
 * DiffTab — lista de diffs pendientes con acciones
 * ============================================================ */

function DiffTab({ actions }: { actions: Action[] }) {
  const diffs = useMemo(() => actions.filter((a): a is DiffAction => a.kind === "diff"), [actions]);

  if (diffs.length === 0) {
    return (
      <EmptyState
        icon={<GitPullRequest size={28} strokeWidth={1} />}
        title="Sin diffs pendientes"
        body="Cuando el agente proponga cambios concretos (rotar selector DKIM, ajustar TLS, etc.), aparecerán acá con vista completa de líneas +/− y CTAs de aprobación."
      />
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-y-auto" style={{ padding: 20, gap: 16 }}>
      <header className="flex items-center" style={{ gap: 8 }}>
        <GitPullRequest size={14} strokeWidth={1.75} style={{ color: "var(--color-accent-tertiary)" }} />
        <span
          className="font-[family-name:var(--font-heading)] font-semibold"
          style={{ fontSize: 14, color: "var(--color-text-primary)" }}
        >
          Diffs pendientes
        </span>
        <span
          className="inline-flex items-center font-[family-name:var(--font-mono)] font-bold"
          style={{
            padding: "1px 8px",
            borderRadius: 6,
            background: "var(--color-warning-soft)",
            color: "var(--color-warning)",
            fontSize: 10
          }}
        >
          {diffs.length} {diffs.length === 1 ? "diff" : "diffs"}
        </span>
        <span className="flex-1" />
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          ordenados por timestamp
        </span>
      </header>
      {diffs.map((d) => (
        <ActionCard key={d.id} action={d} />
      ))}
    </div>
  );
}

/* ============================================================
 * TopologyTab — re-render del ReactFlow real
 * ============================================================ */

function TopologyTab() {
  const [data, setData] = useState<OpenClawCanvasPayload["canvas"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      try {
        const payload = await getJson<OpenClawCanvasPayload>(READ_ENDPOINTS.openClawLiveCanvas);
        if (cancelled) return;
        setData(payload.canvas);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Error cargando topología");
      } finally {
        if (!cancelled) timer = window.setTimeout(tick, 5_000);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  if (error && !data) {
    return (
      <EmptyState
        icon={<GitGraph size={28} strokeWidth={1} />}
        title="Topología sin datos"
        body={`No se pudo cargar /v1/openclaw/live-canvas (${error}). Verificá que el gateway esté arriba.`}
      />
    );
  }

  if (!data) {
    return (
      <EmptyState
        icon={<Loader size={28} strokeWidth={1} style={{ animation: "spin 1.4s linear infinite" }} />}
        title="Cargando topología"
        body="Pidiendo /v1/openclaw/live-canvas al gateway…"
      />
    );
  }

  return (
    <div className="flex flex-1 min-h-0" style={{ padding: 16 }}>
      <CanvasFlow canvas={data} selectedId={selectedId} onSelectNode={setSelectedId} />
    </div>
  );
}

/* ============================================================
 * EmptyState helper compartido
 * ============================================================ */

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ flex: 1, gap: 12, padding: 48 }}
    >
      <span style={{ color: "var(--color-text-tertiary)" }}>{icon}</span>
      <span
        className="font-[family-name:var(--font-heading)] font-semibold"
        style={{ fontSize: 14, color: "var(--color-text-secondary)" }}
      >
        {title}
      </span>
      <span
        className="font-[family-name:var(--font-body)]"
        style={{ fontSize: 12, color: "var(--color-text-tertiary)", textAlign: "center", maxWidth: 460, lineHeight: 1.55 }}
      >
        {body}
      </span>
    </div>
  );
}

/* Keyframes (spin, blink, v4-slide-in, v4-hoverable) viven en app/globals.css
   centralizado — no más inyección defensiva desde acá. */

// Suppress unused imports
void classNames;
void CircleCheck;
void ArrowDown;
