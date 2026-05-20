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
import { Button, Tooltip } from "../../shared/ui/index.ts";

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
      className="fixed right-0 top-[var(--topbar-height)] z-40 flex h-[calc(100vh-var(--topbar-height))] w-[min(100vw,380px)] flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)]"
    >
      <header className="flex min-h-14 items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-[var(--color-accent-soft)] text-[var(--color-accent-tertiary)]"
        >
          <Bot size={17} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-[14px] font-[family-name:var(--font-heading)] font-semibold text-[var(--color-text-primary)]">
            Chat con OpenClaw
          </h2>
          <div className="mt-1 flex items-center gap-2">
            <ConnectionPill connection={state.connection} queuedCount={state.queuedCount} />
          </div>
        </div>
        <Tooltip hint="Cerrar chat" side="left">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Cerrar chat con OpenClaw"
            onClick={onClose}
          >
            <PanelRightClose size={15} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </Tooltip>
      </header>

      <div
        ref={messagesRef}
        className="flex-1 overflow-y-auto bg-[var(--color-surface-sunken)] px-4 py-4"
      >
        <div className="flex min-h-full flex-col justify-end gap-3">
          {state.messages.length === 0 ? (
            <div className="rounded-[8px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
              Sin mensajes en esta sesión.
            </div>
          ) : null}

          {state.messages.map((message) => (
            <MessageBubble key={`${message.role}-${message.msgId}`} message={message} />
          ))}

          {state.streaming ? (
            <div className="flex justify-start">
              <div className="max-w-[88%] rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] leading-relaxed text-[var(--color-text-primary)]">
                <p className="m-0 whitespace-pre-wrap break-words">{state.streaming.deltaSoFar}</p>
                <span className="mt-2 inline-flex items-center gap-1.5 text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
                  <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent-tertiary)]" />
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
            className="min-h-[52px] flex-1 resize-none rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px] leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)]"
          />
          <Tooltip hint="Enviar mensaje" side="top">
            <Button
              variant="accent"
              size="icon"
              type="submit"
              aria-label="Enviar mensaje a OpenClaw"
              disabled={sendingDisabled}
            >
              <Send size={14} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
        <div className="mt-2 flex items-center gap-2 text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
          <span className="truncate">sessionKey: agent:main:operator</span>
          <span className="flex-1" aria-hidden="true" />
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
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[4px] px-2 py-1 text-[10px] font-[family-name:var(--font-caption)] font-semibold",
        copy.className
      )}
    >
      <Circle size={7} fill="currentColor" strokeWidth={0} aria-hidden="true" />
      {copy.label}
    </span>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const operator = message.role === "user";
  return (
    <div className={cn("flex", operator ? "justify-end" : "justify-start")}>
      <article
        className={cn(
          "max-w-[88%] rounded-[8px] border px-3 py-2 text-[13px] leading-relaxed",
          operator
            ? "border-[var(--color-accent-soft)] bg-[var(--color-surface)] text-[var(--color-text-primary)]"
            : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)]"
        )}
      >
        <p className="m-0 whitespace-pre-wrap break-words">{message.content}</p>
        <footer className="mt-1 flex items-center justify-end gap-1.5 text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
          {message.status === "pending" ? <span>Pendiente</span> : null}
          {message.status === "failed" ? <span>Error</span> : null}
          <time dateTime={message.timestamp}>{formatTime(message.timestamp)}</time>
        </footer>
      </article>
    </div>
  );
}

function connectionCopy(connection: ChatConnection, queuedCount: number) {
  if (connection === "connected") {
    return {
      label: queuedCount > 0 ? `Conectado · ${queuedCount} en cola` : "Conectado",
      className: "bg-[var(--color-success-soft)] text-[var(--color-success-fg)]"
    };
  }

  if (connection === "reconnecting") {
    return {
      label: queuedCount > 0 ? `Reconectando · ${queuedCount} en cola` : "Reconectando",
      className: "bg-[var(--color-warning-soft)] text-[var(--color-warning-fg)]"
    };
  }

  return {
    label: queuedCount > 0 ? `Agente offline · ${queuedCount} en cola` : "Agente offline",
    className: "bg-[var(--color-critical-soft)] text-[var(--color-critical-fg)]"
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
