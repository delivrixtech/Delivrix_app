/**
 * Sender Pool · Bloque 10 demo viernes (2026-05-26).
 *
 * Vista del estado actual de los dominios sender en Delivrix:
 *   - Cuáles están provisionados y operativos.
 *   - En qué etapa del warmup están (día N de 30, volumen actual).
 *   - Deliverability básica (último heartbeat de seed inbox).
 *   - Botón "Onboard nuevo dominio" → dispara flow end-to-end OpenClaw.
 *
 * Datos vienen de GET /v1/sender-pool/status que Codex expone en Bloque 10.
 * Mientras el endpoint no esté live, el feature muestra empty state honesto.
 */

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Info, Loader2, Mail, Plus, SendHorizontal, Sparkles, TriangleAlert } from "lucide-react";
import { getJson } from "../../shared/api/client.ts";
import {
  FeatureHeader,
  LiveIndicator,
  SectionDivider,
  SkeletonRow,
  useOpenClawIntent,
  useToast
} from "../../shared/ui/v2/index.ts";
import { WalletWidget } from "./wallet-widget.tsx";

/* ============================================================
 * Contract types · mirror del backend (Bloque 10)
 * ============================================================ */

export type SenderDomainStatus =
  | "onboarding"
  | "warming"
  | "active"
  | "paused"
  | "burned"
  | "failed";

export interface SenderDomainSummary {
  domain: string;
  status: SenderDomainStatus;
  registrar: "route53" | "porkbun" | "ionos" | string;
  serverIp: string | null;
  warmupStartedAt: string | null;
  warmupDayN: number | null;
  warmupTargetDays: number;
  emailsSentToday: number;
  emailsSentTotal: number;
  lastSeedAt: string | null;
  blacklistsClean: boolean;
  authComplete: boolean;
}

export interface SenderPoolStatus {
  generatedAt: string;
  domains: SenderDomainSummary[];
  capacity: {
    activeDomains: number;
    totalDomains: number;
    plannedDomains: number;
  };
  source: { kind: "live" | "mock"; trusted: boolean };
}

/* ============================================================
 * Hook
 * ============================================================ */

const POLL_MS = 15_000;

function usePoolStatus() {
  return useQuery({
    queryKey: ["sender-pool", "status"],
    queryFn: () => getJson<SenderPoolStatus>("/v1/sender-pool/status" as never),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
    retry: false
  });
}

/* ============================================================
 * <SenderPoolSection> · root
 * ============================================================ */

export function SenderPoolSection() {
  const pool = usePoolStatus();
  const lastUpdate = pool.dataUpdatedAt || Date.now();
  const domains = pool.data?.domains ?? [];
  const capacity = pool.data?.capacity ?? { activeDomains: 0, totalDomains: 0, plannedDomains: 0 };

  return (
    <section className="flex flex-col" style={{ gap: 24 }}>
      <FeatureHeader
        eyebrow="Bloque 10 · Demo viernes"
        title="Sender Pool · dominios en producción."
        lead={
          <>
            Cada dominio que enviá email por Delivrix vive acá con su estado de warmup, deliverability y health.
            Onboarding nuevo dispara el flow end-to-end con OpenClaw: compra + DNS + SMTP + warmup, todo visible
            en Canvas Live.
          </>
        }
        rightSlot={<LiveIndicator pollIntervalSec={15} lastUpdateAt={lastUpdate} tone="success" />}
      />

      <CapacityRow capacity={capacity} loading={pool.isLoading} />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]" style={{ gap: 20 }}>
        <div className="flex flex-col min-w-0" style={{ gap: 20 }}>
          <DomainsTable pool={pool} />
        </div>
        <aside className="flex flex-col" style={{ gap: 16 }}>
          <WalletWidget />
          <OnboardNewDomainCard />
          <FlowExplainerCard />
        </aside>
      </div>
    </section>
  );
}

/* ============================================================
 * KPI capacity row
 * ============================================================ */

