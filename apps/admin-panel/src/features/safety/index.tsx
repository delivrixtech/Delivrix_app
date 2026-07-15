/**
 * Seguridad — migrado al MOLDE OFICIAL "Aivora" (features/overview/TravigueOverviewProto.tsx).
 *
 * Reusa los primitivos de src/shared/ui/aivora (Card radius 18 + hairline + shadow,
 * SectionHead eyebrow+h1 light, KpiCard tile+número tabular). Los datos siguen siendo
 * REALES (DashboardData del contrato) — nada mock. Las políticas declaradas (Secrets,
 * primeros 3 gates) se conservan pero etiquetadas "declarado · sin verificar" (A19).
 *
 * Estructura:
 *   Hero (SectionHead Aivora) + Banner OpenClaw v2 (CTAs reales → chat)
 *   KPI row (KpiCard Aivora) — "Roles del norte" derivado del contrato, no hardcodeado
 *   Two col: Kill switch (dark) + Gates · Roles + Sesiones + Secrets
 *   Audit (tabla + filtros FUNCIONALES + export/paginación reales)
 *   Compliance (3 cards) + Footer
 */

import {
  ArrowRight,
  Ban,
  Check,
  Download,
  Lock,
  MessageSquare,
  Minus,
  Power,
  Rocket,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Users,
  Laptop,
  type LucideIcon
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
// Solo hooks/providers de v2 (no design system): useToast, useOpenClawIntent.
// Los componentes VISUALES v2 (BannerOpenClawV2, LiveIndicator) fueron migrados
// a primitivos aivora (AdvisorCard + PollPill) — cero montaje visual.
import { useOpenClawIntent, useToast } from "../../shared/ui/v2/index.ts";
import {
  AdvisorCard,
  aivoraGradient,
  Button,
  Caption,
  Card,
  Heading,
  KpiCard,
  Pill,
  SectionHead
} from "../../shared/ui/aivora/index.tsx";

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
    <section className="flex flex-col" style={{ gap: 24 }}>
      {hasFallback ? <FallbackBanner /> : null}
      <Hero data={data} />
      <KpiRow data={data} />
      <SubHead
        title="Kill switch, gates y permisos"
        subtitle="IAM · sesiones activas · secretos · poll 30s"
      />
      <GovernGrid data={data} rolesPulse={rolesPulse} sessionsPulse={sessionsPulse} />
      <SubHead
        title="Auditoría reciente"
        subtitle="Append-only · log inmutable · SHA-256"
      />
      <Audit data={data} />
      <SubHead
        title="Compliance"
        subtitle="Estados evaluados continuamente"
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

/** Nombres de los roles del norte según el contrato (roleDisplayNames si existe,
 * si no los 3 roles crudos). Fuente única del KPI "Roles del norte" — evita el
 * "3" hardcodeado y refleja lo que el backend realmente expone. */
function northRoleNames(data: DashboardData): string[] {
  const rd = data.operatingNorth.roleDisplayNames;
  const raw = rd
    ? [rd.control_plane, rd.future_optional_external_integration, rd.intelligent_cluster_operator_read_only]
    : [data.operatingNorth.delivrixRole, data.operatingNorth.openClawRole, data.operatingNorth.nfcRole];
  return raw.filter((n): n is string => Boolean(n));
}

/** Header de card estilo demo Aivora: título 15/500 + subtítulo mid + slot derecho. */
function CardHead({
  icon,
  title,
  subtitle,
  right
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center"
      style={{ gap: 10, padding: "16px 20px", borderBottom: "1px solid var(--color-border)" }}
    >
      {icon ? <span className="flex items-center shrink-0">{icon}</span> : null}
      <div className="min-w-0" style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>{title}</div>
        {subtitle ? (
          <div style={{ fontSize: 12.5, color: "var(--color-text-tertiary)", marginTop: 2 }}>{subtitle}</div>
        ) : null}
      </div>
      {/* Sin shrink-0: en angosto el cluster de controles (filtros + export del audit)
       * baja a su propia línea y sus hijos hacen wrap; en lg+ hay ancho de sobra y
       * queda inline igual que hoy. */}
      {right ? <div className="flex flex-wrap items-center" style={{ gap: 8 }}>{right}</div> : null}
    </div>
  );
}

/** Sub-section header a la ALTURA DE SUB-SECCIÓN del molde (h2 15/500 + subtítulo
 * 12.5 dim), NO el page-level SectionHead (h1 30/300). El molde reserva SectionHead
 * para el hero de la página (una sola vez); los divisores internos bajan a esta altura
 * para no apilar cinco h1 de 30px compitiendo entre sí (jerarquía del demo: un solo
 * h1 por pantalla, luego cards con su propio header). */
function SubHead({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="flex flex-col" style={{ gap: 2 }}>
      <h2 className="m-0 font-[family-name:var(--font-sans)]" style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>
        {title}
      </h2>
      {subtitle ? (
        <div style={{ fontSize: 12.5, color: "var(--color-text-tertiary)" }}>{subtitle}</div>
      ) : null}
    </div>
  );
}

function EndpointTag({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
      {children}
    </span>
  );
}

/* ============================================================
 * Hero — SectionHead Aivora (eyebrow + h1 light) + PollPill (config real)
 * ============================================================ */
function Hero({ data }: { data: DashboardData }) {
  void data;
  return (
    <SectionHead
      eyebrow="Seguridad y gobierno"
      title="Sin acciones reales, con todas las barandillas."
      subtitle="El panel opera con read-boundary y ApprovalGate. Toda acción operativa requiere firma humana, dry-run previo, log auditable y kill switch probado."
      right={<PollPill />}
    />
  );
}

/** PollPill — reemplaza al LiveIndicator v2 con un primitivo por tokens aivora.
 * Honesto: el panel NO expone un timestamp de última respuesta, así que no se
 * inventa "hace N s" (eso implicaría una edad de dato que no medimos). Se muestra
 * SOLO la config real del poll (30 s) con un dot de latido success. El pulso se
 * apaga con prefers-reduced-motion (accesibilidad §F). */
function PollPill() {
  return (
    <span
      className="inline-flex items-center"
      style={{
        gap: 8,
        padding: "5px 11px",
        borderRadius: 999,
        background: "var(--color-success-soft)",
        color: "var(--color-success)"
      }}
    >
      <style>{`
        @keyframes safetyPollPulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        @media (prefers-reduced-motion: reduce) { .safety-poll-dot{ animation:none !important } }
      `}</style>
      <span
        aria-hidden="true"
        className="safety-poll-dot"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--color-success)",
          boxShadow: "0 0 6px var(--color-success)",
          animation: "safetyPollPulse 2s ease-in-out infinite"
        }}
      />
      <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold tabular-nums leading-none">
        en vivo · poll 30 s
      </span>
    </span>
  );
}

