/**
 * v5 Sender Pool — dominios en producción + Wallet operativo + Onboard CTA.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Download, FileDown, Flame, KeyRound, Pause, Search, Send, Workflow } from "lucide-react";
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
// MOLDE ÚNICO Aivora — cards radius 18 + hairline + shadow, KpiCard, StateBadge, Spark,
// SectionHead h1 light, y las piezas compartidas (Button/Pill/Eyebrow/Caption/Heading) que
// reemplazan a los primitivos v5 B/N (sin sombras/gradientes).
import {
  Button,
  Caption,
  Card,
  Eyebrow,
  Heading,
  KpiCard,
  Pill,
  SectionHead,
  Spark,
  StateBadge,
  stateColor,
  stateNeedsLeftBorder
} from "../../shared/ui/aivora";
import { WarmupOnboardSelector } from "./WarmupOnboardSelector";
import { PlacementLivePanel } from "../components/PlacementLivePanel";
import { StartWarmupRampInline } from "../components/StartWarmupRampInline";
import { useOpenClawIntent, useToast } from "../../shared/ui/v2";
import {
  downloadSmtpCredential,
  responseErrorMessage,
  triggerDownload
} from "../../shared/api/smtp-credentials";
import { buildEnableSmtpAuthIntent } from "./sender-pool-intents";
import { RealtimeTick, SkeletonKpiCard, SkeletonRow, StaleBadge } from "../../shared/ui/realtime";
import type { CSSProperties, ReactNode } from "react";

const POLL_MS = 15_000;
const CAP_USD = 50;
/** Ventana rolling que define un dominio "recién creado". */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Tono semántico compartido con el Pill de Aivora. */
type PillTone = "neutral" | "accent" | "success" | "warning" | "critical" | "warming" | "info";

/* ----- helpers de texto (tokens del demo, sin primitivos v5 B/N) ----- */

function BodySm({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <p className={className} style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--color-text-secondary)", ...style }}>{children}</p>;
}

function MonoData({ children, className, style, title }: { children: ReactNode; className?: string; style?: CSSProperties; title?: string }) {
  return <span className={className} title={title} style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, fontWeight: 500, fontVariantNumeric: "tabular-nums", color: "var(--color-text-primary)", ...style }}>{children}</span>;
}

/**
 * Cifra Inter tabular (§2/§C del documento: mono SOLO en timestamps/IDs/código —
 * montos, porcentajes y conteos van en Inter con números tabulares, no en mono).
 */
function StatNum({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <span className={className} style={{ fontVariantNumeric: "tabular-nums", color: "var(--color-text-primary)", ...style }}>{children}</span>;
}

function Badge({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface)", padding: "1px 6px", fontSize: 11, fontWeight: 500, fontVariantNumeric: "tabular-nums", color: "var(--color-text-secondary)", ...style }}
    >
      {children}
    </span>
  );
}

interface DomainSummary {
  domain: string;
  status: string;
  registrar?: string;
  serverSlug?: string | null;
  serverIp?: string | null;
  hasCredential?: boolean;
  smtpCredential?: SmtpCredentialMetadata | null;
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
  /** PR-07: timestamp de registro (ISO) para orden cronológico / partición reciente. */
  registeredAt?: string | null;
  /** PR-07: causa textual del fallo (dominios en needs_reconciliation). */
  errorMessage?: string | null;
}

interface SmtpCredentialMetadata {
  domain: string;
  serverSlug?: string | null;
  host: string;
  username: string;
  status: "pending_install" | "configured" | "install_failed";
  ports: {
    submission: 587;
    smtps: 465;
  };
  createdAt: string;
  updatedAt: string;
  hasCredential: boolean;
}

interface SenderPoolPayload {
  domains: DomainSummary[];
  capacity?: { activeDomains: number; totalDomains: number; plannedDomains: number };
  source?: { kind: "live" | "mock" };
  /** PR-07: reloj del server, usado como "ahora" para el divisor de 24h. */
  generatedAt?: string;
}