function CapacityRow({ capacity, loading }: { capacity: SenderPoolStatus["capacity"]; loading: boolean }) {
  const allZero =
    !loading &&
    capacity.activeDomains === 0 &&
    capacity.totalDomains === 0 &&
    capacity.plannedDomains === 0;

  if (allZero) {
    return (
      <div
        className="flex items-start"
        style={{
          gap: 16,
          padding: "18px 22px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 10
        }}
      >
        <span
          aria-hidden="true"
          className="grid place-items-center shrink-0"
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: "var(--color-accent-tertiary-soft, var(--color-surface-sunken))",
            color: "var(--color-accent-tertiary)"
          }}
        >
          <SendHorizontal size={18} strokeWidth={1.75} />
        </span>
        <div className="flex flex-col" style={{ gap: 4 }}>
          <span
            className="font-[family-name:var(--font-sans)] font-semibold"
            style={{ fontSize: 14, color: "var(--color-text-primary)" }}
          >
            Sender pool aún vacío
          </span>
          <p
            className="m-0 font-[family-name:var(--font-caption)]"
            style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.55 }}
          >
            Cuando OpenClaw aprovisione el primer dominio sender (compra · DNS · SMTP · warmup), aparece
            acá con su estado de capacity en vivo. Para arrancar uno, usá el botón{" "}
            <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>Onboard con OpenClaw</span>{" "}
            del panel derecho.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3" style={{ gap: 10 }}>
      <KpiCard label="Activos enviando" value={capacity.activeDomains} loading={loading} tone="success" />
      <KpiCard label="Total provisionados" value={capacity.totalDomains} loading={loading} tone="neutral" />
      <KpiCard label="Planeados próximos 7 días" value={capacity.plannedDomains} loading={loading} tone="info" />
    </div>
  );
}

function KpiCard({
  label,
  value,
  loading,
  tone
}: {
  label: string;
  value: number;
  loading: boolean;
  tone: "success" | "neutral" | "info";
}) {
  const color =
    tone === "success" ? "var(--color-success)" : tone === "info" ? "var(--color-info)" : "var(--color-text-primary)";
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 6,
        padding: "16px 18px",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 10
      }}
    >
      <span
        className="font-[family-name:var(--font-caption)] font-semibold uppercase"
        style={{ fontSize: 10, letterSpacing: "0.6px", color: "var(--color-text-tertiary)" }}
      >
        {label}
      </span>
      {loading ? (
        <SkeletonRow />
      ) : (
        <span
          className="font-[family-name:var(--font-heading)] font-semibold"
          style={{ fontSize: 30, lineHeight: 1.1, color, letterSpacing: "var(--tracking-tight)" }}
        >
          {value}
        </span>
      )}
    </div>
  );
}

/* ============================================================
 * Tabla de dominios sender
 * ============================================================ */

function DomainsTable({ pool }: { pool: ReturnType<typeof usePoolStatus> }) {
  const domains = pool.data?.domains ?? [];

  return (
    <div className="flex flex-col" style={{ gap: 10 }}>
      <SectionDivider
        title="Dominios sender pool"
        caption={
          pool.isError
            ? "Endpoint pendiente en backend (Bloque 10 en construcción)"
            : "GET /v1/sender-pool/status · poll cada 15s"
        }
        countTone={domains.length > 0 ? "success" : "neutral"}
        count={pool.data ? domains.length : undefined}
      />

      {pool.isLoading ? (
        <div className="flex flex-col" style={{ gap: 6 }}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : pool.isError ? (
        <EndpointPendingState />
      ) : domains.length === 0 ? (
        <EmptyPoolState />
      ) : (
        <div
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 10,
            overflow: "hidden"
          }}
        >
          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--color-surface-sunken)" }}>
                <Th>Dominio</Th>
                <Th>Estado</Th>
                <Th>Warmup</Th>
                <Th align="right">Hoy</Th>
                <Th align="right">Total</Th>
                <Th align="center">Health</Th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <DomainRow key={d.domain} d={d} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DomainRow({ d }: { d: SenderDomainSummary }) {
  return (
    <tr style={{ borderTop: "1px solid var(--color-border)" }}>
      <Td>
        <div className="flex flex-col" style={{ gap: 2 }}>
          <span className="font-[family-name:var(--font-mono)]" style={{ fontSize: 12, color: "var(--color-text-primary)" }}>
            {d.domain}
          </span>
          <span
            className="font-[family-name:var(--font-caption)]"
            style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
          >
            {d.registrar} · {d.serverIp ?? "sin servidor"}
          </span>
        </div>
      </Td>
      <Td>
        <StatusPill status={d.status} />
      </Td>
      <Td>
        {d.warmupDayN != null ? (
          <span
            className="font-[family-name:var(--font-mono)]"
            style={{ fontSize: 11, color: "var(--color-text-secondary)" }}
          >
            día {d.warmupDayN} / {d.warmupTargetDays}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>·</span>
        )}
      </Td>
      <Td align="right">
        <span className="font-[family-name:var(--font-mono)] font-semibold" style={{ fontSize: 12 }}>
          {d.emailsSentToday.toLocaleString("es-CO")}
        </span>
      </Td>
      <Td align="right">
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
        >
          {d.emailsSentTotal.toLocaleString("es-CO")}
        </span>
      </Td>
      <Td align="center">
        <HealthIndicators authComplete={d.authComplete} blacklistsClean={d.blacklistsClean} />
      </Td>
    </tr>
  );
}

function StatusPill({ status }: { status: SenderDomainStatus }) {
  const map: Record<SenderDomainStatus, { label: string; bg: string; fg: string }> = {
    onboarding: { label: "Onboarding", bg: "var(--color-info-soft)", fg: "var(--color-info)" },
    warming: { label: "Calentando", bg: "var(--color-warning-soft)", fg: "var(--color-warning)" },
    active: { label: "Activo", bg: "var(--color-success-soft)", fg: "var(--color-success)" },
    paused: { label: "Pausado", bg: "var(--color-surface-sunken)", fg: "var(--color-text-secondary)" },
    burned: { label: "Quemado", bg: "var(--color-critical-soft)", fg: "var(--color-critical)" },
    failed: { label: "Falló", bg: "var(--color-critical-soft)", fg: "var(--color-critical)" }
  };
  const meta = map[status];
  return (
    <span
      className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold uppercase"
      style={{
        fontSize: 10,
        padding: "2px 8px",
        borderRadius: 999,
        background: meta.bg,
        color: meta.fg,
        letterSpacing: "0.6px"
      }}
    >
      {meta.label}
    </span>
  );
}

function HealthIndicators({
  authComplete,
  blacklistsClean
}: {
  authComplete: boolean;
  blacklistsClean: boolean;
}) {
  return (
    <div className="inline-flex items-center" style={{ gap: 6 }}>
      <HealthDot ok={authComplete} label="SPF/DKIM/DMARC" />
      <HealthDot ok={blacklistsClean} label="Blacklists" />
    </div>
  );
}

function HealthDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      title={`${label}: ${ok ? "OK" : "Problema"}`}
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: ok ? "var(--color-success)" : "var(--color-critical)",
        display: "inline-block"
      }}
    />
  );
}

