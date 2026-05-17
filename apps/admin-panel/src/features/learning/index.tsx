/**
 * Aprendizaje supervisado — port LITERAL desde Pencil frame `jkGrg` / `vo9ot`.
 *
 * Estructura:
 *   Header (vnIjB): Welcome 598w + OpenClaw prompt 523w (gradient)
 *   KPI row (vjrUu): 4 cards (Habilidades / Lecciones / Precisión / Pendientes)
 *   Plan + Skills (F8tXWx): Plan de aprendizaje (flex) + Habilidades de OpenClaw 380w
 *   Evidencia curada (La9pF): tabla 7 columnas
 *   Cola retroalimentación (V0QJTS): 3 sugerencias
 *   Audit strip dark (W4egWR): 5 audit rows con sha256 hashes
 */

import {
  ArrowRight,
  ArrowUp,
  BookOpen,
  Eye,
  History,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  WandSparkles
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import { formatDateTime } from "../../shared/lib/formatters.ts";

export function LearningSection({ data }: { data: DashboardData }) {
  return (
    <section className="flex flex-col" style={{ gap: 20, maxWidth: 1352 }}>
      <Header generatedAt={data.learningPlan.generatedAt} />
      <KpiRow />
      <PlanAndSkills />
      <EvidenciaCurada />
      <ColaRetroalimentacion />
      <AuditStrip />
    </section>
  );
}

/* ============================================================
 * Header
 * ============================================================ */
function Header({ generatedAt }: { generatedAt: string }) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,598px)_minmax(0,523px)] items-start">
      <Welcome generatedAt={generatedAt} />
      <OpenClawPrompt />
    </div>
  );
}

function Welcome({ generatedAt }: { generatedAt: string }) {
  return (
    <header className="flex flex-col" style={{ gap: 6 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[#EA580C]"
          style={{ letterSpacing: "1.2px" }}
        >
          APRENDIZAJE SUPERVISADO
        </span>
        <span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "#8A8073" }} />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Actualizado {formatDateTime(generatedAt)}
        </span>
      </div>
      <h1
        className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
        style={{ letterSpacing: "-0.4px" }}
      >
        OpenClaw aprende con humanos al volante.
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        Ninguna habilidad se promueve sin evidencia curada, dry-run estable, evaluación auditada
        y aprobación humana.
      </p>
    </header>
  );
}

function OpenClawPrompt() {
  return (
    <div
      style={{
        borderRadius: 12,
        padding: 2,
        background: "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)",
        boxShadow: "0 6px 18px rgba(146, 64, 14, 0.13)"
      }}
    >
      <div className="flex flex-col bg-[#FFFFFF]" style={{ borderRadius: 10, padding: 16, gap: 12 }}>
        <header className="flex items-center" style={{ gap: 10 }}>
          <span
            aria-hidden="true"
            className="grid place-items-center"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)",
              color: "#FFFBF5"
            }}
          >
            <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
              OpenClaw
            </span>
            <span
              className="text-[10px] font-[family-name:var(--font-caption)] text-[#8A8073]"
              style={{ letterSpacing: "0.4px" }}
            >
              Operador supervisado
            </span>
          </div>
          <span className="flex-1" aria-hidden="true" />
          <span
            className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              background: "#F7F2EA",
              border: "1px solid #EAE0CE",
              color: "#5C544A",
              letterSpacing: "0.4px"
            }}
          >
            read-only
          </span>
        </header>

        <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#1A1410]">
          Hay 3 lecciones nuevas listas para revisión humana antes de pasar a evaluación. Te dejo
          el plan ordenado por impacto.
        </p>

        <div
          aria-hidden="true"
          className="flex items-center"
          style={{
            gap: 8,
            padding: "10px 12px",
            borderRadius: 8,
            background: "#F7F2EA",
            border: "1px solid #EAE0CE"
          }}
        >
          <span className="flex-1 text-[12px] font-[family-name:var(--font-sans)] text-[#8A8073]">
            Responde a OpenClaw…
          </span>
          <ArrowUp size={14} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
        </div>

        <div className="flex items-center" style={{ gap: 8 }}>
          <button
            type="button"
            className="inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5]"
            style={{ gap: 6, padding: "10px 14px", borderRadius: 6, background: "#1A1410" }}
          >
            <WandSparkles size={14} strokeWidth={1.75} aria-hidden="true" />
            Ver plan ordenado
          </button>
          <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
            promoción fuera del panel
          </span>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * KPI row — 4 cards (Habilidades / Lecciones / Precisión / Pendientes)
 * ============================================================ */