/** Epoch (ms) del dominio para ordenar / particionar; null si no hay fecha parseable. */
function domainTimestampMs(d: DomainSummary): number | null {
  const raw = d.registeredAt ?? d.smtpCredential?.createdAt ?? null;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Particiona la flota en "recientes" (registrados dentro de las últimas 24h
 * respecto al reloj del server) y el "resto". Orden defensivo desc por
 * timestamp (nulos al final) por si el contrato viejo llega sin ordenar.
 */
function partitionByRecency(
  domains: DomainSummary[],
  nowMs: number
): { recent: DomainSummary[]; rest: DomainSummary[] } {
  const sorted = [...domains].sort((a, b) => {
    const ta = domainTimestampMs(a);
    const tb = domainTimestampMs(b);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  });
  const recent: DomainSummary[] = [];
  const rest: DomainSummary[] = [];
  for (const d of sorted) {
    const ts = domainTimestampMs(d);
    if (ts !== null && nowMs - ts <= RECENT_WINDOW_MS && ts <= nowMs) {
      recent.push(d);
    } else {
      rest.push(d);
    }
  }
  return { recent, rest };
}

/** "hace Xh" / "hace Xm" para el badge de dominios recientes. */
function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "recién";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min}m`;
  const h = Math.floor(min / 60);
  return `hace ${h}h`;
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
  const { toast } = useToast();
  const pool = useSenderPool();
  const audit = useWalletTransactions();
  const transactions = computeWalletTransactions(audit.data?.events ?? []);
  const spent = transactions.reduce((sum, t) => sum + t.amount, 0);
  const available = CAP_USD - spent;
  const pct = (spent / CAP_USD) * 100;
  const tone = pct >= 95 ? "critical" : pct >= 80 ? "warning" : "success";
  const domains = pool.data?.domains ?? [];
  // Distinguir los tres estados: carga inicial, fallo de red, y pool realmente vacío.
  // Sólo tratamos como loading/error cuando NO hay datos cacheados — si un refetch de
  // fondo falla pero ya teníamos data, la conservamos y avisamos con StaleBadge (no
  // borramos la flota ni disfrazamos el fallo de "pool vacío").
  const poolLoading = pool.isLoading && !pool.data;
  const poolError = pool.isError && !pool.data;
  const noDomains = !poolLoading && !poolError && domains.length === 0;
  const hasDomains = !poolLoading && !poolError && domains.length > 0;
  const poolErrorMessage =
    pool.error instanceof Error ? pool.error.message : "No se pudo leer el estado del sender pool.";
  // KPIs desde datos REALES del pool (sin deltas ni series inventadas).
  const activeCount = domains.filter((d) => d.status === "active").length;
  const warmingCount = domains.filter((d) => d.status === "warming" || d.warmupRampActive === true).length;
  const credCount = domains.filter((d) => d.hasCredential === true).length;
  // Reloj del server para el divisor de 24h (evita parpadeo por skew de cliente).
  const generatedAtMs = pool.data?.generatedAt ? Date.parse(pool.data.generatedAt) : NaN;
  const nowMs = Number.isFinite(generatedAtMs) ? generatedAtMs : Date.now();
  const { recent, rest } = partitionByRecency(domains, nowMs);
  const staleMinutes = pool.dataUpdatedAt
    ? Math.max(0, Math.floor((Date.now() - pool.dataUpdatedAt) / 60_000))
    : 0;
  const exportCredentials = useMutation({
    mutationFn: exportSmtpCredentialInventory,
    onSuccess: (count) => {
      toast.success("Inventario exportado", {
        description: `${count} credenciales SMTP sin secretos.`
      });
    },
    onError: (error) => {
      toast.error("No se pudo exportar", {
        description: error instanceof Error ? error.message : "Revisá gateway/read-boundary."
      });
    }
  });

  // Fila expandible: solo el dominio elegido despliega su warmup/placement — evita el
  // scroll infinito de renderizar el formulario de warmup para los 55 dominios a la vez.
  const [openDomain, setOpenDomain] = useState<string | null>(null);
  const toggleDomain = (domain: string) =>
    setOpenDomain((cur) => (cur === domain ? null : domain));
  // El onboard masivo (segunda lista con checkboxes) va COLAPSADO por defecto para no
  // alargar la página con un segundo listado de los 55 dominios.
  const [onboardOpen, setOnboardOpen] = useState(false);

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <SectionHead
          eyebrow="Pipeline de envío"
          title="Sender Pool — dominios en producción."
          subtitle="Cada dominio que envía email por Delivrix vive acá con su warmup, deliverability y health. Onboarding nuevo dispara compra + DNS + SMTP + warmup, todo visible en Canvas Live."
          right={
            <div className="flex items-center gap-3">
              <RealtimeTick active={pool.isFetching} />
              {staleMinutes >= 1 ? <StaleBadge minutesAgo={staleMinutes} /> : null}
              <Button
                variant="ghost"
                size="md"
                onClick={() => exportCredentials.mutate()}
                disabled={exportCredentials.isPending || !hasDomains}
              >
                <FileDown size={13} strokeWidth={1.75} />
                {exportCredentials.isPending ? "Exportando" : "Exportar"}
              </Button>
            </div>
          }
        />
      </motion.div>

      <motion.div variants={staggerItem} className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        {poolLoading ? (
          <>
            <SkeletonKpiCard className="!w-full" />
            <SkeletonKpiCard className="!w-full" />
            <SkeletonKpiCard className="!w-full" />
            <SkeletonKpiCard className="!w-full" />
          </>
        ) : poolError ? (
          <>
            <KpiCard label="Dominios" value="—" icon={Send} />
            <KpiCard label="Activos" value="—" icon={CheckCircle2} />
            <KpiCard label="Calentando" value="—" icon={Flame} />
            <KpiCard label="Con credencial" value="—" icon={KeyRound} />
          </>
        ) : (
          <>
            <KpiCard label="Dominios" value={domains.length} icon={Send} />
            <KpiCard label="Activos" value={activeCount} icon={CheckCircle2} />
            <KpiCard label="Calentando" value={warmingCount} icon={Flame} />
            <KpiCard label="Con credencial" value={credCount} icon={KeyRound} />
          </>
        )}
      </motion.div>

      {/* Tabla de dominios — ANCHO COMPLETO, paginada, con búsqueda. Un solo scroll. */}
      <motion.div variants={staggerItem}>
        {poolLoading ? (
          <Card className="flex flex-col gap-2" style={{ padding: 16 }}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </Card>
        ) : poolError ? (
          <PoolErrorCard
            message={poolErrorMessage}
            onRetry={() => pool.refetch()}
            retrying={pool.isFetching}
          />
        ) : noDomains ? (
          <Card className="flex items-start gap-4" style={{ padding: 24 }}>
            <div
              className="grid size-10 shrink-0 place-items-center rounded-md text-fg-subtle"
              style={{ background: "var(--color-surface-sunken)" }}
            >
              <Send size={16} strokeWidth={1.75} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Heading level={3}>Sender pool aún vacío</Heading>
              <BodySm>
                Cuando OpenClaw aprovisione el primer dominio sender (compra · DNS · SMTP · warmup),
                aparece acá con su estado de capacity en vivo.
              </BodySm>
            </div>
          </Card>
        ) : (
          <DomainTable
            recent={recent}
            rest={rest}
            nowMs={nowMs}
            openDomain={openDomain}
            onToggle={toggleDomain}
          />
        )}
      </motion.div>

      {/* Onboard masivo — barra colapsable a ANCHO COMPLETO (no se estira; sin card negra vacía) */}
      <motion.div variants={staggerItem}>
        {!hasDomains ? (
          <FlowSteps />
        ) : onboardOpen ? (
          <div className="flex flex-col gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOnboardOpen(false)} style={{ alignSelf: "flex-start" }}>
              <ChevronDown size={13} strokeWidth={2} style={{ transform: "rotate(180deg)" }} />
              Ocultar onboard masivo
            </Button>
            <WarmupOnboardSelector recent={recent} rest={rest} />
          </div>
        ) : (
          <Card
            onClick={() => setOnboardOpen(true)}
            className="flex cursor-pointer items-center justify-between gap-3"
            style={{ padding: "16px 20px" }}
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-md text-fg-subtle" style={{ background: "var(--color-surface-sunken)" }}>
                <Flame size={16} strokeWidth={1.75} />
              </div>
              <div className="flex min-w-0 flex-col">
                <Heading level={3}>Warmup masivo · onboard al mesh</Heading>
                <Caption>Calentar varios buzones a la vez (idempotente) · {recent.length + rest.length} disponibles</Caption>
              </div>
            </div>
            <ChevronDown size={16} strokeWidth={2} className="shrink-0 text-fg-subtle" />
          </Card>
        )}
      </motion.div>

      {/* Wallet — card compacta de presupuesto (no ocupa todo el ancho) */}
      <motion.div variants={staggerItem} className="max-w-[460px]">
        <WalletCard
          spent={spent}
          available={available}
          pct={pct}
          tone={tone}
          transactions={transactions}
          loading={audit.isLoading}
          error={audit.isError}
        />
      </motion.div>
    </motion.div>
  );
}

/* ----- Estado de error del pool (≠ empty state · fallo de red honesto) ----- */

function PoolErrorCard({
  message,
  onRetry,
  retrying
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <Card
      className="flex items-start gap-4"
      style={{
        padding: 24,
        // Estado malo = left-border 2px (demo), sin inundar la card con relleno semántico.
        borderLeft: `2px solid ${stateColor("quarantined")}`
      }}
    >
      <div
        className="grid size-10 shrink-0 place-items-center rounded-md"
        style={{ background: "var(--color-critical-soft)", color: "var(--color-critical)" }}
      >
        <AlertTriangle size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Heading level={3}>No se pudo leer el sender pool</Heading>
        <BodySm>
          El GET a <code>senderPoolStatus</code> falló, así que no hay flota que mostrar. Esto NO
          significa que el pool esté vacío — es un fallo de lectura. Reintentá o revisá el gateway.
        </BodySm>
        <MonoData className="truncate" style={{ fontSize: 11, color: "var(--color-critical)" }} title={message}>
          {message}
        </MonoData>
        <div className="mt-1">
          <Button variant="ghost" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? "Reintentando…" : "Reintentar"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ----- Group head (divisor de sub-lista, escala card-header del demo) ----- */

function GroupHead({
  eyebrow,
  title,
  count,
  tone
}: {
  eyebrow: string;
  title: string;
  count: number;
  tone: "accent" | "neutral";
}) {
  return (
    <div className="flex items-center justify-between gap-3 pt-1">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Eyebrow>{eyebrow}</Eyebrow>
        <Caption style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</Caption>
      </div>
      <Pill tone={tone}>{count}</Pill>
    </div>
  );
}

/* ----- Domain block (row + warmup/placement panels) ----- */

/**
 * Grid de la tabla de dominios. En < md se oculta la columna secundaria
 * "Proveedor · IP" (ver celdas con `hidden md:block`) y el grid cae a 3 tracks
 * (Dominio · Estado · Acciones) para no aplastar ni desbordar en móvil. En md+
 * se restaura el layout desktop canónico de 4 columnas.
 */
const DOMAIN_GRID_COLS =
  "grid-cols-[minmax(0,2.6fr)_auto_auto] md:grid-cols-[minmax(0,2.6fr)_minmax(0,1.8fr)_auto_auto]";
const DOMAINS_PER_PAGE = 10;

/* Tabla de dominios full-width: toolbar (título + búsqueda) + header de columnas +
 * página de N filas + paginación. UN SOLO scroll (la página) — nada de scroll interno.
 * Recién-creados primero (badge "Nuevo"). Solo el dominio expandido despliega su
 * warmup/placement a lo ancho (master-detail). */
function DomainTable({
  recent, rest, nowMs, openDomain, onToggle,
}: {
  recent: DomainSummary[]; rest: DomainSummary[]; nowMs: number;
  openDomain: string | null; onToggle: (domain: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const all = [
    ...recent.map((d) => ({ d, hot: true })),
    ...rest.map((d) => ({ d, hot: false })),
  ];
  const q = query.trim().toLowerCase();
  const filtered = q
    ? all.filter((x) => x.d.domain.toLowerCase().includes(q) || (x.d.serverIp ?? "").toLowerCase().includes(q))
    : all;
  const pages = Math.max(1, Math.ceil(filtered.length / DOMAINS_PER_PAGE));
  const clamped = Math.min(page, pages - 1);
  const start = clamped * DOMAINS_PER_PAGE;
  const shown = filtered.slice(start, start + DOMAINS_PER_PAGE);
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      {/* Toolbar: título + búsqueda */}
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        style={{ padding: "16px 18px", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <Heading level={3}>Dominios del pool</Heading>
          <Caption>
            {filtered.length} {filtered.length === 1 ? "dominio" : "dominios"}
            {q ? ` · filtrando "${query}"` : ""}
          </Caption>
        </div>
        <label
          className="flex items-center gap-2"
          style={{ width: 270, maxWidth: "100%", borderRadius: 999, padding: "8px 13px", background: "var(--color-surface-sunken)", border: "1px solid var(--color-border)" }}
        >
          <Search size={14} strokeWidth={1.75} className="shrink-0 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            placeholder="Buscar dominio o IP…"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle"
            style={{ color: "var(--color-text-primary)" }}
          />
        </label>
      </div>
      {/* Header de columnas */}
      <div
        className={`grid items-center gap-3 ${DOMAIN_GRID_COLS}`}
        style={{ padding: "9px 18px", borderBottom: "1px solid var(--color-border)" }}
      >
        <Eyebrow style={{ fontSize: 10 }}>Dominio</Eyebrow>
        <div className="hidden min-w-0 md:block">
          <Eyebrow style={{ fontSize: 10 }}>Proveedor · IP</Eyebrow>
        </div>
        <Eyebrow style={{ fontSize: 10, textAlign: "right" }}>Estado</Eyebrow>
        <Eyebrow style={{ fontSize: 10, textAlign: "right" }}>Acciones</Eyebrow>
      </div>
      {/* Filas de la página */}
      {shown.length === 0 ? (
        <div style={{ padding: "30px 18px", textAlign: "center" }}>
          <Caption>Sin dominios que coincidan con "{query}".</Caption>
        </div>
      ) : (
        shown.map(({ d, hot }) => {
          const expanded = openDomain === d.domain;
          return (
            <div key={d.domain}>
              <DomainRow d={d} nowMs={nowMs} hot={hot} expanded={expanded} onToggle={() => onToggle(d.domain)} />
              {expanded ? (
                <div
                  className="flex flex-col gap-2"
                  style={{ padding: "8px 18px 16px", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-sunken)" }}
                >
                  {d.warmupRampActive === true ? (
                    <WarmupRampPanel domain={d.domain} />
                  ) : (
                    <StartWarmupRampInline domain={d.domain} />
                  )}
                  {d.ramp && d.ramp.subjectMatcher ? (
                    <PlacementLivePanel rampId={d.ramp.rampId} matcher={d.ramp.subjectMatcher} domain={d.domain} />
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      )}
      {/* Paginación */}
      {pages > 1 ? (
        <div className="flex items-center justify-between gap-3" style={{ padding: "11px 18px" }}>
          <Caption>
            {start + 1}–{Math.min(start + DOMAINS_PER_PAGE, filtered.length)} de {filtered.length}
          </Caption>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={clamped === 0}
              onClick={() => setPage(clamped - 1)}
              title="Anterior"
              className="grid size-7 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-[var(--color-surface-raised)] hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft size={15} strokeWidth={2} />
            </button>
            <Caption>{clamped + 1} / {pages}</Caption>
            <button
              type="button"
              disabled={clamped >= pages - 1}
              onClick={() => setPage(clamped + 1)}
              title="Siguiente"
              className="grid size-7 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-[var(--color-surface-raised)] hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight size={15} strokeWidth={2} />
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/* ----- Domain row ----- */

/**
 * Mapea el estado REAL del dominio a una clave del STATE_MAP de StateBadge (molde
 * Aivora). Directo desde d.status —sin colapsar por un tono intermedio— para que
 * el ícono §4 no mienta: flame/cyan (WARMING) queda reservado SOLO al warmup
 * activo; pending/smtp-auth-pending leen como READY (circle-dot neutro, sin
 * flame); burned = BLOCKED (ban, muerto-conocido) y needs_reconciliation/failed =
 * QUARANTINED (shield-alert, decidir ya). El label muestra el status real.
 */
function domainBadgeStatus(d: DomainSummary): string {
  // La llama/cyan con pulso (WARMING) es EXCLUSIVA de un warmup GENUINAMENTE en
  // curso: status "warming" O rampa activa. Mismo criterio que el KPI de
  // "calentando" (warmingCount) y que el WarmupRampPanel que se abre debajo.
  if (d.status === "warming" || d.warmupRampActive === true) return "warming";
  const credFailed = d.smtpCredential?.status === "install_failed";
  switch (d.status) {
    case "active":
      return "active"; // success + circle-check
    case "burned":
      return "BLOCKED"; // ban — muerto-conocido, chip frío
    case "failed":
    case "needs_reconciliation":
      return "quarantined"; // shield-alert — anomalía accionable
    case "pending":
    case "smtp-auth-pending":
      return "READY"; // circle-dot neutro — en cola, sin flame
    default:
      return credFailed ? "quarantined" : "unknown";
  }
}

function DomainRow({ d, nowMs, hot = false, expanded, onToggle }: { d: DomainSummary; nowMs: number; hot?: boolean; expanded?: boolean; onToggle?: () => void }) {
  const { toast } = useToast();
  const { sendIntent } = useOpenClawIntent();
  const [downloading, setDownloading] = useState(false);
  const badgeKey = domainBadgeStatus(d);
  const ts = domainTimestampMs(d);
  const ageLabel = hot && ts !== null ? formatAge(nowMs - ts) : null;
  // Left-border reservado a estados "malos" (demo) — reusa los primitivos del molde.
  const leftBorder = stateNeedsLeftBorder(badgeKey) ? `3px solid ${stateColor(badgeKey)}` : undefined;
  return (
    <div
      className={`aiv-row grid items-center gap-3 ${DOMAIN_GRID_COLS} ${expanded ? "bg-[var(--color-surface-sunken)]" : ""}`}
      style={{
        padding: "10px 16px",
        borderBottom: "1px solid var(--color-border)",
        borderLeft: leftBorder ?? "3px solid transparent",
      }}
    >
      {/* Dominio */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <MonoData style={{ fontSize: 12.5 }} className="truncate">{d.domain}</MonoData>
          {d.authComplete && <CheckCircle2 size={11} className="shrink-0 text-success" strokeWidth={1.75} />}
          {d.hasCredential && <KeyRound size={11} className="shrink-0 text-success" strokeWidth={1.75} />}
          {ageLabel ? (
            <Badge style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)", borderColor: "transparent" }}>
              Nuevo · {ageLabel}
            </Badge>
          ) : null}
        </div>
        {d.errorMessage ? (
          <Caption style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--color-critical)" }}>
            <AlertTriangle size={10} strokeWidth={1.75} className="shrink-0" />
            <span className="truncate" title={d.errorMessage}>{d.errorMessage}</span>
          </Caption>
        ) : null}
      </div>
      {/* Proveedor · IP — columna secundaria: oculta en < md para no aplastar la fila */}
      <div
        className="hidden truncate md:block"
        style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}
        title={`${d.registrar ?? ""}${d.serverIp ? " · IP " + d.serverIp : ""}`}
      >
        {d.registrar ? `${d.registrar} · ` : ""}
        {d.serverIp ? `IP ${d.serverIp}` : "sin IP"}
      </div>
      {/* Estado + día de warmup */}
      <div className="flex items-center justify-end gap-2">
        <StateBadge status={badgeKey} label={d.status} />
        {d.warmupDayN != null && d.warmupTargetDays != null && (
          <Badge>día {d.warmupDayN}/{d.warmupTargetDays}</Badge>
        )}
      </div>
      {/* Acciones */}
      <div className="flex items-center justify-end gap-1.5">
        {!d.hasCredential ? (
          <Button
            variant={hot ? "primary" : "ghost"}
            size="sm"
            title="Generar credencial SMTP AUTH"
            onClick={() => {
              const intent = buildEnableSmtpAuthIntent(d.domain);
              sendIntent(intent.prompt, intent.source);
            }}
          >
            <KeyRound size={11} strokeWidth={1.75} />
            Generar
          </Button>
        ) : (
          <button
            type="button"
            disabled={downloading}
            title="Descargar credencial SMTP"
            className="grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-[var(--color-surface-raised)] hover:text-fg disabled:opacity-50"
            onClick={async () => {
              setDownloading(true);
              try {
                await downloadSmtpCredential(d.domain);
                toast.success("Credencial descargada", { description: d.domain });
              } catch (error) {
                toast.error("No se pudo descargar", {
                  description: error instanceof Error ? error.message : "Revisá gateway/read-boundary."
                });
              } finally {
                setDownloading(false);
              }
            }}
          >
            <Download size={13} strokeWidth={1.75} />
          </button>
        )}
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            title={expanded ? "Ocultar warmup y placement" : "Ver warmup y placement"}
            className="grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-[var(--color-surface-raised)] hover:text-fg"
          >
            <ChevronDown
              size={15}
              strokeWidth={2}
              style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform .15s ease" }}
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}

async function exportSmtpCredentialInventory(): Promise<number> {
  const response = await fetch(READ_ENDPOINTS.senderPoolCredentialsExport, {
    method: "GET"
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  const payload = await response.json() as { credentials?: SmtpCredentialMetadata[]; generatedAt?: string };
  const credentials = payload.credentials ?? [];
  triggerDownload(
    new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }),
    `smtp-credentials-inventory-${new Date().toISOString().slice(0, 10)}.json`
  );
  return credentials.length;
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
    <Card className="flex flex-col gap-3" style={{ padding: 20, background: "var(--color-surface-sunken)" }}>
      <div className="flex items-center gap-2">
        <Workflow size={12} className="text-fg-subtle" strokeWidth={1.75} />
        <Eyebrow>El flow paso a paso · descripción del pipeline</Eyebrow>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {FLOW.map((s) => (
          <li key={s.n} className="flex items-start gap-3">
            <StatNum className="grid size-5 shrink-0 place-items-center rounded bg-surface text-[10px] font-semibold text-fg-muted ring-1 ring-border">
              {s.n}
            </StatNum>
            <div className="flex flex-col gap-0.5">
              <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--color-text-primary)" }}>{s.label}</span>
              <Caption>{s.caption}</Caption>
            </div>
          </li>
        ))}
      </ul>
      <Caption style={{ marginTop: 8, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em" }}>
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
  loading,
  error
}: {
  spent: number;
  available: number;
  pct: number;
  tone: "success" | "warning" | "critical";
  transactions: WalletTx[];
  loading: boolean;
  error: boolean;
}) {
  const healthLabel = error
    ? "Lectura fallida"
    : tone === "critical" ? "Cap excedido" : tone === "warning" ? "Próximo a cap" : "Saludable";
  // Salud de wallet = chip semántico (Pill del molde), NO un StateBadge de warmup:
  // el ícono Pause/ShieldAlert mentía sobre el estado. El tono ya es
  // success|warning|critical y mapea 1:1 al Pill; error fuerza critical.
  const healthTone: PillTone = error ? "critical" : tone;
  // Serie REAL de gasto acumulado (cronológico). Sin serie real → sin sparkline.
  const walletSeries = (() => {
    if (error || transactions.length < 2) return undefined;
    let acc = 0;
    return [...transactions].reverse().map((t) => (acc += t.amount));
  })();
  // ANTI-MOCK: si la audit chain falló, NO afirmamos "$0.00 intacto" — el gasto es
  // desconocido, no cero. Mostramos "—" en las cifras derivadas.
  return (
    <Card ink className="flex flex-col gap-4" style={{ padding: 24 }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Eyebrow>Wallet operativo</Eyebrow>
          <Heading level={2}>Route53 Domains</Heading>
        </div>
        <Pill tone={healthTone}>{healthLabel}</Pill>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <WalletStat label="Cap mensual · config" value={`$${CAP_USD.toFixed(0)}`} />
        <WalletStat label="Gastado" value={error ? "—" : `$${spent.toFixed(2)}`} tone={error ? undefined : tone} />
        <WalletStat label="Disponible" value={error ? "—" : `$${available.toFixed(2)}`} />
      </div>
      {error ? null : (
        <div
          className="relative h-1 w-full overflow-hidden rounded-full"
          style={{ background: "var(--color-surface-sunken)" }}
        >
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
      )}
      {walletSeries ? (
        <div className="flex flex-col gap-1.5">
          <Eyebrow>Gasto acumulado</Eyebrow>
          <Spark id="wallet-spend" data={walletSeries} up />
        </div>
      ) : null}
      <Eyebrow>Movimientos del mes</Eyebrow>
      {error ? (
        <div
          className="flex items-start gap-2 rounded-md px-3 py-2"
          style={{ border: "1px solid var(--color-critical-border)", background: "var(--color-critical-soft)" }}
        >
          <AlertTriangle size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" style={{ color: "var(--color-critical)" }} />
          <BodySm style={{ color: "var(--color-critical)" }}>
            No se pudo leer la audit chain. El gasto del mes es desconocido — no asumas que el wallet
            está intacto hasta que la lectura vuelva.
          </BodySm>
        </div>
      ) : loading ? (
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
                <MonoData className="truncate" style={{ fontSize: 11 }}>{t.domain}</MonoData>
                <Caption style={{ fontSize: 10 }}>{new Date(t.occurredAt).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · {t.actor}</Caption>
              </div>
              <StatNum className="shrink-0" style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)" }}>−${t.amount.toFixed(2)}</StatNum>
            </li>
          ))}
        </ul>
      )}
      <Caption style={{ marginTop: 4, fontSize: 10 }}>
        Wallet primitivo · S1 trae control granular y multi-wallet.
      </Caption>
    </Card>
  );
}

function WalletStat({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" | "critical" }) {
  const color = tone === "critical" ? "var(--color-critical)" : tone === "warning" ? "var(--color-warning)" : "var(--color-text-primary)";
  return (
    <div className="flex flex-col gap-1">
      <Eyebrow style={{ fontSize: 9.5 }}>{label}</Eyebrow>
      <StatNum style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em", color }}>
        {value}
      </StatNum>
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
      <Card className="flex items-center gap-2" style={{ padding: 16, background: "var(--color-surface-sunken)" }}>
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
    <Card
      className="flex flex-col gap-3"
      style={{ padding: 20, ...(isAutoPaused ? { background: "var(--color-surface-sunken)" } : {}) }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <Eyebrow>Warmup ramp · {ramp.schedule}</Eyebrow>
          <MonoData style={{ fontSize: 12 }}>{ramp.rampId}</MonoData>
        </div>
        <Pill tone={rampStateTone(ramp.state)}>{ramp.state}</Pill>
      </div>

      {isAutoPaused && (
        <div
          className="flex items-start gap-2 rounded-md p-2"
          style={{
            background: "var(--color-critical-soft)",
            border: "1px solid var(--color-critical-border)"
          }}
        >
          <AlertTriangle size={12} className="text-critical mt-0.5" strokeWidth={1.75} />
          <BodySm>
            Ramp en auto-pausa · razón <code>{ramp.pauseReason ?? "unknown"}</code>. Revisá bounce rate antes de reanudar.
          </BodySm>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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
                : "var(--color-warming)"
          }}
        />
      </div>

      <RampSparkline batches={ramp.batches} />

      <div className="flex items-center justify-between gap-2">
        <Caption style={{ fontSize: 10 }}>
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
        <Caption style={{ color: "var(--color-critical)" }}>{pauseError}</Caption>
      )}
    </Card>
  );
}

function RampStat({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" | "critical" }) {
  const color = tone === "critical" ? "var(--color-critical)" : tone === "warning" ? "var(--color-warning)" : tone === "success" ? "var(--color-success)" : "var(--color-text-primary)";
  return (
    <div className="flex flex-col gap-1">
      <Eyebrow style={{ fontSize: 9.5 }}>{label}</Eyebrow>
      <StatNum style={{ fontSize: 14, fontWeight: 600, color }}>
        {value}
      </StatNum>
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
              ? "var(--color-warming)"
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

function rampStateTone(state: WarmupRampStatus["state"]): "success" | "warning" | "warming" | "critical" | "neutral" {
  switch (state) {
    case "running":
      return "warming";
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