/* ============================================================
 * Empty states
 * ============================================================ */

function EmptyPoolState() {
  return (
    <div
      className="flex flex-col items-start"
      style={{
        gap: 6,
        padding: 20,
        background: "var(--color-surface)",
        border: "1px dashed var(--color-border)",
        borderRadius: 10
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <Mail size={16} strokeWidth={1.5} style={{ color: "var(--color-text-tertiary)" }} />
        <span
          className="font-[family-name:var(--font-sans)] font-semibold"
          style={{ fontSize: 13, color: "var(--color-text-primary)" }}
        >
          Sin dominios sender todavía
        </span>
      </div>
      <p
        className="m-0 font-[family-name:var(--font-caption)]"
        style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}
      >
        Onboardá tu primer dominio con OpenClaw desde el panel lateral. El flow end-to-end (compra → DNS → SMTP → warmup)
        toma 5-10 minutos y queda firmado en audit chain.
      </p>
    </div>
  );
}

function EndpointPendingState() {
  return (
    <div
      className="flex flex-col items-start"
      style={{
        gap: 8,
        padding: 20,
        background: "var(--color-surface)",
        border: "1px solid var(--color-info)",
        borderRadius: 10
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <Info size={16} strokeWidth={1.5} style={{ color: "var(--color-info)" }} />
        <span
          className="font-[family-name:var(--font-sans)] font-semibold"
          style={{ fontSize: 13, color: "var(--color-info)" }}
        >
          Próximo paso · `GET /v1/sender-pool/status` en backend
        </span>
      </div>
      <p
        className="m-0 font-[family-name:var(--font-caption)]"
        style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.55 }}
      >
        Codex lo expone como parte del Bloque 10. Mientras tanto, podés onboardar un dominio nuevo desde
        el panel lateral · el flow se ejecuta y aparecerá acá cuando el endpoint esté live. No afecta el
        demo.
      </p>
    </div>
  );
}

/* ============================================================
 * Onboard new domain CTA
 * ============================================================ */

function OnboardNewDomainCard() {
  const intent = useOpenClawIntent();
  const { toast } = useToast();
  const [flowState, setFlowState] = useState<"idle" | "in_progress">("idle");

  const handleOnboard = useCallback(() => {
    if (flowState === "in_progress") return;
    setFlowState("in_progress");
    const prompt = `Acción del operador: onboardar un nuevo dominio sender para Delivrix.

Por favor:
1. Propon 3 dominios disponibles relevantes para envío de email (sufijos .com o .net).
2. Para el dominio que recomiendes, prepara el flow completo:
   - Compra en Route53 (con gates de aprobación).
   - Hosted zone + records DNS básicos.
   - SPF + DKIM + DMARC (DKIM con keypair RSA 2048, DMARC en p=none para warmup).
   - Provisionar VPS Webdock profile bit (Finland).
   - Install stack SMTP (postfix + opendkim + certbot TLS).
   - Bind dominio al servidor (MX + A).
   - Iniciar warmup con 3 emails seed a las inboxes configuradas.
3. Materializa cada paso en Canvas Live como artifact aprovable.
4. NO ejecutes la compra real sin mi aprobación explícita en el artifact.`;
    intent.sendIntent(prompt, "sender-pool:onboard");
    toast.info("Enviando a OpenClaw · Onboarding nuevo dominio", {
      description: "Vas a ver el flow completo en Canvas Live. Aprobá cada paso crítico.",
      duration: 3500
    });
    setTimeout(() => setFlowState("idle"), 2000);
  }, [flowState, intent, toast]);

  return (
    <div
      className="flex flex-col"
      style={{
        gap: 12,
        padding: 18,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border-strong, var(--color-border))",
        borderRadius: 10
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <Sparkles size={14} strokeWidth={1.75} style={{ color: "var(--color-accent-tertiary)" }} />
        <span
          className="font-[family-name:var(--font-sans)] font-semibold"
          style={{ fontSize: 13, color: "var(--color-text-primary)" }}
        >
          Onboard nuevo dominio
        </span>
      </div>
      <p
        className="m-0 font-[family-name:var(--font-caption)]"
        style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.55 }}
      >
        Dispara el flow end-to-end con OpenClaw: compra · DNS · SMTP · warmup. Cada paso crítico requiere tu aprobación.
      </p>
      <button
        type="button"
        onClick={handleOnboard}
        disabled={flowState === "in_progress"}
        className="inline-flex items-center justify-center font-[family-name:var(--font-sans)] font-semibold transition-colors"
        style={{
          gap: 8,
          padding: "9px 14px",
          borderRadius: 8,
          background: "var(--color-text-primary)",
          color: "var(--color-bg)",
          border: "none",
          fontSize: 13,
          cursor: flowState === "in_progress" ? "wait" : "pointer",
          opacity: flowState === "in_progress" ? 0.7 : 1
        }}
      >
        {flowState === "in_progress" ? (
          <>
            <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
            Preparando onboarding…
          </>
        ) : (
          <>
            <Plus size={14} strokeWidth={1.75} />
            Onboard con OpenClaw
            <ArrowRight size={12} strokeWidth={1.75} />
          </>
        )}
      </button>
    </div>
  );
}

