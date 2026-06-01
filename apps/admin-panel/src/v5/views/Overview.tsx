/**
 * v5 Overview — Vista General desde cero.
 *
 * Layout:
 *   Hero (eyebrow + display + body + LiveIndicator)
 *   Section "Métricas operativas" — KPI grid 4 cols
 *   Section "Flujo operativo" — 5 stages horizontal
 *   Section "Aprobaciones pendientes" — list + Gates side panel
 *
 * Disciplina:
 *   - Densidad alta (target sin scroll a 1440x900).
 *   - Tabular-nums en todo número comparable.
 *   - Una sola Caveat per vista permitida (frase de OpenClaw).
 *   - Cero shadows estáticas. Cero pills saturadas. Cero side-tabs.
 */

import { motion } from "framer-motion";
import {
  ArrowRight,
  Clock,
  Flame,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  TriangleAlert
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client";
import { staggerContainer, staggerItem } from "../lib/motion";
import {
  Badge,
  Body,
  BodySm,
  Button,
  Caption,
  Card,
  Display,
  Eyebrow,
  H2,
  H3,
  HumanNote,
  MonoCode,
  MonoData,
  Pill,
  SectionHead,
  Stat
} from "../components/primitives";
import { cn } from "../lib/cn";

export interface OverviewV5Props {
  data: DashboardData;
  onNavigate?: (section: string) => void;
}

export function OverviewV5({ data, onNavigate }: OverviewV5Props) {
  const opSummary = data.operationalSummary;
  const senderByStatus = opSummary.senderNodesByStatus ?? data.overview.summary.senderNodesByStatus ?? {};
  const senderTotal = data.senderNodes.length || Object.values(senderByStatus).reduce((a, b) => a + b, 0);
  const ipsWarming = senderByStatus.warming ?? 0;
  const sendByStatus = opSummary.sendResultsByStatus ?? data.overview.summary.sendResultsByStatus ?? {};
  const totalSends = Object.values(sendByStatus).reduce((a, b) => a + b, 0);
  const accepted = sendByStatus.sent ?? sendByStatus.delivered ?? 0;
  const reputation = totalSends === 0 ? null : Math.round((accepted / totalSends) * 1000) / 10;
  const gatesOpen = data.operatingNorth.gates?.length ?? 0;
  const approvals = data.canvas.requiresHumanApproval ?? [];

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <Hero generatedAt={data.overview.generatedAt} />
      </motion.div>

      <motion.div variants={staggerItem}>
        <BannerOpenClaw />
      </motion.div>

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Estado actual"
          title="Métricas operativas"
          caption={<>Actualizado cada 5 segundos · <MonoCode>panel-aggregator</MonoCode></>}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Nodos de envío"
            value={senderTotal}
            unit="activos"
            hint={`${Object.keys(senderByStatus).length} clases en operación`}
            pill={{ tone: "success", label: "activos" }}
            spark={<NodesSpark byStatus={senderByStatus} />}
          />
          <KpiCard
            label="IPs en calentamiento"
            value={ipsWarming}
            unit="warming"
            hint={ipsWarming === 0 ? "Sin warmup en curso" : "Calentamiento supervisado"}
            pill={{ tone: ipsWarming > 0 ? "warning" : "neutral", label: ipsWarming > 0 ? "en curso" : "idle" }}
            icon={<Flame size={14} strokeWidth={1.75} className="text-fg-subtle" />}
          />
          <KpiCard
            label="Índice de reputación"
            value={reputation === null ? "—" : reputation.toFixed(1)}
            unit="/ 100"
            hint={reputation === null ? "Sin tráfico en el snapshot" : `${accepted}/${totalSends} aceptados`}
            pill={{
              tone: reputation === null ? "neutral" : reputation < 60 ? "critical" : reputation < 85 ? "warning" : "success",
              label: reputation === null ? "sin datos" : reputation < 60 ? "crítico" : reputation < 85 ? "vigilar" : "saludable"
            }}
            valueTone={reputation === null ? "default" : reputation < 60 ? "critical" : reputation < 85 ? "warning" : "success"}
          />
          <KpiCard
            label="Gates abiertos"
            value={gatesOpen}
            unit="pendientes"
            hint={gatesOpen === 0 ? "Sin pendientes humanas" : "Esperan aprobación humana"}
            pill={{ tone: gatesOpen > 0 ? "warning" : "success", label: gatesOpen > 0 ? "revisar" : "limpio" }}
            icon={<ShieldAlert size={14} strokeWidth={1.75} className="text-fg-subtle" />}
          />
        </div>
      </motion.section>

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Pipeline supervisado"
          title="Flujo operativo"
          caption={
            <>
              <MonoCode>onboarding → planificación → provisión → calentamiento → reputación</MonoCode>
            </>
          }
          trailing={
            <Button variant="ghost" size="sm" onClick={() => onNavigate?.("canvas")}>
              Abrir Canvas
              <ArrowRight size={12} strokeWidth={1.75} />
            </Button>
          }
        />
        <PipelineRow />
      </motion.section>

      <motion.section variants={staggerItem} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <ApprovalsCard approvals={approvals} />
        <GatesCard data={data} />
      </motion.section>
    </motion.div>
  );
}

