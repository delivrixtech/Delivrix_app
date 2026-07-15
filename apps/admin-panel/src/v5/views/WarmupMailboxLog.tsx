/**
 * v5 Warmup — historial por buzón (carril C).
 *
 * Panel de detalle que consume GET /v1/mailboxes/:id/events y muestra la línea de tiempo de un buzón:
 * envíos, recepción, placement medido y cambios de estado de la FSM. Además hace surface del DLQ real
 * (envíos dead_lettered/failed) que el dashboard agregado no muestra.
 *
 * Solo lectura. Tolera estado vacío (buzón sin historial) y error del backend con gracia — cuando el
 * endpoint del carril B esté vivo, se llena sin redeploy.
 *
 * Diseño: molde oficial "Aivora" (shared/ui/aivora) — Card radius 18 + hairline, Pill por tono
 * semántico, Eyebrow/Heading/Caption del molde. Color SOLO por tokens var(--color-*). PROHIBIDO
 * v5/components/primitives (B/N): el body/mono que el molde no expone se resuelve con helpers
 * locales token-aware. Todo dato sale del backend (cero mock); loading/error/vacío son honestos.
 */

import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Inbox, Mailbox, Radio, Send, Shuffle, X } from "lucide-react";
import {
  deriveDlqEntries,
  getWarmupMailboxEvents,
  type WarmupMailboxEvent,
  type WarmupMailboxEventsResult
} from "../../shared/api/warmup-mailboxes-client";
import { Caption, Card, Eyebrow, Heading, Pill } from "../../shared/ui/aivora";

const POLL_MS = 30_000;

/* ============================================================
 * Texto del molde — helpers locales token-aware.
 *
 * El molde Aivora no expone un body ni un mono (datos/código/IDs). Estos helpers
 * cubren ese hueco SIN volver a v5/components/primitives (B/N): color/tipografía
 * salen de tokens (text-fg/-muted/-subtle, font-mono, text-critical).
 * ============================================================ */

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function BodyText({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cx("m-0 font-sans text-[13px] leading-[1.5] text-fg-muted", className)}>{children}</p>;
}

function Mono({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cx("font-mono text-[11px] leading-[1.5] text-fg-muted", className)}>{children}</span>;
}

function MonoStrong({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cx("font-mono text-[12px] font-medium leading-[1.4] tabular-nums text-fg", className)}>
      {children}
    </span>
  );
}

/* ============================================================
 * Helpers puros — tono + copy por evento (testeable sin render).
 * ============================================================ */

type EventTone = "success" | "warning" | "critical" | "info" | "neutral";

export function eventTone(event: WarmupMailboxEvent): EventTone {
  if (event.type === "send") {
    switch (event.status) {
      case "sent":
        return "success";
      case "queued":
        return "info";
      case "bounced":
      case "failed":
      case "dead_lettered":
        return "critical";
      default:
        return "neutral";
    }
  }
  if (event.type === "placement") {
    if (event.landedIn === "inbox" || event.landedIn === "tabs") return "success";
    if (event.landedIn === "spam") return "critical";
    if (event.landedIn === "missing") return "warning";
    return "neutral";
  }
  if (event.type === "state_change") {
    if (event.toState === "warm") return "success";
    if (event.toState === "paused") return "warning";
    if (event.toState === "blocked" || event.toState === "quarantined") return "critical";
    return "info";
  }
  if (event.type === "signal") {
    // warmup_signals.kind viaja en status: bounce/complaint = crítico, deferral = warning.
    if (event.status === "bounce" || event.status === "complaint") return "critical";
    if (event.status === "deferral") return "warning";
    return "neutral";
  }
  if (event.type === "receive") return "info";
  if (event.type === "auth") return event.status === "fail" ? "critical" : "neutral";
  return "neutral";
}

/** Etiqueta corta y legible del evento (para el chip de tipo). */
export function eventLabel(event: WarmupMailboxEvent): string {
  switch (event.type) {
    case "send":
      return `envío · ${event.status ?? "?"}`;
    case "signal":
      return `señal · ${event.status ?? "?"}`;
    case "receive":
      return `recepción${event.provider ? ` · ${event.provider}` : ""}`;
    case "placement":
      return `placement${event.landedIn ? ` · ${event.landedIn}` : ""}`;
    case "state_change":
      return `estado · ${event.fromState ?? "?"}→${event.toState ?? "?"}`;
    case "auth":
      return `auth${event.status ? ` · ${event.status}` : ""}`;
    default:
      return event.type;
  }
}

function EventIcon({ type }: { type: string }) {
  const props = { size: 14, strokeWidth: 1.75 } as const;
  if (type === "send") return <Send {...props} />;
  if (type === "signal") return <AlertTriangle {...props} />;
  if (type === "receive") return <Inbox {...props} />;
  if (type === "placement") return <Radio {...props} />;
  if (type === "state_change") return <Shuffle {...props} />;
  return <Mailbox {...props} />;
}