function KpiRow() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 14 }}>
      <KpiHabilidades />
      <KpiLecciones />
      <KpiPrecision />
      <KpiPendientes />
    </div>
  );
}

function KpiShell({ children }: { children: React.ReactNode }) {
  return (
    <article
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        gap: 12,
        padding: 16,
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      {children}
    </article>
  );
}

function KpiHabilidades() {
  return (
    <KpiShell>
      <KpiHead label="Habilidades supervisadas" pillBg="#DCFCE7" pillFg="#15803D" pillText="todas activas" />
      <KpiValue value="6" />
      <KpiDetail
        icon={<Sparkles size={12} strokeWidth={1.75} />}
        text="todas supervisadas"
        color="#EA580C"
        endpoint="/v1/openclaw/skills"
      />
      <div className="flex flex-wrap" style={{ gap: 6 }}>
        {["DNS", "warming", "cumplimiento"].map((c) => (
          <span
            key={c}
            className="inline-block text-[10px] font-[family-name:var(--font-mono)]"
            style={{ padding: "3px 8px", borderRadius: 4, background: "#DCFCE7", color: "#15803D" }}
          >
            {c}
          </span>
        ))}
      </div>
    </KpiShell>
  );
}

function KpiLecciones() {
  return (
    <KpiShell>
      <KpiHead label="Lecciones curadas" pillBg="#DBEAFE" pillFg="#1D4ED8" pillText="+12 esta semana" />
      <KpiValue value="142" />
      <KpiDetail
        icon={<BookOpen size={12} strokeWidth={1.75} />}
        text="+12 esta semana"
        color="#1D4ED8"
        endpoint="/v1/openclaw/lessons"
      />
      <div
        className="relative overflow-hidden w-full"
        style={{ height: 6, borderRadius: 3, background: "#F7F2EA" }}
        aria-hidden="true"
      >
        <span
          className="block"
          style={{
            width: "75%",
            height: "100%",
            background: "linear-gradient(90deg, #FACC15 0%, #EA580C 100%)",
            borderRadius: 3
          }}
        />
      </div>
    </KpiShell>
  );
}

function KpiPrecision() {
  return (
    <KpiShell>
      <KpiHead label="Tasa de precisión" pillBg="#FEF3C7" pillFg="#B45309" pillText="objetivo ≥ 90%" />
      <KpiValue value="92,4%" unit="objetivo ≥ 90%" />
      <KpiDetail
        icon={<TrendingUp size={12} strokeWidth={1.75} />}
        text="+1,8 vs sem prev"
        color="#15803D"
        endpoint="/v1/openclaw/eval"
      />
      <div
        className="relative overflow-hidden w-full"
        style={{ height: 6, borderRadius: 3, background: "#F7F2EA" }}
        aria-hidden="true"
      >
        <span className="block" style={{ width: "92%", height: "100%", background: "#B45309", borderRadius: 3 }} />
      </div>
    </KpiShell>
  );
}

function KpiPendientes() {
  return (
    <KpiShell>
      <KpiHead label="Pendientes de revisión" pillBg="#FEE2E2" pillFg="#B91C1C" pillText="esperan humano" />
      <KpiValue value="3" />
      <KpiDetail
        icon={<ShieldAlert size={12} strokeWidth={1.75} />}
        text="esperan humano"
        color="#B91C1C"
        endpoint="/v1/openclaw/queue"
      />
      <div className="flex flex-wrap" style={{ gap: 6 }}>
        {["DNS drift", "warming step", "ingreso de evidencia"].map((c) => (
          <span
            key={c}
            className="inline-block text-[10px] font-[family-name:var(--font-mono)]"
            style={{ padding: "3px 8px", borderRadius: 4, background: "#FEE2E2", color: "#B91C1C" }}
          >
            {c}
          </span>
        ))}
      </div>
    </KpiShell>
  );
}