/* ============================================================
 * Hero
 * ============================================================ */

function Hero({ generatedAt }: { generatedAt: string }) {
  const updatedAt = formatLocalDateTime(generatedAt);
  return (
    <header className="flex items-start gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <Eyebrow>Inicio operativo</Eyebrow>
          <span aria-hidden="true" className="inline-block size-[3px] rounded-full bg-border-strong" />
          <MonoCode>Actualizado {updatedAt}</MonoCode>
        </div>
        <Display>Capacidad preparada, sin envíos reales.</Display>
        <Body className="max-w-[640px]">
          Delivrix gobierna infraestructura de correo autorizada en modo solo lectura.
          OpenClaw observa, valida y propone. Los humanos aprueban cada acción real.
        </Body>
      </div>
      <Card tone="quiet" padding="compact" className="hidden shrink-0 flex-col items-end gap-1 lg:flex">
        <Eyebrow>Snapshot</Eyebrow>
        <MonoData className="text-[14px]">06h 18m</MonoData>
        <Caption>desde último deploy</Caption>
      </Card>
    </header>
  );
}

/* ============================================================
 * BannerOpenClaw — single high-priority note del agente
 * ============================================================ */

function BannerOpenClaw() {
  return (
    <Card padding="relaxed" className="flex items-start gap-4 bg-surface">
      <div className="grid size-9 shrink-0 place-items-center rounded-md bg-warning-soft text-warning">
        <TriangleAlert size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Eyebrow>OpenClaw propone</Eyebrow>
          <Pill tone="warning" size="sm">
            Dry-run
          </Pill>
        </div>
        <H3>Dos clústeres de envío esperan aprobación humana</H3>
        <BodySm>
          Las quejas del clúster A superaron 0.18% en los últimos 4 snapshots. Preparé un
          plan de degradación gradual en modo dry-run, sin tocar producción.
        </BodySm>
        <HumanNote className="mt-1 max-w-[640px]">
          Si querés revisarlo conmigo paso por paso, abrí el chat y te lo explico antes de firmar.
        </HumanNote>
        <div className="mt-1 flex items-center gap-2">
          <Button variant="primary" size="sm">
            Revisar plan
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
 * KPI Card
 * ============================================================ */

interface KpiCardProps {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  pill?: { tone: "neutral" | "success" | "warning" | "critical"; label: string };
  valueTone?: "default" | "success" | "warning" | "critical";
  icon?: React.ReactNode;
  spark?: React.ReactNode;
}

function KpiCard({ label, value, unit, hint, pill, valueTone, icon, spark }: KpiCardProps) {
  return (
    <Card padding="relaxed" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <Eyebrow className="leading-[1.2]">{label}</Eyebrow>
        {pill ? (
          <Pill tone={pill.tone} size="sm">
            {pill.label}
          </Pill>
        ) : icon}
      </div>
      <Stat
        label=""
        value={String(value)}
        unit={unit}
        tone={valueTone}
        className="min-h-[64px] gap-0"
      />
      {hint ? <Caption>{hint}</Caption> : null}
      {spark ? <div className="mt-1">{spark}</div> : null}
    </Card>
  );
}

function NodesSpark({ byStatus }: { byStatus: Record<string, number> }) {
  const order = ["onboarding", "warming", "active", "paused", "quarantined"];
  const max = Math.max(1, ...Object.values(byStatus));
  return (
    <div className="flex items-end gap-1" aria-hidden="true">
      {order.map((k) => {
        const v = byStatus[k] ?? 0;
        const h = Math.max(3, Math.round((v / max) * 28));
        return (
          <span
            key={k}
            title={`${k}: ${v}`}
            className="block w-3 rounded-sm bg-border-strong"
            style={{ height: h }}
          />
        );
      })}
    </div>
  );
}

/* ============================================================
 * PipelineRow
 * ============================================================ */

const PIPELINE_STAGES = [
  { id: "onboarding", label: "Onboarding", hint: "Servidor, IPs y dominios capturados", status: "ok", progress: 100, detail: "6 / 6 pasos" },
  { id: "planning", label: "Planificación", hint: "Plan de topología generado dry-run", status: "ok", progress: 100, detail: "contrato · /v1/clusters/plan" },
  { id: "provisioning", label: "Provisión", hint: "Postfix · DKIM · TLS · DNS · plan calentamiento", status: "warn", progress: 62, detail: "dry-run en curso" },
  { id: "warming", label: "Calentamiento", hint: "42 IPs · espera aprobación humana", status: "warn", progress: 18, detail: "requiere gate" },
  { id: "reputation", label: "Reputación", hint: "Observadores listos · tráfico simulado", status: "info", progress: 0, detail: "sin envíos reales" }
] as const;

function PipelineRow() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
      {PIPELINE_STAGES.map((stage, i) => (
        <Card key={stage.id} padding="relaxed" className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <Eyebrow>Etapa {String(i + 1).padStart(2, "0")}</Eyebrow>
            <Pill
              tone={stage.status === "ok" ? "success" : stage.status === "warn" ? "warning" : "neutral"}
              size="sm"
            >
              {stage.status === "ok" ? "ok" : stage.status === "warn" ? "atención" : "idle"}
            </Pill>
          </div>
          <H3>{stage.label}</H3>
          <BodySm className="leading-[1.45]">{stage.hint}</BodySm>
          <ProgressBar value={stage.progress} tone={stage.status} />
          <MonoCode>{stage.detail}</MonoCode>
        </Card>
      ))}
    </div>
  );
}

