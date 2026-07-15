import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert, Pause, Play, Search, Terminal, Trash2, Wifi, WifiOff } from "lucide-react";

type LogLevel = "info" | "warn" | "error";
type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

type GatewayLogEvent =
  | {
      type: "GATEWAY_LOG_HELLO";
      at: string;
      logPath: string;
      level: LogLevel;
      backlogLines: number;
      tokenRequired: boolean;
    }
  | {
      type: "GATEWAY_LOG_STATUS";
      at: string;
      status: "watching" | "waiting_for_log_file" | "truncated";
      message: string;
    }
  | {
      type: "GATEWAY_LOG";
      ts: string;
      level: LogLevel;
      message: string;
    }
  | {
      type: "ERROR";
      error: string;
      message: string;
    };

interface TerminalLine {
  id: string;
  ts: string;
  level: LogLevel | "system";
  message: string;
}

const STREAM_PATH = "/v1/gateway/logs/stream";
const STREAM_TOKEN = import.meta.env.VITE_GATEWAY_LOG_STREAM_TOKEN || import.meta.env.VITE_DELIVRIX_OPENCLAW_TOKEN || "";
const MAX_LINES = 1_000;

export function GatewayLogTerminal() {
  const [level, setLevel] = useState<LogLevel>("info");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [pausedCount, setPausedCount] = useState(0);
  const pausedRef = useRef(paused);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused) {
      setPausedCount(0);
    }
  }, [paused]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let cancelled = false;
    let attempts = 0;

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };

    function connect() {
      if (cancelled) {
        return;
      }
      setConnection(attempts === 0 ? "connecting" : "reconnecting");
      socket = new WebSocket(gatewayLogStreamUrl(level));

      socket.onopen = () => {
        attempts = 0;
        setConnection("connected");
      };

      socket.onmessage = (message) => {
        try {
          applyEvent(JSON.parse(String(message.data)) as GatewayLogEvent);
        } catch {
          appendSystem("warn", "Evento de log no parseable recibido desde gateway.");
        }
      };

      socket.onclose = () => {
        if (cancelled) {
          return;
        }
        setConnection("offline");
        attempts += 1;
        reconnectTimer = window.setTimeout(connect, Math.min(15_000, attempts * 1_000));
      };

      socket.onerror = () => {
        setConnection("offline");
      };
    }
  }, [level]);

  useEffect(() => {
    if (paused) {
      return;
    }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines, paused]);

  const visibleLines = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return lines;
    }
    return lines.filter((line) => line.message.toLowerCase().includes(needle));
  }, [lines, query]);

  function applyEvent(event: GatewayLogEvent) {
    if (event.type === "GATEWAY_LOG") {
      appendLine({
        id: `${event.ts}-${Math.random().toString(16).slice(2)}`,
        ts: event.ts,
        level: event.level,
        message: event.message
      });
      return;
    }

    if (event.type === "GATEWAY_LOG_HELLO") {
      appendSystem("info", `stream conectado · ${event.logPath} · level=${event.level}`);
      return;
    }

    if (event.type === "GATEWAY_LOG_STATUS") {
      appendSystem(event.status === "truncated" ? "warn" : "info", event.message);
      return;
    }

    appendSystem("error", event.message);
  }

  function appendSystem(tone: LogLevel, message: string) {
    appendLine({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ts: new Date().toISOString(),
      level: tone === "info" ? "system" : tone,
      message
    });
  }

  function appendLine(line: TerminalLine) {
    if (pausedRef.current) {
      setPausedCount((count) => count + 1);
      return;
    }
    setLines((current) => [...current, line].slice(-MAX_LINES));
  }

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ background: "var(--color-always-dark-bg)" }}>
      <div
        className="flex items-center"
        style={{
          gap: 10,
          padding: "10px 14px",
          background: "var(--color-surface)",
          borderBottom: "1px solid var(--color-border)"
        }}
      >
        <Terminal size={14} strokeWidth={1.75} style={{ color: "var(--color-text-secondary)" }} />
        <span
          className="font-[family-name:var(--font-mono)] font-semibold"
          style={{ fontSize: 12, color: "var(--color-text-primary)" }}
        >
          /v1/gateway/logs/stream
        </span>
        <ConnectionPill state={connection} />
        <span className="flex-1" />
        <label
          className="inline-flex items-center"
          style={{ gap: 6, color: "var(--color-text-tertiary)", fontSize: 11 }}
        >
          level
          <select
            value={level}
            onChange={(event) => setLevel(event.target.value as LogLevel)}
            style={{
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--color-border)",
              background: "var(--color-surface)",
              color: "var(--color-text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              padding: "0 8px"
            }}
          >
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </label>
        <div
          className="hidden md:flex items-center"
          style={{
            gap: 6,
            height: 28,
            padding: "0 8px",
            borderRadius: 6,
            border: "1px solid var(--color-border)",
            background: "var(--color-surface)"
          }}
        >
          <Search size={13} strokeWidth={1.75} style={{ color: "var(--color-text-tertiary)" }} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="buscar"
            style={{
              width: 130,
              border: 0,
              outline: "none",
              background: "transparent",
              color: "var(--color-text-primary)",
              fontFamily: "var(--font-body)",
              fontSize: 12
            }}
          />
        </div>
        <IconButton
          title={paused ? "Reanudar stream" : "Pausar stream"}
          onClick={() => setPaused((value) => !value)}
          active={paused}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </IconButton>
        <IconButton title="Limpiar terminal" onClick={() => setLines([])}>
          <Trash2 size={13} />
        </IconButton>
      </div>

      {paused && pausedCount > 0 ? (
        <div
          className="flex items-center"
          style={{
            gap: 8,
            padding: "7px 14px",
            borderBottom: "1px solid var(--color-warning-border)",
            color: "var(--color-warning)",
            background: "var(--color-warning-soft)",
            fontFamily: "var(--font-mono)",
            fontSize: 11
          }}
        >
          <CircleAlert size={13} strokeWidth={1.75} />
          {pausedCount} lineas nuevas pausadas
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-auto"
        style={{
          padding: "14px 16px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          lineHeight: 1.65,
          color: "#d8dee9"
        }}
      >
        {visibleLines.length === 0 ? (
          <div style={{ color: "#7d8590" }}>
            [{new Date().toLocaleTimeString()}] esperando logs del gateway...
          </div>
        ) : (
          visibleLines.map((line) => (
            <div key={line.id} className="whitespace-pre-wrap break-words">
              <span style={{ color: "#7d8590" }}>[{formatTime(line.ts)}]</span>{" "}
              <span style={{ color: colorForLevel(line.level), fontWeight: 700 }}>[{line.level}]</span>{" "}
              <span>{line.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  const connected = state === "connected";
  const color = connected ? "var(--color-success)" : state === "offline" ? "var(--color-critical)" : "var(--color-warning)";
  return (
    <span
      className="inline-flex items-center font-[family-name:var(--font-mono)]"
      style={{
        gap: 5,
        padding: "2px 8px",
        borderRadius: 999,
        background: connected ? "var(--color-success-soft)" : "var(--color-warning-soft)",
        color,
        fontSize: 10,
        fontWeight: 700
      }}
    >
      {connected ? <Wifi size={11} /> : <WifiOff size={11} />}
      {state}
    </span>
  );
}

function IconButton({
  title,
  active,
  onClick,
  children
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="grid place-items-center transition-colors hover:bg-[var(--color-surface-sunken)]"
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        background: active ? "var(--color-warning-soft)" : "var(--color-surface)",
        color: active ? "var(--color-warning)" : "var(--color-text-secondary)",
        cursor: "pointer"
      }}
    >
      {children}
    </button>
  );
}

export function gatewayLogStreamUrl(
  level: LogLevel,
  location: Pick<Location, "protocol" | "host"> = window.location,
  streamToken = STREAM_TOKEN
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const search = new URLSearchParams({ level });
  if (streamToken) {
    search.set("token", streamToken);
  }
  return `${protocol}//${location.host}${STREAM_PATH}?${search.toString()}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function colorForLevel(level: TerminalLine["level"]): string {
  if (level === "error") {
    return "#ff7b72";
  }
  if (level === "warn") {
    return "#f2cc60";
  }
  if (level === "system") {
    return "#79c0ff";
  }
  return "#7ee787";
}
