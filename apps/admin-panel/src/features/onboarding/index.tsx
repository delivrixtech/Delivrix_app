/**
 * Onboarding Wizard — port LITERAL desde Pencil frame `T9osf` / `GygQG`.
 *
 * Cada texto, color, padding e icono viene del .pen. Los campos del formulario
 * muestran los placeholders literales (hostname `vps-edge-01.delivrix.io`,
 * datacenter `mad-2 · Madrid Norte`, etc.) tal como Pencil los dibuja.
 */

import {
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  Cpu,
  Eye,
  FileSearch,
  Info,
  KeyRound,
  Link as LinkIcon,
  Lock,
  MessageSquare,
  Network,
  Save,
  Send,
  ShieldAlert,
  ShieldX,
  Sparkles,
  WandSparkles
} from "lucide-react";
import type { DashboardData } from "../../shared/api/client.ts";

export function OnboardingSection({ data }: { data: DashboardData }) {
  return (
    <section className="flex flex-col" style={{ gap: 20 }}>
      <PageHeader />
      <Stepper data={data} />
      <WizardBody data={data} />
      <GatesHead />
      <GatesStrip data={data} />
      <ActionBar />
    </section>
  );
}

/* ============================================================
 * PageHeader (M5gN0)
 * ============================================================ */
function PageHeader() {
  return (
    <header className="flex flex-col" style={{ gap: 10 }}>
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#EA580C]"
        style={{ letterSpacing: "1.2px" }}
      >
        PASO 1 DE 6 · INVENTARIO FÍSICO
      </span>
      <h1
        className="m-0 text-[32px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[#1A1410]"
      >
        Onboarding del servidor de envío
      </h1>
      <p className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#5C544A]">
        El asistente captura y valida el servidor físico, sus IPs, dominios, DNS, límites y
        permisos antes de pedir el visto bueno humano. OpenClaw observa la evidencia y
        recomienda, pero nunca ejecuta cambios por su cuenta.
      </p>
    </header>
  );
}

/* ============================================================
 * Stepper (cL78x) — 6 pasos con conectores horizontales
 * ============================================================ */
const STEPS = [
  { kicker: "PASO 1", title: "Servidor", category: "server" },
  { kicker: "PASO 2", title: "IPs y dominios", category: "network" },
  { kicker: "PASO 3", title: "DNS", category: "dns" },
  { kicker: "PASO 4", title: "Límites", category: "limits" },
  { kicker: "PASO 5", title: "Cumplimiento", category: "compliance" },
  { kicker: "PASO 6", title: "Revisión", category: "review" }
] as const;

/**
 * Deriva el paso activo desde `onboardingState.readinessByCategory` + blockers.
 * Primer paso con readiness <1 o con blocker = activo.
 */
function activeStepIndex(data: DashboardData): number {
  const r = data.onboardingState.readinessByCategory ?? {};
  const b = data.onboardingState.blockers ?? [];
  for (let i = 0; i < STEPS.length; i++) {
    const cat = STEPS[i].category.toLowerCase();
    const score = Object.entries(r).find(([k]) => k.toLowerCase().includes(cat))?.[1];
    const blocked = b.some((x) => x.toLowerCase().includes(cat));
    if (blocked || score === undefined || score < 1) return i;
  }
  return 0;
}

function Stepper({ data }: { data: DashboardData }) {
  const activeIdx = activeStepIndex(data);
  return (
    <ol
      className="m-0 p-0 list-none flex items-center bg-[#FFFFFF]"
      style={{
        gap: 14,
        padding: "16px 20px",
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      {STEPS.map((step, i) => {
        const active = i === activeIdx;
        return (
        <li key={step.kicker} className="flex items-center min-w-0" style={{ gap: 10 }}>
          <div className="flex items-center" style={{ gap: 10 }}>
            <span
              aria-hidden="true"
              className="grid place-items-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                background: active ? "#F59E0B" : "#FFFBF5",
                color: active ? "#FFFBF5" : "#8A8073",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                fontWeight: active ? 700 : 600,
                boxShadow: !active ? "inset 0 0 0 1px #EAE0CE" : undefined
              }}
            >
              {i + 1}
            </span>
            <div className="flex flex-col" style={{ gap: 2 }}>
              <span
                className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                style={{
                  color: active ? "#EA580C" : "#8A8073",
                  letterSpacing: "1px"
                }}
              >
                {step.kicker}
              </span>
              <span
                className="text-[13px] font-[family-name:var(--font-sans)]"
                style={{
                  color: active ? "#1A1410" : "#5C544A",
                  fontWeight: active ? 600 : 500
                }}
              >
                {step.title}
              </span>
            </div>
          </div>
          {i < STEPS.length - 1 ? (
            <span
              aria-hidden="true"
              className="block"
              style={{ height: 1, flex: 1, minWidth: 16, background: "#EAE0CE" }}
            />
          ) : null}
        </li>
        );
      })}
    </ol>
  );
}