/** AdvisorOpenClaw — superficie IA (única con gradiente/sparkle), reemplaza al
 * BannerOpenClawV2 (que además usaba ámbar como fondo, prohibido salvo paused).
 * El mensaje/título se derivan del contrato real (gates + kill switch); los CTAs
 * conservan función via useOpenClawIntent (chat OpenClaw real, mismo patrón que
 * Domains). Vive en la columna oscura junto al kill switch → marco cohesivo. */
function AdvisorOpenClaw({ data }: { data: DashboardData }) {
  const { sendIntent, navigateTo } = useOpenClawIntent();
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
      ? `${gates.length} gate${gates.length === 1 ? "" : "s"} abierto${gates.length === 1 ? "" : "s"}`
      : "Barandillas firmes";
  const badge =
    ks.enabled || gates.length > 0
      ? <Pill tone={ks.enabled ? "critical" : "warning"}>1 firma operador</Pill>
      : <Pill tone="success">sin pendientes</Pill>;
  const intentPrompt =
    gates.length > 0
      ? `Repasá conmigo los ${gates.length} gate(s) de seguridad abiertos y proponme un dry-run auditable antes de tocar nada.`
      : ks.enabled
        ? "Explicame el estado del kill switch activo y el protocolo para re-armarlo con firma humana."
        : "Confirmá conmigo que las barandillas de gobierno están firmes y qué revisar a continuación.";
  return (
    <AdvisorCard>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: aivoraGradient, display: "grid", placeItems: "center" }}>
            <Sparkles size={16} color="#fff" aria-hidden="true" />
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 500, color: "var(--color-text-primary)" }}>Advisor · OpenClaw</div>
          <span style={{ marginLeft: "auto" }}>{badge}</span>
        </div>
        <div style={{ borderLeft: "2px solid transparent", borderImage: `${aivoraGradient} 1`, paddingLeft: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>{title}</div>
          <p className="m-0" style={{ fontSize: 13, lineHeight: 1.5, color: "var(--color-text-secondary)" }}>
            {message}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant="gradient" size="sm" onClick={() => sendIntent(intentPrompt, "safety:advisor")}>
            <Rocket size={13} strokeWidth={1.75} aria-hidden="true" />
            Revisar plan dry-run
            <ArrowRight size={12} strokeWidth={1.75} aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigateTo("canvas")}>
            <MessageSquare size={13} strokeWidth={1.75} aria-hidden="true" />
            Abrir chat
          </Button>
        </div>
      </div>
    </AdvisorCard>
  );
}

