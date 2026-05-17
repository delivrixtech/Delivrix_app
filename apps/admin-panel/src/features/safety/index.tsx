/**
 * Seguridad — port LITERAL desde Pencil frame `fAJG6` / `CUxJ8`.
 *
 * Estructura literal:
 *   Hero (r3cIV0): Welcome + OpenClaw prompt (gradient 440w)
 *   KPI row (aJ1TH): Gates aprobados / Roles / Sesiones / Eventos críticos 24h
 *   Two col (H69HQS):
 *     Left:  Kill switch grande (dark) + Gates card
 *     Right: Roles + Sesiones + Secrets (380w)
 *   Audit (McVRn): tabla 6 col x 6 filas con timestamps reales
 *   Compliance row (DQeL9): 3 cards (Privacy / Cumplimiento / Sin acciones reales)
 *   Footer (N0Fra): GET-only chip + runbook link
 */

import {
  Download,
  Laptop,
  Lock,
  Power,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Users,
  WandSparkles
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";
import { formatDateTime } from "../../shared/lib/formatters.ts";

export function SafetySection({ data }: { data: DashboardData }) {
  void data;
  return (
    <section className="flex flex-col" style={{ gap: 20, maxWidth: 1352 }}>
      <Hero />
      <KpiRow />
      <TwoCol />
      <Audit />
      <ComplianceRow />
      <Footer />
    </section>
  );
}

/* ============================================================
 * Hero (r3cIV0)
 * ============================================================ */
function Hero() {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_440px] items-start">
      <HeroLeft />
      <OpenClawPrompt />
    </div>
  );
}

function HeroLeft() {
  return (
    <header className="flex flex-col" style={{ gap: 6 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[#EA580C]"
          style={{ letterSpacing: "1.2px" }}
        >
          SEGURIDAD Y GOBIERNO
        </span>
        <span aria-hidden="true" className="rounded-[2px]" style={{ width: 4, height: 4, background: "#8A8073" }} />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          Actualizado hace 14s
        </span>
      </div>
      <h1
        className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
        style={{ letterSpacing: "-0.4px" }}
      >
        Sin acciones reales, con todas las barandillas.
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        El panel es GET-only. Toda acción operativa requiere aprobación humana, dry-run previo,
        log auditable y kill switch probado.
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
              background: "#FEF3C7",
              color: "#B45309",
              letterSpacing: "0.4px"
            }}
          >
            aviso
          </span>
        </header>
        <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.45] text-[#1A1410]">
          3 gates faltan validación de rollback. Detecté drift en SPF/DMARC del dominio
          delivrix.io — preparé el plan dry-run.
        </p>
        <div className="flex items-center" style={{ gap: 8 }}>
          <button
            type="button"
            className="inline-flex items-center justify-center text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5]"
            style={{ gap: 6, padding: "10px 14px", borderRadius: 6, background: "#1A1410" }}
          >
            <WandSparkles size={14} strokeWidth={1.75} aria-hidden="true" />
            Revisar plan dry-run
          </button>
          <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#8A8073]">
            ejecución fuera del panel
          </span>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * KPI row (aJ1TH)
 * ============================================================ */
function KpiRow() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 14 }}>
      <Kpi label="Gates aprobados" value="6" unit="/ 9 verificados" iconColor="#15803D" icon={<ShieldCheck size={12} strokeWidth={1.75} />} detail="3 pendientes" detailColor="#B45309" endpoint="/v1/security/gates" pillBg="#DCFCE7" pillFg="#15803D" pillText="6 de 9" />
      <Kpi label="Roles activos" value="4" unit="roles" iconColor="#1D4ED8" icon={<Users size={12} strokeWidth={1.75} />} detail="12 usuarios mapeados" detailColor="#5C544A" endpoint="/v1/iam/roles" pillBg="#DBEAFE" pillFg="#1D4ED8" pillText="rbac" />
      <Kpi label="Sesiones activas" value="3" unit="operadores" iconColor="#5C544A" icon={<Laptop size={12} strokeWidth={1.75} />} detail="1 ext · 2 internos" detailColor="#5C544A" endpoint="/v1/iam/sessions" pillBg="#DCFCE7" pillFg="#15803D" pillText="ok" />
      <Kpi label="Eventos críticos 24h" value="2" unit="alertas" iconColor="#B45309" icon={<TriangleAlert size={12} strokeWidth={1.75} />} detail="drift DNS · login fallido" detailColor="#B45309" endpoint="/v1/security/events" pillBg="#FEF3C7" pillFg="#B45309" pillText="atención" />
    </div>
  );
}