/* ============================================================
 * WizardBody (uqjXO) — Form (3 cards) + OpenClawColumn (360w)
 * ============================================================ */
function WizardBody({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
      <Form data={data} />
      <OpenClawColumn data={data} />
    </div>
  );
}

function Form({ data }: { data: DashboardData }) {
  const ph = data.physicalHost;
  const cap = ph.capacity;
  const on = data.operatingNorth;
  const known = data.onboardingState.knownInputs as Record<string, unknown>;
  const knownStr = (k: string, fb: string): string => {
    const v = known[k];
    return v !== undefined && v !== null && v !== "" ? String(v) : fb;
  };

  // Helpers para mostrar capacidad real desde el contrato o '—' si null.
  const cpuLine = cap.cpuCores
    ? `${cap.cpuCores} cores${cap.cpuThreads ? ` · ${cap.cpuThreads} threads` : ""}`
    : "—";
  const ramLine = cap.memoryGb ? `${cap.memoryGb} GB` : "—";
  const storageLine = cap.storageUsableGb ? `${cap.storageUsableGb} GB usables` : "—";
  const linkLine = cap.networkInterfaces ? `${cap.networkInterfaces} interfaces` : "—";

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {/* Sección 1 — Identidad (datos reales de physicalHost.identity + operatingNorth) */}
      <SectionCard
        iconBg="#FEF3C7"
        iconColor="#B45309"
        icon={<ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 1"
        title="Identidad del servidor"
        pillBg="#FEF3C7"
        pillFg="#B45309"
        pillDot="#B45309"
        pillText="campos requeridos"
      >
        <FieldRow label="HOSTNAME" value={ph.identity.label || knownStr("hostname", "—")} />
        <FieldRow label="DATACENTER" value={ph.identity.location || knownStr("datacenter", "—")} />
        <FieldRow label="ROL" value={on.delivrixRole || knownStr("role", "—")} />
        <FieldRow label="ENTORNO" value={data.health.phase || knownStr("environment", "—")} />
      </SectionCard>

      {/* Sección 2 — Inventario de cómputo (capacidad real desde el contrato) */}
      <SectionCard
        iconBg="#DBEAFE"
        iconColor="#1D4ED8"
        icon={<Cpu size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 2"
        title="Inventario de cómputo"
        pillBg="#DBEAFE"
        pillFg="#1D4ED8"
        pillDot="#1D4ED8"
        pillText="detectado por el recolector"
      >
        <FieldRow label="CPU" value={cpuLine} badge={cap.cpuCores ? "DETECTADO" : undefined} />
        <FieldRow label="MEMORIA RAM" value={ramLine} badge={cap.memoryGb ? "DETECTADO" : undefined} />
        <FieldRow label="ALMACENAMIENTO" value={storageLine} badge={cap.storageUsableGb ? "DETECTADO" : undefined} />
        <FieldRow label="ENLACE PRIMARIO" value={linkLine} badge={cap.networkInterfaces ? "DETECTADO" : undefined} />
      </SectionCard>

      {/* Sección 3 — Interfaces de red (knownInputs cuando exista; placeholder cuando falte) */}
      <SectionCard
        iconBg="#DCFCE7"
        iconColor="#15803D"
        icon={<Network size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 3"
        title="Interfaces de red"
        pillBg="#DCFCE7"
        pillFg="#15803D"
        pillDot="#15803D"
        pillText={`${cap.networkInterfaces ?? 0} interfaces declaradas`}
      >
        <FieldRow label="BOND0 · ENVÍO" value={knownStr("interface_primary", "—")} />
        <FieldRow label="ETH2 · GESTIÓN" value={knownStr("interface_management", "—")} />
        <FieldRow
          label="IPMI · FUERA DE BANDA"
          value={knownStr("interface_ipmi", "—")}
          badge={known["interface_ipmi"] ? "DETECTADO" : undefined}
        />
        <FieldRow
          label="DOMINIO PÚBLICO"
          value={knownStr("public_domain", cap.ipPoolSize ? `${cap.ipPoolSize} IPs · pool` : "—")}
        />
      </SectionCard>
    </div>
  );
}

function SectionCard({
  iconBg,
  iconColor,
  icon,
  kicker,
  title,
  pillBg,
  pillFg,
  pillDot,
  pillText,
  children
}: {
  iconBg: string;
  iconColor: string;
  icon: React.ReactNode;
  kicker: string;
  title: string;
  pillBg: string;
  pillFg: string;
  pillDot: string;
  pillText: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="flex flex-col bg-[#FFFFFF]"
      style={{
        gap: 18,
        padding: 20,
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)"
      }}
    >
      {/* SecHead */}
      <header className="flex items-center justify-between" style={{ gap: 10 }}>
        <div className="flex items-center" style={{ gap: 10 }}>
          <span
            aria-hidden="true"
            className="grid place-items-center"
            style={{ width: 32, height: 32, borderRadius: 6, background: iconBg, color: iconColor }}
          >
            {icon}
          </span>
          <div className="flex flex-col" style={{ gap: 2 }}>
            <span
              className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
              style={{ letterSpacing: "1.2px" }}
            >
              {kicker}
            </span>
            <h3 className="m-0 text-[16px] font-[family-name:var(--font-heading)] font-semibold text-[#1A1410]">
              {title}
            </h3>
          </div>
        </div>
        <span
          className="inline-flex items-center text-[11px] font-[family-name:var(--font-caption)] font-semibold"
          style={{
            gap: 6,
            padding: "4px 10px",
            borderRadius: 4,
            background: pillBg,
            color: pillFg,
            letterSpacing: "0.4px"
          }}
        >
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: pillDot }} />
          {pillText}
        </span>
      </header>

      {/* Field rows in 2 columns */}
      <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 16 }}>
        {children}
      </div>
    </section>
  );
}