/* ============================================================
 * KPI row — KpiCard Aivora (tile + número tabular). Sin deltas/sparklines:
 * no hay serie temporal real, así que no se inventan (regla no-mock).
 * ============================================================ */
function KpiRow({ data }: { data: DashboardData }) {
  const allowed = data.operatingNorth.allowedActions?.length ?? 0;
  const blocked = data.operatingNorth.blockedActions?.length ?? 0;
  const gates = data.operatingNorth.gates?.length ?? 0;
  const ks = data.killSwitch;
  const roleCount = northRoleNames(data).length;
  const criticalEvents = (data.overview.alerts ?? []).filter(
    (a) => a.severity === "critical" || a.severity === "blocked"
  ).length;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 20 }}>
      <SafetyKpi
        label="Acciones permitidas"
        value={String(allowed)}
        suffix={`/ ${allowed + blocked}`}
        icon={ShieldCheck}
        note={`${blocked} bloqueadas`}
        noteTone={blocked > 0 ? "var(--color-critical)" : "var(--color-success)"}
        endpoint="/v1/operating-north"
      />
      <SafetyKpi
        label="Roles del norte"
        value={String(roleCount)}
        suffix="roles"
        icon={Users}
        note={roleCount > 0 ? `${data.operatingNorth.delivrixRole} · ${data.operatingNorth.openClawRole}` : "sin roles en contrato"}
        noteTone="var(--color-text-secondary)"
        endpoint="/v1/operating-north"
      />
      <SafetyKpi
        label="Kill switch"
        value={ks.enabled ? "ACTIVO" : "ARMADO"}
        icon={Power}
        note={ks.reason || (ks.enabled ? "sin razón" : "sin uso")}
        noteTone={ks.enabled ? "var(--color-critical)" : "var(--color-text-secondary)"}
        endpoint="/v1/safety/kill-switch"
      />
      <SafetyKpi
        label="Alertas críticas"
        value={String(criticalEvents)}
        icon={TriangleAlert}
        note={`${gates} gates abiertos`}
        noteTone={gates > 0 ? "var(--color-warning)" : "var(--color-success)"}
        endpoint="/v1/admin/overview"
      />
    </div>
  );
}

/** KpiCard Aivora + una línea de contexto real (nota + endpoint) sobre la misma card.
 * La `nota` es un dato del contrato (no un delta/tendencia inventado). */
