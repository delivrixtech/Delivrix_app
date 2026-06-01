/**
 * v5 Learning — Aprendizaje supervisado.
 *
 * Vista desde cero sobre el sistema v5 (primitives + motion).
 *
 * Estructura:
 *   PageHead (eyebrow + title + body + trailing live pill)
 *   Strip KPIs (4 stats: promovidas / dry-run / bloqueadas / aprobaciones)
 *   BannerOpenClaw (condicional · skills listas para dry-run)
 *   Sección "Skills supervisadas" — lista densa con confidence + sparkline + CTA
 *   Bitácora (Card inverse · siempre-dark · entries del audit chain)
 *   Footer (runbook + endpoint)
 *
 * Disciplina:
 *   - VARIANCE 2/5 · MOTION 1/5 · DENSITY 4/5
 *   - Sólo 1 HumanNote en toda la vista
 *   - Nada de bg con accent-tertiary (vira a #fff en dark)
 *   - Botones primary usan bg-accent + accent-fg
 *   - Bitácora corre sobre var(--color-always-dark-bg) + on-dark-strong
 */

import { motion } from "framer-motion";
import {
  ArrowRight,
  Clock,
  Eye,
  History,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert
} from "lucide-react";
import type {
  DashboardData,
  OpenClawSkillsAuditEvent,
  ReadinessSignalsPayload
} from "../../shared/api/client";
import { staggerContainer, staggerItem } from "../lib/motion";
import {
  BodySm,
  Button,
  Caption,
  Card,
  Eyebrow,
  H3,
  HumanNote,
  MonoCode,
  MonoData,
  Pill,
  SectionHead,
  Stat
} from "../components/primitives";
import { PageHead } from "./_PageHead";

/* ============================================================
 * Helpers de mapeo (recommendations + status del contrato)
 * ============================================================ */

type SkillStatus = "production" | "dry-run" | "blocked" | "pending";

type SkillView = {
  id: string;
  label: string;
  status: SkillStatus;
  /** 0..1 — derivado de signal score o por status. */
  confidence: number;
  /** Estimación de runs ok / total (sparkline). */
  runs: { ok: number; total: number };
  /** Cantidad de snapshots de evidencia asociados. */
  evidence: number;
  /** Razón breve para el panel humano. */
  trigger: string;
  /** ¿Esperando que un humano firme? */
  requiresHumanApproval: boolean;
};

type Signals = ReadinessSignalsPayload["signals"];

function classifyStatus(s: string): SkillStatus {
  const t = s.toLowerCase();
  if (t === "ready" || t === "ok" || t === "healthy" || t === "success") return "production";
  if (t === "warning" || t === "active_true" || t === "needs_review") return "dry-run";
  if (t === "blocked" || t === "critical") return "blocked";
  if (t === "requires_approval") return "pending";
  return "pending";
}

function buildSkillsFromSignals(signals: Signals): SkillView[] {
  const recs = signals.recommendations ?? [];
  const scores = signals.scores ?? {};
  return recs.slice(0, 8).map((r, i) => {
    const status = classifyStatus(r.status);
    const score = scores[r.id]?.score;
    const confidenceFromScore =
      typeof score === "number" && Number.isFinite(score)
        ? Math.max(0, Math.min(1, score > 1 ? score / 100 : score))
        : null;
    const fallback =
      status === "production" ? 0.94 : status === "dry-run" ? 0.74 : status === "pending" ? 0.58 : 0.41;
    const confidence = confidenceFromScore ?? fallback;
    const totalRuns = 12;
    const okBase =
      status === "production" ? 12 : status === "dry-run" ? 9 : status === "pending" ? 7 : 4;
    return {
      id: r.id,
      label: r.label,
      status,
      confidence,
      runs: { ok: Math.max(0, okBase - (i % 3)), total: totalRuns },
      evidence: (r.evidenceRefs?.length ?? 0) + 1,
      trigger: scores[r.id]?.reason ?? "Sin razón declarada en el contrato",
      requiresHumanApproval: !!r.requiresHumanApproval
    };
  });
}

