/**
 * v5 Onboarding — wizard de captura del servidor de envío.
 */
import { motion } from "framer-motion";
import { ArrowRight, Check, FileText, KeyRound, Network, ShieldAlert, ShieldX, Send } from "lucide-react";
import type { DashboardData } from "../../shared/api/client";
import { staggerContainer, staggerItem } from "../lib/motion";
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
  SectionHead
} from "../components/primitives";
import { PageHead } from "./_PageHead";

const STEPS = [
  { id: "server", label: "Servidor", hint: "Hostname · datacenter · rol" },
  { id: "ips", label: "IPs y dominios", hint: "Pool · PTR · verificación" },
  { id: "dns", label: "DNS", hint: "Proveedor · NS records" },
  { id: "limits", label: "Límites", hint: "Volumen · warmup · throughput" },
  { id: "compliance", label: "Cumplimiento", hint: "Dirección física · opt-out" },
  { id: "review", label: "Revisión", hint: "Firma + audit" }
];

export function OnboardingV5({ data }: { data: DashboardData }) {
  const sections = data.onboardingState.sections ?? [];
  const blockers = data.onboardingState.blockers ?? [];
  const ph = data.physicalHost;
  const cap = ph.capacity;
  const env = data.onboardingState.environment ?? "mvp.local";
  const pendingFields = data.onboardingState.pendingQuestions?.length ?? 0;
  const currentStep = 0; // por ahora, hero del paso 1

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <PageHead
          eyebrow={`Paso ${currentStep + 1} de ${STEPS.length} · Inventario físico`}
          title="Onboarding del servidor de envío"
          body="El asistente captura y valida el servidor físico, sus IPs, dominios, DNS, límites y permisos antes de pedir el visto bueno humano. OpenClaw observa la evidencia y recomienda, pero nunca ejecuta cambios por su cuenta."
        />
      </motion.div>

      <motion.div variants={staggerItem}>
        <Stepper steps={STEPS} current={currentStep} sections={sections} />
      </motion.div>

      <motion.div variants={staggerItem} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          {/* Sección 1 — Identidad */}
          <SectionCard
            n="01"
            kind="warning"
            title="Identidad del servidor"
            badge="Campos requeridos"
            icon={<ShieldAlert size={14} strokeWidth={1.75} />}
          >
            <Field label="Hostname" value={ph.identity.label || "Sin dato"} />
            <Field label="Datacenter" value={ph.identity.location || "Sin dato"} />
            <Field label="Rol" value={data.operatingNorth.delivrixRole || "Sin dato"} />
            <Field label="Entorno" value={env} mono />
          </SectionCard>

          {/* Sección 2 — Inventario */}
          <SectionCard
            n="02"
            kind="info"
            title="Inventario de cómputo"
            badge={cap.cpuCores ? "Detectado" : "Pendiente"}
            icon={<FileText size={14} strokeWidth={1.75} />}
          >
            <Field label="CPU" value={cap.cpuCores ? `${cap.cpuCores} cores${cap.cpuThreads ? ` · ${cap.cpuThreads} threads` : ""}` : "Sin dato"} />
            <Field label="Memoria RAM" value={cap.memoryGb ? `${cap.memoryGb} GB` : "Sin dato"} />
            <Field label="Almacenamiento" value={cap.storageUsableGb ? `${cap.storageUsableGb} GB usables` : "Sin dato"} />
            <Field label="Interfaces" value={cap.networkInterfaces ? `${cap.networkInterfaces} interfaces` : "0 interfaces"} />
          </SectionCard>

          {/* Sección 3 — Interfaces */}
          <SectionCard
            n="03"
            kind={cap.networkInterfaces ? "info" : "warning"}
            title="Interfaces de red"
            badge={cap.networkInterfaces ? `${cap.networkInterfaces} declaradas` : "0 · pendiente"}
            icon={<Network size={14} strokeWidth={1.75} />}
          >
            <Field label="Bond0 · envío" value="—" />
            <Field label="ETH2 · gestión" value="—" />
            <Field label="IPMI · fuera de banda" value="—" />
            <Field label="Dominio público" value="—" />
          </SectionCard>

          {/* Validaciones y gates */}
          <SectionHead eyebrow="Pendiente humano" title="Validaciones y gates" caption="Antes de habilitar el servidor para envío" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <GateCard icon={<ShieldAlert size={14} />} title="Cumplimiento pendiente" body="A la espera de un revisor humano que firme el cumplimiento." pill={blockers.length > 0 ? `${blockers.length} pendientes` : "humano"} tone="warning" />
            <GateCard icon={<ShieldX size={14} />} title="DNS no validado" body="Las zonas y registros aún no se verifican contra resolvers internos." pill="crítico" tone="critical" />
            <GateCard icon={<KeyRound size={14} />} title="SSH no autorizado" body="OpenClaw no tiene credenciales SSH. Necesita autorización manual." pill="autorizar" tone="warning" />
          </div>

          <div className="flex items-center justify-between border-t border-border pt-4">
            <Caption>{blockers.length} bloqueos · {pendingFields} campos sin completar</Caption>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm">
                <Send size={11} strokeWidth={1.75} />
                Exportar snapshot
              </Button>
              <Button variant="secondary" size="sm">
                Refrescar estado
              </Button>
              <Button variant="primary" size="sm" disabled={blockers.length > 0}>
                Solicitar evaluación a OpenClaw
                <ArrowRight size={11} strokeWidth={1.75} />
              </Button>
            </div>
          </div>
        </div>

        {/* Side: OpenClaw + meta */}
        <div className="flex flex-col gap-4">
          <Card padding="hero" className="flex flex-col gap-3">
            <Eyebrow>OpenClaw recomienda</Eyebrow>
            <H3>{blockers.length > 0 ? `${blockers.length} ítems pendientes en onboarding` : "Inventario completo"}</H3>
            <HumanNote className="max-w-[280px]">
              {blockers.length > 0
                ? "¿Quieres que te resuma los críticos antes del gate?"
                : "Puedo proponer el plan de topología cuando lo autorices."}
            </HumanNote>
            <div className="flex flex-col gap-1.5">
              <Button variant="primary" size="sm">
                Revisar recomendación
                <ArrowRight size={11} strokeWidth={1.75} />
              </Button>
              <Button variant="ghost" size="sm">
                Ver evidencia
              </Button>
            </div>
          </Card>
          <Card tone="quiet" padding="relaxed" className="flex flex-col gap-2">
            <Eyebrow>Por qué OpenClaw observa aquí</Eyebrow>
            <BodySm>
              El onboarding requiere validación humana en cada gate. OpenClaw correlaciona la evidencia capturada y propone próximos pasos, pero no escribe en producción.
            </BodySm>
          </Card>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ----- Stepper ----- */

function Stepper({
  steps,
  current,
  sections
}: {
  steps: { id: string; label: string; hint: string }[];
  current: number;
  sections: { id: string; detectedFieldCount: number; totalFieldCount: number }[];
}) {
  const sectionsById = new Map(sections.map((s) => [s.id, s]));
  return (
    <Card padding="relaxed" className="flex items-center gap-2 overflow-x-auto">
      {steps.map((step, i) => {
        const sec = sectionsById.get(step.id);
        const done = sec ? sec.detectedFieldCount === sec.totalFieldCount && sec.totalFieldCount > 0 : i < current;
        const active = i === current;
        return (
          <div key={step.id} className="flex flex-1 min-w-[140px] items-center gap-2">
            <span
              className="grid size-6 shrink-0 place-items-center rounded-full font-mono text-[10px] font-semibold tabular-nums"
              style={{
                background: done
                  ? "var(--color-success)"
                  : active
                  ? "var(--color-fg)"
                  : "var(--color-surface-sunken)",
                color: done || active ? "var(--color-bg)" : "var(--color-fg-subtle)",
                border: done || active ? "0" : "1px solid var(--color-border)"
              }}
            >
              {done ? <Check size={12} strokeWidth={2.5} /> : i + 1}
            </span>
            <div className="flex min-w-0 flex-col leading-none">
              <Eyebrow className="text-[9px]">{`paso ${i + 1}`}</Eyebrow>
              <span className={`mt-1 truncate font-sans text-[12.5px] font-semibold ${active ? "text-fg" : done ? "text-fg-muted" : "text-fg-subtle"}`}>
                {step.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span aria-hidden="true" className="mx-1 h-px flex-1 bg-border" />
            )}
          </div>
        );
      })}
    </Card>
  );
}

