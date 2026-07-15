/**
 * Aprendizaje supervisado — restyle al molde oficial "Aivora"
 * (shared/ui/aivora + features/overview/TravigueOverviewProto como referencia).
 *
 * Estructura (datos REALES, sin mock):
 *   SectionHead (eyebrow + h1 light) + AdvisorCard OpenClaw derivado de datos reales
 *   KPI row: 4 KpiCard (Habilidades / Signals / Salud / Pendientes)
 *   Plan de aprendizaje (stages) + Habilidades de OpenClaw (recommendations)
 *   Evidencia curada (tabla, /v1/openclaw/evidence)
 *   Bitácora del aprendizaje (/v1/openclaw/skills/audit)
 *
 * Colores SOLO por tokens var(--color-*) o los primitivos aivora. Sin hex, sin paletas nuevas.
 */

import {
  Activity,
  ArrowRight,
  Cpu,
  Eye,
  HeartPulse,
  History,
  Inbox,
  MessageSquare,
  Sparkles
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getJson,
  type DashboardData,
  type OpenClawEvidenceItem,
  type OpenClawEvidencePayload,
  type OpenClawSkillsAuditEvent,
  type OpenClawSkillsAuditPayload,
  type RealTimeMeta
} from "../../shared/api/client.ts";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary.ts";
import {
  formatDateTime,
  formatTimeOnly
} from "../../shared/lib/formatters.ts";
import {
  EmptyEventsCard,
  EmptyEvidenceCard,
  FallbackBanner,
  RealtimeTick,
  SkeletonRow,
  StaleBadge,
  isCachedMeta,
  isFallbackMeta,
  staleMinutesFromMeta
} from "../../shared/ui/realtime/index.ts";
import {
  useOpenClawIntent,
  useToast
} from "../../shared/ui/v2/index.ts";
import {
  AdvisorCard,
  Caption,
  Card,
  Heading,
  KpiCard,
  SectionHead,
  aivoraGradient
} from "../../shared/ui/aivora/index.tsx";

const LEARNING_POLL_INTERVAL_MS = 30_000;
const LEARNING_POLL_INTERVAL_SECONDS = LEARNING_POLL_INTERVAL_MS / 1_000;

export function LearningSection({ data }: { data: DashboardData }) {
  const skillsAuditQuery = useQuery({
    queryKey: ["openclaw", "skills-audit"],
    queryFn: () => getJson<OpenClawSkillsAuditPayload>(READ_ENDPOINTS.openClawSkillsAudit),
    refetchInterval: LEARNING_POLL_INTERVAL_MS
  });
  const evidenceQuery = useQuery({
    queryKey: ["openclaw", "evidence"],
    queryFn: () => getJson<OpenClawEvidencePayload>(READ_ENDPOINTS.openClawEvidence),
    refetchInterval: LEARNING_POLL_INTERVAL_MS
  });
  const skillsAuditPayload = learningSkillsAuditPayload(data, skillsAuditQuery.data, skillsAuditQuery.isLoading);
  const evidencePayload = learningEvidencePayload(data, evidenceQuery.data, evidenceQuery.isLoading);
  const skillsPulse = useRealtimePulse(skillsAuditSignature(skillsAuditPayload.events));
  const evidencePulse = useRealtimePulse(evidenceSignature(evidencePayload.curated));
  const hasFallback = [
    skillsAuditPayload.meta,
    evidencePayload.meta
  ].some(isFallbackMeta) || skillsAuditQuery.isError || evidenceQuery.isError;

  return (
    <section className="flex flex-col" style={{ gap: 24 }}>
      {hasFallback ? (
        <FallbackBanner
          message={skillsAuditQuery.isError || evidenceQuery.isError ? "Mostrando último snapshot disponible" : undefined}
        />
      ) : null}
      <Header data={data} />
      <KpiRow data={data} />
      <PlanAndSkills data={data} />
      <EvidenciaCurada
        items={evidencePayload.curated}
        isLoading={evidenceQuery.isLoading}
        meta={evidencePayload.meta}
        pulseActive={evidencePulse}
      />
      <AuditStrip
        events={skillsAuditPayload.events}
        isLoading={skillsAuditQuery.isLoading}
        meta={skillsAuditPayload.meta}
        pulseActive={skillsPulse}
      />
    </section>
  );
}