function FieldRow({ label, value, badge }: { label: string; value: string; badge?: string }) {
  return (
    <div className="flex flex-col" style={{ gap: 6 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
          style={{ letterSpacing: "0.4px" }}
        >
          {label}
        </span>
        {badge ? (
          <span
            className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
            style={{
              padding: "1px 6px",
              borderRadius: 4,
              background: "#DCFCE7",
              color: "#15803D",
              letterSpacing: "0.4px"
            }}
          >
            {badge}
          </span>
        ) : null}
      </div>
      <div
        className="bg-[#FFFFFF]"
        style={{
          padding: "12px 10px",
          borderRadius: 6,
          border: "1px solid #EAE0CE"
        }}
      >
        <span className="text-[13px] font-[family-name:var(--font-mono)] text-[#1A1410]">{value}</span>
      </div>
    </div>
  );
}

/* ============================================================
 * OpenClawColumn (vBXlY, 360w)
 * ============================================================ */
function OpenClawColumn({ data }: { data: DashboardData }) {
  const unknownsCount =
    (data.physicalHost.quality.unknownFields?.length ?? 0) +
    (data.telemetry.quality.unknownFields?.length ?? 0);
  const blockers = data.onboardingState.blockers?.length ?? 0;
  return (
    <aside className="flex flex-col" style={{ gap: 16 }}>
      <OpenClawCard unknownsCount={unknownsCount} blockers={blockers} />
      <OpenClawMeta />
    </aside>
  );
}

function OpenClawCard({ unknownsCount, blockers }: { unknownsCount: number; blockers: number }) {
  return (
    <div
      style={{
        borderRadius: 12,
        padding: 2,
        background: "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)",
        boxShadow: "0 8px 24px rgba(26, 20, 16, 0.13)"
      }}
    >
      <div className="flex flex-col bg-[#FFFBF5]" style={{ borderRadius: 10, padding: 20, gap: 16 }}>
        {/* ocHead */}
        <header className="flex items-center" style={{ gap: 10 }}>
          <span
            aria-hidden="true"
            className="grid place-items-center"
            style={{
              width: 32,
              height: 32,
              borderRadius: 999,
              background: "linear-gradient(135deg, #FACC15 0%, #EA580C 100%)",
              color: "#FFFBF5"
            }}
          >
            <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="flex flex-col flex-1 min-w-0" style={{ gap: 2 }}>
            <span className="text-[14px] font-[family-name:var(--font-heading)] font-semibold text-[#1A1410]">
              OpenClaw
            </span>
            <span className="text-[11px] font-[family-name:var(--font-caption)] text-[#8A8073]">
              supervisado · solo lectura
            </span>
          </div>
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
            GET
          </span>
        </header>

        {/* ocMsgWrap */}
        <div
          className="flex flex-col"
          style={{
            gap: 8,
            padding: 14,
            borderRadius: 8,
            background: "#F7F2EA",
            border: "1px solid #EAE0CE"
          }}
        >
          <span
            className="text-[10px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#EA580C]"
            style={{ letterSpacing: "1px" }}
          >
            Sugerencia
          </span>
          <p className="m-0 text-[13px] font-[family-name:var(--font-sans)] leading-[1.5] text-[#1A1410]">
            {blockers > 0
              ? `Tengo ${blockers} bloqueo${blockers === 1 ? "" : "s"} pendiente${blockers === 1 ? "" : "s"} en el onboarding. ¿Quieres que resuma el más crítico antes del gate?`
              : unknownsCount > 0
                ? `Detecté ${unknownsCount} campo${unknownsCount === 1 ? "" : "s"} sin completar en tu inventario. ¿Quieres que resuma lo que falta antes de avanzar al gate de cumplimiento?`
                : "Inventario completo. Puedo proponer el plan de topología cuando lo autorices."}
          </p>
        </div>

        {/* ocInput */}
        <div
          aria-hidden="true"
          className="flex items-center bg-[#FFFBF5]"
          style={{
            gap: 8,
            padding: 12,
            borderRadius: 6,
            border: "1px solid #EAE0CE"
          }}
        >
          <MessageSquare size={14} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
          <span className="flex-1 text-[11px] font-[family-name:var(--font-sans)] text-[#8A8073] truncate">
            Pregunta a OpenClaw sobre evidencia, gates o recomendaciones…
          </span>
          <ArrowUp size={14} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
        </div>

        {/* ocActions */}
        <div className="flex flex-col" style={{ gap: 8 }}>
          <button
            type="button"
            className="inline-flex items-center justify-center text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#FFFBF5]"
            style={{ gap: 6, padding: "10px 12px", borderRadius: 6, background: "#1A1410" }}
          >
            <WandSparkles size={14} strokeWidth={1.75} aria-hidden="true" />
            Revisar recomendación
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]"
            style={{
              gap: 6,
              padding: "10px 12px",
              borderRadius: 6,
              background: "#FFFBF5",
              border: "1px solid #EAE0CE"
            }}
          >
            <FileSearch size={14} strokeWidth={1.75} aria-hidden="true" />
            Ver evidencia
          </button>
        </div>

        {/* ocFoot */}
        <div className="flex items-center" style={{ gap: 6, padding: "0 4px" }}>
          <LinkIcon size={11} strokeWidth={1.75} className="text-[#8A8073]" aria-hidden="true" />
          <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
            /v1/openclaw/recommendations
          </span>
        </div>
      </div>
    </div>
  );
}

function OpenClawMeta() {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 8,
        padding: 14,
        borderRadius: 8,
        background: "#F7F2EA",
        border: "1px solid #EAE0CE"
      }}
    >
      <header className="flex items-center" style={{ gap: 8 }}>
        <Info size={13} strokeWidth={1.75} className="text-[#5C544A]" aria-hidden="true" />
        <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
          Por qué OpenClaw observa aquí
        </span>
      </header>
      <p className="m-0 text-[11px] font-[family-name:var(--font-caption)] leading-[1.45] text-[#5C544A]">
        El onboarding requiere validación humana en cada gate. OpenClaw correlaciona la evidencia
        capturada y propone próximos pasos, pero no escribe en producción.
      </p>
    </div>
  );
}

