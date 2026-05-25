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

import { ChevronRight, Eye, FlaskConical, Menu, MessageSquare, Power, RefreshCw, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { loadDashboardData, type DashboardData } from "../shared/api/client.ts";
import { stateTone, type Tone } from "../shared/lib/formatters.ts";
import { cn } from "../shared/lib/cn.ts";
import {
  Button,
  NoticeBanner,
  SkeletonKpiCard,
  Tooltip,
  TooltipProvider
} from "../shared/ui/index.ts";
import {
  sectionGroupLabels,
  sectionGroupOrder,
  sections,
  sectionsById,
  type SectionId
} from "./sections.ts";

const chatOpenStorageKey = "delivrix.openclaw.chat.open";
const OverviewSection = lazy(async () => ({ default: (await import("../features/overview/index.tsx")).OverviewSection }));
const OnboardingSection = lazy(async () => ({ default: (await import("../features/onboarding/index.tsx")).OnboardingSection }));
const CanvasV4 = lazy(async () => ({ default: (await import("../features/canvas/canvas-v4.tsx")).CanvasV4 }));
const HardwareSection = lazy(async () => ({ default: (await import("../features/hardware/index.tsx")).HardwareSection }));
const CollectorSection = lazy(async () => ({ default: (await import("../features/collector/index.tsx")).CollectorSection }));
const ClustersSection = lazy(async () => ({ default: (await import("../features/clusters/index.tsx")).ClustersSection }));
const LearningSection = lazy(async () => ({ default: (await import("../features/learning/index.tsx")).LearningSection }));
const SafetySection = lazy(async () => ({ default: (await import("../features/safety/index.tsx")).SafetySection }));
const InfrastructureSection = lazy(async () => ({ default: (await import("../features/infrastructure/index.tsx")).InfrastructureSection }));
const ChatWidget = lazy(async () => ({ default: (await import("../features/chat/ChatWidget.tsx")).ChatWidget }));

export function App() {
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [chatOpen, setChatOpen] = useState(readChatOpenPreference);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const dashboard = useQuery({
    queryKey: ["admin-panel", "dashboard"],
    queryFn: loadDashboardData,
    refetchInterval: 30_000,
    staleTime: 10_000
  });

  useEffect(() => {
    localStorage.setItem(chatOpenStorageKey, chatOpen ? "1" : "0");
  }, [chatOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileNavOpen]);

  const selectSection = (section: SectionId) => {
    setActiveSection(section);
    setMobileNavOpen(false);
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text-primary)]">
        <div className="grid min-h-screen grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)]">
          {mobileNavOpen ? (
            <button
              type="button"
              aria-label="Cerrar navegación"
              className="fixed inset-0 z-30 bg-[rgba(0,0,0,0.28)] md:hidden"
              onClick={() => setMobileNavOpen(false)}
            />
          ) : null}
          <Sidebar
            activeSection={activeSection}
            onSelect={selectSection}
            mobileOpen={mobileNavOpen}
            onCloseMobile={() => setMobileNavOpen(false)}
            data={dashboard.data}
          />
          <div className="flex flex-col min-w-0">
            <Topbar
              activeSection={activeSection}
              isFetching={dashboard.isFetching}
              onRefresh={() => void dashboard.refetch()}
              mobileNavOpen={mobileNavOpen}
              onToggleMobileNav={() => setMobileNavOpen((value) => !value)}
              chatOpen={chatOpen}
              onToggleChat={() => setChatOpen((value) => !value)}
            />
            <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-6 md:px-7 lg:px-10 xl:px-14 2xl:px-16">
              <div className="mx-auto w-full" style={{ maxWidth: 1680 }}>
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
              </div>
            </main>
          </div>
        </div>
        {chatOpen ? (
          <Suspense fallback={<ChatWidgetLoadingState />}>
            <ChatWidget open={chatOpen} onClose={() => setChatOpen(false)} />
          </Suspense>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

/**
 * Topbar Pencil (frame `U7pIqs`): fill var(--color-bg), padding [16,28], gap 16,
 * border-bottom var(--color-border) 1px. Contiene breadcrumb + read-only badge + env chip
 * + user chip. El refresh queda como acción ghost para no perder utilidad GET.
 */
function Topbar({
  activeSection,
  isFetching,
  onRefresh,
  mobileNavOpen,
  onToggleMobileNav,
  chatOpen,
  onToggleChat
}: {
  activeSection: SectionId;
  isFetching: boolean;
  onRefresh: () => void;
  mobileNavOpen: boolean;
  onToggleMobileNav: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
}) {
  const section = sectionsById[activeSection];
  return (
    <header
      className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 sm:flex-nowrap sm:gap-4 sm:px-5 sm:py-4 md:px-6 lg:px-7"
    >
      <Tooltip hint={mobileNavOpen ? "Cerrar navegación" : "Abrir navegación"} side="bottom">
        <Button
          variant="ghost"
          size="icon"
          aria-label={mobileNavOpen ? "Cerrar navegación del panel" : "Abrir navegación del panel"}
          aria-expanded={mobileNavOpen}
          onClick={onToggleMobileNav}
          className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] md:hidden"
        >
          {mobileNavOpen ? (
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Menu size={16} strokeWidth={1.75} aria-hidden="true" />
          )}
        </Button>
      </Tooltip>

      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 min-w-0">
        <span className="text-[12px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
          Operar
        </span>
        <ChevronRight size={12} strokeWidth={1.75} className="text-[var(--color-text-tertiary)] shrink-0" aria-hidden="true" />
        <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)] truncate">
          {section.navLabel}
        </span>
      </nav>

      <span className="flex-1" aria-hidden="true" />

      {/* Read-only badge */}
      <span className="inline-flex items-center gap-1.5 rounded-[4px] bg-[var(--color-info-soft)] px-2.5 py-1.5">
        <Eye size={12} strokeWidth={1.75} className="text-[var(--color-info)]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[var(--color-info)]">
          Solo lectura · GET-only
        </span>
      </span>

      {/* Env chip */}
      <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5">
        <FlaskConical size={12} strokeWidth={1.75} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
        <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)]">
          mvp.local
        </span>
      </span>

      {/* User chip */}
      <span className="inline-flex items-center gap-2 rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] pl-1 pr-2.5 py-1">
        <span
          aria-hidden="true"
          className="grid h-6 w-6 place-items-center rounded-full bg-[var(--color-accent-tertiary)] text-[11px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-bg)]"
        >
          J
        </span>
        <span className="text-[12px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-primary)]">
          operador
        </span>
      </span>

      <Tooltip hint={chatOpen ? "Cerrar chat" : "Abrir chat"} side="bottom">
        <Button
          variant={chatOpen ? "default" : "ghost"}
          size="icon"
          aria-label={chatOpen ? "Cerrar chat con OpenClaw" : "Abrir chat con OpenClaw"}
          aria-pressed={chatOpen}
          onClick={onToggleChat}
          className={chatOpen ? "text-[var(--color-accent-tertiary)]" : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"}
        >
          <MessageSquare size={14} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </Tooltip>

      {/* Refresh — utilidad ghost; el panel es GET vivo aunque Pencil no lo dibuja */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Actualizar datos"
        onClick={onRefresh}
        className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
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
 * Sidebar Pencil (frame `jEU4h` / `BWD3g` reusable). 240w, fill var(--color-surface-sunken),
 * padding [20, 16], gap 24, border-right var(--color-border) 1.
 *
 * Estructura: sbBrand (mark + text) → sbNav (group labels + items) → sbKillSwitch.
 */
function Sidebar({
  activeSection,
  onSelect,
  mobileOpen,
  onCloseMobile,
  data
}: {
  activeSection: SectionId;
  onSelect: (section: SectionId) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  data: DashboardData | undefined;
}) {
  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex h-screen w-[min(82vw,300px)] max-w-[300px] flex-col gap-6 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3 py-5 shadow-[0_18px_48px_rgba(0,0,0,0.18)] transition-transform duration-200 ease-out md:sticky md:top-0 md:z-auto md:h-screen md:w-full md:max-w-none md:translate-x-0 md:self-start md:shadow-none lg:px-4",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}
    >
      {/* sbBrand */}
      <div className="flex items-center gap-2.5 pb-4 pt-1 pl-1 pr-1">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 place-items-center rounded-[8px] text-[18px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-bg)]"
          style={{
            background:
              "linear-gradient(135deg, var(--color-accent-secondary) 0%, var(--color-accent) 50%, var(--color-accent-tertiary) 100%)"
          }}
        >
          D
        </span>
        <div className="flex flex-col">
          <span className="text-[16px] font-[family-name:var(--font-heading)] font-bold leading-tight text-[var(--color-text-primary)]">
            Delivrix
          </span>
          <span
            className="text-[11px] font-[family-name:var(--font-caption)] leading-tight text-[var(--color-text-tertiary)]"
            style={{ letterSpacing: "0.4px" }}
          >
            plataforma de control
          </span>
        </div>
        <span className="flex-1 md:hidden" aria-hidden="true" />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cerrar navegación"
          onClick={onCloseMobile}
          className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] md:hidden"
        >
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>

      {/* sbNav */}
      <nav className="flex flex-col gap-5" aria-label="Secciones del panel">
        {sectionGroupOrder.map((group) => {
          const items = sections.filter((section) => section.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="flex flex-col gap-1">
              <span
                className="px-3 pt-1 text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[var(--color-text-tertiary)]"
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
                        ? "border border-[var(--color-border)] bg-[var(--color-surface)]"
                        : "hover:bg-[var(--color-surface)]/40"
                    )}
                  >
                    <Icon
                      size={16}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className={active ? "text-[var(--color-accent-tertiary)]" : "text-[var(--color-text-secondary)]"}
                    />
                    <span
                      className={cn(
                        "flex-1 text-[13px] font-[family-name:var(--font-sans)]",
                        active
                          ? "font-semibold text-[var(--color-text-primary)]"
                          : "font-medium text-[var(--color-text-secondary)]"
                      )}
                    >
                      {section.navLabel}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "block h-1.5 w-1.5 rounded-[3px]",
                        active && tone === "success" && "bg-[var(--color-success)]",
                        active && tone === "warning" && "bg-[var(--color-warning)]",
                        active && tone === "critical" && "bg-[var(--color-critical)]",
                        active && (tone === "neutral" || tone === "success" || tone === "warning" || tone === "critical")
                          ? ""
                          : "opacity-0"
                      )}
                      style={
                        active && tone === "neutral"
                          ? { background: "var(--color-accent)" }
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
 * Kill switch card Pencil (`z0dLBo`). cornerRadius 8 fill var(--color-surface) padding 14
 * gap 10 border var(--color-border) 1 shadow. Lee `data.killSwitch.enabled` y muestra el
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
      className="flex flex-col gap-2.5 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3.5"
      style={{ boxShadow: "var(--shadow-sm)" }}
    >
      <div className="flex items-center gap-2">
        <Power
          size={14}
          strokeWidth={1.75}
          className={armed ? "text-[var(--color-success)]" : "text-[var(--color-critical)]"}
          aria-hidden="true"
        />
        <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Interruptor de corte
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-[family-name:var(--font-caption)] font-semibold uppercase"
          style={{
            gap: 4,
            background: armed ? "var(--color-success-soft)" : "var(--color-critical-soft)",
            color: armed ? "var(--color-success)" : "var(--color-critical)",
            letterSpacing: "var(--tracking-wider)"
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 5,
              height: 5,
              borderRadius: 999,
              background: armed ? "var(--color-success)" : "var(--color-critical)"
            }}
          />
          {armed ? "Armado" : "Activo"}
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
          {data ? "actualizado" : "sin datos"}
        </span>
      </div>
      <p className="m-0 text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
        Prueba en modo simulado
      </p>
      <p className="m-0 text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-secondary)]">
        Requiere regla de 2 personas
      </p>
    </section>
  );
}