function ProgressBar({ value, tone }: { value: number; tone: "ok" | "warn" | "info" }) {
  const color =
    tone === "ok" ? "var(--color-success)" : tone === "warn" ? "var(--color-warning)" : "var(--color-fg-subtle)";
  return (
    <div className="relative h-1 w-full overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
      <span
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
        style={{ width: `${Math.max(2, value)}%`, background: color }}
      />
    </div>
  );
}

/* ============================================================
 * Approvals
 * ============================================================ */

function ApprovalsCard({ approvals }: { approvals: string[] }) {
  return (
    <Card padding="relaxed" className="flex flex-col gap-3">
      <SectionHead
        eyebrow="Pendiente"
        title="Aprobaciones humanas"
        caption="Cada acción que un humano debe firmar antes de tocar producción"
        count={approvals.length}
        countTone={approvals.length === 0 ? "success" : "warning"}
      />
      {approvals.length === 0 ? (
        <div className="flex items-center gap-3 py-3">
          <ShieldCheck size={16} className="text-success" strokeWidth={1.75} />
          <BodySm>Cola limpia. Todas las acciones supervisadas están autorizadas.</BodySm>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {approvals.slice(0, 5).map((id) => {
            const kind = id.includes("ssh") ? "ssh" : id.includes("dns") ? "dns" : id.includes("smtp") ? "smtp" : "humano";
            const tone = kind === "dns" ? "critical" : kind === "ssh" ? "warning" : "neutral";
            return (
              <li
                key={id}
                className="group flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 transition-colors hover:border-border-strong"
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-1.5 rounded-full"
                  style={{
                    background:
                      tone === "critical"
                        ? "var(--color-critical)"
                        : tone === "warning"
                        ? "var(--color-warning)"
                        : "var(--color-fg-subtle)"
                  }}
                />
                <span className="font-sans text-[13px] font-medium text-fg">{id.replace(/_/g, " ")}</span>
                <Pill tone={tone as never} size="sm">
                  {kind}
                </Pill>
                <span className="flex-1" aria-hidden="true" />
                <Button variant="ghost" size="sm">
                  Revisar
                  <ArrowRight size={11} strokeWidth={1.75} />
                </Button>
              </li>
            );
          })}
          {approvals.length > 5 ? (
            <Button variant="link" size="sm" className="self-start">
              Ver {approvals.length - 5} más
            </Button>
          ) : null}
        </ul>
      )}
    </Card>
  );
}

/* ============================================================
 * Gates side panel
 * ============================================================ */

function GatesCard({ data }: { data: DashboardData }) {
  const gates = (data.operatingNorth.gateDetails ?? data.operatingNorth.gates?.map((g) => ({ id: g, displayLabel: g })) ?? []).slice(0, 8);
  const total = data.operatingNorth.gates?.length ?? 0;
  const verified = 6;
  return (
    <Card tone="quiet" padding="relaxed" className="flex flex-col gap-3">
      <SectionHead
        eyebrow="Gates"
        title="No negociables"
        caption={`${verified} verificados · ${total - verified} en revisión`}
      />
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {gates.map((g) => (
          <li
            key={g.id}
            className="flex items-center gap-2"
            title={g.id}
          >
            <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-warning" />
            <span className="flex-1 truncate font-sans text-[12.5px] text-fg-muted">
              {g.displayLabel}
            </span>
            <Caption className="font-mono text-[10px]">pend.</Caption>
          </li>
        ))}
      </ul>
      {total > gates.length ? (
        <Button variant="link" size="sm" className="self-start">
          Ver los {total} gates
        </Button>
      ) : null}
    </Card>
  );
}

/* ============================================================
 * util
 * ============================================================ */

function formatLocalDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-CO", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}