/* ============================================================
 * GatesHead + GatesStrip
 * ============================================================ */
function GatesHead() {
  return (
    <header className="flex flex-col" style={{ gap: 6 }}>
      <span
        className="text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[#8A8073]"
        style={{ letterSpacing: "1.2px" }}
      >
        VALIDACIONES Y GATES
      </span>
      <h2 className="m-0 text-[13px] font-[family-name:var(--font-sans)] text-[#5C544A]">
        Pendientes humanas antes de habilitar el servidor para envío
      </h2>
    </header>
  );
}

function GatesStrip({ data }: { data: DashboardData }) {
  const blockers = data.onboardingState.blockers ?? [];
  const blockersCount = blockers.length;
  const dnsBlocker = blockers.some((b) => b.toLowerCase().includes("dns"));
  const sshBlocker = blockers.some((b) => b.toLowerCase().includes("ssh"));
  return (
    <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 14 }}>
      <GateCard
        iconBg="#FEF3C7"
        iconColor="#B45309"
        icon={<ShieldAlert size={18} strokeWidth={1.75} aria-hidden="true" />}
        title="Cumplimiento pendiente"
        pillBg="#FEF3C7"
        pillFg="#B45309"
        pillText={blockersCount > 0 ? `${blockersCount} bloqueos` : "revisión humana"}
        desc="A la espera de que un revisor humano firme el cumplimiento de políticas y registre la evidencia."
      />
      <GateCard
        iconBg={dnsBlocker ? "#FEE2E2" : "#FEF3C7"}
        iconColor={dnsBlocker ? "#B91C1C" : "#B45309"}
        icon={<ShieldX size={18} strokeWidth={1.75} aria-hidden="true" />}
        title="DNS no validado"
        pillBg={dnsBlocker ? "#FEE2E2" : "#FEF3C7"}
        pillFg={dnsBlocker ? "#B91C1C" : "#B45309"}
        pillText={dnsBlocker ? "crítico" : "pendiente"}
        desc="Las zonas y registros aún no se verifican contra los resolvers internos del clúster de envío."
      />
      <GateCard
        iconBg="#EDE9FE"
        iconColor="#7C3AED"
        icon={<KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />}
        title="SSH no autorizado"
        pillBg="#EDE9FE"
        pillFg="#7C3AED"
        pillText={sshBlocker ? "ssh bloqueado" : "autorizar manualmente"}
        desc="OpenClaw no tiene credenciales para acceder por SSH. Necesita autorización manual del operador con rol elevado."
      />
    </div>
  );
}