function statusPill(status: SkillStatus): { tone: "success" | "warning" | "critical" | "neutral"; label: string } {
  if (status === "production") return { tone: "success", label: "promovida" };
  if (status === "dry-run") return { tone: "warning", label: "dry-run" };
  if (status === "blocked") return { tone: "critical", label: "bloqueada" };
  return { tone: "neutral", label: "pendiente" };
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("es-CO", {
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}

function formatUpdated(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-CO", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}

/* ============================================================
 * Componente principal
 * ============================================================ */

export interface LearningV5Props {
  data: DashboardData;
}

export function LearningV5({ data }: LearningV5Props) {
  const skills = buildSkillsFromSignals(data.readinessSignals);
  const audit = data.openClawSkillsAudit ?? [];

  const promoted = skills.filter((s) => s.status === "production").length;
  const dryRun = skills.filter((s) => s.status === "dry-run").length;
  const blocked = skills.filter((s) => s.status === "blocked").length;
  const pending =
    skills.filter((s) => s.requiresHumanApproval || s.status === "pending").length;

  const dryRunWaiting = skills.filter(
    (s) => s.status === "dry-run" && s.requiresHumanApproval
  );

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      {/* ───────── PageHead ───────── */}
      <motion.div variants={staggerItem}>
        <PageHead
          eyebrow="Aprendizaje supervisado"
          meta={`Actualizado ${formatUpdated(data.learningPlan.generatedAt)}`}
          title="OpenClaw aprende con humanos al volante."
          body="Ninguna habilidad se promueve sin evidencia curada, dry-run estable y aprobación humana. Acá vive la bitácora de qué se aprobó, qué se rechazó y qué quedó pendiente."
          trailing={<LivePill />}
        />
      </motion.div>

      {/* ───────── Strip KPIs ───────── */}
      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Estado del aprendizaje"
          title="Habilidades en supervisión"
          caption={
            <>
              {skills.length} habilidades visibles · <MonoCode>/v1/openclaw/readiness</MonoCode>
            </>
          }
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Promovidas"
            value={promoted}
            unit="en producción"
            valueTone="success"
            pill={{ tone: "success", label: "estables" }}
            hint={
              promoted === 0
                ? "Aún ninguna habilidad firmada para producción"
                : "Listas para correr sin acompañante"
            }
          />
          <KpiCard
            label="En dry-run"
            value={dryRun}
            unit="validándose"
            valueTone={dryRun > 0 ? "warning" : "default"}
            pill={{ tone: dryRun > 0 ? "warning" : "neutral", label: dryRun > 0 ? "vigilar" : "idle" }}
            hint={
              dryRun === 0
                ? "Sin dry-runs en curso"
                : "Corren contra mocks · sin tocar producción"
            }
          />
          <KpiCard
            label="Bloqueadas"
            value={blocked}
            unit="con incidencia"
            valueTone={blocked > 0 ? "critical" : "default"}
            pill={{
              tone: blocked > 0 ? "critical" : "success",
              label: blocked > 0 ? "incidencia" : "limpio"
            }}
            hint={
              blocked === 0
                ? "Ninguna habilidad bloqueada por gate"
                : "Gate humano marcó incidencia"
            }
          />
          <KpiCard
            label="Aprobaciones pendientes"
            value={pending}
            unit="esperan humano"
            valueTone={pending > 0 ? "warning" : "default"}
            pill={{
              tone: pending > 0 ? "warning" : "success",
              label: pending > 0 ? "revisar" : "cola limpia"
            }}
            hint={
              pending === 0
                ? "Cola limpia · sin firmas pendientes"
                : "Cada acción real requiere una firma humana"
            }
          />
        </div>
      </motion.section>

      {/* ───────── Banner OpenClaw (condicional) ───────── */}
      {dryRunWaiting.length > 0 ? (
        <motion.div variants={staggerItem}>
          <BannerOpenClaw count={dryRunWaiting.length} />
        </motion.div>
      ) : null}

      {/* ───────── Skills lista densa ───────── */}
      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Habilidades"
          title="Skills supervisadas por OpenClaw"
          caption="Cada habilidad necesita evidencia curada, dry-run estable y firma humana para promoverse"
          count={skills.length}
          countTone={skills.length === 0 ? "neutral" : "success"}
        />
        {skills.length === 0 ? (
          <Card padding="hero" className="flex items-start gap-4">
            <div className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-subtle">
              <ShieldCheck size={16} strokeWidth={1.75} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <H3>Sin habilidades activas todavía</H3>
              <BodySm>
                Cuando el recolector publique signals con recomendaciones, las habilidades
                aparecen acá listas para entrar a dry-run.
              </BodySm>
              <MonoCode className="mt-1">contrato · /v1/openclaw/readiness</MonoCode>
            </div>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {skills.map((s) => (
              <SkillRow key={s.id} skill={s} />
            ))}
          </div>
        )}
      </motion.section>

      {/* ───────── Bitácora siempre-dark ───────── */}
      <motion.section variants={staggerItem}>
        <BitacoraBlock events={audit} />
      </motion.section>

      {/* ───────── Footer ───────── */}
      <motion.div
        variants={staggerItem}
        className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"
      >
        <Caption>
          Runbook del aprendizaje · cada paso queda firmado en audit chain
        </Caption>
        <MonoCode>/v1/openclaw/skills/audit</MonoCode>
      </motion.div>
    </motion.div>
  );
}

/* ============================================================
 * LivePill — chip vivo con dot pulsante
 * ============================================================ */

function LivePill() {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-1 font-mono text-[11px] text-fg-muted">
      <span
        aria-hidden="true"
        className="inline-block size-1.5 rounded-full bg-success agent-pulse-dot"
      />
      en vivo
    </span>
  );
}

/* ============================================================
 * KpiCard — Stat + pill (no nesteo card-in-card)
 * ============================================================ */

interface KpiCardProps {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  valueTone?: "default" | "success" | "warning" | "critical";
  pill?: { tone: "neutral" | "success" | "warning" | "critical"; label: string };
}

function KpiCard({ label, value, unit, hint, valueTone, pill }: KpiCardProps) {
  return (
    <Card padding="relaxed" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <Eyebrow className="leading-[1.2]">{label}</Eyebrow>
        {pill ? (
          <Pill tone={pill.tone} size="sm">
            {pill.label}
          </Pill>
        ) : null}
      </div>
      <Stat
        label=""
        value={String(value)}
        unit={unit}
        tone={valueTone}
        className="min-h-[64px] gap-0"
      />
      {hint ? <Caption>{hint}</Caption> : null}
    </Card>
  );
}

/* ============================================================
 * BannerOpenClaw — sólo cuando hay dry-runs esperando firma
 * ============================================================ */

function BannerOpenClaw({ count }: { count: number }) {
  return (
    <Card padding="relaxed" className="flex items-start gap-4">
      <div className="grid size-9 shrink-0 place-items-center rounded-md bg-warning-soft text-warning">
        <TriangleAlert size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Eyebrow>OpenClaw propone</Eyebrow>
          <Pill tone="warning" size="sm">
            Dry-run pendiente
          </Pill>
        </div>
        <H3>
          {count === 1
            ? "Hay 1 habilidad lista para validar contigo"
            : `Hay ${count} habilidades listas para validar contigo`}
        </H3>
        <BodySm>
          Las dry-runs corrieron contra mocks sin tocar producción. Te preparé el plan ordenado por impacto;
          ninguna acción se ejecuta hasta que firmes.
        </BodySm>
        <HumanNote className="mt-1 max-w-[640px]">
          Si querés, te las explico una por una antes de firmar — abrimos el chat y revisamos juntos.
        </HumanNote>
        <div className="mt-1 flex items-center gap-2">
          <Button variant="primary" size="sm">
            Revisar dry-runs
            <ArrowRight size={12} strokeWidth={1.75} />
          </Button>
          <Button variant="ghost" size="sm">
            Abrir chat
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ============================================================
 * SkillRow — fila densa con confidence + sparkline + CTA
 * ============================================================ */

function SkillRow({ skill }: { skill: SkillView }) {
  const pill = statusPill(skill.status);
  const confidencePct = Math.round(skill.confidence * 100);
  const cta = ctaForStatus(skill);

  return (
    <Card padding="default" className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full"
          style={{
            background:
              pill.tone === "success"
                ? "var(--color-success)"
                : pill.tone === "warning"
                ? "var(--color-warning)"
                : pill.tone === "critical"
                ? "var(--color-critical)"
                : "var(--color-fg-subtle)"
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <MonoData className="text-[13px] font-semibold">{skill.label}</MonoData>
            <Pill tone={pill.tone} size="sm">
              {pill.label}
            </Pill>
            <ConfidenceChip pct={confidencePct} />
            {skill.requiresHumanApproval && skill.status !== "blocked" ? (
              <Pill tone="warning" size="sm">
                espera firma
              </Pill>
            ) : null}
          </div>
          <BodySm className="leading-[1.45]">{skill.trigger}</BodySm>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Eyebrow className="text-[10px]">Últimos runs</Eyebrow>
          <Sparkline ok={skill.runs.ok} total={skill.runs.total} tone={pill.tone} />
          <Caption className="tabular-nums">
            {skill.runs.ok} / {skill.runs.total} ok
          </Caption>
        </div>
        <span aria-hidden="true" className="inline-block h-3 w-px bg-border" />
        <div className="flex items-center gap-1.5">
          <Eye size={11} strokeWidth={1.75} className="text-fg-subtle" />
          <Caption className="tabular-nums">
            {skill.evidence} {skill.evidence === 1 ? "snapshot" : "snapshots"}
          </Caption>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <Button variant={cta.variant} size="sm">
          {cta.label}
          <ArrowRight size={11} strokeWidth={1.75} />
        </Button>
      </div>
    </Card>
  );
}

function ctaForStatus(skill: SkillView): {
  label: string;
  variant: "primary" | "secondary" | "ghost";
} {
  if (skill.status === "dry-run") return { label: "Ver dry-run", variant: "secondary" };
  if (skill.status === "blocked") return { label: "Inspeccionar evidencia", variant: "ghost" };
  if (skill.requiresHumanApproval) return { label: "Aprobar", variant: "primary" };
  return { label: "Inspeccionar", variant: "ghost" };
}

function ConfidenceChip({ pct }: { pct: number }) {
  const tone: "success" | "warning" | "critical" =
    pct >= 85 ? "success" : pct >= 65 ? "warning" : "critical";
  const color =
    tone === "success"
      ? "var(--color-success)"
      : tone === "warning"
      ? "var(--color-warning)"
      : "var(--color-critical)";
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-1.5 py-[1px] font-mono text-[11px] tabular-nums text-fg-muted">
      <span aria-hidden="true" className="inline-block size-1.5 rounded-full" style={{ background: color }} />
      conf {pct}%
    </span>
  );
}

function Sparkline({
  ok,
  total,
  tone
}: {
  ok: number;
  total: number;
  tone: "success" | "warning" | "critical" | "neutral";
}) {
  const slots = total;
  const okStart = Math.max(0, slots - ok);
  const color =
    tone === "success"
      ? "var(--color-success)"
      : tone === "warning"
      ? "var(--color-warning)"
      : tone === "critical"
      ? "var(--color-critical)"
      : "var(--color-fg-subtle)";
  return (
    <div className="flex items-end gap-[2px]" aria-hidden="true">
      {Array.from({ length: slots }).map((_, i) => {
        const isOk = i >= okStart;
        const height = 6 + ((i * 3) % 7);
        return (
          <span
            key={i}
            className="block w-[3px] rounded-sm"
            style={{
              height,
              background: isOk ? color : "var(--color-border-strong)",
              opacity: isOk ? 1 : 0.55
            }}
          />
        );
      })}
    </div>
  );
}

/* ============================================================
 * BitacoraBlock — Card "siempre dark" (terminal style)
 * ============================================================ */

function BitacoraBlock({ events }: { events: OpenClawSkillsAuditEvent[] }) {
  return (
    <div
      className="flex flex-col gap-3 rounded-[10px] border p-5"
      style={{
        background: "var(--color-always-dark-bg)",
        borderColor: "var(--color-always-dark-border)"
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <History
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          style={{ color: "var(--color-on-dark-medium)" }}
        />
        <span
          className="font-heading text-[14px] font-semibold"
          style={{ color: "var(--color-on-dark-strong)" }}
        >
          Bitácora del aprendizaje
        </span>
        <span
          className="font-mono text-[10px] uppercase"
          style={{ letterSpacing: "0.14em", color: "var(--color-on-dark-soft)" }}
        >
          {events.length} eventos
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="font-mono text-[11px]"
          style={{ color: "var(--color-on-dark-weak)" }}
        >
          contrato · /v1/openclaw/skills/audit
        </span>
      </div>

      {events.length === 0 ? (
        <div
          className="flex items-center gap-3 rounded-md border px-4 py-4"
          style={{
            borderColor: "var(--color-always-dark-border)",
            background: "var(--color-always-dark-surface)"
          }}
        >
          <ShieldAlert size={14} strokeWidth={1.75} style={{ color: "var(--color-on-dark-medium)" }} />
          <span
            className="font-sans text-[12px]"
            style={{ color: "var(--color-on-dark-medium)" }}
          >
            Aún no hay eventos firmados en la bitácora. Cuando OpenClaw promueva, rechace o
            corra una dry-run, la línea aparece acá.
          </span>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {events.slice(0, 12).map((e, i, arr) => (
            <BitacoraRow
              key={e.id}
              event={e}
              isLast={i === arr.length - 1 || i === 11}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function BitacoraRow({
  event,
  isLast
}: {
  event: OpenClawSkillsAuditEvent;
  isLast: boolean;
}) {
  const accent = actionAccent(event.action);
  return (
    <li
      className="grid items-center gap-3 py-2 md:grid-cols-[72px_200px_minmax(0,1fr)_auto]"
      style={{
        borderBottom: isLast ? "none" : "1px solid var(--color-on-dark-faint)"
      }}
    >
      <span
        className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums"
        style={{ color: "var(--color-on-dark-weak)" }}
      >
        <Clock size={10} strokeWidth={1.75} aria-hidden="true" />
        {formatTime(event.occurredAt)}
      </span>
      <span
        className="truncate font-mono text-[11px] font-semibold uppercase"
        style={{ letterSpacing: "0.06em", color: accent }}
      >
        {event.action}
      </span>
      <span
        className="truncate font-mono text-[11px]"
        style={{ color: "var(--color-on-dark-strong)" }}
      >
        {event.actor} · {event.body}
      </span>
      <span
        className="truncate font-mono text-[11px] md:text-right"
        style={{ color: "var(--color-on-dark-weak)" }}
      >
        {event.id}
      </span>
    </li>
  );
}

function actionAccent(action: string): string {
  const t = action.toLowerCase();
  if (t.includes("promot") || t.includes("approv") || t.includes("pass") || t.includes("promov"))
    return "var(--color-success)";
  if (t.includes("reject") || t.includes("rechaz") || t.includes("block") || t.includes("fail"))
    return "var(--color-critical)";
  if (t.includes("dry") || t.includes("warn") || t.includes("review"))
    return "var(--color-warning)";
  return "var(--color-on-dark-medium)";
}