function learningSkillsAuditPayload(
  data: DashboardData,
  payload: OpenClawSkillsAuditPayload | undefined,
  isLoading: boolean
): OpenClawSkillsAuditPayload {
  if (payload) return payload;
  if (isLoading) return { events: [] };
  return {
    events: data.openClawSkillsAudit,
    meta: data.learningRealtime.openClawSkillsAudit ?? null
  };
}

function learningEvidencePayload(
  data: DashboardData,
  payload: OpenClawEvidencePayload | undefined,
  isLoading: boolean
): OpenClawEvidencePayload {
  if (payload) return payload;
  if (isLoading) return { curated: [] };
  return {
    curated: data.openClawEvidence,
    meta: data.learningRealtime.openClawEvidence ?? null
  };
}

function useRealtimePulse(signature: string): boolean {
  const previousSignature = useRef<string | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (previousSignature.current !== null && previousSignature.current !== signature) {
      setActive(true);
      const timeout = setTimeout(() => setActive(false), 200);
      previousSignature.current = signature;
      return () => clearTimeout(timeout);
    }

    previousSignature.current = signature;
    return undefined;
  }, [signature]);

  return active;
}

function skillsAuditSignature(events: OpenClawSkillsAuditEvent[]): string {
  return events.map((event) => `${event.id}:${event.occurredAt}:${event.action}`).join("|");
}

function evidenceSignature(items: OpenClawEvidenceItem[]): string {
  return items.map((item) => `${item.snapshotId}:${item.capturedAt}:${item.impact}`).join("|");
}

function staleBadgeFor(meta: RealTimeMeta | null | undefined): ReactNode {
  if (!isCachedMeta(meta)) return null;
  return <StaleBadge minutesAgo={staleMinutesFromMeta(meta)} />;
}

/* ============================================================
 * Header — SectionHead (eyebrow + h1 light) + AdvisorCard OpenClaw
 * ============================================================ */
function Header({ data }: { data: DashboardData }) {
  // El advisor (~440px) no cabe en el slot `right` de SectionHead (flex:none, no stackea):
  // en < ~456px aplastaba el h1 y desbordaba en horizontal. Se saca del slot y se stackea
  // en su propio contenedor responsive (col en móvil, row 440px en lg) sin tocar SectionHead
  // ni al resto de sus consumidores. Look desktop idéntico (flex-row + justify-between + gap 16).
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0 lg:flex-1">
        <SectionHead
          eyebrow="Aprendizaje supervisado"
          title="OpenClaw aprende con humanos al volante."
          subtitle={
            <>
              Ninguna habilidad se promueve sin evidencia curada, dry-run estable, evaluación auditada y
              aprobación humana. · Actualizado {formatDateTime(data.learningPlan.generatedAt)}
            </>
          }
        />
      </div>
      <div className="w-full lg:w-[440px] lg:flex-none">
        <OpenClawAdvisor data={data} />
      </div>
    </div>
  );
}

/**
 * Advisor OpenClaw — única superficie con gradiente (patrón del demo).
 * DE-MOCK: el "N recomendaciones listas" sale del contrato real
 * (readinessSignals.recommendations que requieren aprobación humana), no de un número fijo.
 * Los CTAs enrutan al chat OpenClaw vía el sistema de intents real (sendIntent).
 */