/* ----- SectionCard ----- */

function SectionCard({
  n,
  kind,
  title,
  badge,
  icon,
  children
}: {
  n: string;
  kind: "warning" | "info" | "success" | "critical";
  title: string;
  badge: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const tone = kind === "warning" ? "warning" : kind === "info" ? "info" : kind === "success" ? "success" : "critical";
  return (
    <Card padding="relaxed" className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          className="grid size-7 place-items-center rounded-md"
          style={{
            background:
              tone === "warning"
                ? "var(--color-warning-soft)"
                : tone === "info"
                ? "var(--color-info-soft)"
                : tone === "success"
                ? "var(--color-success-soft)"
                : "var(--color-critical-soft)",
            color:
              tone === "warning"
                ? "var(--color-warning)"
                : tone === "info"
                ? "var(--color-info)"
                : tone === "success"
                ? "var(--color-success)"
                : "var(--color-critical)"
          }}
        >
          {icon}
        </span>
        <div className="flex flex-col">
          <Eyebrow>{`Sección ${n}`}</Eyebrow>
          <H3>{title}</H3>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <Pill tone={tone as never} size="sm">
          {badge}
        </Pill>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>
    </Card>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded border border-border bg-surface px-3 py-2">
      <Eyebrow className="text-[9.5px]">{label}</Eyebrow>
      {mono ? <MonoData className="text-[12.5px]">{value}</MonoData> : <span className="font-sans text-[13px] font-medium text-fg">{value}</span>}
    </div>
  );
}

function GateCard({
  icon,
  title,
  body,
  pill,
  tone
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  pill: string;
  tone: "warning" | "critical" | "success";
}) {
  return (
    <Card padding="relaxed" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          className="grid size-6 place-items-center rounded text-fg-subtle"
          style={{
            background:
              tone === "critical"
                ? "var(--color-critical-soft)"
                : tone === "warning"
                ? "var(--color-warning-soft)"
                : "var(--color-success-soft)",
            color:
              tone === "critical"
                ? "var(--color-critical)"
                : tone === "warning"
                ? "var(--color-warning)"
                : "var(--color-success)"
          }}
        >
          {icon}
        </span>
        <Eyebrow>{title}</Eyebrow>
        <span className="flex-1" aria-hidden="true" />
        <Pill tone={tone as never} size="sm">
          {pill}
        </Pill>
      </div>
      <BodySm>{body}</BodySm>
    </Card>
  );
}