function KpiHead({ label, pillBg, pillFg, pillText }: { label: string; pillBg: string; pillFg: string; pillText: string }) {
  return (
    <div className="flex items-center" style={{ gap: 8 }}>
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#5C544A]"
        style={{ letterSpacing: "0.4px" }}
      >
        {label}
      </span>
      <span className="flex-1" aria-hidden="true" />
      <span
        className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
        style={{ padding: "2px 6px", borderRadius: 4, background: pillBg, color: pillFg }}
      >
        {pillText}
      </span>
    </div>
  );
}

function KpiValue({ value, unit }: { value: string; unit?: string }) {
  return (
    <div className="flex items-end" style={{ gap: 8 }}>
      <span
        className="text-[32px] font-[family-name:var(--font-mono)] font-bold leading-none text-[#1A1410] tabular-nums"
        style={{ letterSpacing: "-0.6px" }}
      >
        {value}
      </span>
      {unit ? (
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073] leading-none">
          {unit}
        </span>
      ) : null}
    </div>
  );
}

function KpiDetail({
  icon,
  text,
  color,
  endpoint
}: {
  icon: React.ReactNode;
  text: string;
  color: string;
  endpoint: string;
}) {
  return (
    <div className="flex items-center" style={{ gap: 6 }}>
      <span style={{ color }} aria-hidden="true">
        {icon}
      </span>
      <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold" style={{ color }}>
        {text}
      </span>
      <span className="flex-1" aria-hidden="true" />
      <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{endpoint}</span>
    </div>
  );
}

/* ============================================================
 * Plan + Skills (F8tXWx)
 * ============================================================ */
function PlanAndSkills() {
  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
      <PlanCard />
      <SkillsCard />
    </div>
  );
}

const PLAN_MILESTONES = [
  {
    order: "01",
    title: "Curar evidencia DNS drift",
    state: "En curso",
    stateBg: "#FEF3C7",
    stateFg: "#B45309",
    body: "OpenClaw etiqueta 9 incidentes nuevos. El operador revisa antes de proponer el ajuste de umbral.",
    meta: "responsable · operador · ETA 14:00"
  },
  {
    order: "02",
    title: "Dry-run habilidad ‘pausar IP caliente’",
    state: "Listo para revisión",
    stateBg: "#DBEAFE",
    stateFg: "#1D4ED8",
    body: "10 ejecuciones sintéticas estables · escenario clúster A · log auditable.",
    meta: "evidencia · run-2026-05-14-04"
  },
  {
    order: "03",
    title: "Evaluación humana de precisión",
    state: "Programado",
    stateBg: "#EDE9FE",
    stateFg: "#7C3AED",
    body: "Mañana 09:00 · panel humano firma desbloqueo si precisión ≥ 90% sin regresiones.",
    meta: "panel · 4 revisores"
  },
  {
    order: "04",
    title: "Promoción supervisada",
    state: "Bloqueado por gate",
    stateBg: "#FEE2E2",
    stateFg: "#B91C1C",
    body: "Requiere que rollback definitions estén firmados antes del despliegue.",
    meta: "gate · definiciones rollback"
  }
];