function Kpi({
  label,
  value,
  unit,
  icon,
  iconColor,
  detail,
  detailColor,
  endpoint,
  pillBg,
  pillFg,
  pillText
}: {
  label: string;
  value: string;
  unit: string;
  icon: React.ReactNode;
  iconColor: string;
  detail: string;
  detailColor: string;
  endpoint: string;
  pillBg: string;
  pillFg: string;
  pillText: string;
}) {
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
      <div className="flex items-end" style={{ gap: 8 }}>
        <span
          className="text-[32px] font-[family-name:var(--font-mono)] font-bold leading-none text-[#1A1410] tabular-nums"
          style={{ letterSpacing: "-0.6px" }}
        >
          {value}
        </span>
        <span className="text-[12px] font-[family-name:var(--font-mono)] text-[#8A8073] leading-none">
          {unit}
        </span>
      </div>
      <div className="flex items-center" style={{ gap: 6 }}>
        <span style={{ color: iconColor }} aria-hidden="true">
          {icon}
        </span>
        <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold" style={{ color: detailColor }}>
          {detail}
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{endpoint}</span>
      </div>
    </article>
  );
}

/* ============================================================
 * Two col (H69HQS): Kill switch grande + Gates / Roles + Sesiones + Secrets
 * ============================================================ */
function TwoCol() {
  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
      <Left />
      <Right />
    </div>
  );
}

function Left() {
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <KillSwitchGrande />
      <GatesCard />
    </div>
  );
}

function KillSwitchGrande() {
  return (
    <section
      className="flex flex-col overflow-hidden"
      style={{
        borderRadius: 10,
        background: "#1A1410",
        boxShadow: "0 6px 18px rgba(0, 0, 0, 0.13)"
      }}
    >
      <div
        className="flex items-center"
        style={{ gap: 16, padding: "20px 24px" }}
      >
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{
            width: 48,
            height: 48,
            borderRadius: 999,
            background: "linear-gradient(135deg, #FACC15 0%, #EA580C 100%)",
            color: "#1A1410"
          }}
        >
          <Power size={22} strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="flex flex-col flex-1" style={{ gap: 4 }}>
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
            style={{ color: "rgba(255, 251, 245, 0.5)", letterSpacing: "1.2px" }}
          >
            KILL SWITCH GLOBAL
          </span>
          <h2
            className="m-0 text-[20px] font-[family-name:var(--font-heading)] font-bold leading-tight"
            style={{ color: "#FFFBF5" }}
          >
            Armado · probado hace 14 min
          </h2>
          <span className="text-[12px] font-[family-name:var(--font-sans)]" style={{ color: "rgba(255, 251, 245, 0.7)" }}>
            Requiere regla de dos personas y log auditado en cada activación.
          </span>
        </div>
        <span
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
          style={{
            gap: 6,
            padding: "6px 12px",
            borderRadius: 999,
            background: "rgba(220, 252, 231, 0.16)",
            color: "#86EFAC",
            letterSpacing: "0.6px"
          }}
        >
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: "#4ADE80" }} />
          ARMADO
        </span>
      </div>
      <div
        className="grid items-center"
        style={{
          gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)",
          gap: 16,
          padding: "14px 24px",
          background: "#0A0805",
          borderTop: "1px solid rgba(255, 251, 245, 0.08)"
        }}
      >
        <KillStat label="responsables" value="sre-01 · sre-02" />
        <KillStat label="prueba dry-run" value="cada 24 h" />
        <KillStat label="último uso real" value="nunca" />
      </div>
    </section>
  );
}

function KillStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col" style={{ gap: 2 }}>
      <span
        className="text-[10px] font-[family-name:var(--font-caption)] uppercase"
        style={{ color: "rgba(255, 251, 245, 0.5)", letterSpacing: "0.6px" }}
      >
        {label}
      </span>
      <span className="text-[12px] font-[family-name:var(--font-mono)]" style={{ color: "#FACC15" }}>
        {value}
      </span>
    </div>
  );
}

const GATE_ROWS = [
  { check: true, label: "Log de auditoría append-only", state: "verificado", tone: "#15803D" },
  { check: true, label: "Dry-run obligatorio antes de escribir", state: "verificado", tone: "#15803D" },
  { check: true, label: "Panel solo lectura · GET-only", state: "verificado", tone: "#15803D" },
  { check: true, label: "Kill switch probado", state: "hace 14 min", tone: "#15803D" },
  { check: "warn", label: "Definiciones de rollback firmadas", state: "3 faltantes", tone: "#B45309" },
  { check: "warn", label: "Autorización por rol", state: "revisión pendiente", tone: "#B45309" },
  { check: "bad", label: "Drift DNS SPF/DMARC", state: "alerta abierta", tone: "#B91C1C" },
  { check: "off", label: "Puente NFC", state: "deshabilitado", tone: "#8A8073" },
  { check: true, label: "Sesión externa con MFA", state: "verificado", tone: "#15803D" }
] as const;

