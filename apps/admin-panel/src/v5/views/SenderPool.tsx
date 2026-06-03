/**
 * v5 Sender Pool — dominios en producción + Wallet operativo + Onboard CTA.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowRight, CheckCircle2, Pause, Plus, Send, Sparkles } from "lucide-react";
import {
  getJson,
  getJsonWithQuery,
  getWarmupRampByDomain,
  pauseWarmupRamp,
  type AuditEventsPayload,
  type WarmupRampStatus
} from "../../shared/api/client";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";
import { computeWalletTransactions, type WalletTx } from "./sender-pool-wallet";
import { staggerContainer, staggerItem } from "../lib/motion";
import {
  Badge,
  Body,
  BodySm,
  Button,
  Caption,
  Card,
  Eyebrow,
  H2,
  H3,
  MonoCode,
  MonoData,
  Pill,
  type PillProps,
  SectionHead
} from "../components/primitives";
import { PageHead } from "./_PageHead";
import { PlacementLivePanel } from "../components/PlacementLivePanel";
import { StartWarmupRampInline } from "../components/StartWarmupRampInline";

const POLL_MS = 15_000;
const CAP_USD = 50;
type PillTone = NonNullable<PillProps["tone"]>;

interface DomainSummary {
  domain: string;
  status: string;
  registrar?: string;
  serverIp?: string | null;
  warmupDayN?: number | null;
  warmupTargetDays?: number;
  emailsSentToday?: number;
  blacklistsClean?: boolean;
  authComplete?: boolean;
  /** Hito 5.12 sub-agente D: ramp activo con subject matcher único. */
  ramp?: {
    rampId: string;
    subjectMatcher: string;
    status?: string;
  } | null;
  /** Hito 5.12 sub-agente C: ramp gradual de warmup en curso. */
  warmupRampActive?: boolean;
}

interface SenderPoolPayload {
  domains: DomainSummary[];
  capacity?: { activeDomains: number; totalDomains: number; plannedDomains: number };
  source?: { kind: "live" | "mock" };
}

function useSenderPool() {
  return useQuery({
    queryKey: ["sender-pool", "status"],
    queryFn: () => getJson<SenderPoolPayload>(READ_ENDPOINTS.senderPoolStatus),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
    retry: false
  });
}

function useWalletTransactions() {
  return useQuery({
    queryKey: ["audit-events", "wallet"],
    queryFn: () => getJsonWithQuery<AuditEventsPayload>(READ_ENDPOINTS.auditEvents, { limit: 50 }),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1
  });
}