function GateCard({
  iconBg,
  iconColor,
  icon,
  title,
  pillBg,
  pillFg,
  pillText,
  desc
}: {
  iconBg: string;
  iconColor: string;
  icon: React.ReactNode;
  title: string;
  pillBg: string;
  pillFg: string;
  pillText: string;
  desc: string;
}) {
  return (
    <article
      className="flex bg-[#FFFFFF]"
      style={{ gap: 14, padding: 16, borderRadius: 6, border: "1px solid #EAE0CE" }}
    >
      <span
        aria-hidden="true"
        className="grid place-items-center shrink-0"
        style={{ width: 36, height: 36, borderRadius: 4, background: iconBg, color: iconColor }}
      >
        {icon}
      </span>
      <div className="flex flex-col min-w-0 flex-1" style={{ gap: 4 }}>
        <header className="flex items-center" style={{ gap: 8 }}>
          <h3 className="m-0 text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
            {title}
          </h3>
          <span className="flex-1" aria-hidden="true" />
          <span
            className="inline-block text-[9px] font-[family-name:var(--font-caption)] font-semibold"
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              background: pillBg,
              color: pillFg,
              letterSpacing: "0.4px"
            }}
          >
            {pillText}
          </span>
        </header>
        <p className="m-0 text-[12px] font-[family-name:var(--font-caption)] leading-[1.45] text-[#5C544A]">
          {desc}
        </p>
      </div>
    </article>
  );
}

/* ============================================================
 * ActionBar
 * ============================================================ */
function ActionBar() {
  return (
    <section
      className="flex items-center bg-[#FFFFFF]"
      style={{
        padding: "14px 18px",
        borderRadius: 8,
        border: "1px solid #EAE0CE",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)",
        justifyContent: "space-between"
      }}
    >
      <button
        type="button"
        className="inline-flex items-center text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#5C544A]"
        style={{ gap: 8, padding: "10px 12px", borderRadius: 6, background: "transparent" }}
      >
        <Save size={14} strokeWidth={1.75} aria-hidden="true" />
        Guardar borrador
      </button>

      <div className="flex items-center" style={{ gap: 14 }}>
        <span
          className="inline-flex items-center text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#B45309]"
          style={{
            gap: 6,
            padding: "8px 12px",
            borderRadius: 6,
            background: "#FEF3C7",
            border: "1px solid #B45309"
          }}
        >
          <Lock size={12} strokeWidth={1.75} aria-hidden="true" />
          Requiere validación humana del gate de cumplimiento
        </span>
        <button
          type="button"
          className="inline-flex items-center text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]"
          style={{
            gap: 8,
            padding: "10px 16px",
            borderRadius: 6,
            background: "#FFFBF5",
            border: "1px solid #EAE0CE"
          }}
        >
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
          Volver
        </button>
        <button
          type="button"
          disabled
          className="inline-flex items-center text-[13px] font-[family-name:var(--font-sans)] font-bold text-[#8A8073] disabled:cursor-default"
          style={{
            gap: 8,
            padding: "10px 18px",
            borderRadius: 6,
            background: "#F5F5F4",
            border: "1px solid #EAE0CE",
            opacity: 0.55
          }}
        >
          <Send size={14} strokeWidth={1.75} aria-hidden="true" />
          Enviar para aprobación
        </button>
      </div>
    </section>
  );
}

void CheckCircle2;
