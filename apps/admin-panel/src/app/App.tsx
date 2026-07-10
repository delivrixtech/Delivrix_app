/**
 * Admin panel shell — Fase H.12 (2026-05-17, port 1:1 Pencil).
 *
 * Topbar y Sidebar derivan de `Panel Front End.pen` frame `e1ashz`. Valores
 * literales documentados en DOCUMENTACION/pencil-dumps/01_overview_spec.md.
 *
 * - Topbar: breadcrumb + approval badge + live-gates chip + user chip.
 * - Sidebar: brand mark + nav + kill switch card.
 * - Branding vive en el sidebar, no en el topbar.
 */

import { ChevronRight, FlaskConical, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Power, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
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
  CommandPaletteProvider,
  OpenClawIntentProvider,
  ToastProvider,
  useCommandPalette,
  useToast,
  type PaletteCommand
} from "../shared/ui/v2/index.ts";
import {
  sectionGroupLabels,
  sectionGroupOrder,
  sections,
  sectionsById,
  type SectionId
} from "./sections.ts";
import { Shell, type NavGroup } from "../v5/shell/Shell.tsx";

const chatOpenStorageKey = "delivrix.openclaw.chat.open";
const sidebarCollapsedStorageKey = "delivrix.panel.sidebar.collapsed";

function readSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(sidebarCollapsedStorageKey) === "1";
}
const OverviewSection = lazy(async () => ({ default: (await import("../features/overview/index.tsx")).OverviewSection }));
const OnboardingSection = lazy(async () => ({ default: (await import("../features/onboarding/index.tsx")).OnboardingSection }));
const CanvasV4 = lazy(async () => ({ default: (await import("../features/canvas/canvas-v4.tsx")).CanvasV4 }));
const CanvasV5Preview = lazy(async () => ({ default: (await import("../features/canvas/CanvasV5Preview.tsx")).CanvasV5Preview }));
const HardwareSection = lazy(async () => ({ default: (await import("../features/hardware/index.tsx")).HardwareSection }));
const CollectorSection = lazy(async () => ({ default: (await import("../features/collector/index.tsx")).CollectorSection }));
const ClustersSection = lazy(async () => ({ default: (await import("../v5/views/Clusters.tsx")).ClustersV5 }));
const LearningSection = lazy(async () => ({ default: (await import("../features/learning/index.tsx")).LearningSection }));
const SafetySection = lazy(async () => ({ default: (await import("../features/safety/index.tsx")).SafetySection }));
const MxtoolboxHealthSection = lazy(async () => ({ default: (await import("../v5/views/MxtoolboxHealth.tsx")).MxtoolboxHealthV5 }));
const InfrastructureSection = lazy(async () => ({ default: (await import("../v5/views/Infrastructure.tsx")).InfrastructureV5 }));
const DomainsSection = lazy(async () => ({ default: (await import("../v5/views/Domains.tsx")).DomainsV5 }));
const SenderPoolSection = lazy(async () => ({ default: (await import("../v5/views/SenderPool.tsx")).SenderPoolV5 }));
const WarmupSection = lazy(async () => ({ default: (await import("../v5/views/Warmup.tsx")).WarmupV5 }));
const ChatWidget = lazy(async () => ({ default: (await import("../features/chat/ChatWidget.tsx")).ChatWidget }));

function readInitialSection(): SectionId {
  return readSectionFromLocation();
}

function readSectionFromLocation(): SectionId {
  if (typeof window === "undefined") return "overview";
  const slug = window.location.pathname.split("/").filter(Boolean)[0];
  if (slug && slug in sectionsById) return slug as SectionId;
  return "overview";
}

function writeSectionToHistory(section: SectionId) {
  if (typeof window === "undefined") return;
  const nextPath = section === "overview" ? "/" : `/${section}`;
  if (window.location.pathname === nextPath) return;
  window.history.pushState(null, "", nextPath);
}

const shellGroups: NavGroup[] = sectionGroupOrder.map((group) => ({
  id: group,
  label: sectionGroupLabels[group],
  items: sections
    .filter((section) => section.group === group)
    .map((section) => {
      const Icon = section.icon;
      return {
        id: section.id,
        label: section.navLabel,
        icon: <Icon size={14} strokeWidth={1.75} aria-hidden="true" />,
        status: section.id === "canvas" ? "ok" : null
      };
    })
}));

