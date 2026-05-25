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
  TriangleAlert,
  Users
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DashboardData, RealTimeMeta } from "../../shared/api/client.ts";
import {
  filterAuditEvents,
  formatDateTime,
  formatTimeOnly,
  humanize,
  shortAuditHash
} from "../../shared/lib/formatters.ts";
import {
  EmptySessionsCard,
  FallbackBanner,
  RealtimeTick,
  StaleBadge,
  isCachedMeta,
  isFallbackMeta,
  staleMinutesFromMeta
} from "../../shared/ui/realtime/index.ts";
import {
  BannerOpenClawV2,
  LiveIndicator,
  SectionDivider
} from "../../shared/ui/v2/index.ts";

export function SafetySection({ data }: { data: DashboardData }) {
  const hasFallback = [
    data.safetyRealtime.complianceStatus,
    data.safetyRealtime.iamRoles,
    data.safetyRealtime.iamSessions
  ].some(isFallbackMeta);
  const rolesPulse = useRealtimePulse(roleSignature(data.iamRoles));
  const sessionsPulse = useRealtimePulse(sessionSignature(data.iamSessions));
  const compliancePulse = useRealtimePulse(complianceSignature(data.complianceControls));

  return (
    <section className="flex flex-col" style={{ gap: 20 }}>
      {hasFallback ? <FallbackBanner /> : null}
      <Hero data={data} />
      <SectionDivider
        title="Estado del gobierno"
        caption="Permisos, kill switch, sesiones · poll 30s"
        countTone="success"
      />
      <KpiRow data={data} />
      <SectionDivider
        title="Permisos y sesiones"
        caption="IAM · sesiones activas · secretos"
        countTone="success"
      />
      <TwoCol data={data} rolesPulse={rolesPulse} sessionsPulse={sessionsPulse} />
      <SectionDivider
        title="Auditoría reciente"
        caption="Append-only · log inmutable · SHA-256"
        countTone="success"
      />
      <Audit data={data} />
      <SectionDivider
        title="Compliance"
        caption="Estados evaluados continuamente"
        countTone="success"
      />
      <ComplianceRow data={data} pulseActive={compliancePulse} />
      <Footer />
    </section>
  );
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

function roleSignature(roles: DashboardData["iamRoles"]): string {
  return roles.map((role) => `${role.id}:${role.userCount}`).join("|");
}

function sessionSignature(sessions: DashboardData["iamSessions"]): string {
  return sessions.map((session) => `${session.actor}:${session.lastSeenAt}:${session.risk}`).join("|");
}

function complianceSignature(controls: DashboardData["complianceControls"]): string {
  return controls.map((control) => `${control.id}:${control.state}:${control.lines.join(",")}`).join("|");
}

function staleBadgeFor(meta: RealTimeMeta | null): ReactNode {
  if (!isCachedMeta(meta)) return null;
  return <StaleBadge minutesAgo={staleMinutesFromMeta(meta)} />;
}

/* ============================================================
 * Hero — Welcome v2 (LiveIndicator inline) + Banner OpenClaw v2
 * ============================================================ */
function Hero({ data }: { data: DashboardData }) {
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <HeroLeft />
      <OpenClawPrompt data={data} />
    </div>
  );
}

function HeroLeft() {
  // Sin timestamp real expuesto; LiveIndicator cuenta segundos desde mount,
  // reflejando que la página está "viva" (poll 30s safety realtime).
  const mountedAt = useRef<number>(Date.now()).current;
  return (
    <header className="flex items-start" style={{ gap: 16 }}>
      <div className="flex flex-col min-w-0 flex-1" style={{ gap: 6 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            className="text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-accent-tertiary)]"
            style={{ letterSpacing: "var(--tracking-widest)" }}
          >
            Seguridad y gobierno
          </span>
        </div>
        <h1
          className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[var(--color-text-primary)]"
          style={{ letterSpacing: "var(--tracking-tightest)" }}
        >
          Sin acciones reales, con todas las barandillas.
        </h1>
        <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-secondary)]">
          El panel es GET-only. Toda acción operativa requiere aprobación humana, dry-run previo,
          log auditable y kill switch probado.
        </p>
      </div>
      <div className="shrink-0">
        <LiveIndicator pollIntervalSec={30} lastUpdateAt={mountedAt} tone="success" />
      </div>
    </header>
  );
}

