/**
 * PlacementLivePanel — placement-check telemetry para un ramp activo.
 *
 * Hito 5.12 sub-agente D · panel del SenderPool que muestra inbox vs spam
 * para un subject matcher único `[delivrix-...]`. Llama POST a
 * /v1/openclaw/skills/placement-check cada 30s (useQuery refetchInterval).
 *
 * Reglas:
 *  - El App Password jamás vive en el frontend; backend usa GMAIL_IMAP_APP_PASSWORD.
 *  - Loading: "esperando indexación 0/3 · reintento en 30s".
 *  - Empty (matched=0): "Sin emails todavía. Gmail puede tardar 5-30s en indexar."
 *  - Lista 5 samples con folder pill + subject truncado.
 *  - Última lectura IMAP hace Xs + query elapsedMs.
 *
 * MOLDE: superficie Aivora (card radius 18 + hairline + shadow), tipografía sans del demo.
 */
import type { CSSProperties, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  postPlacementCheck,
  type PlacementCheckResult,
  type PlacementSample
} from "../../shared/api/client";
import { Card, Caption, Eyebrow, Heading, Pill } from "../../shared/ui/aivora";

const REFETCH_MS = 30_000;
const ACTOR_ID = "panel/placement-live";

/* ----- helpers de texto (tokens del demo, sin primitivos v5 B/N) ----- */

function BodySm({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--color-text-secondary)", ...style }}>{children}</p>;
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        padding: "1px 6px",
        fontSize: 11,
        fontWeight: 500,
        fontVariantNumeric: "tabular-nums",
        color: "var(--color-text-secondary)"
      }}
    >
      {children}
    </span>
  );
}

export interface PlacementLivePanelProps {
  rampId?: string;
  matcher: string;
  domain: string;
  windowMinutes?: number;
}

export function PlacementLivePanel({
  rampId,
  matcher,
  domain,
  windowMinutes = 30
}: PlacementLivePanelProps) {
  const enabled = Boolean(matcher) && matcher.trim().length > 0;
  const query = useQuery<PlacementCheckResult>({
    queryKey: ["placement-check", matcher],
    queryFn: () =>
      postPlacementCheck({
        matchBy: "subject",
        matcher,
        windowMinutes,
        actorId: ACTOR_ID,
        rampId
      }),
    refetchInterval: REFETCH_MS,
    staleTime: REFETCH_MS / 2,
    enabled,
    retry: 1
  });

  // IMAP es OPCIONAL. Si el backend reporta que IMAP no está configurado
  // (operador NO seteó GMAIL_IMAP_*), el panel no se renderiza — el
  // operador puede mirar su Gmail directamente en otra pestaña sin la
  // capa IMAP en medio. El feature queda implementado para automatización
  // futura, pero NO se exige para correr warmup.
  const errMsg = query.error instanceof Error ? query.error.message : "";
  const imapNotConfigured =
    errMsg.includes("imap_disabled") || errMsg.includes("imap_credentials_missing");
  if (imapNotConfigured) {
    return null;
  }

  const data = query.data;
  const matched = data?.matched ?? 0;
  const inbox = data?.inbox ?? 0;
  const spam = data?.spam ?? 0;
  const promotions = data?.promotions ?? 0;
  const lastReadAt = data?.meta.queriedAt ?? null;
  const elapsedMs = data?.meta.elapsedMs ?? null;

  return (
    <Card className="flex flex-col gap-4" style={{ padding: 24 }}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Eyebrow>Placement live · Gmail IMAP</Eyebrow>
          <Heading level={3}>{domain}</Heading>
          <Caption style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10.5 }}>{matcher}</Caption>
        </div>
        <PlacementHeaderPill matched={matched} loading={query.isFetching && !data} />
      </header>

      {!enabled ? (
        <BodySm style={{ color: "var(--color-text-tertiary)" }}>
          Sin matcher activo. Cuando el ramp esté corriendo, aparece acá.
        </BodySm>
      ) : query.isLoading && !data ? (
        <BodySm style={{ color: "var(--color-text-tertiary)" }}>
          esperando indexación 0/3 · reintento en 30s
        </BodySm>
      ) : query.isError ? (
        <BodySm style={{ color: "var(--color-critical)" }}>
          {(query.error as Error | undefined)?.message ?? "Error consultando IMAP."}
        </BodySm>
      ) : matched === 0 ? (
        <BodySm style={{ color: "var(--color-text-tertiary)" }}>
          Sin emails todavía. Gmail puede tardar 5-30s en indexar.
        </BodySm>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <ProgressRow label="INBOX" count={inbox} total={matched} tone="success" />
            <ProgressRow label="SPAM" count={spam} total={matched} tone="critical" />
            {promotions > 0 ? (
              <div className="flex items-center justify-between gap-2">
                <Caption>Promotions</Caption>
                <Badge>{promotions} de {matched}</Badge>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Eyebrow>Últimos {Math.min(5, data?.samples.length ?? 0)} samples</Eyebrow>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {(data?.samples ?? []).slice(0, 5).map((sample) => (
                <SampleRow key={sample.uid} sample={sample} />
              ))}
            </ul>
          </div>
        </>
      )}

      <Caption style={{ fontSize: 10 }}>
        Última lectura IMAP {formatLastRead(lastReadAt)}
        {elapsedMs != null ? ` · query ${elapsedMs}ms` : ""}
      </Caption>
    </Card>
  );
}

function PlacementHeaderPill({ matched, loading }: { matched: number; loading: boolean }) {
  if (loading) {
    return <Pill tone="neutral">cargando</Pill>;
  }
  if (matched === 0) {
    return <Pill tone="neutral">{matched} matched</Pill>;
  }
  return <Pill tone="info">{matched} matched</Pill>;
}

function ProgressRow({
  label,
  count,
  total,
  tone
}: {
  label: string;
  count: number;
  total: number;
  tone: "success" | "critical";
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const barColor =
    tone === "success" ? "var(--color-success)" : "var(--color-critical)";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        <span className="text-[12px] font-semibold tabular-nums text-fg">
          {count}/{total}
        </span>
      </div>
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
          style={{
            width: `${Math.min(100, Math.max(2, pct))}%`,
            background: barColor
          }}
        />
      </div>
    </div>
  );
}

function SampleRow({ sample }: { sample: PlacementSample }) {
  const tone =
    sample.folder === "inbox"
      ? "success"
      : sample.folder === "spam"
      ? "critical"
      : sample.folder === "promotions"
      ? "warning"
      : "neutral";
  const label =
    sample.folder === "inbox"
      ? "INBOX"
      : sample.folder === "spam"
      ? "SPAM"
      : sample.folder === "promotions"
      ? "PROMO"
      : "OTHER";
  return (
    <li className="flex items-center gap-2 text-[12px]">
      <Pill tone={tone}>{label}</Pill>
      <span className="min-w-0 flex-1 truncate font-sans text-fg">
        {sample.subject || "(sin asunto)"}
      </span>
    </li>
  );
}

function formatLastRead(iso: string | null): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `hace ${hours}h`;
}