export function App() {
  const [activeSection, setActiveSection] = useState<SectionId>(readInitialSection);
  const [chatOpen, setChatOpen] = useState(readChatOpenPreference);
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
    const handlePopState = () => {
      setActiveSection(readSectionFromLocation());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const selectSection = (section: SectionId) => {
    setActiveSection(section);
    writeSectionToHistory(section);
  };

  /**
   * Comandos del palette cmd+k. Cada sección + acciones globales.
   * useMemo para no recrear el array en cada render (rompería el provider).
   */
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const sectionCmds: PaletteCommand[] = sections.map((s) => ({
      id: `nav:${s.id}`,
      label: `Ir a ${s.navLabel}`,
      group: "Navegación",
      keywords: [s.id, s.navLabel.toLowerCase()],
      action: (close) => {
        selectSection(s.id);
        close();
      }
    }));
    const actionCmds: PaletteCommand[] = [
      {
        id: "action:refresh",
        label: "Actualizar datos del panel",
        group: "Acciones",
        kbd: "r",
        keywords: ["refresh", "reload", "actualizar"],
        action: (close) => {
          void dashboard.refetch();
          close();
        }
      },
      {
        id: "action:chat-toggle",
        label: chatOpen ? "Cerrar chat con OpenClaw" : "Abrir chat con OpenClaw",
        group: "Acciones",
        keywords: ["chat", "openclaw", "mensaje"],
        action: (close) => {
          setChatOpen((v) => !v);
          close();
        }
      }
    ];
    return [...sectionCmds, ...actionCmds];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen]);

  return (
    <TooltipProvider delayDuration={200}>
      <ToastProvider>
      <OpenClawIntentProvider onNavigate={(s) => selectSection(s as SectionId)}>
      <CommandPaletteProvider commands={paletteCommands}>
        <AppShellFrame
          activeSection={activeSection}
          chatOpen={chatOpen}
          dashboard={dashboard}
          onNavigate={selectSection}
          onToggleChat={() => setChatOpen((value) => !value)}
          onCloseChat={() => setChatOpen(false)}
        />
      </CommandPaletteProvider>
      </OpenClawIntentProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}

function AppShellFrame({
  activeSection,
  chatOpen,
  dashboard,
  onNavigate,
  onToggleChat,
  onCloseChat
}: {
  activeSection: SectionId;
  chatOpen: boolean;
  dashboard: UseQueryResult<DashboardData, Error>;
  onNavigate: (section: SectionId) => void;
  onToggleChat: () => void;
  onCloseChat: () => void;
}) {
  const palette = useCommandPalette();
  const { toast } = useToast();
  const section = sectionsById[activeSection];
  const isCanvas = activeSection === "canvas";
  const killSwitchArmed = !(dashboard.data?.killSwitch.enabled ?? false);

  const handleRefresh = async () => {
    const result = await dashboard.refetch();
    if (result.isError) {
      toast.error("No pude refrescar los datos", {
        description: result.error instanceof Error ? result.error.message : "Reintenta en unos segundos."
      });
      return;
    }
    toast.success("Datos actualizados", {
      description: "Snapshot vigente del backend.",
      duration: 2500
    });
  };

  return (
    <>
      <Shell
        groups={shellGroups}
        activeSection={activeSection}
        onSelect={(id) => onNavigate(id as SectionId)}
        breadcrumb={{ group: sectionGroupLabels[section.group], section: section.navLabel }}
        agentState="idle"
        killSwitchArmed={killSwitchArmed}
        killSwitchOnClick={() => onNavigate("clusters")}
        onRefresh={handleRefresh}
        isRefreshing={dashboard.isFetching}
        onOpenCommand={palette.open}
        chatOpen={chatOpen}
        onToggleChat={onToggleChat}
        user={{ initial: "J", label: "operador" }}
        contentClassName={isCanvas ? "overflow-hidden" : undefined}
        contentInnerClassName={isCanvas ? "h-full max-w-none px-0 py-0" : undefined}
      >
        {dashboard.isLoading ? <LoadingState /> : null}
        {dashboard.isError ? (
          <ErrorState
            message={errorMessage(dashboard.error)}
            onRefresh={() => void dashboard.refetch()}
          />
        ) : null}
        {dashboard.data && !dashboard.isLoading && !dashboard.isError ? (
          <PanelErrorBoundary resetKey={activeSection} title="No pude abrir esta sección">
            <SectionView section={activeSection} data={dashboard.data} onNavigate={onNavigate} />
          </PanelErrorBoundary>
        ) : null}
      </Shell>
      {chatOpen ? (
        <PanelErrorBoundary resetKey="chat" title="No pude abrir el chat">
          <Suspense fallback={<ChatWidgetLoadingState />}>
            <ChatWidget open={chatOpen} onClose={onCloseChat} />
          </Suspense>
        </PanelErrorBoundary>
      ) : null}
    </>
  );
}