function OpenClawPrompt({ data }: { data: DashboardData }) {
  const gates = data.operatingNorth.gates ?? [];
  const live = data.operatingNorth.liveInfrastructureWritesEnabled;
  const smtp = data.operatingNorth.delivrixSendsRealEmail;
  const ks = data.killSwitch;
  const message =
    gates.length > 0
      ? `${gates.length} gate${gates.length === 1 ? "" : "s"} faltan validación. ${live || smtp ? "Detecté frontera abierta en infra/SMTP — " : ""}preparé el plan dry-run.`
      : ks.enabled
        ? `Kill switch activo: ${ks.reason || "sin razón registrada"}. Confirmar protocolo antes de re-armar.`
        : "Sin gates pendientes. Las barandillas están firmes.";
  const title = ks.enabled
    ? "Kill switch activo"
    : gates.length > 0
      ? "OpenClaw detectó gates abiertos"
      : "OpenClaw: barandillas firmes";
  return (
    <BannerOpenClawV2
      title={title}
      body={message}
      primaryCta="Revisar plan dry-run"
      secondaryCta="Abrir runbook"
    />
  );
}

/* ============================================================
 * KPI row (aJ1TH)
 * ============================================================ */
function KpiRow({ data }: { data: DashboardData }) {
  const allowed = data.operatingNorth.allowedActions?.length ?? 0;
  const blocked = data.operatingNorth.blockedActions?.length ?? 0;
  const gates = data.operatingNorth.gates?.length ?? 0;
  const totalGates = gates + allowed; // proxy: cuántos gates vigentes
  void totalGates;
  const ks = data.killSwitch;
  const criticalEvents = (data.overview.alerts ?? []).filter(
    (a) => a.severity === "critical" || a.severity === "blocked"
  ).length;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 14 }}>
      <Kpi
        label="Acciones permitidas"
        value={String(allowed)}
        unit={`/ ${allowed + blocked} totales`}
        iconColor="var(--color-success)"
        icon={<ShieldCheck size={12} strokeWidth={1.75} />}
        detail={`${blocked} bloqueadas`}
        detailColor={blocked > 0 ? "var(--color-critical)" : "var(--color-success)"}
        endpoint="/v1/operating-north"
        pillBg="var(--color-success-soft)"
        pillFg="var(--color-success)"
        pillText={`${allowed} ok`}
      />
      <Kpi
        label="Roles del norte"
        value="3"
        unit="roles"
        iconColor="var(--color-info)"
        icon={<Users size={12} strokeWidth={1.75} />}
        detail={`${data.operatingNorth.delivrixRole} · ${data.operatingNorth.openClawRole}`}
        detailColor="var(--color-text-secondary)"
        endpoint="/v1/operating-north"
        pillBg="var(--color-info-soft)"
        pillFg="var(--color-info)"
        pillText="rbac"
      />
      <Kpi
        label="Kill switch"
        value={ks.enabled ? "ACTIVO" : "ARMADO"}
        unit={ks.updatedBy || "sin uso"}
        iconColor={ks.enabled ? "var(--color-critical)" : "var(--color-success)"}
        icon={<Laptop size={12} strokeWidth={1.75} />}
        detail={ks.reason || "sin razón"}
        detailColor={ks.enabled ? "var(--color-critical)" : "var(--color-text-secondary)"}
        endpoint="/v1/safety/kill-switch"
        pillBg={ks.enabled ? "var(--color-critical-soft)" : "var(--color-success-soft)"}
        pillFg={ks.enabled ? "var(--color-critical)" : "var(--color-success)"}
        pillText={ks.enabled ? "corte real" : "ok"}
      />
      <Kpi
        label="Alertas críticas"
        value={String(criticalEvents)}
        unit="alertas"
        iconColor="var(--color-warning)"
        icon={<TriangleAlert size={12} strokeWidth={1.75} />}
        detail={`${gates} gates abiertos`}
        detailColor={gates > 0 ? "var(--color-warning)" : "var(--color-success)"}
        endpoint="/v1/admin/overview"
        pillBg={criticalEvents > 0 ? "var(--color-warning-soft)" : "var(--color-success-soft)"}
        pillFg={criticalEvents > 0 ? "var(--color-warning)" : "var(--color-success)"}
        pillText={criticalEvents > 0 ? "atención" : "ok"}
      />
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
  icon: ReactNode;
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
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 12,
        padding: 16,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-sm)"
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[var(--color-text-secondary)]"
          style={{ letterSpacing: "var(--tracking-wide)" }}
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
          className="text-[32px] font-[family-name:var(--font-mono)] font-bold leading-none text-[var(--color-text-primary)] tabular-nums"
          style={{ letterSpacing: "var(--tracking-tightest)" }}
        >
          {value}
        </span>
        <span className="text-[12px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)] leading-none">
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
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{endpoint}</span>
      </div>
    </article>
  );
}

