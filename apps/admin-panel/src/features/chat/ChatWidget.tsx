import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, Circle, PanelRightClose, Send } from "lucide-react";
import {
  chatClient,
  useChatStream,
  type ChatClientLike,
  type ChatConnection,
  type ChatMessage
} from "../../shared/api/chat-client.ts";
import { cn } from "../../shared/lib/cn.ts";
import { Tooltip } from "../../shared/ui/index.ts";
import { Button, Heading, Pill } from "../../shared/ui/aivora/index.tsx";
import { MarkdownText } from "../../shared/ui/v2/MarkdownText.tsx";

export interface ChatWidgetProps {
  open: boolean;
  onClose: () => void;
  client?: ChatClientLike;
}

export function ChatWidget({ open, onClose, client = chatClient }: ChatWidgetProps) {
  const state = useChatStream(client);
  const [draft, setDraft] = useState("");
  const messagesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    client.connect();
    return () => {
      client.disconnect();
    };
  }, [client, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [open, state.messages, state.streaming]);

  if (!open) {
    return null;
  }

  const sendingDisabled = !draft.trim();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    await client.sendMessage(content);
  }

  return (
    <aside
      aria-label="Chat con OpenClaw"
      className={cn(
        "fixed z-40 flex flex-col bg-[var(--color-surface)] shadow-[var(--shadow-lg)]",
        // base (<640): bottom-sheet full-width, alto ~85dvh, esquinas superiores redondeadas
        "inset-x-0 bottom-0 h-[85dvh] rounded-t-2xl border-t border-[var(--color-border)]",
        // sm+ : panel lateral derecho (desktop actual, intacto)
        "sm:inset-x-auto sm:right-0 sm:bottom-auto sm:top-[var(--topbar-height)] sm:h-[calc(100dvh-var(--topbar-height))] sm:w-[min(100vw,380px)] sm:rounded-none sm:border-l sm:border-t-0"
      )}
    >
      <header className="flex min-h-14 items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <span
          aria-hidden="true"
          className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[12px] border border-[var(--color-border)]"
          style={{ background: "color-mix(in srgb, var(--color-text-primary) 5%, transparent)" }}
        >
          <Bot size={18} strokeWidth={1.7} color="var(--color-text-secondary)" />
        </span>
        <div className="min-w-0 flex-1">
          <Heading level={3} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Chat con OpenClaw
          </Heading>
          <div className="mt-1 flex items-center gap-2">
            <ConnectionPill connection={state.connection} queuedCount={state.queuedCount} />
          </div>
        </div>
        <Tooltip hint="Cerrar chat" side="left">
          <Button
            variant="ghost"
            aria-label="Cerrar chat con OpenClaw"
            onClick={onClose}
            style={{ padding: 0, width: 34, height: 34, borderRadius: 10 }}
          >
            <PanelRightClose size={15} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </Tooltip>
      </header>

      <div
        ref={messagesRef}
        className="flex-1 overflow-y-auto bg-[var(--color-surface-sunken)] px-4 py-4"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <div className="flex min-h-full flex-col justify-end gap-3">
          {state.messages.length === 0 ? (
            <div className="rounded-[14px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
              Sin mensajes en esta sesión.
            </div>
          ) : null}

          {state.messages.map((message) => (
            <MessageBubble key={`${message.role}-${message.msgId}`} message={message} />
          ))}

          {state.streaming ? (
            <div className="flex justify-start">
              <div className="max-w-[92%] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
                {state.streaming.deltaSoFar ? (
                  <MarkdownText fontSize={13} muted>{state.streaming.deltaSoFar}</MarkdownText>
                ) : (
                  <p className="m-0 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">…</p>
                )}
                <span className="mt-2 inline-flex items-center gap-1.5 text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
                  <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
                  escribiendo
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {state.lastError ? (
        <div className="border-t border-[var(--color-warning-border)] bg-[var(--color-warning-soft)] px-4 py-2 text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-warning-fg)]">
          {state.lastError}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <label className="sr-only" htmlFor="openclaw-chat-input">
          Pregúntale a OpenClaw
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="openclaw-chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Pregúntale a OpenClaw..."
            rows={2}
            maxLength={1200}
            className="min-h-[52px] flex-1 resize-none rounded-[12px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-[16px] leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] sm:text-[13px]"
          />
          <Tooltip hint="Enviar mensaje" side="top">
            <Button
              variant="primary"
              type="submit"
              aria-label="Enviar mensaje a OpenClaw"
              disabled={sendingDisabled}
              style={{ padding: 0, width: 38, height: 38, borderRadius: 10 }}
            >
              <Send size={14} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
        <div className="mt-2 flex items-center justify-end text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
          <span>{draft.length}/1200</span>
        </div>
      </form>
    </aside>
  );
}

function ConnectionPill({
  connection,
  queuedCount
}: {
  connection: ChatConnection;
  queuedCount: number;
}) {
  const copy = connectionCopy(connection, queuedCount);
  return (
    <Pill tone={copy.tone}>
      <Circle size={7} fill="currentColor" strokeWidth={0} aria-hidden="true" />
      {copy.label}
    </Pill>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const operator = message.role === "user";
  return (
    <div className={cn("flex", operator ? "justify-end" : "justify-start")}>
      <article
        className={cn(
          "rounded-[14px] border px-3 py-2 text-[13px] leading-relaxed",
          operator
            ? "max-w-[88%] border-[var(--color-accent-soft)] bg-[var(--color-surface)] text-[var(--color-text-primary)]"
            : "max-w-[92%] border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)]"
        )}
      >
        {operator ? (
          <p className="m-0 whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <MarkdownText fontSize={13} muted>{message.content}</MarkdownText>
        )}
        <footer className="mt-1 flex items-center justify-end gap-1.5 text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
          {message.status === "pending" ? <span>Pendiente</span> : null}
          {message.status === "failed" ? <span>Error</span> : null}
          <time dateTime={message.timestamp}>{formatTime(message.timestamp)}</time>
        </footer>
      </article>
    </div>
  );
}

type PillTone = "neutral" | "accent" | "success" | "warning" | "critical" | "warming" | "info";

function connectionCopy(connection: ChatConnection, queuedCount: number): { label: string; tone: PillTone } {
  if (connection === "connected") {
    return {
      label: queuedCount > 0 ? `Conectado · ${queuedCount} en cola` : "Conectado",
      tone: "success"
    };
  }

  if (connection === "reconnecting") {
    return {
      label: queuedCount > 0 ? `Reconectando · ${queuedCount} en cola` : "Reconectando",
      tone: "warning"
    };
  }

  return {
    label: queuedCount > 0 ? `Agente offline · ${queuedCount} en cola` : "Agente offline",
    tone: "critical"
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
