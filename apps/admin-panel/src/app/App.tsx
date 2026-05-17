/**
 * Admin panel shell — Fase H.12 (2026-05-17, port 1:1 Pencil).
 *
 * Topbar y Sidebar derivan de `Panel Front End.pen` frame `e1ashz`. Valores
 * literales documentados en DOCUMENTACION/pencil-dumps/01_overview_spec.md.
 *
 * - Topbar: breadcrumb + Read-only badge + env chip + user chip.
 * - Sidebar: brand mark + nav + kill switch card.
 * - Branding vive en el sidebar, no en el topbar.
 */

import { ChevronRight, Eye, FlaskConical, Power, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { loadDashboardData, type DashboardData } from "../shared/api/client.ts";
import { stateTone, type Tone } from "../shared/lib/formatters.ts";
import { cn } from "../shared/lib/cn.ts";
import {
  Button,
  NoticeBanner,
  TooltipProvider
} from "../shared/ui/index.ts";
import {
  sectionGroupLabels,
  sectionGroupOrder,
  sections,
  sectionsById,
  type SectionId
} from "./sections.ts";
import { OverviewSection } from "../features/overview/index.tsx";
import { OnboardingSection } from "../features/onboarding/index.tsx";
import { HardwareSection } from "../features/hardware/index.tsx";
import { CollectorSection } from "../features/collector/index.tsx";
import { ClustersSecuritySection } from "../features/clusters-security/index.tsx";

export function App() {
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const dashboard = useQuery({
    queryKey: ["admin-panel", "dashboard"],
    queryFn: loadDashboardData,
    refetchInterval: 30_000,
    staleTime: 10_000
  });

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-[#FFFBF5] text-[#1A1410]">
        <div className="grid grid-cols-[240px_minmax(0,1fr)] min-h-screen max-md:grid-cols-1">
          <Sidebar
            activeSection={activeSection}
            onSelect={setActiveSection}
            data={dashboard.data}
          />
          <div className="flex flex-col min-w-0">
            <Topbar
              activeSection={activeSection}
              isFetching={dashboard.isFetching}
              onRefresh={() => void dashboard.refetch()}
            />
            <main className="min-w-0 flex-1 px-7 py-6 max-md:px-5">
              {dashboard.isLoading ? <LoadingState /> : null}
              {dashboard.isError ? (
                <ErrorState
                  message={errorMessage(dashboard.error)}
                  onRefresh={() => void dashboard.refetch()}
                />
              ) : null}
              {dashboard.data && !dashboard.isLoading && !dashboard.isError ? (
                <SectionView section={activeSection} data={dashboard.data} />
              ) : null}
            </main>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * Topbar Pencil (frame `U7pIqs`): fill #FFFBF5, padding [16,28], gap 16,
 * border-bottom #EAE0CE 1px. Contiene breadcrumb + read-only badge + env chip
 * + user chip. El refresh queda como acción ghost para no perder utilidad GET.
 */
function Topbar({
  activeSection,
  isFetching,
  onRefresh
}: {
  activeSection: SectionId;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const section = sectionsById[activeSection];
  return (
    <header
      className="flex items-center gap-4 border-b border-[#EAE0CE] bg-[#FFFBF5] px-7 max-md:px-5"
      style={{ paddingTop: 16, paddingBottom: 16 }}
    >
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 min-w-0">
        <span className="text-[12px] font-[family-name:var(--font-caption)] text-[#8A8073]">
          Operar
        </span>
        <ChevronRight size={12} strokeWidth={1.75} className="text-[#8A8073] shrink-0" aria-hidden="true" />
        <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410] truncate">
          {section.navLabel}
        </span>
      </nav>

      <span className="flex-1" aria-hidden="true" />

      {/* Read-only badge */}
      <span className="inline-flex items-center gap-1.5 rounded-[4px] bg-[#DBEAFE] px-2.5 py-1.5">
        <Eye size={12} strokeWidth={1.75} className="text-[#1D4ED8]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[#1D4ED8]">
          Solo lectura · GET-only
        </span>
      </span>

      {/* Env chip */}
      <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-[#EAE0CE] bg-[#F7F2EA] px-2.5 py-1.5">
        <FlaskConical size={12} strokeWidth={1.75} className="text-[#5C544A]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[#5C544A]">
          mvp.local
        </span>
      </span>

      {/* User chip */}
      <span className="inline-flex items-center gap-2 rounded-[18px] border border-[#EAE0CE] bg-[#F7F2EA] pl-1 pr-2.5 py-1">
        <span
          aria-hidden="true"
          className="grid h-6 w-6 place-items-center rounded-full bg-[#EA580C] text-[11px] font-[family-name:var(--font-heading)] font-bold text-[#FFFBF5]"
        >
          J
        </span>
        <span className="text-[12px] font-[family-name:var(--font-sans)] font-medium text-[#1A1410]">
          operador
        </span>
      </span>

      {/* Refresh — utilidad ghost; el panel es GET vivo aunque Pencil no lo dibuja */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Actualizar datos"
        onClick={onRefresh}
        className="text-[#8A8073] hover:text-[#1A1410]"
      >
        <RefreshCw
          size={14}
          strokeWidth={1.75}
          className={isFetching ? "animate-spin" : ""}
          aria-hidden="true"
        />
      </Button>
    </header>
  );
}

/**
 * Sidebar Pencil (frame `jEU4h` / `BWD3g` reusable). 240w, fill #F7F2EA,
 * padding [20, 16], gap 24, border-right #EAE0CE 1.
 *
 * Estructura: sbBrand (mark + text) → sbNav (group labels + items) → sbKillSwitch.
 */
function Sidebar({
  activeSection,
  onSelect,
  data
}: {
  activeSection: SectionId;
  onSelect: (section: SectionId) => void;
  data: DashboardData | undefined;
}) {
  return (
    <aside
      className="sticky top-0 self-start flex h-screen flex-col gap-6 overflow-y-auto border-r border-[#EAE0CE] bg-[#F7F2EA] px-4 py-5 max-md:static max-md:h-auto max-md:overflow-visible max-md:border-r-0 max-md:border-b"
      style={{ width: 240 }}
    >
      {/* sbBrand */}
      <div className="flex items-center gap-2.5 pb-4 pt-1 pl-1 pr-1">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 place-items-center rounded-[8px] text-[18px] font-[family-name:var(--font-heading)] font-bold text-[#FFFBF5]"
          style={{
            background:
              "linear-gradient(135deg, #FACC15 0%, #F59E0B 50%, #EA580C 100%)"
          }}
        >
          D
        </span>
        <div className="flex flex-col">
          <span className="text-[16px] font-[family-name:var(--font-heading)] font-bold leading-tight text-[#1A1410]">
            Delivrix
          </span>
          <span
            className="text-[11px] font-[family-name:var(--font-caption)] leading-tight text-[#8A8073]"
            style={{ letterSpacing: "0.4px" }}
          >
            plataforma de control
          </span>
        </div>
      </div>

      {/* sbNav */}
      <nav className="flex flex-col gap-5" aria-label="Secciones del panel">
        {sectionGroupOrder.map((group) => {
          const items = sections.filter((section) => section.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="flex flex-col gap-1">
              <span
                className="px-3 pt-1 text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[#8A8073]"
                style={{ letterSpacing: "1.2px" }}
              >
                {sectionGroupLabels[group]}
              </span>
              {items.map((section) => {
                const Icon = section.icon;
                const active = section.id === activeSection;
                const tone = toneForSection(section.id, data);
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => onSelect(section.id)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-[6px] px-3 py-2.5 text-left transition-colors",
                      active
                        ? "border border-[#EAE0CE] bg-[#FFFFFF]"
                        : "hover:bg-[#FFFFFF]/40"
                    )}
                  >
                    <Icon
                      size={16}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className={active ? "text-[#EA580C]" : "text-[#5C544A]"}
                    />
                    <span
                      className={cn(
                        "flex-1 text-[13px] font-[family-name:var(--font-sans)]",
                        active
                          ? "font-semibold text-[#1A1410]"
                          : "font-medium text-[#5C544A]"
                      )}
                    >
                      {section.navLabel}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "block h-1.5 w-1.5 rounded-[3px]",
                        active && tone === "success" && "bg-[#15803D]",
                        active && tone === "warning" && "bg-[#B45309]",
                        active && tone === "critical" && "bg-[#B91C1C]",
                        active && (tone === "neutral" || tone === "success" || tone === "warning" || tone === "critical")
                          ? ""
                          : "opacity-0"
                      )}
                      style={
                        active && tone === "neutral"
                          ? { background: "#F59E0B" }
                          : undefined
                      }
                    />
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      <span className="flex-1" aria-hidden="true" />

      {/* sbKillSwitch */}
      <KillSwitchCard data={data} />
    </aside>
  );
}

/**
 * Kill switch card Pencil (`z0dLBo`). cornerRadius 8 fill #FFFFFF padding 14
 * gap 10 border #EAE0CE 1 shadow. Lee `data.killSwitch.enabled` y muestra el
 * estado real ARMADO / ACTIVO.
 */
function KillSwitchCard({ data }: { data: DashboardData | undefined }) {
  const enabled = data?.killSwitch.enabled ?? false;
  // Cuando enabled=true significa que el kill switch fue ACTIVADO (corte real).
  // El "ARMADO" verde de Pencil corresponde a !enabled (listo para apretar).
  const armed = !enabled;
  return (
    <section
      aria-label="Interruptor de corte"
      className="flex flex-col gap-2.5 rounded-[8px] border border-[#EAE0CE] bg-[#FFFFFF] px-3.5 py-3.5"
      style={{ boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)" }}
    >
      <div className="flex items-center gap-2">
        <Power
          size={14}
          strokeWidth={1.75}
          className={armed ? "text-[#15803D]" : "text-[#B91C1C]"}
          aria-hidden="true"
        />
        <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[#1A1410]">
          Interruptor de corte
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="inline-block rounded-[4px] px-1.5 py-0.5 text-[9px] font-[family-name:var(--font-caption)] font-bold"
          style={{
            background: armed ? "#DCFCE7" : "#FEE2E2",
            color: armed ? "#15803D" : "#B91C1C",
            letterSpacing: "0.6px"
          }}
        >
          {armed ? "ARMADO" : "ACTIVO"}
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
          {data ? "actualizado" : "sin datos"}
        </span>
      </div>
      <p className="m-0 text-[10px] font-[family-name:var(--font-mono)] text-[#8A8073]">
        Prueba en modo simulado
      </p>
      <p className="m-0 text-[10px] font-[family-name:var(--font-caption)] text-[#5C544A]">
        Requiere regla de 2 personas
      </p>
    </section>
  );
}

function SectionView({ section, data }: { section: SectionId; data: DashboardData }) {
  switch (section) {
    case "overview":
      return <OverviewSection data={data} />;
    case "onboarding":
      return <OnboardingSection data={data} />;
    case "hardware":
      return <HardwareSection data={data} />;
    case "collector":
      return <CollectorSection data={data} />;
    case "clusters-security":
      return <ClustersSecuritySection data={data} />;
    default: {
      const _exhaustive: never = section;
      void _exhaustive;
      return null;
    }
  }
}

function LoadingState() {
  return (
    <section className="flex flex-col gap-5 max-w-[1200px]">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-[460px] max-w-full" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[86px] rounded-[8px]" />
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Skeleton className="h-64 rounded-[8px]" />
        <Skeleton className="h-64 rounded-[8px]" />
      </div>
    </section>
  );
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("bg-[#F7F2EA] animate-pulse", className)}
    />
  );
}

function ErrorState({ message, onRefresh }: { message: string; onRefresh: () => void }) {
  return (
    <section className="flex flex-col gap-5 max-w-[720px]">
      <NoticeBanner
        tone="critical"
        title="Gateway no disponible"
        description={message}
        action={
          <Button variant="default" size="sm" onClick={onRefresh}>
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
            Reintentar
          </Button>
        }
      />
    </section>
  );
}

function toneForSection(section: SectionId, data: DashboardData | undefined): Tone {
  if (!data) return "neutral";
  switch (section) {
    case "overview":
      return stateTone(data.overview.state);
    case "onboarding":
      if (data.onboardingState.blockers.length > 0) return "critical";
      if (data.onboardingState.warnings.length > 0) return "warning";
      return data.onboardingState.canGenerateTopologyPlan ? "success" : "neutral";
    case "hardware":
      return data.telemetry.summary.stale ? "warning" : stateTone(data.telemetry.summary.status);
    case "collector":
      return stateTone(data.supervisedCollector.status);
    case "clusters-security":
      if (data.operatingNorth.liveInfrastructureWritesEnabled || data.killSwitch.enabled)
        return "critical";
      return stateTone(data.clusters.clusters[0]?.managementState ?? "unknown");
    default: {
      const _exhaustive: never = section;
      void _exhaustive;
      return "neutral";
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "No se pudo cargar el panel.";
}