function PlanCard() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header
        className="flex items-center"
        style={{
          gap: 12,
          padding: "16px 20px 14px 20px",
          borderBottom: "1px solid #EAE0CE"
        }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Plan de aprendizaje
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            4 hitos · cada gate humano queda en bitácora
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ padding: "3px 8px", borderRadius: 4, background: "#FEF3C7", color: "#B45309" }}
        >
          en curso
        </span>
      </header>

      <ol className="m-0 p-0 list-none flex flex-col" style={{ padding: "8px 20px 18px 20px" }}>
        {PLAN_MILESTONES.map((m) => (
          <li
            key={m.order}
            className="flex items-start"
            style={{ gap: 14, padding: "14px 0", borderBottom: "1px solid #EAE0CE" }}
          >
            <span
              aria-hidden="true"
              className="grid place-items-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: m.stateBg,
                color: m.stateFg,
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                fontWeight: 700
              }}
            >
              {m.order}
            </span>
            <div className="flex flex-col flex-1 min-w-0" style={{ gap: 4 }}>
              <div className="flex items-center" style={{ gap: 8 }}>
                <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
                  {m.title}
                </h3>
                <span
                  className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                  style={{
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: m.stateBg,
                    color: m.stateFg,
                    letterSpacing: "0.4px"
                  }}
                >
                  {m.state}
                </span>
              </div>
              <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#5C544A]">
                {m.body}
              </p>
              <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{m.meta}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const SKILLS = [
  { title: "Recomendar degradación", state: "supervisada", stateBg: "#DCFCE7", stateFg: "#15803D", endpoint: "/v1/openclaw/skills/degradation" },
  { title: "Detectar drift DNS", state: "supervisada", stateBg: "#DCFCE7", stateFg: "#15803D", endpoint: "/v1/openclaw/skills/dns-drift" },
  { title: "Pausar IP caliente", state: "dry-run", stateBg: "#DBEAFE", stateFg: "#1D4ED8", endpoint: "/v1/openclaw/skills/pause-ip" },
  { title: "Curar evidencia", state: "supervisada", stateBg: "#DCFCE7", stateFg: "#15803D", endpoint: "/v1/openclaw/skills/curate" },
  { title: "Sugerir runbook SSH", state: "en evaluación", stateBg: "#EDE9FE", stateFg: "#7C3AED", endpoint: "/v1/openclaw/skills/ssh-runbook" },
  { title: "Auto-promoción habilidades", state: "bloqueada", stateBg: "#FEE2E2", stateFg: "#B91C1C", endpoint: "/v1/openclaw/skills/auto-promote" }
];

function SkillsCard() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header
        className="flex items-center"
        style={{ gap: 12, padding: "16px 18px 14px 18px", borderBottom: "1px solid #EAE0CE" }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Habilidades de OpenClaw
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            Cada una requiere supervisión humana
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ padding: "3px 8px", borderRadius: 4, background: "#DCFCE7", color: "#15803D" }}
        >
          6 / 6
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {SKILLS.map((s, i) => (
          <li
            key={s.title}
            className="flex flex-col"
            style={{
              gap: 6,
              padding: "12px 18px",
              borderBottom: i < SKILLS.length - 1 ? "1px solid #EAE0CE" : "none"
            }}
          >
            <div className="flex items-center" style={{ gap: 8 }}>
              <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
                {s.title}
              </span>
              <span className="flex-1" aria-hidden="true" />
              <span
                className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                style={{
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: s.stateBg,
                  color: s.stateFg,
                  letterSpacing: "0.4px"
                }}
              >
                {s.state}
              </span>
            </div>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{s.endpoint}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ============================================================
 * Evidencia curada — tabla 7 columnas
 * ============================================================ */
const EVIDENCE_ROWS = [
  ["snap-7f2a91c4", "DNS drift", "Zona delivrix.io con SPF/DKIM en derivación", "operador@delivrix", "2026-05-14", "GET-only", "alto"],
  ["snap-7e44ab21", "Promo skill", "Habilidad 'Recomendar degradación' propone reducir warming", "openclaw-eval", "2026-05-14", "GET-only", "alto"],
  ["snap-b0f1ad12", "Evidencia humana", "Operador marca DNS como 'pendiente de propagación'", "operador@delivrix", "2026-05-14", "GET-only", "medio"],
  ["snap-1c92cd03", "Promoción", "Detectar drift DNS actualiza umbral a 87%", "openclaw-auto", "2026-05-13", "GET-only", "medio"],
  ["snap-33de44ef", "Evaluación", "Regla de pausa enviada a panel de revisión humana", "openclaw-eval", "2026-05-13", "GET-only", "bajo"],
  ["snap-fa07b3c2", "Curated lesson", "IP 185.243.12.031 etiquetada como transactional EU", "operador@delivrix", "2026-05-12", "GET-only", "bajo"]
];

function EvidenciaCurada() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header
        className="flex items-center"
        style={{ gap: 12, padding: "16px 20px 14px 20px", borderBottom: "1px solid #EAE0CE" }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Evidencia curada por OpenClaw
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            Snapshots, notas y anotaciones humanas que alimentan cada habilidad
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          contrato · /v1/openclaw/evidence
        </span>
        <span
          className="inline-flex items-center text-[9px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            gap: 4,
            padding: "3px 8px",
            borderRadius: 4,
            background: "#DBEAFE",
            color: "#1D4ED8",
            letterSpacing: "0.6px"
          }}
        >
          <Eye size={10} strokeWidth={2} aria-hidden="true" />
          GET-only
        </span>
      </header>

      {/* header row */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "120px 140px minmax(0,1fr) 110px 120px 120px 80px",
          gap: 12,
          padding: "10px 20px",
          background: "#F7F2EA",
          borderBottom: "1px solid #EAE0CE"
        }}
      >
        {["EVIDENCIA", "TIPO", "DESCRIPCIÓN", "ACTOR", "FECHA", "MODO", "IMPACTO"].map((h) => (
          <span
            key={h}
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
            style={{ letterSpacing: "0.6px" }}
          >
            {h}
          </span>
        ))}
      </div>

      <div className="flex flex-col">
        {EVIDENCE_ROWS.map((row, i) => (
          <div
            key={i}
            className="grid items-center"
            style={{
              gridTemplateColumns: "120px 140px minmax(0,1fr) 110px 120px 120px 80px",
              gap: 12,
              padding: "12px 20px",
              borderBottom: i < EVIDENCE_ROWS.length - 1 ? "1px solid #EAE0CE" : "none"
            }}
          >
            <code className="text-[11px] font-[family-name:var(--font-mono)] text-[#1A1410]">{row[0]}</code>
            <span className="text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[#EA580C]">
              {row[1]}
            </span>
            <span className="text-[12px] font-[family-name:var(--font-sans)] text-[#5C544A] truncate">
              {row[2]}
            </span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A] truncate">
              {row[3]}
            </span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">{row[4]}</span>
            <span
              className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
              style={{
                padding: "2px 6px",
                borderRadius: 4,
                background: "#DBEAFE",
                color: "#1D4ED8",
                width: "fit-content"
              }}
            >
              {row[5]}
            </span>
            <span
              className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
              style={{
                padding: "2px 8px",
                borderRadius: 999,
                background:
                  row[6] === "alto" ? "#FEE2E2" : row[6] === "medio" ? "#FEF3C7" : "#DCFCE7",
                color: row[6] === "alto" ? "#B91C1C" : row[6] === "medio" ? "#B45309" : "#15803D",
                letterSpacing: "0.4px",
                width: "fit-content"
              }}
            >
              {row[6]}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ============================================================
 * Cola de retroalimentación humana — 3 sugerencias
 * ============================================================ */
function ColaRetroalimentacion() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header
        className="flex items-center"
        style={{ gap: 12, padding: "16px 20px 14px 20px", borderBottom: "1px solid #EAE0CE" }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Cola de retroalimentación humana
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            Sugerencias listas para que el operador acepte o rechace fuera del panel
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            padding: "3px 8px",
            borderRadius: 4,
            background: "#DBEAFE",
            color: "#1D4ED8",
            letterSpacing: "0.6px"
          }}
        >
          GET-only · aprobación fuera del panel
        </span>
      </header>

      <FeedbackRow
        iconBg="#FEF3C7"
        iconColor="#B45309"
        title="Subir warming clúster A al día 10"
        desc="OpenClaw recomienda continuar el plan. Quejas se mantienen bajo 0,18%."
        meta="contrato · /v1/warming/plan · hace 2 min"
      />
      <FeedbackRow
        iconBg="#DBEAFE"
        iconColor="#1D4ED8"
        title="Curar drift DNS delivrix.io"
        desc="Detecta cambios SPF/DKIM/DMARC desde el último snapshot estable."
        meta="contrato · /v1/dns/plan · hace 18 min"
        showBorder
      />
      <FeedbackRow
        iconBg="#FEE2E2"
        iconColor="#B91C1C"
        title="Bloquear adaptador SSH nodo-envio-04"
        desc="Sin regla de 2 personas firmada. OpenClaw mantiene SSH apagado."
        meta="runbook · ssh-gate.md · hace 1 h"
        last
      />
    </section>
  );
}