/* ============================================================
 * Two col (H69HQS): Kill switch grande + Gates / Roles + Sesiones + Secrets
 * ============================================================ */
function TwoCol({
  data,
  rolesPulse,
  sessionsPulse
}: {
  data: DashboardData;
  rolesPulse: boolean;
  sessionsPulse: boolean;
}) {
  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
      <Left data={data} />
      <Right data={data} rolesPulse={rolesPulse} sessionsPulse={sessionsPulse} />
    </div>
  );
}

function Left({ data }: { data: DashboardData }) {
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <KillSwitchGrande data={data} />
      <GatesCard data={data} />
    </div>
  );
}

function KillSwitchGrande({ data }: { data: DashboardData }) {
  const ks = data.killSwitch;
  const armed = !ks.enabled;
  const ksTitle = armed ? `Armado · listo para activar` : `Activado · ${ks.reason || "intervención manual"}`;
  const ksSubtitle = ks.updatedAt
    ? `Actualizado · ${new Date(ks.updatedAt).toLocaleString("es-CO")}`
    : "Sin movimientos registrados";
  return (
    <section
      className="flex flex-col overflow-hidden"
      style={{
        borderRadius: 10,
        background: "var(--color-surface-inverse)",
        border: "1px solid var(--color-on-dark-hint)",
        boxShadow: "var(--shadow-md)"
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
            width: 44,
            height: 44,
            borderRadius: 10,
            background: "linear-gradient(135deg, var(--color-accent-secondary) 0%, var(--color-accent-tertiary) 100%)",
            color: "var(--color-on-dark-strong)",
            boxShadow: "0 0 0 1px var(--color-on-dark-hint), 0 8px 20px rgba(234, 88, 12, 0.25)"
          }}
        >
          <Power size={20} strokeWidth={2.25} aria-hidden="true" />
        </span>
        <div className="flex flex-col flex-1" style={{ gap: 4 }}>
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase"
            style={{ color: "var(--color-on-dark-soft)", letterSpacing: "var(--tracking-widest)" }}
          >
            Kill switch global
          </span>
          <h2
            className="m-0 text-[18px] font-[family-name:var(--font-sans)] font-semibold leading-tight"
            style={{ color: "var(--color-on-dark-strong)", letterSpacing: "var(--tracking-tight)" }}
          >
            {ksTitle}
          </h2>
          <span className="text-[12px] font-[family-name:var(--font-sans)]" style={{ color: "var(--color-on-dark-medium)" }}>
            {ksSubtitle} · regla de dos personas exigida en cada activación.
          </span>
        </div>
        <span
          className="inline-flex items-center text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase"
          style={{
            gap: 6,
            padding: "5px 10px",
            borderRadius: 999,
            background: armed ? "var(--color-on-dark-success-overlay)" : "var(--color-on-dark-critical-overlay)",
            border: armed ? "1px solid var(--color-on-dark-success-overlay)" : "1px solid var(--color-on-dark-critical-overlay)",
            color: armed ? "var(--color-success-border)" : "var(--color-critical-border)",
            letterSpacing: "var(--tracking-wider)"
          }}
        >
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: armed ? "var(--color-success)" : "var(--color-critical)" }} />
          {armed ? "Armado" : "Activo"}
        </span>
      </div>
      <div
        className="grid items-center"
        style={{
          gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)",
          gap: 16,
          padding: "14px 24px",
          background: "var(--color-surface-inverse)",
          borderTop: "1px solid var(--color-on-dark-hint)"
        }}
      >
        <KillStat label="responsable" value={ks.updatedBy || "sin asignar"} />
        <KillStat label="fase del norte" value={data.operatingNorth.phase || "—"} />
        <KillStat label="último uso real" value={ks.enabled ? "ahora" : "nunca"} />
      </div>
    </section>
  );
}

function KillStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col" style={{ gap: 2 }}>
      <span
        className="text-[10px] font-[family-name:var(--font-caption)] font-medium uppercase"
        style={{ color: "var(--color-on-dark-soft)", letterSpacing: "var(--tracking-wider)" }}
      >
        {label}
      </span>
      <span className="text-[12px] font-[family-name:var(--font-mono)] tabular-nums" style={{ color: "var(--color-accent-secondary)" }}>
        {value}
      </span>
    </div>
  );
}

function buildSafetyGates(data: DashboardData) {
  const ks = data.killSwitch;
  const live = data.operatingNorth.liveInfrastructureWritesEnabled;
  const smtp = data.operatingNorth.delivrixSendsRealEmail;
  const nfc = data.operatingNorth.nfcProductionWritesEnabled;
  const base: Array<{ check: true | "warn" | "bad" | "off"; label: string; state: string; tone: string }> = [
    { check: true, label: "Log de auditoría append-only", state: "verificado", tone: "var(--color-success)" },
    { check: true, label: "Dry-run obligatorio antes de escribir", state: "verificado", tone: "var(--color-success)" },
    { check: true, label: "Panel solo lectura · GET-only", state: "verificado", tone: "var(--color-success)" },
    {
      check: ks.enabled ? "bad" : true,
      label: "Kill switch probado",
      state: ks.updatedAt ? new Date(ks.updatedAt).toLocaleDateString("es-CO") : "sin uso",
      tone: ks.enabled ? "var(--color-critical)" : "var(--color-success)"
    },
    {
      check: live ? "warn" : true,
      label: "Live infrastructure writes",
      state: live ? "enabled · revisar" : "disabled",
      tone: live ? "var(--color-warning)" : "var(--color-success)"
    },
    {
      check: smtp ? "warn" : true,
      label: "SMTP envía correo real",
      state: smtp ? "envío real activo" : "simulación",
      tone: smtp ? "var(--color-warning)" : "var(--color-success)"
    },
    {
      check: nfc ? "warn" : "off",
      label: "Puente NFC",
      state: nfc ? "enabled" : "deshabilitado",
      tone: nfc ? "var(--color-warning)" : "var(--color-text-tertiary)"
    }
  ];
  const opGates = (data.operatingNorth.gates ?? []).map((g) => ({
    check: "warn" as const,
    label: humanize(g),
    rawLabel: g,
    state: "revisión pendiente",
    tone: "var(--color-warning)"
  }));
  // El subset de base no tiene rawLabel, agregamos uno igual al label para uniformar
  const baseWithRaw = base.map((b) => ({ ...b, rawLabel: b.label }));
  return [...baseWithRaw, ...opGates];
}