/**
 * Topbar Pencil (frame `U7pIqs`): fill var(--color-bg), padding [16,28], gap 16,
 * border-bottom var(--color-border) 1px. Contiene breadcrumb + approval badge + live gates
 * + user chip. El refresh queda como acción ghost para no perder utilidad operativa.
 */
function Topbar({
  activeSection,
  isFetching,
  onRefresh,
  mobileNavOpen,
  onToggleMobileNav,
  chatOpen,
  onToggleChat,
  sidebarCollapsed,
  onToggleSidebar
}: {
  activeSection: SectionId;
  isFetching: boolean;
  onRefresh: () => Promise<void>;
  mobileNavOpen: boolean;
  onToggleMobileNav: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  const section = sectionsById[activeSection];
  const { toast } = useToast();
  const palette = useCommandPalette();
  const handleRefresh = async () => {
    try {
      await onRefresh();
      toast.success("Datos actualizados", {
        description: "Snapshot vigente del backend.",
        duration: 2500
      });
    } catch (error) {
      toast.error("No pude refrescar los datos", {
        description: error instanceof Error ? error.message : "Reintenta en unos segundos."
      });
    }
  };
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

      <Tooltip
        hint={sidebarCollapsed ? "Mostrar barra lateral (⌘ \\)" : "Ocultar barra lateral (⌘ \\)"}
        side="bottom"
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={sidebarCollapsed ? "Mostrar barra lateral" : "Ocultar barra lateral"}
          aria-pressed={sidebarCollapsed}
          onClick={onToggleSidebar}
          className="hidden text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] md:inline-flex"
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden="true" />
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

      {/* Command palette trigger */}
      <Tooltip hint="Paleta de comandos (⌘K)" side="bottom">
        <button
          type="button"
          onClick={palette.open}
          aria-label="Abrir paleta de comandos"
          className="inline-flex items-center transition-colors hover:bg-[var(--color-surface-sunken)]"
          style={{
            gap: 8,
            padding: "5px 10px",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            background: "var(--color-surface)",
            color: "var(--color-text-tertiary)",
            cursor: "pointer"
          }}
        >
          <Search size={11} strokeWidth={2} aria-hidden="true" />
          <span className="hidden text-[11px] font-[family-name:var(--font-sans)] sm:inline">
            Buscar
          </span>
          <kbd
            className="hidden font-[family-name:var(--font-mono)] sm:inline"
            style={{
              padding: "1px 5px",
              fontSize: 10,
              border: "1px solid var(--color-border)",
              borderRadius: 3,
              background: "var(--color-surface-sunken)",
              color: "var(--color-text-tertiary)"
            }}
          >
            ⌘K
          </kbd>
        </button>
      </Tooltip>

      {/* Approval badge — texto colapsa a icono en mobile (tooltip) */}
      <Tooltip hint="ApprovalGate activo · 1 firma operador" side="bottom">
        <span className="inline-flex items-center gap-1.5 rounded-[4px] bg-[var(--color-info-soft)] px-2 py-1.5 sm:px-2.5">
          <ShieldCheck size={12} strokeWidth={1.75} className="text-[var(--color-info)]" aria-hidden="true" />
          <span className="hidden text-[11px] font-[family-name:var(--font-caption)] font-semibold text-[var(--color-info)] md:inline">
            1 firma operador
          </span>
        </span>
      </Tooltip>

      {/* Env chip — colapsa a icono en mobile/tablet (tooltip) */}
      <Tooltip hint="Gateway local con live gates y audit chain" side="bottom">
        <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-2 py-1.5 sm:px-2.5">
          <FlaskConical size={12} strokeWidth={1.75} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
          <span className="hidden text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)] md:inline">
            fase-1 · live gates
          </span>
        </span>
      </Tooltip>

      {/* User chip — texto operador colapsa a solo avatar en mobile */}
      <span className="inline-flex items-center gap-2 rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] pl-1 pr-1 py-1 sm:pr-2.5">
        <span
          aria-hidden="true"
          className="grid h-6 w-6 place-items-center rounded-full bg-[var(--color-accent)] text-[11px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-accent-fg)]"
        >
          J
        </span>
        <span className="hidden text-[12px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-primary)] sm:inline">
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
        onClick={() => void handleRefresh()}
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
          className="grid h-8 w-8 place-items-center rounded-[8px] text-[18px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-accent-fg)]"
          style={{
            background: "var(--color-accent)"
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
      <KillSwitchCard data={data} onNavigate={onSelect} />
    </aside>
  );
}

/**
 * Kill switch card del sidebar — read-only at-a-glance del estado global.
 *
 * Click navega a Clusters (donde vive el modal completo para activar/rearmar).
 * El click es solo navegación, NO ejecuta acción directa: la acción real
 * requiere reason + actorId + firma de operador, que solo se puede capturar
 * desde el modal de Clusters.
 */
function KillSwitchCard({
  data,
  onNavigate
}: {
  data: DashboardData | undefined;
  onNavigate?: (section: SectionId) => void;
}) {
  const enabled = data?.killSwitch.enabled ?? false;
  // Cuando enabled=true significa que el kill switch fue ACTIVADO (corte real).
  // El "ARMADO" verde de Pencil corresponde a !enabled (listo para apretar).
  const armed = !enabled;
  return (
    <button
      type="button"
      onClick={() => onNavigate?.("clusters")}
      aria-label="Interruptor de corte · abrir gestión en Clústeres"
      className="flex flex-col gap-2.5 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3.5 text-left transition-colors hover:bg-[var(--color-surface-sunken)] hover:border-[var(--color-border-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      style={{ boxShadow: "var(--shadow-sm)", cursor: "pointer" }}
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
        Click para gestionar · 1 firma operador
      </p>
    </button>
  );
}

function SectionView({
  section,
  data,
  onNavigate
}: {
  section: SectionId;
  data: DashboardData;
  onNavigate: (section: SectionId) => void;
}) {
  switch (section) {
    case "overview":
      return <Suspense fallback={<SectionLoadingState />}><OverviewSection data={data} onNavigate={(s) => onNavigate(s as SectionId)} /></Suspense>;
    case "onboarding":
      return <Suspense fallback={<SectionLoadingState />}><OnboardingSection data={data} /></Suspense>;
    case "canvas": {
      // v5 es el canvas por defecto. ?canvasv4 queda como escape temporal de rollback.
      let useV4 = false;
      if (typeof window !== "undefined") {
        try {
          const search = window.location.search;
          if (search.includes("canvasv5")) window.sessionStorage.removeItem("canvasv4");
          else if (search.includes("canvasv4")) window.sessionStorage.setItem("canvasv4", "1");
          useV4 = window.sessionStorage.getItem("canvasv4") === "1";
        } catch {
          useV4 = window.location.search.includes("canvasv4");
        }
      }
      return <Suspense fallback={<SectionLoadingState />}>{useV4 ? <CanvasV4 /> : <CanvasV5Preview />}</Suspense>;
    }
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
    case "mxtoolbox":
      return <Suspense fallback={<SectionLoadingState />}><MxtoolboxHealthSection /></Suspense>;
    case "infrastructure":
      return <Suspense fallback={<SectionLoadingState />}><InfrastructureSection /></Suspense>;
    case "domains":
      return <Suspense fallback={<SectionLoadingState />}><DomainsSection /></Suspense>;
    case "sender-pool":
      return <Suspense fallback={<SectionLoadingState />}><SenderPoolSection /></Suspense>;
    case "warmup":
      return <Suspense fallback={<SectionLoadingState />}><WarmupSection /></Suspense>;
    default: {
      const _exhaustive: never = section;
      void _exhaustive;
      return null;
    }
  }
}

class PanelErrorBoundary extends Component<
  { children: ReactNode; resetKey: string; title: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <section className="flex flex-col gap-5 max-w-[720px]">
        <NoticeBanner
          tone="critical"
          title={this.props.title}
          description={this.state.error.message || "Error cargando el módulo del panel."}
          action={
            <Button variant="default" size="sm" onClick={() => window.location.reload()}>
              <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
              Recargar
            </Button>
          }
        />
      </section>
    );
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
    case "mxtoolbox":
      return "neutral";
    case "infrastructure":
      // Hito 5.12: el badge del sidebar se calcula desde el endpoint
      // /v1/infrastructure/inventory. Mientras Codex no lo expone, dejamos
      // neutral. Cuando esté listo, contar providers en error/paused.
      return "neutral";
    case "domains":
      // Route53 Fase 1 live; sin propios todavía → neutral. Cuando haya
      // propios o propuestas pendientes, calcular tono desde useOwned().
      return "neutral";
    case "sender-pool":
      // Bloque 10 demo viernes — endpoint pending hasta que Codex termine.
      // Neutral mientras tanto; cuando haya datos, tono según estado warmup global.
      return "neutral";
    case "warmup":
      // Warmup engine — vista con su propia query a /v1/warmup/status. El
      // dashboard global no carga ese endpoint, así que el badge queda neutral;
      // el estado real vive dentro de la vista (engine ON/OFF, byState).
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