function OpenClawAdvisor({ data }: { data: DashboardData }) {
  const { sendIntent } = useOpenClawIntent();
  const { toast } = useToast();

  const recommendations = data.readinessSignals.recommendations ?? [];
  const pendingReview = recommendations.filter((r) => r.requiresHumanApproval).length;
  const governance = data.readinessSignals.modelGovernance;
  const hasWork = pendingReview > 0;

  const title = hasWork
    ? `${pendingReview} ${pendingReview === 1 ? "recomendación lista" : "recomendaciones listas"} para revisión`
    : "Sin recomendaciones pendientes de revisión";
  const body = hasWork
    ? `Hay ${pendingReview} ${pendingReview === 1 ? "recomendación" : "recomendaciones"} que requieren aprobación humana antes de pasar a evaluación. Te dejo el plan ordenado por impacto.`
    : "OpenClaw no tiene recomendaciones esperando aprobación humana en este momento.";

  const openPlan = () => {
    sendIntent(
      `Acción del operador: revisar el plan de aprendizaje de OpenClaw ordenado por impacto.\n\n` +
        `Contexto del panel: ${pendingReview} recomendación(es) requieren aprobación humana.\n\n` +
        `Tráeme el plan ordenado por impacto citando la evidencia curada y el audit chain.`,
      "learning:advisor-plan"
    );
    toast.info("Enviando a OpenClaw · plan de aprendizaje", {
      description: "Prompt pre-llenado en el chat. Revisa y presiona Enter para ejecutar.",
      duration: 2500
    });
  };

  const openChat = () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="OpenClaw"]');
    if (textarea) {
      textarea.focus();
      textarea.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      sendIntent("", "learning:advisor-chat");
    }
  };

  return (
    <AdvisorCard>
      <div style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: aivoraGradient, display: "grid", placeItems: "center" }}>
            <Sparkles size={16} color="var(--color-accent-fg)" />
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 500, color: "var(--color-text-primary)" }}>Advisor · OpenClaw</div>
        </div>
        <div style={{ marginTop: 14, borderLeft: "2px solid transparent", borderImage: `${aivoraGradient} 1`, paddingLeft: 12 }}>
          <div style={{ fontSize: 13.5, color: "var(--color-text-primary)", lineHeight: 1.5, fontWeight: 300 }}>
            <b style={{ fontWeight: 600 }}>{title}.</b> {body}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11.5, color: "var(--color-text-secondary)", background: "var(--color-surface-sunken)", borderRadius: 999, padding: "3px 9px" }}>
              modo {governance.modelMode}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--color-accent)", background: "var(--color-accent-soft)", borderRadius: 999, padding: "3px 9px" }}>
              {pendingReview} {pendingReview === 1 ? "pendiente" : "pendientes"}
            </span>
            {governance.requiresHumanApproval ? (
              <span style={{ fontSize: 11.5, color: "var(--color-text-secondary)", background: "var(--color-surface-sunken)", borderRadius: 999, padding: "3px 9px" }}>
                gate humano
              </span>
            ) : null}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={openPlan}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: aivoraGradient, color: "var(--color-accent-fg)", border: "none", borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            Ver plan ordenado
            <ArrowRight size={14} strokeWidth={2.25} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={openChat}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "8px 16px", fontSize: 13, cursor: "pointer" }}
          >
            <MessageSquare size={14} strokeWidth={1.9} aria-hidden="true" />
            Abrir chat
          </button>
        </div>
      </div>
    </AdvisorCard>
  );
}

/* ============================================================
 * KPI row — 4 KpiCard (molde aivora: tile + número tabular)
 * ============================================================ */
function KpiRow({ data }: { data: DashboardData }) {
  const stagesTotal = data.learningPlan.stages.length;
  const stagesReady = data.learningPlan.stages.filter((s) => s.status === "ready" || s.status === "ok").length;
  const signalsTotal = Object.keys(data.readinessSignals.scores).length;
  const signalsBlocked = Object.values(data.readinessSignals.scores).filter(
    (s) => s.status === "blocked" || s.status === "critical"
  ).length;
  const requiresApproval = data.canvas.requiresHumanApproval?.length ?? 0;
  const healthyPct = signalsTotal === 0 ? 0 : ((signalsTotal - signalsBlocked) / signalsTotal) * 100;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 20 }}>
      <KpiCard label="Habilidades listas" value={String(stagesReady)} suffix={` / ${stagesTotal}`} icon={Cpu} />
      <KpiCard label="Signals de readiness" value={String(signalsTotal)} icon={Activity} />
      <KpiCard
        label="Signals saludables"
        value={healthyPct.toFixed(1).replace(".", ",")}
        suffix="%"
        icon={HeartPulse}
      />
      <KpiCard label="Pendientes de revisión" value={String(requiresApproval)} icon={Inbox} />
    </div>
  );
}

/* ============================================================
 * Plan + Skills
 * ============================================================ */
function PlanAndSkills({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
      <PlanCard data={data} />
      <SkillsCard data={data} />
    </div>
  );
}

function statusToPill(status: string): { bg: string; fg: string; text: string } {
  const t = status.toLowerCase();
  if (t === "ready" || t === "ok") return { bg: "var(--color-success-soft)", fg: "var(--color-success)", text: "completado" };
  if (t === "needs_review" || t === "warning" || t === "active_true")
    return { bg: "var(--color-info-soft)", fg: "var(--color-info)", text: "en curso" };
  if (t === "blocked" || t === "critical")
    return { bg: "var(--color-critical-soft)", fg: "var(--color-critical)", text: "bloqueado" };
  if (t === "requires_approval") return { bg: "var(--color-unknown-soft)", fg: "var(--color-unknown)", text: "aprobación" };
  return { bg: "var(--color-neutral-soft)", fg: "var(--color-text-secondary)", text: status };
}