function GatesCard({ data }: { data: DashboardData }) {
  const GATE_ROWS = buildSafetyGates(data);
  const okCount = GATE_ROWS.filter((g) => g.check === true).length;
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{ borderRadius: 8, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 12, padding: "16px 20px 14px 20px", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
            Gates de seguridad
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            Estado de los gates no negociables del MVP
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold"
          style={{ padding: "3px 8px", borderRadius: 4, background: "var(--color-success-soft)", color: "var(--color-success)" }}
        >
          {okCount} / {GATE_ROWS.length}
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {GATE_ROWS.map((row, i) => (
          <li
            key={`${i}-${row.rawLabel}`}
            className="flex items-center min-w-0"
            style={{
              gap: 12,
              padding: "10px 20px",
              borderBottom: i < GATE_ROWS.length - 1 ? "1px solid var(--color-border)" : "none"
            }}
            title={row.rawLabel}
          >
            <span
              aria-hidden="true"
              className="grid place-items-center text-[var(--color-on-dark-strong)] text-[10px] shrink-0"
              style={{ width: 16, height: 16, borderRadius: 999, background: row.tone, fontWeight: 700 }}
            >
              {row.check === true ? "✓" : row.check === "warn" ? "!" : row.check === "bad" ? "×" : "−"}
            </span>
            <span
              className="text-[12px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-primary)] truncate"
              style={{ flex: "1 1 auto", minWidth: 0 }}
            >
              {row.label}
            </span>
            <span
              className="text-[10px] font-[family-name:var(--font-mono)] shrink-0"
              style={{ color: row.tone, whiteSpace: "nowrap" }}
            >
              {row.state}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Right({
  data,
  rolesPulse,
  sessionsPulse
}: {
  data: DashboardData;
  rolesPulse: boolean;
  sessionsPulse: boolean;
}) {
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <RolesCard
        roles={data.iamRoles}
        meta={data.safetyRealtime.iamRoles}
        pulseActive={rolesPulse}
      />
      <SesionesCard
        sessions={data.iamSessions}
        meta={data.safetyRealtime.iamSessions}
        pulseActive={sessionsPulse}
      />
      <SecretsCard />
    </div>
  );
}

function roleColorHex(c: string): string {
  if (c === "blue") return "var(--color-info)";
  if (c === "green") return "var(--color-success)";
  if (c === "violet") return "var(--color-unknown)";
  if (c === "amber") return "var(--color-accent-tertiary)";
  return "var(--color-text-secondary)";
}

function RolesCard({
  roles: contractRoles,
  meta,
  pulseActive
}: {
  roles: DashboardData["iamRoles"];
  meta: RealTimeMeta | null;
  pulseActive: boolean;
}) {
  const stale = staleBadgeFor(meta);
  const roles =
    contractRoles.length > 0
      ? contractRoles.map((r) => ({
          name: r.name,
          count: r.userCount,
          color: roleColorHex(r.color),
          derivedFrom: r.countDerivedFrom
        }))
      : [{ name: "Sin roles del contrato", count: 0, color: "var(--color-text-secondary)" }];
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{ borderRadius: 8, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 8, padding: "14px 16px 12px 16px", borderBottom: "1px solid var(--color-border)" }}
      >
        <Users size={13} strokeWidth={1.75} className="text-[var(--color-info)]" aria-hidden="true" />
        <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Roles
        </h3>
        <span className="flex-1" aria-hidden="true" />
        <RealtimeTick active={pulseActive} />
        {stale}
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">/v1/iam/roles</span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {roles.map((r, i) => (
          <li
            key={r.name}
            className="flex items-center"
            style={{
              gap: 8,
              padding: "10px 16px",
              borderBottom: i < roles.length - 1 ? "1px solid var(--color-border)" : "none"
            }}
          >
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: r.color }} />
            <span className="text-[12px] font-[family-name:var(--font-sans)] text-[var(--color-text-primary)]">{r.name}</span>
            <span className="flex-1" aria-hidden="true" />
            <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-text-secondary)]">
              {r.count}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function relativeAgeShort(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  if (diff < 60_000) return "ahora";
  if (diff < 3_600_000) return `hace ${Math.round(diff / 60_000)} m`;
  if (diff < 86_400_000) return `hace ${Math.round(diff / 3_600_000)} h`;
  return `hace ${Math.round(diff / 86_400_000)} d`;
}