function formatWhen(iso: string): string {
  if (!iso) return "sin fecha";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(iso).toLocaleString("es-CO", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/* ============================================================
 * Hook.
 * ============================================================ */

type LogState =
  | { status: "loading" }
  | { status: "ok"; payload: WarmupMailboxEventsResult }
  | { status: "error"; message: string };

function useMailboxEvents(mailboxId: string): LogState {
  const query = useQuery({
    queryKey: ["v5", "warmup", "mailbox-events", mailboxId],
    queryFn: () => getWarmupMailboxEvents(mailboxId),
    enabled: mailboxId.length > 0,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS / 2
  });

  if (query.isLoading) return { status: "loading" };
  if (query.isError) {
    return {
      status: "error",
      message:
        query.error instanceof Error ? query.error.message : "no se pudo obtener el historial del buzón"
    };
  }
  if (query.data) return { status: "ok", payload: query.data };
  return { status: "loading" };
}

/* ============================================================
 * Componente.
 * ============================================================ */

export function WarmupMailboxLog({
  mailboxId,
  mailbox,
  onClose
}: {
  mailboxId: string;
  mailbox?: string;
  onClose?: () => void;
}) {
  const state = useMailboxEvents(mailboxId);

  return (
    <Card style={{ padding: 20 }} className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Eyebrow>Historial del buzón</Eyebrow>
          <MonoStrong className="text-[13px] text-fg">{mailbox ?? mailboxId}</MonoStrong>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar historial del buzón"
            className="grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-surface-sunken hover:text-fg"
          >
            <X size={15} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      <LogBody state={state} />

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Mono>GET /v1/mailboxes/{mailboxId}/events</Mono>
      </div>
    </Card>
  );
}

function LogBody({ state }: { state: LogState }) {
  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-10 w-full rounded bg-surface-sunken" aria-hidden="true" />
        ))}
        <span className="sr-only">Cargando historial del buzón…</span>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-md bg-warning-soft text-warning"
        >
          <AlertTriangle size={15} strokeWidth={1.75} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <BodyText>El endpoint de historial por buzón todavía no responde. Cuando el carril B lo exponga, esta línea de tiempo se llena sin redeploy.</BodyText>
          <Mono className="break-all">{state.message}</Mono>
        </div>
      </div>
    );
  }
  return <LogLoaded payload={state.payload} />;
}

function LogLoaded({ payload }: { payload: WarmupMailboxEventsResult }) {
  const { events, note } = payload;
  const dlq = useMemo(() => deriveDlqEntries(events), [events]);
  const ordered = useMemo(
    () => [...events].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1)),
    [events]
  );

  if (events.length === 0) {
    return (
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-muted"
        >
          <Mailbox size={15} strokeWidth={1.75} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Heading level={2}>Sin eventos todavía</Heading>
          <BodyText>
            {note
              ? "Las tablas del warmup aún no están disponibles en esta base; el historial se llena cuando el engine registre actividad."
              : "Este buzón no tiene envíos, recepción ni cambios de estado registrados aún."}
          </BodyText>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {dlq.length > 0 ? <DlqBanner entries={dlq} /> : null}

      <ol className="flex flex-col gap-2">
        {ordered.map((event) => (
          <li key={event.id}>
            <EventRow event={event} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function EventRow({ event }: { event: WarmupMailboxEvent }) {
  const tone = eventTone(event);
  return (
    <div className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
      <div
        aria-hidden="true"
        className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-muted"
      >
        <EventIcon type={event.type} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={tone}>{eventLabel(event)}</Pill>
          {event.provider && event.type !== "receive" ? (
            <Caption style={{ fontSize: 11 }}>{event.provider}</Caption>
          ) : null}
          {event.toAddress ? (
            <Caption style={{ fontSize: 11 }}>→ {event.toAddress}</Caption>
          ) : null}
          <Caption style={{ fontSize: 11 }}>{formatWhen(event.occurredAt)}</Caption>
        </div>
        {event.detail ? <BodyText className="text-fg-muted">{event.detail}</BodyText> : null}
        {event.lastError ? (
          <BodyText className="text-critical">{event.lastError}</BodyText>
        ) : null}
        {event.slotKey ? <Mono className="break-all text-fg-subtle">{event.slotKey}</Mono> : null}
      </div>
    </div>
  );
}

/* ============================================================
 * DLQ — surface del warmup_sends dead_lettered/failed.
 * ============================================================ */

function DlqBanner({ entries }: { entries: WarmupMailboxEvent[] }) {
  return (
    <Card
      className="flex items-start gap-3"
      style={{ padding: 16, borderColor: "var(--color-critical-border, var(--color-border-strong))" }}
    >
      <div
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-md bg-critical-soft text-critical"
      >
        <AlertTriangle size={15} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Heading level={2}>Dead-letter queue</Heading>
          <Pill tone="critical">{entries.length}</Pill>
        </div>
        <BodyText>
          Envíos que agotaron reintentos o fallaron de forma terminal (dead_lettered/failed). Requieren
          revisión: no se reintentan solos.
        </BodyText>
      </div>
    </Card>
  );
}