function SectionView({ section, data }: { section: SectionId; data: DashboardData }) {
  switch (section) {
    case "overview":
      return <Suspense fallback={<SectionLoadingState />}><OverviewSection data={data} /></Suspense>;
    case "onboarding":
      return <Suspense fallback={<SectionLoadingState />}><OnboardingSection data={data} /></Suspense>;
    case "canvas":
      return <Suspense fallback={<SectionLoadingState />}><CanvasV4 /></Suspense>;
    case "hardware":
      return <Suspense fallback={<SectionLoadingState />}><HardwareSection data={data} /></Suspense>;
    case "collector":
      return <Suspense fallback={<SectionLoadingState />}><CollectorSection data={data} /></Suspense>;
    case "clusters":
      return <Suspense fallback={<SectionLoadingState />}><ClustersSection data={data} /></Suspense>;
    case "learning":
      return <Suspense fallback={<SectionLoadingState />}><LearningSection data={data} /></Suspense>;
    case "safety":
      return <Suspense fallback={<SectionLoadingState />}><SafetySection data={data} /></Suspense>;
    case "infrastructure":
      return <Suspense fallback={<SectionLoadingState />}><InfrastructureSection /></Suspense>;
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
          <SkeletonKpiCard key={i} />
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Skeleton className="h-64 rounded-[8px]" />
        <Skeleton className="h-64 rounded-[8px]" />
      </div>
    </section>
  );
}