function SafetyKpi({
  label,
  value,
  suffix,
  icon,
  note,
  noteTone,
  endpoint
}: {
  label: string;
  value: string;
  suffix?: string;
  icon: LucideIcon;
  note: string;
  noteTone: string;
  endpoint: string;
}) {
  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      <KpiCard label={label} value={value} suffix={suffix} icon={icon} />
      <div className="flex items-center" style={{ gap: 6, padding: "0 2px" }}>
        <span className="text-[11px] font-[family-name:var(--font-mono)] font-semibold truncate min-w-0" style={{ color: noteTone }}>
          {note}
        </span>
        <span className="flex-1" aria-hidden="true" />
        <EndpointTag>{endpoint}</EndpointTag>
      </div>
    </div>
  );
}

/* ============================================================
 * Govern grid — CENTRO CLARO (gates, roles, sesiones, secrets: contenido de
 * trabajo que el operador escanea) + COLUMNA OSCURA a la derecha (kill switch +
 * Advisor OpenClaw). Los dos bloques negros van AGRUPADOS formando el borde
 * derecho del marco (regla anti "card oscura suelta" del demo), nunca un negro
 * flotando entre claras.
 * ============================================================ */
function GovernGrid({
  data,
  rolesPulse,
  sessionsPulse
}: {
  data: DashboardData;
  rolesPulse: boolean;
  sessionsPulse: boolean;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] items-start" style={{ gap: 20 }}>
      <LeftGovern data={data} rolesPulse={rolesPulse} sessionsPulse={sessionsPulse} />
      <RightGovern data={data} />
    </div>
  );
}

/** Centro claro: gates + roles/sesiones + secrets. Todo Card clara (sin ink). */
function LeftGovern({
  data,
  rolesPulse,
  sessionsPulse
}: {
  data: DashboardData;
  rolesPulse: boolean;
  sessionsPulse: boolean;
}) {
  return (
    <div className="flex flex-col" style={{ gap: 20 }}>
      <GatesCard data={data} />
      <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 20 }}>
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
      </div>
      <SecretsCard />
    </div>
  );
}

/** Columna oscura = borde derecho del marco: kill switch (ops always-dark) +
 * Advisor OpenClaw (ink). Dos superficies negras agrupadas, cohesivas en claro. */
function RightGovern({ data }: { data: DashboardData }) {
  return (
    <div className="flex flex-col" style={{ gap: 20 }}>
      <KillSwitchGrande data={data} />
      <AdvisorOpenClaw data={data} />
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
    <Card
      className="flex flex-col overflow-hidden"
      style={{
        padding: 0,
        background: "var(--color-always-dark-surface)",
        border: "1px solid var(--color-always-dark-border)"
      }}
    >
      <div className="flex items-center" style={{ gap: 14, padding: "20px 24px" }}>
        <span
          aria-hidden="true"
          className="grid place-items-center shrink-0"
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: armed ? "var(--color-on-dark-success-overlay)" : "var(--color-on-dark-critical-overlay)",
            color: "var(--color-on-dark-strong)",
            boxShadow: "0 0 0 1px var(--color-always-dark-border)"
          }}
        >
          <Power size={20} strokeWidth={2.25} aria-hidden="true" />
        </span>
        <div className="flex flex-col flex-1 min-w-0" style={{ gap: 4 }}>
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
            {ksSubtitle} · 1 firma de operador exigida en cada activación.
          </span>
        </div>
        <span
          className="inline-flex items-center shrink-0 self-start text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase"
          style={{
            gap: 6,
            padding: "5px 10px",
            borderRadius: 999,
            background: armed ? "var(--color-on-dark-success-overlay)" : "var(--color-on-dark-critical-overlay)",
            border: "1px solid var(--color-always-dark-border)",
            color: "var(--color-on-dark-strong)",
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
          // auto-fit + minmax → 3 columnas cuando hay ancho, reflow a 2 (o apiladas)
          // en la columna angosta de 380px sin apretar los valores.
          gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))",
          gap: 16,
          padding: "14px 24px",
          background: "var(--color-always-dark-bg)",
          borderTop: "1px solid var(--color-always-dark-border)"
        }}
      >
        <KillStat label="responsable" value={ks.updatedBy || "sin asignar"} />
        <KillStat label="fase del norte" value={data.operatingNorth.phase || "—"} />
        {/* El contrato NO expone marca de última activación/uso; solo updatedAt (último
         * cambio de estado). No inventamos historial: mostramos el último cambio real
         * (o "sin registro" si el contrato no trae fecha), nunca "nunca"/"ahora". */}
        <KillStat
          label="último cambio"
          value={ks.updatedAt ? new Date(ks.updatedAt).toLocaleDateString("es-CO") : "sin registro"}
        />
      </div>
    </Card>
  );
}

function KillStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col min-w-0" style={{ gap: 2 }}>
      <span
        className="text-[10px] font-[family-name:var(--font-caption)] font-medium uppercase truncate"
        style={{ color: "var(--color-on-dark-soft)", letterSpacing: "var(--tracking-wider)" }}
      >
        {label}
      </span>
      <span
        className="text-[12px] font-[family-name:var(--font-mono)] tabular-nums truncate"
        style={{ color: "var(--color-on-dark-medium)" }}
        title={value}
      >
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
  const base: Array<{
    check: true | "warn" | "bad" | "off";
    label: string;
    state: string;
    tone: string;
    declared?: boolean;
  }> = [
    // Estos 3 gates son afirmaciones de diseño hardcodeadas (check:true fijo):
    // el panel NO verifica en runtime que se cumplan. Se muestran como
    // "declarado · sin verificar" con tono neutro para no afirmar una
    // verificación que no ocurrió (A19). La lógica de gates no cambia.
    { check: true, declared: true, label: "Log de auditoría append-only", state: "declarado · sin verificar", tone: "var(--color-text-tertiary)" },
    { check: true, declared: true, label: "Dry-run obligatorio antes de escribir", state: "declarado · sin verificar", tone: "var(--color-text-tertiary)" },
    { check: true, declared: true, label: "Read-boundary + ApprovalGate", state: "declarado · sin verificar", tone: "var(--color-text-tertiary)" },
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
    tone: "var(--color-warning)",
    declared: false
  }));
  // El subset de base no tiene rawLabel, agregamos uno igual al label para uniformar
  const baseWithRaw = base.map((b) => ({ ...b, rawLabel: b.label, declared: b.declared ?? false }));
  return [...baseWithRaw, ...opGates];
}

/** Ícono de estado del gate — lucide (no glifo ASCII), mismo criterio que StateBadge
 * del molde: Check=verificado, TriangleAlert=revisar, Ban=bloqueado/crítico, Minus=off.
 * Da la redundancia daltónica (§4/§8): dot de color + label + ÍCONO distinguible en gris. */
function GateGlyph({ check }: { check: true | "warn" | "bad" | "off" }) {
  const Icon = check === true ? Check : check === "warn" ? TriangleAlert : check === "bad" ? Ban : Minus;
  return <Icon size={10} strokeWidth={2.5} aria-hidden="true" />;
}