export function SenderPoolV5() {
  const pool = useSenderPool();
  const audit = useWalletTransactions();
  const transactions = computeWalletTransactions(audit.data?.events ?? []);
  const spent = transactions.reduce((sum, t) => sum + t.amount, 0);
  const available = CAP_USD - spent;
  const pct = (spent / CAP_USD) * 100;
  const tone = pct >= 95 ? "critical" : pct >= 80 ? "warning" : "success";
  const domains = pool.data?.domains ?? [];
  const noDomains = domains.length === 0;

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <PageHead
          eyebrow="Bloque 10 · Demo viernes"
          title="Sender Pool — dominios en producción."
          body="Cada dominio que envía email por Delivrix vive acá con su warmup, deliverability y health. Onboarding nuevo dispara compra + DNS + SMTP + warmup, todo visible en Canvas Live."
          trailing={
            <Button variant="primary" size="md">
              <Plus size={13} strokeWidth={1.75} />
              Onboard dominio
            </Button>
          }
        />
      </motion.div>

      <motion.div variants={staggerItem} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          <SectionHead
            eyebrow="Producción"
            title="Dominios sender"
            caption={noDomains ? "Sin dominios provisionados aún" : `${domains.length} dominios activos`}
            count={domains.length}
            countTone={noDomains ? "neutral" : "success"}
          />
          {noDomains ? (
            <Card padding="hero" className="flex items-start gap-4">
              <div className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-subtle">
                <Send size={16} strokeWidth={1.75} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <H3>Sender pool aún vacío</H3>
                <BodySm>
                  Cuando OpenClaw aprovisione el primer dominio sender (compra · DNS · SMTP · warmup),
                  aparece acá con su estado de capacity en vivo.
                </BodySm>
                <div className="mt-1 flex items-center gap-2">
                  <Button variant="primary" size="sm">
                    <Plus size={11} strokeWidth={1.75} />
                    Onboard con OpenClaw
                  </Button>
                  <Button variant="ghost" size="sm">
                    Ver flow paso a paso
                    <ArrowRight size={11} strokeWidth={1.75} />
                  </Button>
                </div>
              </div>
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              {domains.map((d) => (
                <div key={d.domain} className="flex flex-col gap-2">
                  <DomainRow d={d} />
                  {d.warmupRampActive === true ? (
                    <WarmupRampPanel domain={d.domain} />
                  ) : (
                    <StartWarmupRampInline domain={d.domain} />
                  )}
                  {d.ramp && d.ramp.subjectMatcher ? (
                    <PlacementLivePanel
                      rampId={d.ramp.rampId}
                      matcher={d.ramp.subjectMatcher}
                      domain={d.domain}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          )}
          <FlowSteps />
        </div>
        <div className="flex flex-col gap-4">
          <WalletCard spent={spent} available={available} pct={pct} tone={tone} transactions={transactions} loading={audit.isLoading} />
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ----- Domain row ----- */

function DomainRow({ d }: { d: DomainSummary }) {
  const statusTone: PillTone =
    d.status === "active"
      ? "success"
      : d.status === "warming"
      ? "warning"
      : d.status === "burned" || d.status === "failed"
      ? "critical"
      : "neutral";
  return (
    <Card padding="default" className="flex items-center gap-4">
      <span
        aria-hidden="true"
        className="inline-block size-1.5 rounded-full"
        style={{
          background:
            statusTone === "success"
              ? "var(--color-success)"
              : statusTone === "warning"
              ? "var(--color-warning)"
              : statusTone === "critical"
              ? "var(--color-critical)"
              : "var(--color-fg-subtle)"
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <MonoData className="text-[13px]">{d.domain}</MonoData>
          {d.authComplete && <CheckCircle2 size={11} className="text-success" strokeWidth={1.75} />}
        </div>
        <Caption>
          {d.registrar ? `${d.registrar} · ` : ""}
          {d.serverIp ? `IP ${d.serverIp}` : "sin IP asignada"}
        </Caption>
      </div>
      <div className="flex items-center gap-2">
        <Pill tone={statusTone} size="sm">
          {d.status}
        </Pill>
        {d.warmupDayN != null && d.warmupTargetDays != null && (
          <Badge>
            día {d.warmupDayN}/{d.warmupTargetDays}
          </Badge>
        )}
      </div>
    </Card>
  );
}

/* ----- Flow steps ----- */

const FLOW = [
  { n: 1, label: "Compra en Route53", caption: "con gates de aprobación" },
  { n: 2, label: "Hosted zone + DNS", caption: "SPF · DKIM · DMARC publicados" },
  { n: 3, label: "Provisionar VPS Webdock", caption: "+ install postfix opendkim TLS" },
  { n: 4, label: "Bind dominio ↔ servidor", caption: "MX + A records firmados" },
  { n: 5, label: "Warmup seed", caption: "3 emails iniciales · 24h grace" }
];

function FlowSteps() {
  return (
    <Card tone="quiet" padding="relaxed" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Sparkles size={12} className="text-fg-subtle" strokeWidth={1.75} />
        <Eyebrow>El flow paso a paso</Eyebrow>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {FLOW.map((s) => (
          <li key={s.n} className="flex items-start gap-3">
            <span className="grid size-5 shrink-0 place-items-center rounded bg-surface text-[10px] font-mono font-semibold tabular-nums text-fg-muted ring-1 ring-border">
              {s.n}
            </span>
            <div className="flex flex-col gap-0.5">
              <MonoData className="text-[12px]">{s.label}</MonoData>
              <Caption>{s.caption}</Caption>
            </div>
          </li>
        ))}
      </ul>
      <Caption className="mt-2 text-[10px] uppercase" style={{ letterSpacing: "0.12em" }}>
        Cada paso queda firmado en audit chain
      </Caption>
    </Card>
  );
}

/* ----- Wallet ----- */

function WalletCard({
  spent,
  available,
  pct,
  tone,
  transactions,
  loading
}: {
  spent: number;
  available: number;
  pct: number;
  tone: "success" | "warning" | "critical";
  transactions: WalletTx[];
  loading: boolean;
}) {
  const pillLabel = tone === "critical" ? "Cap excedido" : tone === "warning" ? "Próximo a cap" : "Saludable";
  return (
    <Card padding="hero" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Eyebrow>Wallet operativo</Eyebrow>
          <H2>Route53 Domains</H2>
        </div>
        <Pill tone={tone} size="sm">
          {pillLabel}
        </Pill>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <WalletStat label="Cap mensual" value={`$${CAP_USD.toFixed(0)}`} />
        <WalletStat label="Gastado" value={`$${spent.toFixed(2)}`} tone={tone} />
        <WalletStat label="Disponible" value={`$${available.toFixed(2)}`} />
      </div>
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
          style={{
            width: `${Math.min(100, Math.max(2, pct))}%`,
            background:
              tone === "critical"
                ? "var(--color-critical)"
                : tone === "warning"
                ? "var(--color-warning)"
                : "var(--color-success)"
          }}
        />
      </div>
      <Eyebrow>Movimientos del mes</Eyebrow>
      {loading ? (
        <Caption>Cargando audit chain…</Caption>
      ) : transactions.length === 0 ? (
        <BodySm className="text-fg-subtle">
          Sin compras este mes. El wallet está intacto. Cuando OpenClaw registre un dominio, aparece acá firmado.
        </BodySm>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {transactions.slice(0, 4).map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-2 text-[11px]">
              <div className="flex min-w-0 flex-col">
                <MonoData className="truncate text-[11px]">{t.domain}</MonoData>
                <Caption className="text-[10px]">{new Date(t.occurredAt).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · {t.actor}</Caption>
              </div>
              <MonoData className="shrink-0 text-warning">−${t.amount.toFixed(2)}</MonoData>
            </li>
          ))}
        </ul>
      )}
      <Caption className="mt-1 text-[10px]">
        Wallet primitivo · S1 trae control granular y multi-wallet.
      </Caption>
    </Card>
  );
}

function WalletStat({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" | "critical" }) {
  const color = tone === "critical" ? "text-critical" : tone === "warning" ? "text-warning" : "text-fg";
  return (
    <div className="flex flex-col gap-1">
      <Eyebrow className="text-[9.5px]">{label}</Eyebrow>
      <MonoData className={`text-[16px] font-semibold tabular-nums ${color}`}>
        {value}
      </MonoData>
    </div>
  );
}

/* ----- Warmup Ramp panel (Bloque 10 · Carril C) ----- */

const RAMP_POLL_MS = 5_000;

function WarmupRampPanel({ domain }: { domain: string }) {
  const queryClient = useQueryClient();
  const [pauseError, setPauseError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["warmup-ramp", domain],
    queryFn: () => getWarmupRampByDomain(domain),
    refetchInterval: RAMP_POLL_MS,
    staleTime: RAMP_POLL_MS / 2,
    enabled: true,
    retry: false
  });

  const ramp: WarmupRampStatus | null | undefined = query.data;
  const pauseMutation = useMutation({
    mutationFn: () => {
      if (!ramp) throw new Error("ramp_unknown");
      return pauseWarmupRamp(ramp.rampId, "operator/panel");
    },
    onSuccess: () => {
      setPauseError(null);
      queryClient.invalidateQueries({ queryKey: ["warmup-ramp", domain] });
    },
    onError: (error) => {
      setPauseError(error instanceof Error ? error.message : "Pause failed.");
    }
  });

  if (query.isLoading) {
    return (
      <Card tone="quiet" padding="default" className="flex items-center gap-2">
        <Caption>Cargando ramp…</Caption>
      </Card>
    );
  }
  if (!ramp) {
    return null;
  }

  const totalPct = ramp.totals.planned === 0
    ? 0
    : Math.min(100, (ramp.totals.sent / ramp.totals.planned) * 100);
  const deliveryPct = (ramp.totals.deliveryRate * 100).toFixed(1);
  const bouncePct = (ramp.totals.bounceRate * 100).toFixed(2);
  const countdown = formatCountdown(ramp.nextBatchAt);
  const isAutoPaused = ramp.state === "auto_paused";
  const isPaused = ramp.state === "paused" || isAutoPaused;
  const isCompleted = ramp.state === "completed";

  return (
    <Card padding="relaxed" className="flex flex-col gap-3" tone={isAutoPaused ? "quiet" : "default"}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <Eyebrow>Warmup ramp · {ramp.schedule}</Eyebrow>
          <MonoData className="text-[12px]">{ramp.rampId}</MonoData>
        </div>
        <Pill tone={rampStateTone(ramp.state)} size="sm">
          {ramp.state}
        </Pill>
      </div>

      {isAutoPaused && (
        <div
          className="flex items-start gap-2 rounded-md p-2"
          style={{
            background: "var(--color-critical-bg, rgba(220,38,38,0.08))",
            border: "1px solid var(--color-critical)"
          }}
        >
          <AlertTriangle size={12} className="text-critical mt-0.5" strokeWidth={1.75} />
          <BodySm>
            Ramp en auto-pausa · razón <code>{ramp.pauseReason ?? "unknown"}</code>. Revisá bounce rate antes de reanudar.
          </BodySm>
        </div>
      )}

      <div className="grid grid-cols-4 gap-3">
        <RampStat
          label="Enviados"
          value={`${ramp.totals.sent}/${ramp.totals.planned}`}
        />
        <RampStat label="Delivery" value={`${deliveryPct}%`} tone={ramp.totals.deliveryRate >= 0.85 ? "success" : "warning"} />
        <RampStat label="Bounce" value={`${bouncePct}%`} tone={ramp.totals.bounceRate > 0.05 ? "critical" : "success"} />
        <RampStat label="Próximo batch" value={countdown} />
      </div>

      <div className="relative h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
          style={{
            width: `${Math.max(2, totalPct)}%`,
            background: isAutoPaused
              ? "var(--color-critical)"
              : isCompleted
                ? "var(--color-success)"
                : "var(--color-warning)"
          }}
        />
      </div>

      <RampSparkline batches={ramp.batches} />

      <div className="flex items-center justify-between gap-2">
        <Caption className="text-[10px]">
          {ramp.batches.filter((b) => b.status === "sent").length}/{ramp.batches.length} batches completados
        </Caption>
        {!isCompleted && !isPaused && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => pauseMutation.mutate()}
            disabled={pauseMutation.isPending}
          >
            <Pause size={11} strokeWidth={1.75} />
            {pauseMutation.isPending ? "Pausando…" : "Pausar ramp"}
          </Button>
        )}
      </div>

      {pauseError && (
        <Caption className="text-critical">{pauseError}</Caption>
      )}
    </Card>
  );
}

function RampStat({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" | "critical" }) {
  const color = tone === "critical" ? "text-critical" : tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-fg";
  return (
    <div className="flex flex-col gap-1">
      <Eyebrow className="text-[9.5px]">{label}</Eyebrow>
      <MonoData className={`text-[13px] font-semibold tabular-nums ${color}`}>
        {value}
      </MonoData>
    </div>
  );
}

/**
 * Sparkline inline SVG (sin Chart.js) que dibuja la curva de calentamiento:
 * eje X = batchIndex, eje Y = emailCount planificado, barras coloreadas según
 * estado del batch.
 */
function RampSparkline({ batches }: { batches: WarmupRampStatus["batches"] }) {
  if (batches.length === 0) {
    return <Caption>Sin batches planificados.</Caption>;
  }
  const W = 280;
  const H = 48;
  const PAD = 4;
  const max = Math.max(...batches.map((b) => b.emailCount));
  const colW = (W - PAD * 2) / batches.length;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      role="img"
      aria-label="Curva de calentamiento del ramp"
      style={{ display: "block" }}
    >
      {batches.map((batch, idx) => {
        const x = PAD + idx * colW + 1;
        const h = max === 0 ? 0 : ((batch.emailCount / max) * (H - PAD * 2));
        const y = H - PAD - h;
        const fill = batch.status === "sent"
          ? "var(--color-success)"
          : batch.status === "failed"
            ? "var(--color-critical)"
            : batch.status === "running"
              ? "var(--color-warning)"
              : "var(--color-fg-subtle)";
        return (
          <g key={batch.batchIndex}>
            <rect
              x={x}
              y={y}
              width={Math.max(2, colW - 2)}
              height={Math.max(2, h)}
              rx={1}
              fill={fill}
              opacity={batch.status === "pending" ? 0.35 : 0.9}
            />
          </g>
        );
      })}
    </svg>
  );
}

function rampStateTone(state: WarmupRampStatus["state"]): "success" | "warning" | "critical" | "neutral" {
  switch (state) {
    case "running":
      return "warning";
    case "completed":
      return "success";
    case "auto_paused":
    case "failed":
      return "critical";
    case "paused":
    default:
      return "neutral";
  }
}

function formatCountdown(iso: string | undefined): string {
  if (!iso) return "—";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "—";
  const deltaMs = target - Date.now();
  if (deltaMs <= 0) return "ahora";
  const totalSec = Math.floor(deltaMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${String(sec).padStart(2, "0")}s`;
}