/**
 * StatePill — réplica local del molde StateBadge (aivora) para los enums de dominio
 * (ready/needs_review/blocked/…) que no calzan con STATE_MAP: pill radius 999 + dot de color
 * + soft bg + label ~12px/peso 500. Mata el look off-brand v5 (radius 4, 9px, uppercase micro-caps).
 */
function StatePill({ bg, fg, label }: { bg: string; fg: string; label: string }) {
  return (
    <span
      className="inline-flex items-center"
      style={{
        gap: 6,
        padding: "3px 9px 3px 7px",
        borderRadius: 999,
        background: bg,
        color: fg,
        fontSize: 12,
        fontWeight: 500,
        width: "fit-content"
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: "50%", background: fg }}
      />
      {label}
    </span>
  );
}

function CardHead({
  title,
  subtitle,
  right
}: {
  title: string;
  subtitle: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header
      className="flex min-w-0 flex-wrap items-start sm:items-center"
      style={{ gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--color-border)" }}
    >
      <div className="flex min-w-[200px] flex-1 flex-col" style={{ gap: 2 }}>
        <h2 className="m-0" style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>
          {title}
        </h2>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{subtitle}</span>
      </div>
      {right}
    </header>
  );
}

function PlanCard({ data }: { data: DashboardData }) {
  const stages = data.learningPlan.stages ?? [];
  const headlinePill = (() => {
    if (stages.some((s) => s.status === "blocked" || s.status === "critical"))
      return { bg: "var(--color-critical-soft)", fg: "var(--color-critical)", text: "bloqueado por gate" };
    if (stages.some((s) => s.status === "needs_review" || s.status === "active_true"))
      return { bg: "var(--color-info-soft)", fg: "var(--color-info)", text: "en curso" };
    return { bg: "var(--color-success-soft)", fg: "var(--color-success)", text: "al día" };
  })();
  return (
    <Card className="flex min-w-0 flex-col" style={{ overflow: "hidden" }}>
      <CardHead
        title="Plan de aprendizaje"
        subtitle={`${stages.length} hitos · cada gate humano queda en bitácora`}
        right={
          <span
            className="inline-block"
            style={{ fontSize: 11, fontWeight: 500, padding: "3px 10px", borderRadius: 999, background: headlinePill.bg, color: headlinePill.fg }}
          >
            {headlinePill.text}
          </span>
        }
      />

      <ol className="m-0 p-0 list-none flex flex-col" style={{ padding: "8px 20px 18px 20px" }}>
        {stages.map((stage, i) => {
          const pill = statusToPill(stage.status);
          const order = String(stage.order ?? i + 1).padStart(2, "0");
          return (
          <li
            key={stage.id}
            className="flex items-start"
            style={{ gap: 14, padding: "14px 0", borderBottom: i < stages.length - 1 ? "1px solid var(--color-border)" : "none" }}
          >
            <span
              aria-hidden="true"
              className="grid place-items-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: pill.bg,
                color: pill.fg,
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                fontWeight: 700
              }}
            >
              {order}
            </span>
            <div className="flex flex-col flex-1 min-w-0" style={{ gap: 4 }}>
              <div className="flex items-center" style={{ gap: 8 }}>
                <h3 className="m-0" style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>
                  {stage.title}
                </h3>
                <StatePill bg={pill.bg} fg={pill.fg} label={pill.text} />
              </div>
              {stage.goal ? (
                <p className="m-0" style={{ fontSize: 12, lineHeight: 1.45, color: "var(--color-text-secondary)" }}>
                  {stage.goal}
                </p>
              ) : null}
              {stage.exitGate ? (
                <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}>
                  gate de salida · {stage.exitGate}
                </span>
              ) : null}
            </div>
          </li>
          );
        })}
      </ol>
    </Card>
  );
}

export interface SkillRow {
  title: string;
  state: string;
  stateBg: string;
  stateFg: string;
  endpoint: string;
}

export function buildSkillRows(readinessSignals: DashboardData["readinessSignals"]): SkillRow[] {
  const recs = readinessSignals.recommendations ?? [];
  return recs.slice(0, 6).map((r) => {
    const pill = statusToPill(r.status);
    return { title: r.label, state: pill.text, stateBg: pill.bg, stateFg: pill.fg, endpoint: r.id };
  });
}