function GatesCard({ data }: { data: DashboardData }) {
  const GATE_ROWS = buildSafetyGates(data);
  // Solo cuentan como "OK" los gates que el panel verifica en runtime.
  // Los gates `declared` (check:true fijo por diseño, no verificado en vivo)
  // se excluyen del rollup verde y se reportan aparte como "sin verificar",
  // para que el resumen no afirme como satisfechos controles que no comprueba (A19).
  const declaredCount = GATE_ROWS.filter((g) => g.declared).length;
  const okCount = GATE_ROWS.filter((g) => g.check === true && !g.declared).length;
  const verifiableTotal = GATE_ROWS.length - declaredCount;
  return (
    <Card className="flex flex-col" style={{ padding: 0 }}>
      <CardHead
        title="Gates de seguridad"
        subtitle="Estado de los gates no negociables del MVP"
        right={
          <>
            {declaredCount > 0 ? (
              <Pill tone="neutral">{declaredCount} sin verificar</Pill>
            ) : null}
            <Pill tone="success">
              {okCount} / {verifiableTotal} verificados
            </Pill>
          </>
        }
      />
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
              className="grid place-items-center text-[var(--color-on-dark-strong)] shrink-0"
              style={{ width: 16, height: 16, borderRadius: 999, background: row.tone }}
            >
              <GateGlyph check={row.check} />
            </span>
            <span
              className="text-[12px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-primary)] truncate"
              style={{ flex: "1 1 auto", minWidth: 0 }}
            >
              {row.label}
            </span>
            {row.declared ? (
              <span
                className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase shrink-0"
                style={{
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: "var(--color-neutral-soft)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                  letterSpacing: "var(--tracking-wide)",
                  whiteSpace: "nowrap"
                }}
                title="Declarado por diseño; el panel no verifica este control en runtime."
              >
                sin verificar
              </span>
            ) : null}
            <span
              className="text-[10px] font-[family-name:var(--font-mono)] shrink-0"
              style={{ color: row.tone, whiteSpace: "nowrap" }}
            >
              {row.state}
            </span>
          </li>
        ))}
      </ul>
    </Card>
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
    <Card className="flex flex-col" style={{ padding: 0 }}>
      <CardHead
        icon={<Users size={15} strokeWidth={1.7} className="text-[var(--color-info)]" aria-hidden="true" />}
        title="Roles"
        right={
          <>
            <RealtimeTick active={pulseActive} />
            {stale}
            <EndpointTag>/v1/iam/roles</EndpointTag>
          </>
        }
      />
      <ul className="m-0 p-0 list-none flex flex-col">
        {roles.map((r, i) => (
          <li
            key={r.name}
            className="flex items-center"
            style={{
              gap: 8,
              padding: "10px 20px",
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
    </Card>
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
          <EndpointTag>/v1/iam/sessions</EndpointTag>
        </div>
        <EmptySessionsCard />
      </div>
    );
  }

  return (
    <Card className="flex flex-col" style={{ padding: 0 }}>
      <CardHead
        icon={<Laptop size={15} strokeWidth={1.7} className="text-[var(--color-text-secondary)]" aria-hidden="true" />}
        title="Sesiones activas"
        right={
          <>
            <RealtimeTick active={pulseActive} />
            {stale}
            <EndpointTag>/v1/iam/sessions</EndpointTag>
          </>
        }
      />
      <ul className="m-0 p-0 list-none flex flex-col">
        {sessions.map((s, i) => (
          <li
            key={s.actor}
            className="flex flex-col"
            style={{
              gap: 2,
              padding: "10px 20px",
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
    </Card>
  );
}

function SecretsCard() {
  // Estas líneas son la política de secretos DECLARADA (configuración esperada),
  // no una verificación en vivo: el panel no consulta AWS Secrets Manager ni
  // audita el repo en runtime. Se presenta con tono neutro y tag "sin verificar"
  // para no afirmar una verificación que no ocurrió (A19).
  const lines = [
    "0 secretos en el repositorio",
    "Rotación SMTP cada 30 d",
    "Acceso JIT al kill switch"
  ];
  return (
    <Card className="flex flex-col gap-2.5" style={{ padding: 20 }}>
      <header className="flex items-center" style={{ gap: 8 }}>
        <Lock size={15} strokeWidth={1.7} className="text-[var(--color-unknown)]" aria-hidden="true" />
        <h3 className="m-0 text-[15px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-primary)]">
          Secrets management
        </h3>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase shrink-0"
          style={{
            padding: "2px 6px",
            borderRadius: 4,
            background: "var(--color-neutral-soft)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
            letterSpacing: "var(--tracking-wide)",
            whiteSpace: "nowrap"
          }}
          title="Política declarada; el panel no verifica el estado de los secretos en runtime."
        >
          declarado · sin verificar
        </span>
      </header>
      <p className="m-0 text-[12px] font-[family-name:var(--font-sans)] leading-[1.4] text-[var(--color-text-secondary)]">
        Política declarada: AWS Secrets Manager, 0 secretos en repo y SMTP cifrado. El panel no verifica este estado en vivo.
      </p>
      <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 6 }}>
        {lines.map((l) => (
          <li key={l} className="flex items-center" style={{ gap: 6 }}>
            <Lock size={11} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
            <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">{l}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ============================================================
 * Audit — audit rows desde /v1/audit-events
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
  isCritical: boolean;
  isOperator: boolean;
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
    isCritical: ["critical", "blocked", "high", "warning"].includes(e.riskLevel),
    isOperator: e.actorType.includes("operator") || e.actorType.includes("human"),
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

const AUDIT_INITIAL_VISIBLE = 24;
const AUDIT_PAGE_SIZE = 24;

type AuditFilter = "all" | "critical" | "operator";
const AUDIT_FILTERS: Array<{ id: AuditFilter; label: string }> = [
  { id: "all", label: "Todos" },
  { id: "critical", label: "Críticos" },
  { id: "operator", label: "Operador" }
];

/** Chip de filtro (molde Aivora, por tokens). Activo = well hundido + hairline
 * fuerte + texto primario; inactivo = transparente + texto atenuado. Sin acento:
 * el azul se reserva para señales, no para la barra de filtros. */
function AuditChip({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 10px",
        borderRadius: 8,
        fontSize: 12,
        fontWeight: 500,
        cursor: "pointer",
        whiteSpace: "nowrap",
        background: active ? "var(--color-surface-sunken)" : "transparent",
        border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
        color: active ? "var(--color-text-primary)" : "var(--color-text-tertiary)"
      }}
    >
      {children}
    </button>
  );
}

function AuditTable({ rows }: { rows: AuditRow[] }) {
  const { toast } = useToast();
  const [visibleCount, setVisibleCount] = useState(AUDIT_INITIAL_VISIBLE);
  const [filter, setFilter] = useState<AuditFilter>("all");

  // Filtro FUNCIONAL: recorta las filas por severidad/actor antes de paginar.
  const filteredRows =
    filter === "critical"
      ? rows.filter((r) => r.isCritical)
      : filter === "operator"
        ? rows.filter((r) => r.isOperator)
        : rows;

  // Paginación cliente: ocultamos rows excedentes y damos botón para cargar más.
  const visibleRows = filteredRows.slice(0, visibleCount);
  const hasMore = visibleCount < filteredRows.length;
  const remaining = filteredRows.length - visibleCount;

  const selectFilter = (next: AuditFilter) => {
    setFilter(next);
    setVisibleCount(AUDIT_INITIAL_VISIBLE);
  };

  const handleExport = () => {
    try {
      const payload = {
        exportedAt: new Date().toISOString(),
        filter,
        rowCount: filteredRows.length,
        rows: filteredRows.map((r) => ({
          ts: r.ts,
          actor: r.actor,
          action: r.action,
          resource: r.resource,
          hash: r.hash,
          result: r.result
        }))
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `delivrix-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Auditoría exportada", {
        description: `${filteredRows.length} eventos en JSON.`,
        duration: 2500
      });
    } catch (e) {
      toast.error("No se pudo exportar la auditoría", {
        description: e instanceof Error ? e.message : "Error desconocido"
      });
    }
  };

  return (
    <Card className="flex flex-col" style={{ padding: 0 }}>
      <CardHead
        title="Log de auditoría"
        subtitle="Append-only · hash encadenado SHA-256 · contrato /v1/audit-events"
        right={
          <>
            <div className="flex items-center" style={{ gap: 6 }}>
              {AUDIT_FILTERS.map((f) => (
                <AuditChip key={f.id} active={filter === f.id} onClick={() => selectFilter(f.id)}>
                  {f.label}
                </AuditChip>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={handleExport} disabled={filteredRows.length === 0}>
              <Download size={12} strokeWidth={1.75} aria-hidden="true" />
              Exportar
            </Button>
          </>
        }
      />

      <div className="overflow-x-auto">
      <div
        className="grid"
        style={{
          gridTemplateColumns: "84px 128px 160px minmax(0,1fr) 96px 80px",
          minWidth: 720,
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

      {visibleRows.length > 0 ? (
        <ul className="m-0 p-0 list-none flex flex-col">
          {visibleRows.map((row, i) => (
            <li
              key={`${row.hash}-${i}`}
              className="grid items-center"
              style={{
                gridTemplateColumns: "84px 128px 160px minmax(0,1fr) 96px 80px",
                minWidth: 720,
                gap: 12,
                padding: "10px 20px",
                borderBottom: i < visibleRows.length - 1 ? "1px solid var(--color-border)" : "none"
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
        <AuditEmptyState filtered={rows.length > 0} />
      )}
      </div>

      {hasMore ? (
        <div className="flex items-center justify-center" style={{ padding: "10px 12px 12px 12px" }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVisibleCount((c) => Math.min(c + AUDIT_PAGE_SIZE, filteredRows.length))}
          >
            Mostrar {Math.min(AUDIT_PAGE_SIZE, remaining)} entradas más
            <span className="text-[10px] font-[family-name:var(--font-mono)]" style={{ color: "var(--color-text-tertiary)" }}>
              {visibleCount}/{filteredRows.length}
            </span>
          </Button>
        </div>
      ) : filteredRows.length > 0 ? (
        <div className="flex items-center justify-center" style={{ padding: "10px 12px 12px 12px" }}>
          <span className="text-[10px] font-[family-name:var(--font-mono)]" style={{ color: "var(--color-text-tertiary)" }}>
            {filteredRows.length} {filteredRows.length === 1 ? "entrada" : "entradas"} · todas visibles
          </span>
        </div>
      ) : null}
    </Card>
  );
}

function AuditEmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-start" style={{ gap: 8, padding: "24px 20px" }}>
      <Heading level={3}>
        {filtered ? "Sin eventos para este filtro" : "Sin eventos de auditoría"}
      </Heading>
      <Caption style={{ maxWidth: 520, color: "var(--color-text-secondary)" }}>
        {filtered
          ? "Ningún evento del log coincide con el filtro seleccionado. Cambiá a «Todos» para ver el log completo."
          : "El contrato no devolvió eventos para la tabla de seguridad."}
      </Caption>
      <div style={{ marginTop: 4 }}>
        <EndpointTag>/v1/audit-events</EndpointTag>
      </div>
    </div>
  );
}

/* ============================================================
 * Compliance row — 3 cards
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
      <Card className="flex items-center gap-2" style={{ padding: 12 }}>
        <p className="m-0 text-[12px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
          El contrato /v1/compliance/status no devuelve controles todavía.
        </p>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 20 }}>
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
    <Card className="flex flex-col gap-2.5" style={{ padding: 20 }}>
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
    </Card>
  );
}

/* ============================================================
 * Footer
 * ============================================================ */
function Footer() {
  return (
    <footer
      className="flex flex-wrap items-center"
      style={{ gap: 16, padding: "12px 0 0 0" }}
    >
      <span className="inline-flex items-center" style={{ gap: 8 }}>
        <ShieldCheck size={12} strokeWidth={1.75} className="text-[var(--color-success)]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-caption)] text-[var(--color-text-secondary)]">
          Read-boundary activo · firmas por ApprovalGate auditado
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