function GatesCard() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{ borderRadius: 8, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 12, padding: "16px 20px 14px 20px", borderBottom: "1px solid #EAE0CE" }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Gates de seguridad
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            Estado de los gates no negociables del MVP
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ padding: "3px 8px", borderRadius: 4, background: "#DCFCE7", color: "#15803D" }}
        >
          6 / 9
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {GATE_ROWS.map((row, i) => (
          <li
            key={row.label}
            className="flex items-center"
            style={{
              gap: 12,
              padding: "10px 20px",
              borderBottom: i < GATE_ROWS.length - 1 ? "1px solid #EAE0CE" : "none"
            }}
          >
            <span
              aria-hidden="true"
              className="grid place-items-center text-[#FFFBF5] text-[10px]"
              style={{ width: 16, height: 16, borderRadius: 999, background: row.tone, fontWeight: 700 }}
            >
              {row.check === true ? "✓" : row.check === "warn" ? "!" : row.check === "bad" ? "×" : "−"}
            </span>
            <span className="text-[12px] font-[family-name:var(--font-sans)] font-medium text-[#1A1410]">
              {row.label}
            </span>
            <span className="flex-1" aria-hidden="true" />
            <span className="text-[10px] font-[family-name:var(--font-mono)]" style={{ color: row.tone }}>
              {row.state}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Right() {
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <RolesCard />
      <SesionesCard />
      <SecretsCard />
    </div>
  );
}

function RolesCard() {
  const roles = [
    { name: "Operador", count: 4, color: "#1D4ED8" },
    { name: "SRE", count: 2, color: "#15803D" },
    { name: "Auditor externo", count: 1, color: "#7C3AED" },
    { name: "Sólo lectura", count: 5, color: "#5C544A" }
  ];
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{ borderRadius: 8, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 8, padding: "14px 16px 12px 16px", borderBottom: "1px solid #EAE0CE" }}
      >
        <Users size={13} strokeWidth={1.75} className="text-[#1D4ED8]" aria-hidden="true" />
        <h3 className="m-0 text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Roles
        </h3>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">/v1/iam/roles</span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {roles.map((r, i) => (
          <li
            key={r.name}
            className="flex items-center"
            style={{
              gap: 8,
              padding: "10px 16px",
              borderBottom: i < roles.length - 1 ? "1px solid #EAE0CE" : "none"
            }}
          >
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: r.color }} />
            <span className="text-[12px] font-[family-name:var(--font-sans)] text-[#1A1410]">{r.name}</span>
            <span className="flex-1" aria-hidden="true" />
            <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold text-[#5C544A]">
              {r.count}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SesionesCard() {
  const sessions = [
    { actor: "operador@delivrix", from: "Madrid · VPN", time: "ahora" },
    { actor: "sre-01@delivrix", from: "iad-01 · interno", time: "hace 12 m" },
    { actor: "auditor-ext@delivrix", from: "Berlín · MFA", time: "hace 38 m" }
  ];
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{ borderRadius: 8, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 8, padding: "14px 16px 12px 16px", borderBottom: "1px solid #EAE0CE" }}
      >
        <Laptop size={13} strokeWidth={1.75} className="text-[#5C544A]" aria-hidden="true" />
        <h3 className="m-0 text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Sesiones activas
        </h3>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">/v1/iam/sessions</span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {sessions.map((s, i) => (
          <li
            key={s.actor}
            className="flex flex-col"
            style={{
              gap: 2,
              padding: "10px 16px",
              borderBottom: i < sessions.length - 1 ? "1px solid #EAE0CE" : "none"
            }}
          >
            <div className="flex items-center" style={{ gap: 8 }}>
              <span className="text-[12px] font-[family-name:var(--font-mono)] font-semibold text-[#1A1410] truncate">
                {s.actor}
              </span>
              <span className="flex-1" aria-hidden="true" />
              <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{s.time}</span>
            </div>
            <span className="text-[10px] font-[family-name:var(--font-caption)] text-[#5C544A]">{s.from}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SecretsCard() {
  const lines = [
    "0 secretos en el repositorio",
    "Rotación SMTP cada 30 d",
    "Acceso JIT al kill switch"
  ];
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        gap: 10,
        padding: 16,
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <Lock size={13} strokeWidth={1.75} className="text-[#7C3AED]" aria-hidden="true" />
        <h3 className="m-0 text-[13px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
          Secrets management
        </h3>
      </header>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.4] text-[#5C544A]">
        AWS Secrets Manager activo · 0 secretos en repo · todos los SMTP cifrados.
      </p>
      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 6 }}>
        {lines.map((l) => (
          <li key={l} className="flex items-center" style={{ gap: 6 }}>
            <ShieldCheck size={11} strokeWidth={1.75} className="text-[#15803D]" aria-hidden="true" />
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#1A1410]">{l}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ============================================================
 * Audit (McVRn) — 6 audit rows literales
 * ============================================================ */
const AUDIT_ROWS = [
  { ts: "09:18:42", actor: "operador@delivrix", actorColor: "#1A1410", action: "Solicitó plan dry-run", resource: "plan_warming · cluster-eu-01", hash: "4f1a…0c8", result: "ok", resultBg: "#DCFCE7", resultFg: "#15803D" },
  { ts: "09:14:21", actor: "sre-01@delivrix", actorColor: "#1A1410", action: "Probó kill switch", resource: "killswitch · simulado", hash: "a09c…b32", result: "ok", resultBg: "#DCFCE7", resultFg: "#15803D" },
  { ts: "09:04:11", actor: "openclaw", actorColor: "#EA580C", action: "Recomendó degradar", resource: "cluster-eu-01 · quejas 0,18%", hash: "7d41…f1a", result: "supervisado", resultBg: "#EDE9FE", resultFg: "#7C3AED" },
  { ts: "08:54:33", actor: "collector", actorColor: "#1D4ED8", action: "Detectó drift DNS", resource: "zone delivrix.io · SPF/DMARC", hash: "3e89…2bd", result: "alerta", resultBg: "#FEF3C7", resultFg: "#B45309" },
  { ts: "08:42:09", actor: "auditor-ext@delivrix", actorColor: "#1A1410", action: "Vio log", resource: "audit · últimas 24 h", hash: "c54f…908", result: "lectura", resultBg: "#DBEAFE", resultFg: "#1D4ED8" },
  { ts: "07:58:55", actor: "sistema", actorColor: "#5C544A", action: "Rechazó login externo", resource: "IP 200.93.x.x fuera de rango VPN", hash: "9bb2…ee4", result: "bloqueo", resultBg: "#FEE2E2", resultFg: "#B91C1C" }
];

function Audit() {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{ borderRadius: 8, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 12, padding: "16px 20px 14px 20px", borderBottom: "1px solid #EAE0CE" }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-heading)] font-bold text-[#1A1410]">
            Log de auditoría
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
            Append-only · hash encadenado SHA-256 · contrato /v1/audit
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <div
          className="flex items-center"
          style={{ padding: 2, borderRadius: 6, background: "#F7F2EA", border: "1px solid #EAE0CE", gap: 0 }}
        >
          {["Todos", "Críticos", "Operador"].map((f, i) => (
            <span
              key={f}
              className="text-[10px] font-[family-name:var(--font-caption)] font-semibold"
              style={{
                padding: "5px 10px",
                borderRadius: 4,
                background: i === 0 ? "#1A1410" : "transparent",
                color: i === 0 ? "#FFFBF5" : "#5C544A"
              }}
            >
              {f}
            </span>
          ))}
        </div>
        <button
          type="button"
          className="inline-flex items-center text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]"
          style={{ gap: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid #D4C5A8", background: "transparent" }}
        >
          <Download size={12} strokeWidth={1.75} aria-hidden="true" />
          Exportar
        </button>
      </header>

      <div
        className="grid"
        style={{
          gridTemplateColumns: "84px 128px 160px minmax(0,1fr) 96px 80px",
          gap: 12,
          padding: "8px 20px",
          background: "#F7F2EA",
          borderBottom: "1px solid #EAE0CE"
        }}
      >
        {["Hora", "Actor", "Acción", "Recurso", "Hash", "Resultado"].map((h) => (
          <span
            key={h}
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
            style={{ letterSpacing: "0.6px" }}
          >
            {h}
          </span>
        ))}
      </div>

      <ul className="m-0 p-0 list-none flex flex-col">
        {AUDIT_ROWS.map((row, i) => (
          <li
            key={i}
            className="grid items-center"
            style={{
              gridTemplateColumns: "84px 128px 160px minmax(0,1fr) 96px 80px",
              gap: 12,
              padding: "10px 20px",
              borderBottom: i < AUDIT_ROWS.length - 1 ? "1px solid #EAE0CE" : "none"
            }}
          >
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A]">{row.ts}</span>
            <span
              className="text-[11px] font-[family-name:var(--font-mono)] font-semibold truncate"
              style={{ color: row.actorColor }}
            >
              {row.actor}
            </span>
            <span className="text-[11.5px] font-[family-name:var(--font-sans)] text-[#1A1410] truncate">
              {row.action}
            </span>
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A] truncate">
              {row.resource}
            </span>
            <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">{row.hash}</span>
            <span
              className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
              style={{
                padding: "2px 8px",
                borderRadius: 4,
                background: row.resultBg,
                color: row.resultFg,
                letterSpacing: "0.4px",
                width: "fit-content"
              }}
            >
              {row.result}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-center" style={{ padding: "10px 12px 12px 12px" }}>
        <button
          type="button"
          className="text-[11.5px] font-[family-name:var(--font-sans)] font-semibold text-[#5C544A]"
        >
          Mostrar 24 entradas más
        </button>
      </div>
    </section>
  );
}

/* ============================================================
 * Compliance row (DQeL9) — 3 cards
 * ============================================================ */
function ComplianceRow() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 14 }}>
      <ComplianceCard
        iconBg="#DCFCE7"
        iconColor="#15803D"
        icon={<ShieldCheck size={14} strokeWidth={1.75} />}
        title="Cumplimiento GDPR"
        pillBg="#DCFCE7"
        pillFg="#15803D"
        pillText="ok"
        lines={[
          "DPA firmado con Anthropic · 2026-03-11",
          "Datos almacenados sólo en EU-WEST-1",
          "Solicitudes de borrado vía privacy@delivrix.io"
        ]}
      />
      <ComplianceCard
        iconBg="#DBEAFE"
        iconColor="#1D4ED8"
        icon={<Shield size={14} strokeWidth={1.75} />}
        title="Cumplimiento operativo"
        pillBg="#FEF3C7"
        pillFg="#B45309"
        pillText="3 abiertos"
        lines={[
          "Rollback definitions · 3 faltantes",
          "Pruebas DR · trimestrales",
          "Encriptación en tránsito · TLS 1.3"
        ]}
      />
      <ComplianceCard
        iconBg="#F5F5F4"
        iconColor="#5C544A"
        icon={<ShieldAlert size={14} strokeWidth={1.75} />}
        title="Sin acciones reales"
        pillBg="#F5F5F4"
        pillFg="#5C544A"
        pillText="MVP"
        lines={[
          "0 envíos reales en producción",
          "0 mutaciones a infraestructura externa",
          "Toda escritura supervisada por humano"
        ]}
      />
    </div>
  );
}