function SkillsCard({ data }: { data: DashboardData }) {
  const skills = buildSkillRows(data.readinessSignals);
  return (
    <Card className="flex flex-col" style={{ overflow: "hidden" }}>
      <CardHead
        title="Habilidades de OpenClaw"
        subtitle="Cada una requiere supervisión humana"
        right={
          <span
            className="inline-block"
            style={{ fontSize: 11, fontWeight: 500, padding: "3px 10px", borderRadius: 999, background: "var(--color-success-soft)", color: "var(--color-success)" }}
          >
            {skills.length} reales
          </span>
        }
      />
      {skills.length > 0 ? (
        <ul className="m-0 p-0 list-none flex flex-col">
          {skills.map((s, i, arr) => (
            <li
              key={s.title}
              className="flex flex-col"
              style={{
                gap: 6,
                padding: "12px 20px",
                borderBottom: i < arr.length - 1 ? "1px solid var(--color-border)" : "none"
              }}
            >
              <div className="flex items-center" style={{ gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>
                  {s.title}
                </span>
                <span className="flex-1" aria-hidden="true" />
                <StatePill bg={s.stateBg} fg={s.stateFg} label={s.state} />
              </div>
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}>{s.endpoint}</span>
            </li>
          ))}
        </ul>
      ) : (
        <SkillsEmptyState />
      )}
    </Card>
  );
}

function SkillsEmptyState() {
  return (
    <div className="flex flex-col items-start" style={{ gap: 8, padding: "24px 20px" }}>
      <Heading level={3}>Sin recomendaciones de readiness</Heading>
      <Caption style={{ maxWidth: 520, color: "var(--color-text-secondary)" }}>
        El contrato no devolvió recomendaciones activas para OpenClaw.
      </Caption>
      <code
        style={{
          marginTop: 4,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--color-text-tertiary)"
        }}
      >
        {READ_ENDPOINTS.openClawReadinessSignals}
      </code>
    </div>
  );
}

/* ============================================================
 * Evidencia curada — tabla 7 columnas (cableada a /v1/openclaw/evidence)
 * ============================================================ */
type EvidenceRow = readonly [string, string, string, string, string, string, string];

function modeLabel(mode: string): string {
  if (mode === "get-only" || mode === "GET-only") return "Read-boundary";
  return mode;
}

function buildEvidenceRows(items: OpenClawEvidenceItem[]): readonly EvidenceRow[] {
  return items.map(
    (e) => [
      e.snapshotId,
      e.type,
      e.description,
      e.actor,
      e.capturedAt,
      modeLabel(e.mode),
      e.impact
    ] as const
  );
}

function EvidenciaCurada({
  items,
  isLoading,
  meta,
  pulseActive
}: {
  items: OpenClawEvidenceItem[];
  isLoading: boolean;
  meta: RealTimeMeta | null | undefined;
  pulseActive: boolean;
}) {
  const rows = buildEvidenceRows(items);
  const stale = staleBadgeFor(meta);
  return (
    <Card className="flex min-w-0 flex-col" style={{ overflow: "hidden" }}>
      <header
        className="flex min-w-0 flex-wrap items-start sm:items-center"
        style={{ gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex min-w-[220px] flex-1 flex-col" style={{ gap: 2 }}>
          <h2 className="m-0" style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>
            Evidencia curada por OpenClaw
          </h2>
          <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
            Snapshots, notas y anotaciones humanas que alimentan cada habilidad
          </span>
        </div>
        <RealtimeTick active={pulseActive} />
        {stale}
        <span className="min-w-0 max-w-full truncate" style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}>
          contrato · /v1/openclaw/evidence
        </span>
        <span
          className="inline-flex items-center"
          style={{
            gap: 4,
            fontSize: 9,
            fontWeight: 700,
            padding: "3px 8px",
            borderRadius: 999,
            background: "var(--color-info-soft)",
            color: "var(--color-info)",
            letterSpacing: "var(--tracking-wider)"
          }}
        >
          <Eye size={10} strokeWidth={2} aria-hidden="true" />
          Read-boundary
        </span>
      </header>

      {isLoading ? (
        <div className="flex flex-col" style={{ gap: 8, padding: 16 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex justify-center" style={{ padding: 20 }}>
          <EmptyEvidenceCard pollIntervalSeconds={LEARNING_POLL_INTERVAL_SECONDS} />
        </div>
      ) : (
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          {/* header row */}
          <div
            className="grid"
            style={{
              gridTemplateColumns: "120px 140px minmax(0,1fr) 110px 120px 120px 80px",
              gap: 12,
              padding: "8px 20px",
              borderBottom: "1px solid var(--color-border)"
            }}
          >
            {["EVIDENCIA", "TIPO", "DESCRIPCIÓN", "ACTOR", "FECHA", "MODO", "IMPACTO"].map((h) => (
              <span
                key={h}
                className="uppercase"
                style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-tertiary)", letterSpacing: ".05em" }}
              >
                {h}
              </span>
            ))}
          </div>

          <div className="flex flex-col">
            {rows.map((row, i) => (
              <div
                key={`${row[0]}-${i}`}
                className="grid items-center"
                style={{
                  gridTemplateColumns: "120px 140px minmax(0,1fr) 110px 120px 120px 80px",
                  gap: 12,
                  padding: "12px 20px",
                  borderBottom: i < rows.length - 1 ? "1px solid var(--color-border)" : "none"
                }}
              >
                <span className="flex min-w-0 items-center" style={{ gap: 8 }}>
                  <RealtimeTick active={pulseActive && i === 0} />
                  <code className="truncate" style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--color-text-primary)" }}>{row[0]}</code>
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--color-accent-tertiary)" }}>
                  {row[1]}
                </span>
                <span className="truncate" style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                  {row[2]}
                </span>
                <span className="truncate" style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>
                  {row[3]}
                </span>
                <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}>{row[4]}</span>
                <StatePill bg="var(--color-info-soft)" fg="var(--color-info)" label={row[5]} />
                <span
                  className="inline-block uppercase"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background:
                      row[6] === "alto" ? "var(--color-critical-soft)" : row[6] === "medio" ? "var(--color-info-soft)" : "var(--color-success-soft)",
                    color: row[6] === "alto" ? "var(--color-critical)" : row[6] === "medio" ? "var(--color-info)" : "var(--color-success)",
                    letterSpacing: "var(--tracking-wide)",
                    width: "fit-content"
                  }}
                >
                  {row[6]}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      )}
    </Card>
  );
}