function FeedbackRow({
  iconBg,
  iconColor,
  title,
  desc,
  meta,
  showBorder,
  last
}: {
  iconBg: string;
  iconColor: string;
  title: string;
  desc: string;
  meta: string;
  showBorder?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-center"
      style={{
        gap: 14,
        padding: "14px 20px",
        borderBottom: last ? "none" : "1px solid #EAE0CE",
        background: showBorder ? "#FFFFFF" : "#FFFFFF"
      }}
    >
      <span
        aria-hidden="true"
        className="grid place-items-center shrink-0"
        style={{ width: 36, height: 36, borderRadius: 8, background: iconBg, color: iconColor }}
      >
        <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="flex flex-col flex-1 min-w-0" style={{ gap: 2 }}>
        <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
          {title}
        </h3>
        <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#5C544A]">
          {desc}
        </p>
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{meta}</span>
      </div>
      <div className="flex flex-col" style={{ gap: 6 }}>
        <button
          type="button"
          className="inline-flex items-center text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]"
          style={{
            gap: 6,
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #D4C5A8",
            background: "transparent"
          }}
        >
          Revisar
          <ArrowRight size={11} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/* ============================================================
 * Audit strip (dark) — 5 audit rows con sha256 hashes
 * ============================================================ */
const AUDIT_LINES = [
  {
    ts: "09:02:17",
    action: "curated_lesson_added",
    body: "operador · IP 185.243.12.031 etiquetada como transactional EU",
    hash: "sha256:fa07…"
  },
  {
    ts: "08:55:38",
    action: "skill_evaluation_queued",
    body: "openclaw-eval · regla de pausa enviada a panel de revisión humana",
    hash: "sha256:33de…"
  },
  {
    ts: "08:42:09",
    action: "feedback_recorded",
    body: "operador · marca evidencia DNS como ‘pendiente de propagación’",
    hash: "sha256:b0f1…"
  },
  {
    ts: "08:34:21",
    action: "lesson_promoted",
    body: "openclaw-auto · habilidad ‘Detectar drift DNS’ actualiza umbral a 87%",
    hash: "sha256:7e44…"
  },
  {
    ts: "08:21:47",
    action: "skill_promotion_requested",
    body: "openclaw-eval · pide promover ‘Recomendar degradación’ a producción supervisada",
    hash: "sha256:1c92…"
  }
];

function AuditStrip() {
  return (
    <section
      className="flex flex-col"
      style={{
        gap: 10,
        padding: "14px 18px",
        borderRadius: 8,
        background: "#1A1410",
        boxShadow: "0 6px 18px rgba(0, 0, 0, 0.13)"
      }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <History size={14} strokeWidth={1.75} aria-hidden="true" style={{ color: "#FACC15" }} />
        <span className="text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#FFFBF5]">
          Bitácora del aprendizaje
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)]" style={{ color: "rgba(255, 251, 245, 0.4)" }}>
          contrato · /v1/openclaw/audit
        </span>
      </header>

      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 4 }}>
        {AUDIT_LINES.map((a, i) => (
          <li
            key={i}
            className="grid items-center"
            style={{
              gridTemplateColumns: "80px 220px minmax(0,1fr) auto",
              gap: 14,
              padding: "6px 0"
            }}
          >
            <span
              className="text-[11px] font-[family-name:var(--font-mono)]"
              style={{ color: "rgba(255, 251, 245, 0.4)" }}
            >
              {a.ts}
            </span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] font-bold" style={{ color: "#FACC15" }}>
              {a.action}
            </span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#FFFBF5] truncate">
              {a.body}
            </span>
            <span
              className="text-[11px] font-[family-name:var(--font-mono)]"
              style={{ color: "rgba(255, 251, 245, 0.4)" }}
            >
              {a.hash}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