function SectionLoadingState() {
  return (
    <section aria-label="Cargando sección" className="flex flex-col gap-4 max-w-[1200px]">
      <Skeleton className="h-6 w-48 rounded-[6px]" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Skeleton className="h-36 rounded-[8px]" />
        <Skeleton className="h-36 rounded-[8px]" />
        <Skeleton className="h-36 rounded-[8px]" />
      </div>
      <Skeleton className="h-64 rounded-[8px]" />
    </section>
  );
}

function ChatWidgetLoadingState() {
  return (
    <aside
      aria-label="Cargando chat con OpenClaw"
      className="fixed bottom-4 right-4 z-50 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[12px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-secondary)] shadow-[0_18px_48px_rgba(0,0,0,0.18)]"
    >
      Cargando chat...
    </aside>
  );
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("bg-[var(--color-surface-sunken)] animate-pulse", className)}
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
    case "canvas":
      if (data.canvas.blockedBy.length > 0) return "critical";
      if (data.canvas.requiresHumanApproval.length > 0) return "warning";
      return "success";
    case "hardware":
      return data.telemetry.summary.stale ? "warning" : stateTone(data.telemetry.summary.status);
    case "collector":
      return stateTone(data.supervisedCollector.status);
    case "clusters":
      return stateTone(data.clusters.clusters[0]?.managementState ?? "unknown");
    case "learning": {
      const blocked = data.learningPlan.stages.some((s) => stateTone(s.status) === "critical");
      if (blocked) return "critical";
      if (data.readinessSignals.modelGovernance.canSelfPromote) return "warning";
      return "success";
    }
    case "safety":
      if (data.killSwitch.enabled) return "critical";
      if (
        data.operatingNorth.liveInfrastructureWritesEnabled ||
        data.operatingNorth.delivrixSendsRealEmail ||
        data.operatingNorth.nfcProductionWritesEnabled
      )
        return "warning";
      return "success";
    case "infrastructure":
      // Hito 5.12: el badge del sidebar se calcula desde el endpoint
      // /v1/infrastructure/inventory. Mientras Codex no lo expone, dejamos
      // neutral. Cuando esté listo, contar providers en error/paused.
      return "neutral";
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

function readChatOpenPreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(chatOpenStorageKey) === "1";
}
