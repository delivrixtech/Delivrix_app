/**
 * v5 Seguridad — gobernanza, kill switch, IAM, audit chain, compliance.
 *
 * Layout:
 *   PageHead (eyebrow + title + body + LiveIndicator trailing)
 *   BannerOpenClaw condicional (si hay gates abiertos / kill switch activo)
 *   KPI strip 4 cols (acciones / roles / kill switch / alertas)
 *   Kill Switch hero block (always-dark) — regla de 2 personas
 *   Grid 2-col: Gates | IAM (roles + sesiones + secretos)
 *   Audit table (append-only · SHA-256)
 *   Footer compliance chips + runbook
 *
 * Disciplina v5:
 *   - VARIANCE 2/5, MOTION 1/5, DENSITY 4/5
 *   - Una sola HumanNote (footer del banner OpenClaw)
 *   - Sin pills redundantes en KPIs (eyebrow + valueTone bastan)
 *   - Kill Switch usa --color-always-dark-bg + on-dark-* (no se invierte)
 *   - Primary CTA: bg-accent + accent-fg (Button variant=primary)
 *   - Sin shadows estáticas, hairlines 1px, mono para datos/hashes
 */

import { motion } from "framer-motion";
import {
  ArrowRight,
  Lock,
  Power,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Users
} from "lucide-react";
import { useRef, type ReactNode } from "react";
import type { DashboardData } from "../../shared/api/client";
import {
  filterAuditEvents,
  formatTimeOnly,
  shortAuditHash
} from "../../shared/lib/formatters";
import { LiveIndicator } from "../../shared/ui/v2/LiveIndicator";
import {
  Badge,
  Body,
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
import { cn } from "../lib/cn";
import { staggerContainer, staggerItem } from "../lib/motion";
import { PageHead } from "./_PageHead";

const POLL_SEC = 30;

export interface SafetyV5Props {
  data: DashboardData;
}

export function SafetyV5({ data }: SafetyV5Props) {
  const mountedAt = useRef<number>(Date.now()).current;
  const ks = data.killSwitch;
  const gates = data.operatingNorth.gates ?? [];
  const liveInfra = data.operatingNorth.liveInfrastructureWritesEnabled;
  const sendsReal = data.operatingNorth.delivrixSendsRealEmail;
  const criticalAlerts = (data.overview.alerts ?? []).filter(
    (a) => a.severity === "critical" || a.severity === "blocked"
  ).length;
  const allowed = data.operatingNorth.allowedActions?.length ?? 0;
  const blocked = data.operatingNorth.blockedActions?.length ?? 0;
  const rolesCount = data.iamRoles.length;
  const sessions = data.iamSessions;
  const showBanner = gates.length > 0 || ks.enabled || liveInfra || sendsReal;

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <PageHead
          eyebrow="Seguridad y gobierno"
          title="Sin acciones reales, con todas las barandillas."
          body="El panel es GET-only. Toda acción operativa requiere aprobación humana, dry-run previo, log auditable y kill switch probado."
          trailing={
            <div className="flex flex-col items-end gap-1.5">
              <LiveIndicator pollIntervalSec={POLL_SEC} lastUpdateAt={mountedAt} tone="success" />
              <MonoCode className="text-[10px]">poll {POLL_SEC}s · /v1/safety/*</MonoCode>
            </div>
          }
        />
      </motion.div>

      {showBanner && (
        <motion.div variants={staggerItem}>
          <OpenClawBanner
            gates={gates.length}
            ksActive={ks.enabled}
            ksReason={ks.reason}
            liveInfra={liveInfra}
            sendsReal={sendsReal}
          />
        </motion.div>
      )}

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Estado actual"
          title="Indicadores de gobierno"
          caption={
            <>
              Acciones, roles, kill switch y alertas críticas ·{" "}
              <MonoCode>/v1/operating-north · /v1/safety/kill-switch</MonoCode>
            </>
          }
        />
        <KpiStrip
          allowed={allowed}
          blocked={blocked}
          rolesCount={rolesCount}
          ksEnabled={ks.enabled}
          ksUpdatedBy={ks.updatedBy}
          criticalAlerts={criticalAlerts}
          gatesOpen={gates.length}
        />
      </motion.section>

      <motion.section variants={staggerItem}>
        <KillSwitchHero data={data} />
      </motion.section>

      <motion.section variants={staggerItem} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <GatesCard data={data} />
        <IamColumn data={data} sessions={sessions} />
      </motion.section>

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Audit chain"
          title="Log inmutable"
          caption={
            <>
              Append-only · SHA-256 encadenado ·{" "}
              <MonoCode>/v1/audit-events</MonoCode>
            </>
          }
          trailing={
            <Button variant="ghost" size="sm">
              Ver todo
              <ArrowRight size={11} strokeWidth={1.75} />
            </Button>
          }
        />
        <AuditTable data={data} />
      </motion.section>

      <motion.div variants={staggerItem}>
        <ComplianceFooter />
      </motion.div>
    </motion.div>
  );
}

/* ============================================================
 * Banner OpenClaw (condicional)
 * ============================================================ */

function OpenClawBanner({
  gates,
  ksActive,
  ksReason,
  liveInfra,
  sendsReal
}: {
  gates: number;
  ksActive: boolean;
  ksReason: string;
  liveInfra: boolean;
  sendsReal: boolean;
}) {
  const title = ksActive
    ? "Kill switch activo"
    : gates > 0
    ? `OpenClaw detectó ${gates} gate${gates === 1 ? "" : "s"} abierto${gates === 1 ? "" : "s"}`
    : "Frontera abierta en infraestructura";
  const body = ksActive
    ? `Razón registrada: ${ksReason || "sin razón"}. Antes de re-armar, validá el protocolo y firmá con un segundo operador.`
    : gates > 0
    ? `Hay validaciones humanas pendientes en el contrato del norte. ${
        liveInfra || sendsReal ? "Detecté escrituras reales habilitadas — " : ""
      }Preparé un plan dry-run para revisarlo paso a paso.`
    : "Detecté escrituras reales habilitadas. Recomiendo bajar la frontera antes del próximo despliegue.";
  const tone = ksActive ? "critical" : "warning";
  return (
    <Card padding="relaxed" className="flex items-start gap-4 bg-surface">
      <div
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-md",
          tone === "critical" ? "bg-critical-soft text-critical" : "bg-warning-soft text-warning"
        )}
      >
        {tone === "critical" ? (
          <ShieldAlert size={16} strokeWidth={1.75} />
        ) : (
          <TriangleAlert size={16} strokeWidth={1.75} />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Eyebrow>OpenClaw propone</Eyebrow>
          <Pill tone={tone} size="sm">
            Dry-run
          </Pill>
        </div>
        <H3>{title}</H3>
        <BodySm>{body}</BodySm>
        <HumanNote className="mt-1 max-w-[640px]">
          Si querés revisarlo conmigo, abrí el runbook y te lo explico antes de cualquier firma.
        </HumanNote>
        <div className="mt-1 flex items-center gap-2">
          <Button variant="primary" size="sm">
            Revisar plan dry-run
            <ArrowRight size={12} strokeWidth={1.75} />
          </Button>
          <Button variant="ghost" size="sm">
            Abrir runbook
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ============================================================
 * KPI strip
 * ============================================================ */

function KpiStrip({
  allowed,
  blocked,
  rolesCount,
  ksEnabled,
  ksUpdatedBy,
  criticalAlerts,
  gatesOpen
}: {
  allowed: number;
  blocked: number;
  rolesCount: number;
  ksEnabled: boolean;
  ksUpdatedBy: string;
  criticalAlerts: number;
  gatesOpen: number;
}) {
  const ksTone: "success" | "critical" = ksEnabled ? "critical" : "success";
  const alertTone: "default" | "warning" =
    criticalAlerts > 0 ? "warning" : "default";
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card padding="relaxed">
        <Stat
          label="Acciones permitidas"
          value={allowed}
          unit={`/ ${allowed + blocked}`}
          tone="default"
          hint={
            blocked > 0
              ? `${blocked} bloqueadas · contrato del norte`
              : "Sin acciones bloqueadas"
          }
        />
      </Card>
      <Card padding="relaxed">
        <Stat
          label="Roles activos"
          value={rolesCount}
          unit="roles"
          tone="default"
          hint="Control plane · operador supervisado · integración futura"
        />
      </Card>
      <Card padding="relaxed">
        <Stat
          label="Kill switch"
          value={ksEnabled ? "Activo" : "Armado"}
          unit={ksEnabled ? "corte real" : "listo"}
          tone={ksTone}
          hint={ksUpdatedBy ? `Responsable · ${ksUpdatedBy}` : "Sin responsable registrado"}
        />
      </Card>
      <Card padding="relaxed">
        <Stat
          label="Alertas críticas"
          value={criticalAlerts}
          unit={gatesOpen > 0 ? `${gatesOpen} gates abiertos` : "todo limpio"}
          tone={alertTone}
          hint={
            criticalAlerts > 0
              ? "Atención humana requerida"
              : "Sin incidentes activos en el snapshot"
          }
        />
      </Card>
    </div>
  );
}

/* ============================================================
 * Kill Switch hero — always-dark block, regla de 2 personas.
 * ============================================================ */

function KillSwitchHero({ data }: { data: DashboardData }) {
  const ks = data.killSwitch;
  const armed = !ks.enabled;
  const title = armed
    ? "Armado · listo para activar"
    : `Activado · ${ks.reason || "intervención manual"}`;
  const subtitle = ks.updatedAt
    ? `Actualizado ${new Date(ks.updatedAt).toLocaleString("es-CO", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      })}`
    : "Sin movimientos registrados";
  return (
    <section
      className="flex flex-col overflow-hidden rounded-[10px]"
      style={{
        background: "var(--color-always-dark-bg)",
        border: "1px solid var(--color-always-dark-border)"
      }}
    >
      <div className="flex items-start gap-4 p-5">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-md"
          style={{
            background: "var(--color-always-dark-raised)",
            border: "1px solid var(--color-always-dark-border-strong)",
            color: "var(--color-on-dark-strong)"
          }}
        >
          <Power size={18} strokeWidth={1.75} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span
            className="font-mono text-[10px] font-semibold uppercase leading-none"
            style={{
              color: "var(--color-on-dark-soft)",
              letterSpacing: "0.14em"
            }}
          >
            Kill switch global · /v1/safety/kill-switch
          </span>
          <h2
            className="m-0 font-heading text-[20px] font-semibold leading-[1.2]"
            style={{
              color: "var(--color-on-dark-strong)",
              letterSpacing: "-0.015em"
            }}
          >
            {title}
          </h2>
          <span
            className="font-sans text-[13px] font-normal leading-[1.5]"
            style={{ color: "var(--color-on-dark-medium)" }}
          >
            {subtitle}
          </span>
        </div>
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 font-sans text-[11px] font-semibold uppercase"
          style={{
            letterSpacing: "0.08em",
            background: armed
              ? "var(--color-on-dark-success-overlay)"
              : "var(--color-on-dark-critical-overlay)",
            color: armed ? "var(--color-success-fg)" : "var(--color-critical-fg)"
          }}
        >
          <span
            aria-hidden="true"
            className="inline-block size-1.5 rounded-full"
            style={{
              background: armed ? "var(--color-success)" : "var(--color-critical)"
            }}
          />
          {armed ? "Armado" : "Activo"}
        </span>
      </div>

      <div
        className="grid grid-cols-1 sm:grid-cols-3"
        style={{
          borderTop: "1px solid var(--color-always-dark-border)"
        }}
      >
        <KillStat label="Responsable" value={ks.updatedBy || "sin asignar"} />
        <KillStat
          label="Fase del norte"
          value={data.operatingNorth.phase || "—"}
          divider
        />
        <KillStat
          label="Último uso real"
          value={ks.enabled ? "ahora" : "nunca"}
          divider
        />
      </div>

      <div
        className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"
        style={{
          borderTop: "1px solid var(--color-always-dark-border)",
          background: "var(--color-always-dark-surface)"
        }}
      >
        <div className="flex items-center gap-2">
          <ShieldAlert
            size={13}
            strokeWidth={1.75}
            style={{ color: "var(--color-on-dark-medium)" }}
            aria-hidden="true"
          />
          <span
            className="font-sans text-[12px] leading-[1.45]"
            style={{ color: "var(--color-on-dark-medium)" }}
          >
            Requiere rol elevado y regla de dos personas en cada activación.
          </span>
        </div>
        <Button
          variant="primary"
          size="sm"
          style={{
            background: armed ? "var(--color-accent)" : "var(--color-critical)",
            color: armed ? "var(--color-accent-fg)" : "var(--color-on-dark-strong)"
          }}
        >
          {armed ? "Activar interruptor de corte" : "Rearmar interruptor"}
          <ArrowRight size={12} strokeWidth={1.75} />
        </Button>
      </div>
    </section>
  );
}

function KillStat({
  label,
  value,
  divider
}: {
  label: string;
  value: string;
  divider?: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-1 px-5 py-3.5"
      style={{
        borderLeft: divider
          ? "1px solid var(--color-always-dark-border)"
          : undefined
      }}
    >
      <span
        className="font-mono text-[10px] font-semibold uppercase leading-none"
        style={{
          color: "var(--color-on-dark-soft)",
          letterSpacing: "0.14em"
        }}
      >
        {label}
      </span>
      <span
        className="font-mono text-[13px] font-medium leading-[1.3] tabular-nums"
        style={{ color: "var(--color-on-dark-strong)" }}
      >
        {value}
      </span>
    </div>
  );
}

/* ============================================================
 * Gates de seguridad (izq del grid 2-col)
 * ============================================================ */

interface GateRow {
  label: string;
  state: string;
  tone: "success" | "warning" | "critical" | "neutral";
}

function buildGateRows(data: DashboardData): GateRow[] {
  const ks = data.killSwitch;
  const live = data.operatingNorth.liveInfrastructureWritesEnabled;
  const smtp = data.operatingNorth.delivrixSendsRealEmail;
  const nfc = data.operatingNorth.nfcProductionWritesEnabled;
  const base: GateRow[] = [
    {
      label: "Log de auditoría append-only",
      state: "verificado",
      tone: "success"
    },
    {
      label: "Dry-run obligatorio antes de escribir",
      state: "verificado",
      tone: "success"
    },
    {
      label: "Panel solo lectura · GET-only",
      state: "verificado",
      tone: "success"
    },
    {
      label: "Kill switch probado",
      state: ks.updatedAt
        ? new Date(ks.updatedAt).toLocaleDateString("es-CO")
        : "sin uso",
      tone: ks.enabled ? "critical" : "success"
    },
    {
      label: "Live infrastructure writes",
      state: live ? "habilitado · revisar" : "deshabilitado",
      tone: live ? "warning" : "success"
    },
    {
      label: "SMTP envía correo real",
      state: smtp ? "envío real activo" : "simulación",
      tone: smtp ? "warning" : "success"
    },
    {
      label: "Puente NFC",
      state: nfc ? "habilitado" : "deshabilitado",
      tone: nfc ? "warning" : "neutral"
    }
  ];
  const opGates: GateRow[] = (data.operatingNorth.gateDetails ?? []).map((g) => ({
    label: g.displayLabel,
    state: "revisión pendiente",
    tone: "warning"
  }));
  return [...base, ...opGates];
}

function GatesCard({ data }: { data: DashboardData }) {
  const rows = buildGateRows(data);
  const okCount = rows.filter((r) => r.tone === "success").length;
  return (
    <Card padding="none" className="flex flex-col">
      <header className="flex items-end justify-between gap-4 border-b border-border px-5 py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Eyebrow>No negociables</Eyebrow>
          <H3>Gates de seguridad</H3>
          <Caption>Cada barandilla evaluada contra el contrato del norte</Caption>
        </div>
        <Badge>
          {okCount} / {rows.length}
        </Badge>
      </header>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((row, i) => (
          <li
            key={`${i}-${row.label}`}
            className={cn(
              "flex items-center gap-3 px-5 py-3",
              i < rows.length - 1 && "border-b border-border"
            )}
          >
            <span
              aria-hidden="true"
              className="inline-block size-1.5 shrink-0 rounded-full"
              style={{ background: toneColor(row.tone) }}
            />
            <span className="flex-1 truncate font-sans text-[13px] font-medium text-fg">
              {row.label}
            </span>
            <span
              className="shrink-0 font-mono text-[11px] tabular-nums"
              style={{ color: toneColor(row.tone) }}
            >
              {row.state}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function toneColor(tone: "success" | "warning" | "critical" | "neutral"): string {
  if (tone === "success") return "var(--color-success)";
  if (tone === "warning") return "var(--color-warning)";
  if (tone === "critical") return "var(--color-critical)";
  return "var(--color-text-tertiary)";
}

/* ============================================================
 * IAM column (der del grid 2-col)
 * ============================================================ */

function IamColumn({
  data,
  sessions
}: {
  data: DashboardData;
  sessions: DashboardData["iamSessions"];
}) {
  return (
    <div className="flex flex-col gap-4">
      <RolesCard roles={data.iamRoles} />
      <SessionsCard sessions={sessions} />
      <SecretsCard />
    </div>
  );
}

function RolesCard({ roles }: { roles: DashboardData["iamRoles"] }) {
  return (
    <Card padding="none" className="flex flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Users size={13} strokeWidth={1.75} className="text-fg-subtle" aria-hidden="true" />
        <H3>Roles IAM</H3>
        <span className="flex-1" aria-hidden="true" />
        <MonoCode className="text-[10px]">/v1/iam/roles</MonoCode>
      </header>
      {roles.length === 0 ? (
        <div className="px-4 py-4">
          <BodySm className="text-fg-subtle">
            El contrato no devolvió roles. Verificá la conexión con el gateway.
          </BodySm>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {roles.map((r, i) => {
            const label = r.displayName ?? r.name;
            return (
              <li
                key={r.id}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5",
                  i < roles.length - 1 && "border-b border-border"
                )}
                title={r.name !== label ? r.name : undefined}
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-1.5 shrink-0 rounded-full bg-border-strong"
                />
                <span className="flex-1 truncate font-sans text-[12.5px] text-fg">
                  {label}
                </span>
                <Badge>{r.userCount}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function SessionsCard({ sessions }: { sessions: DashboardData["iamSessions"] }) {
  if (sessions.length === 0) {
    return (
      <Card tone="quiet" padding="relaxed" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Eyebrow>Sesiones activas</Eyebrow>
          <MonoCode className="text-[10px]">/v1/iam/sessions</MonoCode>
        </div>
        <BodySm className="text-fg-subtle">
          Sin sesiones humanas activas en el snapshot. OpenClaw observa sin operadores conectados.
        </BodySm>
      </Card>
    );
  }
  return (
    <Card padding="none" className="flex flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Eyebrow>Sesiones activas</Eyebrow>
        <span className="flex-1" aria-hidden="true" />
        <MonoCode className="text-[10px]">/v1/iam/sessions</MonoCode>
      </header>
      <ul className="m-0 flex list-none flex-col p-0">
        {sessions.slice(0, 4).map((s, i) => (
          <li
            key={`${s.actor}-${s.startedAt}`}
            className={cn(
              "flex flex-col gap-0.5 px-4 py-2.5",
              i < Math.min(sessions.length, 4) - 1 && "border-b border-border"
            )}
          >
            <div className="flex items-center gap-2">
              <MonoData className="truncate text-[12px]">{s.actor}</MonoData>
              <span className="flex-1" aria-hidden="true" />
              <Caption className="shrink-0 font-mono text-[10px]">
                {relativeAge(s.lastSeenAt)}
              </Caption>
            </div>
            <Caption className="text-[11px]">
              {s.location} · {s.transport.toUpperCase()} · riesgo {s.risk}
            </Caption>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SecretsCard() {
  const lines: { label: string; value: string }[] = [
    { label: "Secretos en repo", value: "0" },
    { label: "Rotación SMTP", value: "cada 30 d" },
    { label: "Acceso al kill switch", value: "JIT" }
  ];
  return (
    <Card padding="relaxed" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Lock size={13} strokeWidth={1.75} className="text-fg-subtle" aria-hidden="true" />
        <H3>Secrets management</H3>
      </div>
      <BodySm>
        AWS Secrets Manager activo. Todos los SMTP cifrados en reposo. Nada en commits.
      </BodySm>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {lines.map((l) => (
          <li key={l.label} className="flex items-center justify-between gap-2">
            <Caption>{l.label}</Caption>
            <MonoData className="text-[11px]">{l.value}</MonoData>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ============================================================
 * Audit table — append-only, mono, tabular
 * ============================================================ */

interface AuditRow {
  ts: string;
  shortHash: string;
  actor: string;
  action: string;
  resource: string;
  tone: "success" | "warning" | "critical" | "info" | "neutral";
  risk: string;
}

function buildAuditRows(data: DashboardData): AuditRow[] {
  const events = filterAuditEvents(
    data.auditEvents,
    [
      "kill_switch",
      "kill-switch",
      "operating_north",
      "gate",
      "role",
      "permission",
      "approval",
      "denied"
    ],
    10
  );
  return events.map((e) => ({
    ts: formatTimeOnly(e.occurredAt),
    shortHash: shortAuditHash(e.id).replace("sha:", ""),
    actor: `${e.actorType}.${e.actorId}`.slice(0, 28),
    action: e.action,
    resource: `${e.targetType} · ${e.targetId}`,
    tone: riskTone(e.riskLevel),
    risk: e.riskLevel
  }));
}

function riskTone(risk: string): AuditRow["tone"] {
  if (risk === "critical" || risk === "blocked") return "critical";
  if (risk === "high" || risk === "warning") return "warning";
  if (risk === "info" || risk === "medium") return "info";
  if (risk === "low") return "success";
  return "neutral";
}

function AuditTable({ data }: { data: DashboardData }) {
  const rows = buildAuditRows(data);
  if (rows.length === 0) {
    return (
      <Card padding="hero" className="flex flex-col gap-2">
        <Eyebrow>Sin eventos</Eyebrow>
        <H3>El contrato no devolvió eventos para Seguridad</H3>
        <BodySm>
          El log audit-chain está vacío para los keywords de gobierno (kill switch, gates, roles).
        </BodySm>
        <MonoCode className="mt-1 text-[10px]">/v1/audit-events</MonoCode>
      </Card>
    );
  }
  return (
    <Card padding="none" className="flex flex-col overflow-hidden">
      <div className="overflow-x-auto">
        <div
          className="grid items-center gap-3 border-b border-border bg-surface-sunken px-5 py-2"
          style={{
            gridTemplateColumns: "72px 96px 152px minmax(0,1fr) 96px",
            minWidth: 680
          }}
        >
          {["Hora", "Hash", "Actor", "Acción y recurso", "Riesgo"].map((h) => (
            <Eyebrow key={h}>{h}</Eyebrow>
          ))}
        </div>
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((row, i) => (
            <li
              key={`${row.shortHash}-${i}`}
              className={cn(
                "grid items-center gap-3 px-5 py-2.5",
                i < rows.length - 1 && "border-b border-border"
              )}
              style={{
                gridTemplateColumns: "72px 96px 152px minmax(0,1fr) 96px",
                minWidth: 680
              }}
            >
              <MonoCode className="text-[11px]">{row.ts}</MonoCode>
              <MonoData className="truncate text-[11px] text-fg-muted">
                {row.shortHash}
              </MonoData>
              <MonoData className="truncate text-[11.5px]">{row.actor}</MonoData>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-sans text-[12px] font-medium text-fg">
                  {row.action}
                </span>
                <MonoCode className="truncate text-[10.5px]">{row.resource}</MonoCode>
              </div>
              <Pill tone={pillTone(row.tone)} size="sm">
                {row.risk}
              </Pill>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center justify-between border-t border-border px-5 py-3">
        <Caption>
          {rows.length} {rows.length === 1 ? "evento" : "eventos"} en ventana
        </Caption>
        <Button variant="link" size="sm">
          Ver más en /v1/admin/audit
          <ArrowRight size={11} strokeWidth={1.75} />
        </Button>
      </div>
    </Card>
  );
}

function pillTone(
  tone: AuditRow["tone"]
): "success" | "warning" | "critical" | "info" | "neutral" {
  return tone;
}

/* ============================================================
 * Compliance footer
 * ============================================================ */

function ComplianceFooter() {
  const chips: { label: string; body: string; icon: ReactNode }[] = [
    {
      label: "Privacy",
      body: "PII redactado antes de hashear. Logs sin datos personales.",
      icon: <ShieldCheck size={12} strokeWidth={1.75} />
    },
    {
      label: "Cumplimiento",
      body: "CAN-SPAM · GDPR · dirección física en cada envío.",
      icon: <ShieldCheck size={12} strokeWidth={1.75} />
    },
    {
      label: "Sin acciones reales",
      body: "Panel GET-only. Ningún POST/PUT/PATCH/DELETE en el bundle.",
      icon: <ShieldCheck size={12} strokeWidth={1.75} />
    }
  ];
  return (
    <Card tone="quiet" padding="relaxed" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <Eyebrow>Compliance</Eyebrow>
        <MonoCode className="text-[10px]">runbook · security-runbook.md</MonoCode>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {chips.map((c) => (
          <div key={c.label} className="flex items-start gap-2">
            <span className="mt-[2px] text-success" aria-hidden="true">
              {c.icon}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-sans text-[12px] font-semibold text-fg">{c.label}</span>
              <Caption>{c.body}</Caption>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ============================================================
 * util
 * ============================================================ */

function relativeAge(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  if (diff < 60_000) return "ahora";
  if (diff < 3_600_000) return `hace ${Math.round(diff / 60_000)} m`;
  if (diff < 86_400_000) return `hace ${Math.round(diff / 3_600_000)} h`;
  return `hace ${Math.round(diff / 86_400_000)} d`;
}

void Body;