function ComplianceCard({
  iconBg,
  iconColor,
  icon,
  title,
  pillBg,
  pillFg,
  pillText,
  lines
}: {
  iconBg: string;
  iconColor: string;
  icon: React.ReactNode;
  title: string;
  pillBg: string;
  pillFg: string;
  pillText: string;
  lines: string[];
}) {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{ gap: 10, padding: 16, borderRadius: 8, border: "1px solid #EAE0CE", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{ width: 28, height: 28, borderRadius: 8, background: iconBg, color: iconColor }}
        >
          {icon}
        </span>
        <div className="flex flex-col flex-1" style={{ gap: 1 }}>
          <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
            {title}
          </h3>
        </div>
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
          style={{ padding: "2px 6px", borderRadius: 4, background: pillBg, color: pillFg, letterSpacing: "0.4px" }}
        >
          {pillText}
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 5 }}>
        {lines.map((l) => (
          <li key={l} className="flex items-center" style={{ gap: 6 }}>
            <span aria-hidden="true" style={{ width: 4, height: 4, borderRadius: 999, background: "#8A8073" }} />
            <span className="text-[11px] font-[family-name:var(--font-sans)] text-[#5C544A]">{l}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ============================================================
 * Footer
 * ============================================================ */
function Footer() {
  return (
    <footer
      className="flex items-center"
      style={{ gap: 16, padding: "12px 0 0 0" }}
    >
      <span className="inline-flex items-center" style={{ gap: 8 }}>
        <ShieldCheck size={12} strokeWidth={1.75} className="text-[#15803D]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#5C544A]">
          Panel GET-only · ningún POST/PUT/PATCH/DELETE en el bundle frontend
        </span>
      </span>
      <span className="flex-1" aria-hidden="true" />
      <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
        runbook · security-runbook.md
      </span>
    </footer>
  );
}

void formatDateTime;
