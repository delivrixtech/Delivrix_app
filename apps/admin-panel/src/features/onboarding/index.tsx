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
  void data;
  return (
    <section className="flex flex-col" style={{ gap: 20, maxWidth: 1352 }}>
      <PageHeader />
      <Stepper />
      <WizardBody />
      <GatesHead />
      <GatesStrip />
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
  { kicker: "PASO 1", title: "Servidor", active: true },
  { kicker: "PASO 2", title: "IPs y dominios", active: false },
  { kicker: "PASO 3", title: "DNS", active: false },
  { kicker: "PASO 4", title: "Límites", active: false },
  { kicker: "PASO 5", title: "Cumplimiento", active: false },
  { kicker: "PASO 6", title: "Revisión", active: false }
] as const;

function Stepper() {
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
      {STEPS.map((step, i) => (
        <li key={step.kicker} className="flex items-center min-w-0" style={{ gap: 10 }}>
          <div className="flex items-center" style={{ gap: 10 }}>
            <span
              aria-hidden="true"
              className="grid place-items-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                background: step.active ? "#F59E0B" : "#FFFBF5",
                color: step.active ? "#FFFBF5" : "#8A8073",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                fontWeight: step.active ? 700 : 600,
                boxShadow: !step.active ? "inset 0 0 0 1px #EAE0CE" : undefined
              }}
            >
              {i + 1}
            </span>
            <div className="flex flex-col" style={{ gap: 2 }}>
              <span
                className="text-[9px] font-[family-name:var(--font-caption)] font-bold uppercase"
                style={{
                  color: step.active ? "#EA580C" : "#8A8073",
                  letterSpacing: "1px"
                }}
              >
                {step.kicker}
              </span>
              <span
                className="text-[13px] font-[family-name:var(--font-sans)]"
                style={{
                  color: step.active ? "#1A1410" : "#5C544A",
                  fontWeight: step.active ? 600 : 500
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
      ))}
    </ol>
  );
}

/* ============================================================
 * WizardBody (uqjXO) — Form (3 cards) + OpenClawColumn (360w)
 * ============================================================ */
function WizardBody() {
  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
      <Form />
      <OpenClawColumn />
    </div>
  );
}

function Form() {
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {/* Sección 1 — Identidad */}
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
        <FieldRow label="HOSTNAME" value="vps-edge-01.delivrix.io" />
        <FieldRow label="DATACENTER" value="mad-2 · Madrid Norte" />
        <FieldRow label="ROL" value="sender-edge · zona caliente" />
        <FieldRow label="ENTORNO" value="mvp.local · staging" />
      </SectionCard>

      {/* Sección 2 — Inventario de cómputo */}
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
        <FieldRow label="CPU" value="AMD EPYC 7763 · 2×64 núcleos" badge="DETECTADO" />
        <FieldRow label="MEMORIA RAM" value="512 GB · DDR4 ECC" badge="DETECTADO" />
        <FieldRow label="ALMACENAMIENTO" value="4 × 3.84 TB NVMe RAID-10" badge="DETECTADO" />
        <FieldRow label="ENLACE PRIMARIO" value="25 GbE · LACP bond0" badge="DETECTADO" />
      </SectionCard>

      {/* Sección 3 — Interfaces de red */}
      <SectionCard
        iconBg="#DCFCE7"
        iconColor="#15803D"
        icon={<Network size={16} strokeWidth={1.75} aria-hidden="true" />}
        kicker="SECCIÓN 3"
        title="Interfaces de red"
        pillBg="#DCFCE7"
        pillFg="#15803D"
        pillDot="#15803D"
        pillText="3 interfaces declaradas"
      >
        <FieldRow label="BOND0 · ENVÍO" value="10.42.7.21/24 · vlan 102" />
        <FieldRow label="ETH2 · GESTIÓN" value="10.99.0.21/24 · vlan 901" />
        <FieldRow label="IPMI · FUERA DE BANDA" value="172.20.4.21 · ACL restringida" badge="DETECTADO" />
        <FieldRow label="DOMINIO PÚBLICO" value="send.delivrix.io · A + PTR" />
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
function OpenClawColumn() {
  return (
    <aside className="flex flex-col" style={{ gap: 16 }}>
      <OpenClawCard />
      <OpenClawMeta />
    </aside>
  );
}

function OpenClawCard() {
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
            Detecté 4 campos sin completar en tu inventario. ¿Quieres que resuma lo que falta
            antes de avanzar al gate de cumplimiento?
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

function GatesStrip() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 14 }}>
      <GateCard
        iconBg="#FEF3C7"
        iconColor="#B45309"
        icon={<ShieldAlert size={18} strokeWidth={1.75} aria-hidden="true" />}
        title="Cumplimiento pendiente"
        pillBg="#FEF3C7"
        pillFg="#B45309"
        pillText="revisión humana"
        desc="A la espera de que un revisor humano firme el cumplimiento de políticas y registre la evidencia."
      />
      <GateCard
        iconBg="#FEE2E2"
        iconColor="#B91C1C"
        icon={<ShieldX size={18} strokeWidth={1.75} aria-hidden="true" />}
        title="DNS no validado"
        pillBg="#FEE2E2"
        pillFg="#B91C1C"
        pillText="crítico"
        desc="Las zonas y registros aún no se verifican contra los resolvers internos del clúster de envío."
      />
      <GateCard
        iconBg="#EDE9FE"
        iconColor="#7C3AED"
        icon={<KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />}
        title="SSH no autorizado"
        pillBg="#EDE9FE"
        pillFg="#7C3AED"
        pillText="autorizar manualmente"
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