/* ============================================================
 * Audit strip — cableado a /v1/openclaw/skills/audit
 * ============================================================ */
type LearningAuditLine = {
  id: string;
  ts: string;
  action: string;
  body: string;
  hash: string;
};

function buildLearningAuditLines(events: OpenClawSkillsAuditEvent[]): LearningAuditLine[] {
  return events.map((event) => ({
    id: event.id,
    ts: formatTimeOnly(event.occurredAt),
    action: event.action,
    body: `${event.actor} · ${event.body}`,
    hash: event.id
  }));
}

function AuditStrip({
  events,
  isLoading,
  meta,
  pulseActive
}: {
  events: OpenClawSkillsAuditEvent[];
  isLoading: boolean;
  meta: RealTimeMeta | null | undefined;
  pulseActive: boolean;
}) {
  const auditLines = buildLearningAuditLines(events);
  const stale = staleBadgeFor(meta);
  return (
    <Card className="flex min-w-0 flex-col" style={{ gap: 10, padding: "14px 18px" }}>
      <header className="flex min-w-0 flex-wrap items-center" style={{ gap: 8 }}>
        <History size={14} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--color-accent-secondary)" }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>
          Bitácora del aprendizaje
        </span>
        <span className="flex-1" aria-hidden="true" />
        <RealtimeTick active={pulseActive} />
        {stale}
        <span className="min-w-0 truncate" style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}>
          contrato · /v1/openclaw/skills/audit
        </span>
      </header>

      {isLoading ? (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      ) : auditLines.length === 0 ? (
        <div className="flex justify-center" style={{ padding: "10px 0 2px" }}>
          <EmptyEventsCard pollIntervalSeconds={LEARNING_POLL_INTERVAL_SECONDS} />
        </div>
      ) : (
      <ul className="m-0 p-0 list-none flex min-w-0 flex-col" style={{ gap: 4 }}>
        {auditLines.map((a, i) => (
          <li
            key={a.id}
            className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 md:grid-cols-[80px_220px_minmax(0,1fr)_minmax(80px,auto)] md:gap-[14px]"
            style={{
              padding: "6px 0"
            }}
          >
            <span
              className="flex min-w-0 items-center"
              style={{ gap: 6, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}
            >
              <RealtimeTick active={pulseActive && i === 0} />
              {a.ts}
            </span>
            <span
              className="min-w-0 truncate"
              style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--color-accent-secondary)" }}
            >
              {a.action}
            </span>
            <span className="truncate" style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--color-text-primary)" }}>
              {a.body}
            </span>
            <span
              className="col-span-2 min-w-0 truncate md:col-span-1 md:text-right"
              style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}
            >
              {a.hash}
            </span>
          </li>
        ))}
      </ul>
      )}
    </Card>
  );
}