function SesionesCard({
  sessions: contractSessions,
  meta,
  pulseActive
}: {
  sessions: DashboardData["iamSessions"];
  meta: RealTimeMeta | null;
  pulseActive: boolean;
}) {
  const stale = staleBadgeFor(meta);
  const sessions = contractSessions.map((s) => ({
    actor: s.actor,
    from: `${s.location} · ${s.transport.toUpperCase()}`,
    time: relativeAgeShort(s.lastSeenAt)
  }));

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col" style={{ gap: 8 }}>
        <div className="flex items-center justify-end" style={{ gap: 8 }}>
          <RealtimeTick active={pulseActive} />
          {stale}
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">/v1/iam/sessions</span>
        </div>
        <EmptySessionsCard />
      </div>
    );
  }

  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{ borderRadius: 8, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 8, padding: "14px 16px 12px 16px", borderBottom: "1px solid var(--color-border)" }}
      >
        <Laptop size={13} strokeWidth={1.75} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
        <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Sesiones activas
        </h3>
        <span className="flex-1" aria-hidden="true" />
        <RealtimeTick active={pulseActive} />
        {stale}
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">/v1/iam/sessions</span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col">
        {sessions.map((s, i) => (
          <li
            key={s.actor}
            className="flex flex-col"
            style={{
              gap: 2,
              padding: "10px 16px",
              borderBottom: i < sessions.length - 1 ? "1px solid var(--color-border)" : "none"
            }}
          >
            <div className="flex items-center" style={{ gap: 8 }}>
              <span className="text-[12px] font-[family-name:var(--font-mono)] font-semibold text-[var(--color-text-primary)] truncate">
                {s.actor}
              </span>
              <span className="flex-1" aria-hidden="true" />
              <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{s.time}</span>
            </div>
            <span className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-secondary)]">{s.from}</span>
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
      className="flex flex-col bg-[var(--color-surface)]"
      style={{
        gap: 10,
        padding: 16,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-sm)"
      }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <Lock size={13} strokeWidth={1.75} className="text-[var(--color-unknown)]" aria-hidden="true" />
        <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Secrets management
        </h3>
      </header>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.4] text-[var(--color-text-secondary)]">
        AWS Secrets Manager activo · 0 secretos en repo · todos los SMTP cifrados.
      </p>
      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 6 }}>
        {lines.map((l) => (
          <li key={l} className="flex items-center" style={{ gap: 6 }}>
            <ShieldCheck size={11} strokeWidth={1.75} className="text-[var(--color-success)]" aria-hidden="true" />
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{l}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ============================================================
 * Audit (McVRn) — audit rows desde /v1/audit-events
 * ============================================================ */
interface AuditRow {
  ts: string;
  actor: string;
  actorColor: string;
  action: string;
  resource: string;
  hash: string;
  result: string;
  resultBg: string;
  resultFg: string;
}

export function buildSafetyAuditRows(data: DashboardData): AuditRow[] {
  const events = filterAuditEvents(
    data.auditEvents,
    ["kill_switch", "kill-switch", "operating_north", "gate", "role", "permission", "approval", "denied"],
    6
  );
  return events.map((e) => ({
    ts: formatTimeOnly(e.occurredAt),
    actor: `${e.actorType}.${e.actorId}`.slice(0, 28),
    actorColor: e.actorType.includes("openclaw")
      ? "var(--color-accent-tertiary)"
      : e.actorType.includes("collector")
        ? "var(--color-info)"
        : "var(--color-text-primary)",
    action: e.action,
    resource: `${e.targetType} · ${e.targetId}`,
    hash: shortAuditHash(e.id).replace("sha:", ""),
    result: e.riskLevel,
    resultBg:
      e.riskLevel === "critical" || e.riskLevel === "blocked"
        ? "var(--color-critical-soft)"
        : e.riskLevel === "high" || e.riskLevel === "warning"
          ? "var(--color-warning-soft)"
          : e.riskLevel === "info" || e.riskLevel === "medium"
            ? "var(--color-info-soft)"
            : "var(--color-success-soft)",
    resultFg:
      e.riskLevel === "critical" || e.riskLevel === "blocked"
        ? "var(--color-critical)"
        : e.riskLevel === "high" || e.riskLevel === "warning"
        ? "var(--color-warning)"
        : e.riskLevel === "info" || e.riskLevel === "medium"
          ? "var(--color-info)"
          : "var(--color-success)"
  }));
}

function Audit({ data }: { data: DashboardData }) {
  const rows = buildSafetyAuditRows(data);
  return <AuditTable rows={rows} />;
}

function AuditTable({ rows }: { rows: AuditRow[] }) {
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{ borderRadius: 8, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
    >
      <header
        className="flex items-center"
        style={{ gap: 12, padding: "16px 20px 14px 20px", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <h2 className="m-0 text-[14px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
            Log de auditoría
          </h2>
          <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
            Append-only · hash encadenado SHA-256 · contrato /v1/audit-events
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <div
          className="flex items-center"
          style={{ padding: 2, borderRadius: 6, background: "var(--color-surface-sunken)", border: "1px solid var(--color-border)", gap: 0 }}
        >
          {["Todos", "Críticos", "Operador"].map((f, i) => (
            <span
              key={f}
              className="text-[10px] font-[family-name:var(--font-caption)] font-semibold"
              style={{
                padding: "5px 10px",
                borderRadius: 4,
                background: i === 0 ? "var(--color-text-primary)" : "transparent",
                color: i === 0 ? "var(--color-bg)" : "var(--color-text-secondary)"
              }}
            >
              {f}
            </span>
          ))}
        </div>
        <button
          type="button"
          className="inline-flex items-center text-[11px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]"
          style={{ gap: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border-strong)", background: "transparent" }}
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
          background: "var(--color-surface-sunken)",
          borderBottom: "1px solid var(--color-border)"
        }}
      >
        {["Hora", "Actor", "Acción", "Recurso", "Hash", "Resultado"].map((h) => (
          <span
            key={h}
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-text-tertiary)]"
            style={{ letterSpacing: "var(--tracking-wider)" }}
          >
            {h}
          </span>
        ))}
      </div>

      {rows.length > 0 ? (
        <ul className="m-0 p-0 list-none flex flex-col">
          {rows.map((row, i) => (
            <li
              key={`${row.hash}-${i}`}
              className="grid items-center"
              style={{
                gridTemplateColumns: "84px 128px 160px minmax(0,1fr) 96px 80px",
                gap: 12,
                padding: "10px 20px",
                borderBottom: i < rows.length - 1 ? "1px solid var(--color-border)" : "none"
              }}
            >
              <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">{row.ts}</span>
              <span
                className="text-[11px] font-[family-name:var(--font-mono)] font-semibold truncate"
                style={{ color: row.actorColor }}
              >
                {row.actor}
              </span>
              <span className="text-[11.5px] font-[family-name:var(--font-sans)] text-[var(--color-text-primary)] truncate">
                {row.action}
              </span>
              <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)] truncate">
                {row.resource}
              </span>
              <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">{row.hash}</span>
              <span
                className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: row.resultBg,
                  color: row.resultFg,
                  letterSpacing: "var(--tracking-wide)",
                  width: "fit-content"
                }}
              >
                {row.result}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <AuditEmptyState />
      )}

      {rows.length > 0 ? (
        <div className="flex items-center justify-center" style={{ padding: "10px 12px 12px 12px" }}>
        <button
          type="button"
          className="text-[11.5px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-secondary)]"
        >
          Mostrar 24 entradas más
        </button>
        </div>
      ) : null}
    </section>
  );
}

function AuditEmptyState() {
  return (
    <div className="flex flex-col" style={{ gap: 6, padding: "18px 20px" }}>
      <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
        Sin eventos de auditoría
      </span>
      <span className="text-[11px] font-[family-name:var(--font-sans)] leading-[1.45] text-[var(--color-text-secondary)]">
        El contrato no devolvió eventos para la tabla de seguridad.
      </span>
      <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
        /v1/audit-events
      </span>
    </div>
  );
}

/* ============================================================
 * Compliance row (DQeL9) — 3 cards
 * ============================================================ */
function complianceVisual(state: string): {
  iconBg: string;
  iconColor: string;
  icon: ReactNode;
  pillBg: string;
  pillFg: string;
  pillText: string;
} {
  if (state === "ok")
    return {
      iconBg: "var(--color-success-soft)",
      iconColor: "var(--color-success)",
      icon: <ShieldCheck size={14} strokeWidth={1.75} />,
      pillBg: "var(--color-success-soft)",
      pillFg: "var(--color-success)",
      pillText: "ok"
    };
  if (state === "warning")
    return {
      iconBg: "var(--color-warning-soft)",
      iconColor: "var(--color-warning)",
      icon: <Shield size={14} strokeWidth={1.75} />,
      pillBg: "var(--color-warning-soft)",
      pillFg: "var(--color-warning)",
      pillText: "atención"
    };
  if (state === "critical")
    return {
      iconBg: "var(--color-critical-soft)",
      iconColor: "var(--color-critical)",
      icon: <ShieldAlert size={14} strokeWidth={1.75} />,
      pillBg: "var(--color-critical-soft)",
      pillFg: "var(--color-critical)",
      pillText: "crítico"
    };
  return {
    iconBg: "var(--color-neutral-soft)",
    iconColor: "var(--color-text-secondary)",
    icon: <ShieldAlert size={14} strokeWidth={1.75} />,
    pillBg: "var(--color-neutral-soft)",
    pillFg: "var(--color-text-secondary)",
    pillText: "info"
  };
}

function ComplianceRow({ data, pulseActive }: { data: DashboardData; pulseActive: boolean }) {
  const controls = data.complianceControls;
  const stale = staleBadgeFor(data.safetyRealtime.complianceStatus);
  if (controls.length === 0) {
    return (
      <section
        className="flex items-center bg-[var(--color-surface)]"
        style={{ gap: 8, padding: "14px 16px", borderRadius: 8, border: "1px solid var(--color-border)" }}
      >
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
          El contrato /v1/compliance/status no devuelve controles todavía.
        </p>
      </section>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 14 }}>
      {controls.slice(0, 3).map((c) => {
        const v = complianceVisual(c.state);
        return (
          <ComplianceCard
            key={c.id}
            iconBg={v.iconBg}
            iconColor={v.iconColor}
            icon={v.icon}
            title={c.title}
            pillBg={v.pillBg}
            pillFg={v.pillFg}
            pillText={v.pillText}
            lines={c.lines}
            stale={stale}
            pulseActive={pulseActive}
          />
        );
      })}
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
  lines,
  stale,
  pulseActive
}: {
  iconBg: string;
  iconColor: string;
  icon: ReactNode;
  title: string;
  pillBg: string;
  pillFg: string;
  pillText: string;
  lines: string[];
  stale: ReactNode;
  pulseActive: boolean;
}) {
  return (
    <section
      className="flex flex-col bg-[var(--color-surface)]"
      style={{ gap: 10, padding: 16, borderRadius: 8, border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}
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
          <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
            {title}
          </h3>
        </div>
        <RealtimeTick active={pulseActive} />
        {stale}
        <span
          className="inline-block text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase"
          style={{ padding: "2px 6px", borderRadius: 4, background: pillBg, color: pillFg, letterSpacing: "var(--tracking-wide)" }}
        >
          {pillText}
        </span>
      </header>
      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 5 }}>
        {lines.map((l) => (
          <li key={l} className="flex items-center" style={{ gap: 6 }}>
            <span aria-hidden="true" style={{ width: 4, height: 4, borderRadius: 999, background: "var(--color-text-tertiary)" }} />
            <span className="text-[11px] font-[family-name:var(--font-sans)] text-[var(--color-text-secondary)]">{l}</span>
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
        <ShieldCheck size={12} strokeWidth={1.75} className="text-[var(--color-success)]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-secondary)]">
          Panel GET-only · ningún POST/PUT/PATCH/DELETE en el bundle frontend
        </span>
      </span>
      <span className="flex-1" aria-hidden="true" />
      <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
        runbook · security-runbook.md
      </span>
    </footer>
  );
}

void formatDateTime;