function FlowExplainerCard() {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 10,
        padding: 16,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 10
      }}
    >
      <span
        className="font-[family-name:var(--font-sans)] font-semibold"
        style={{ fontSize: 13, color: "var(--color-text-primary)" }}
      >
        El flow paso a paso
      </span>
      <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {[
          "Compra en Route53 (con gates)",
          "Hosted zone + records DNS",
          "SPF · DKIM · DMARC publicados",
          "Provisionar VPS Webdock",
          "Install postfix + opendkim + TLS",
          "Bind dominio ↔ servidor",
          "Warmup seed (3 emails)"
        ].map((step, i) => (
          <li key={i} className="flex items-start" style={{ gap: 8 }}>
            <span
              aria-hidden="true"
              className="grid place-items-center font-[family-name:var(--font-mono)] font-bold"
              style={{
                width: 18,
                height: 18,
                borderRadius: 999,
                background: "var(--color-surface-sunken)",
                color: "var(--color-text-secondary)",
                fontSize: 10,
                flexShrink: 0
              }}
            >
              {i + 1}
            </span>
            <span
              className="font-[family-name:var(--font-caption)]"
              style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.45 }}
            >
              {step}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex items-center" style={{ gap: 6, paddingTop: 8, borderTop: "1px solid var(--color-border)" }}>
        <CheckCircle2 size={11} strokeWidth={1.75} style={{ color: "var(--color-success)" }} />
        <span
          className="font-[family-name:var(--font-caption)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          Cada paso queda firmado en audit chain
        </span>
      </div>
    </div>
  );
}

/* ============================================================
 * Table primitives
 * ============================================================ */

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" | "center" }) {
  return (
    <th
      style={{
        textAlign: align,
        padding: "8px 14px",
        fontSize: 10,
        fontFamily: "var(--font-caption)",
        fontWeight: 600,
        letterSpacing: "1px",
        textTransform: "uppercase",
        color: "var(--color-text-tertiary)"
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" | "center" }) {
  return <td style={{ textAlign: align, padding: "10px 14px", verticalAlign: "middle" }}>{children}</td>;
}
