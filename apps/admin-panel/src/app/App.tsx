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

import { ChevronRight, Eye, FlaskConical, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Power, RefreshCw, Search, X } from "lucide-react";
import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
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

const chatOpenStorageKey = "delivrix.openclaw.chat.open";
const sidebarCollapsedStorageKey = "delivrix.panel.sidebar.collapsed";

function readSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(sidebarCollapsedStorageKey) === "1";
}
const OverviewSection = lazy(async () => ({ default: (await import("../features/overview/index.tsx")).OverviewSection }));
const OnboardingSection = lazy(async () => ({ default: (await import("../features/onboarding/index.tsx")).OnboardingSection }));
const CanvasV4 = lazy(async () => ({ default: (await import("../features/canvas/canvas-v4.tsx")).CanvasV4 }));
const HardwareSection = lazy(async () => ({ default: (await import("../features/hardware/index.tsx")).HardwareSection }));
const CollectorSection = lazy(async () => ({ default: (await import("../features/collector/index.tsx")).CollectorSection }));
const ClustersSection = lazy(async () => ({ default: (await import("../features/clusters/index.tsx")).ClustersSection }));
const LearningSection = lazy(async () => ({ default: (await import("../features/learning/index.tsx")).LearningSection }));
const SafetySection = lazy(async () => ({ default: (await import("../features/safety/index.tsx")).SafetySection }));
const InfrastructureSection = lazy(async () => ({ default: (await import("../features/infrastructure/index.tsx")).InfrastructureSection }));
const DomainsSection = lazy(async () => ({ default: (await import("../features/domains/index.tsx")).DomainsSection }));
const SenderPoolSection = lazy(async () => ({ default: (await import("../features/sender-pool/index.tsx")).SenderPoolSection }));
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

export function App() {
  const [activeSection, setActiveSection] = useState<SectionId>(readInitialSection);
  const [chatOpen, setChatOpen] = useState(readChatOpenPreference);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(readSidebarCollapsed);

  useEffect(() => {
    localStorage.setItem(sidebarCollapsedStorageKey, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);
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
      setMobileNavOpen(false);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

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
    writeSectionToHistory(section);
    setMobileNavOpen(false);
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
      },
      {
        id: "action:sidebar-toggle",
        label: sidebarCollapsed ? "Mostrar barra lateral" : "Ocultar barra lateral",
        group: "Acciones",
        kbd: "⌘ \\",
        keywords: ["sidebar", "lateral", "navegacion", "ocultar", "colapsar"],
        action: (close) => {
          setSidebarCollapsed((v) => !v);
          close();
        }
      }
    ];
    return [...sectionCmds, ...actionCmds];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen, sidebarCollapsed]);

  // Atajo global ⌘ \ para toggle sidebar en desktop, igual que Notion/VS Code.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isMeta = event.metaKey || event.ctrlKey;
      if (isMeta && event.key === "\\") {
        event.preventDefault();
        setSidebarCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <ToastProvider>
      <OpenClawIntentProvider onNavigate={(s) => selectSection(s as SectionId)}>
      <CommandPaletteProvider commands={paletteCommands}>
      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text-primary)]">
        <div
          className={cn(
            "grid min-h-screen grid-cols-1",
            // Rebrand 2026-05-28: el sidebar nunca desaparece — colapsa a
            // 64px icon-only (Linear/Notion style). Eso lo hace profesional.
            sidebarCollapsed
              ? "md:grid-cols-[64px_minmax(0,1fr)]"
              : "md:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[256px_minmax(0,1fr)]"
          )}
        >
          {mobileNavOpen ? (
            <button
              type="button"
              aria-label="Cerrar navegación"
              className="fixed inset-0 z-30 bg-[rgba(0,0,0,0.4)] backdrop-blur-sm md:hidden"
              onClick={() => setMobileNavOpen(false)}
            />
          ) : null}
          <Sidebar
            activeSection={activeSection}
            onSelect={selectSection}
            mobileOpen={mobileNavOpen}
            onCloseMobile={() => setMobileNavOpen(false)}
            data={dashboard.data}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
          />
          <div className="flex flex-col min-w-0">
            <Topbar
              activeSection={activeSection}
              isFetching={dashboard.isFetching}
              onRefresh={async () => {
                const result = await dashboard.refetch();
                if (result.isError) {
                  throw result.error instanceof Error ? result.error : new Error("refresh failed");
                }
              }}
              mobileNavOpen={mobileNavOpen}
              onToggleMobileNav={() => setMobileNavOpen((value) => !value)}
              chatOpen={chatOpen}
              onToggleChat={() => setChatOpen((value) => !value)}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
              health={dashboard.data?.health}
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
                  <PanelErrorBoundary resetKey={activeSection} title="No pude abrir esta sección">
                    <SectionView section={activeSection} data={dashboard.data} onNavigate={selectSection} />
                  </PanelErrorBoundary>
                ) : null}
              </div>
            </main>
            <Footer health={dashboard.data?.health} operatingNorth={dashboard.data?.operatingNorth} />
          </div>
        </div>
        {chatOpen ? (
          <PanelErrorBoundary resetKey="chat" title="No pude abrir el chat">
            <Suspense fallback={<ChatWidgetLoadingState />}>
              <ChatWidget open={chatOpen} onClose={() => setChatOpen(false)} />
            </Suspense>
          </PanelErrorBoundary>
        ) : null}
      </div>
      </CommandPaletteProvider>
      </OpenClawIntentProvider>
      </ToastProvider>
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
  onToggleChat,
  sidebarCollapsed,
  onToggleSidebar,
  health
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
  health?: DashboardData["health"];
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
      className="sticky top-0 z-30 flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 sm:gap-2 sm:px-5 md:px-6 lg:px-7"
      style={{ height: "var(--topbar-height, 56px)" }}
    >
      {/* === LEFT === Toggle mobile / sidebar */}
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

      {/* Toggle sidebar movido al header del sidebar (Linear/Notion/Cursor
          style). Cuando colapsado, el sidebar mismo expone un botón para
          re-expandirse. */}

      {/* === BREADCRUMB === Group → Section, con tipografía clara */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2">
        <span className="text-[12px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-tertiary)]">
          {sectionGroupLabels[section.group]}
        </span>
        <ChevronRight size={12} strokeWidth={2} className="shrink-0 text-[var(--color-text-disabled)]" aria-hidden="true" />
        <span className="truncate text-[14px] font-[family-name:var(--font-heading)] font-semibold text-[var(--color-text-primary)]" style={{ letterSpacing: "-0.2px" }}>
          {section.navLabel}
        </span>
      </nav>

      <span className="flex-1" aria-hidden="true" />

      {/* === SEARCH === Paleta de comandos */}
      <Tooltip hint="Paleta de comandos (⌘K)" side="bottom">
        <button
          type="button"
          onClick={palette.open}
          aria-label="Abrir paleta de comandos"
          className="hidden items-center gap-2 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[var(--color-text-tertiary)] transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-secondary)] sm:inline-flex"
          style={{ cursor: "pointer" }}
        >
          <Search size={12} strokeWidth={1.75} aria-hidden="true" />
          <span className="hidden text-[12px] font-[family-name:var(--font-sans)] font-medium md:inline">
            Buscar
          </span>
          <kbd
            className="hidden font-[family-name:var(--font-mono)] md:inline"
            style={{
              padding: "1px 4px",
              fontSize: 10,
              borderRadius: 3,
              background: "var(--color-surface-sunken)",
              color: "var(--color-text-tertiary)",
              fontWeight: 500
            }}
          >
            ⌘K
          </kbd>
        </button>
      </Tooltip>

      <span className="hidden h-5 w-px bg-[var(--color-border)] sm:block" aria-hidden="true" />

      {/* === STATUS CHIPS === Read-only · pg · redis · env */}
      <Tooltip hint="Panel en modo solo lectura · todas las acciones requieren aprobación humana" side="bottom">
        <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 sm:px-2.5">
          <Eye size={11} strokeWidth={1.75} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
          <span className="hidden text-[11px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-secondary)] md:inline">
            Solo lectura
          </span>
        </span>
      </Tooltip>

      {/* Dependency chips — Codex 50876e5 (OPS OrbStack): /health reporta
          postgres + redis con SELECT 1 y PING. */}
      <DependencyChip name="pg" status={health?.postgres} check={health?.dependencies?.postgres} />
      <DependencyChip name="redis" status={health?.redis} check={health?.dependencies?.redis} />

      <Tooltip hint="Entorno mvp.local" side="bottom">
        <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 sm:px-2.5">
          <FlaskConical size={11} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
          <span className="hidden text-[11px] font-[family-name:var(--font-mono)] font-medium text-[var(--color-text-secondary)] md:inline">
            mvp.local
          </span>
        </span>
      </Tooltip>

      <span className="hidden h-5 w-px bg-[var(--color-border)] sm:block" aria-hidden="true" />

      {/* === ACTIONS === Refresh / Chat */}
      <Tooltip hint="Actualizar datos" side="bottom">
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
      </Tooltip>

      <Tooltip hint={chatOpen ? "Cerrar chat con OpenClaw" : "Abrir chat con OpenClaw"} side="bottom">
        <Button
          variant={chatOpen ? "default" : "ghost"}
          size="icon"
          aria-label={chatOpen ? "Cerrar chat con OpenClaw" : "Abrir chat con OpenClaw"}
          aria-pressed={chatOpen}
          onClick={onToggleChat}
          className={chatOpen ? "" : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"}
        >
          <MessageSquare size={14} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </Tooltip>

      {/* === USER === Avatar B/W */}
      <Tooltip hint="Operador: Juanes" side="bottom">
        <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] pl-0.5 pr-2.5 py-0.5">
          <span
            aria-hidden="true"
            className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-[family-name:var(--font-heading)] font-semibold"
            style={{
              background: "var(--color-text-primary)",
              color: "var(--color-bg)",
              letterSpacing: "0"
            }}
          >
            J
          </span>
          <span className="hidden text-[12px] font-[family-name:var(--font-sans)] font-medium text-[var(--color-text-primary)] sm:inline">
            operador
          </span>
        </span>
      </Tooltip>
    </header>
  );
}

/**
 * Sidebar — Rebrand B/W 2026-05-28.
 *
 * Profesional Linear/Notion-style:
 *   - Modo expandido (240/256px): nav completo con grupos + labels.
 *   - Modo colapsado (64px): solo iconos centrados con tooltip al hover.
 *     Brand + Kill Switch siempre visibles, colapsando solo el text.
 *   - Active state: surface-sunken background + accent ring izquierdo
 *     2px (NO un side-tab 4px que sería un anti-pattern de Impeccable).
 *   - Hover smooth con transition 120ms.
 *   - Brand mark monocromático (B/W puro), sin gradient amber.
 */
function Sidebar({
  activeSection,
  onSelect,
  mobileOpen,
  onCloseMobile,
  data,
  collapsed,
  onToggleCollapsed
}: {
  activeSection: SectionId;
  onSelect: (section: SectionId) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  data: DashboardData | undefined;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex h-screen flex-col overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] transition-[transform,width] duration-200 ease-out md:sticky md:top-0 md:z-auto md:h-screen md:translate-x-0 md:self-start md:shadow-none",
        // Mobile: ancho ~300 con slide in/out
        "w-[min(82vw,300px)] max-w-[300px] shadow-[0_18px_48px_rgba(10,10,10,0.18)]",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
        // Desktop: full width o colapsado
        collapsed ? "md:w-full md:max-w-none" : "md:w-full md:max-w-none"
      )}
    >
      {/* === BRAND === Logo B/W monocromático + toggle colapsar (desktop) */}
      <div className={cn("flex items-center border-b border-[var(--color-border)]", collapsed ? "flex-col gap-2 px-2 py-4" : "gap-2.5 px-4 py-4")}>
        <span
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-[6px] text-[14px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-bg)]"
          style={{
            background: "var(--color-text-primary)",
            letterSpacing: "-0.5px"
          }}
        >
          D
        </span>
        {!collapsed && (
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[14px] font-[family-name:var(--font-heading)] font-semibold leading-tight text-[var(--color-text-primary)]" style={{ letterSpacing: "-0.2px" }}>
              Delivrix
            </span>
            <span
              className="text-[10px] font-[family-name:var(--font-caption)] font-medium uppercase leading-tight text-[var(--color-text-tertiary)]"
              style={{ letterSpacing: "1.2px" }}
            >
              control plane
            </span>
          </div>
        )}
        {/* Cierre nav móvil — solo visible en mobile */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cerrar navegación"
          onClick={onCloseMobile}
          className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] md:hidden"
        >
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </Button>
        {/* Toggle colapsar — desktop only, esquina derecha cuando expandido,
            debajo del logo cuando colapsado. */}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Mostrar barra lateral" : "Ocultar barra lateral"}
          aria-pressed={collapsed}
          title={collapsed ? "Mostrar barra lateral · ⌘\\" : "Ocultar barra lateral · ⌘\\"}
          className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-[4px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-primary)] md:inline-flex"
        >
          {collapsed ? (
            <PanelLeftOpen size={14} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={14} strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </div>

      {/* === NAV === Grupos + items */}
      <nav
        className={cn("flex flex-col gap-4 overflow-y-auto py-4", collapsed ? "px-2" : "px-3")}
        aria-label="Secciones del panel"
      >
        {sectionGroupOrder.map((group) => {
          const items = sections.filter((section) => section.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="flex flex-col gap-0.5">
              {!collapsed && (
                <span
                  className="px-3 pb-1 pt-2 text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[var(--color-text-tertiary)]"
                  style={{ letterSpacing: "1.2px" }}
                >
                  {sectionGroupLabels[group]}
                </span>
              )}
              {collapsed && group !== sectionGroupOrder[0] && (
                <div className="my-1 h-px bg-[var(--color-border)]" aria-hidden="true" />
              )}
              {items.map((section) => {
                const Icon = section.icon;
                const active = section.id === activeSection;
                const tone = toneForSection(section.id, data);
                const toneDotBg =
                  tone === "success" ? "var(--color-success)"
                  : tone === "warning" ? "var(--color-warning)"
                  : tone === "critical" ? "var(--color-critical)"
                  : tone === "neutral" ? "var(--color-accent)"
                  : undefined;
                return (
                  <Tooltip
                    key={section.id}
                    hint={collapsed ? section.navLabel : ""}
                    side="right"
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(section.id)}
                      aria-current={active ? "page" : undefined}
                      title={collapsed ? section.navLabel : undefined}
                      className={cn(
                        "group relative flex items-center rounded-[6px] text-left transition-colors duration-[120ms]",
                        collapsed ? "h-9 w-full justify-center" : "gap-2.5 px-3 py-2",
                        active
                          ? "bg-[var(--color-surface)] text-[var(--color-text-primary)]"
                          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text-primary)]"
                      )}
                    >
                      {/* Active indicator izquierdo — 2px hairline, no side-tab */}
                      {active && !collapsed && (
                        <span
                          aria-hidden="true"
                          className="absolute left-0 top-1/2 -translate-y-1/2"
                          style={{
                            width: 2,
                            height: 16,
                            borderRadius: 1,
                            background: "var(--color-accent)"
                          }}
                        />
                      )}
                      <Icon
                        size={16}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        className={cn("shrink-0", active ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-secondary)]")}
                      />
                      {!collapsed && (
                        <>
                          <span
                            className={cn(
                              "flex-1 truncate text-[13px] font-[family-name:var(--font-sans)]",
                              active ? "font-semibold" : "font-medium"
                            )}
                          >
                            {section.navLabel}
                          </span>
                          {toneDotBg && (
                            <span
                              aria-hidden="true"
                              className="shrink-0"
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: 999,
                                background: toneDotBg
                              }}
                            />
                          )}
                        </>
                      )}
                      {collapsed && toneDotBg && (
                        <span
                          aria-hidden="true"
                          className="absolute"
                          style={{
                            top: 6,
                            right: 6,
                            width: 6,
                            height: 6,
                            borderRadius: 999,
                            background: toneDotBg,
                            border: "1.5px solid var(--color-surface-sunken)"
                          }}
                        />
                      )}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          );
        })}
      </nav>

      <span className="flex-1" aria-hidden="true" />

      {/* === KILL SWITCH === Compacto cuando colapsado */}
      <div className={cn("border-t border-[var(--color-border)]", collapsed ? "px-2 py-3" : "px-3 py-4")}>
        <KillSwitchCard data={data} onNavigate={onSelect} collapsed={collapsed} />
      </div>
    </aside>
  );
}

/**
 * Kill switch card del sidebar — read-only at-a-glance del estado global.
 *
 * Click navega a Clusters (donde vive el modal completo para activar/rearmar).
 * El click es solo navegación, NO ejecuta acción directa: la acción real
 * requiere reason + actorId + regla de 2 personas, que solo se puede capturar
 * desde el modal de Clusters.
 */
function KillSwitchCard({
  data,
  onNavigate,
  collapsed = false
}: {
  data: DashboardData | undefined;
  onNavigate?: (section: SectionId) => void;
  collapsed?: boolean;
}) {
  const enabled = data?.killSwitch.enabled ?? false;
  // Cuando enabled=true significa que el kill switch fue ACTIVADO (corte real).
  // El "ARMADO" verde de Pencil corresponde a !enabled (listo para apretar).
  const armed = !enabled;
  if (collapsed) {
    return (
      <Tooltip hint={`Kill Switch · ${armed ? "Armado" : "Activo"} · click para gestionar`} side="right">
        <button
          type="button"
          onClick={() => onNavigate?.("clusters")}
          aria-label="Interruptor de corte"
          className="grid h-9 w-full place-items-center rounded-[6px] transition-colors hover:bg-[var(--color-surface)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        >
          <span className="relative grid h-7 w-7 place-items-center">
            <Power
              size={16}
              strokeWidth={1.75}
              style={{ color: armed ? "var(--color-success)" : "var(--color-critical)" }}
              aria-hidden="true"
            />
            <span
              aria-hidden="true"
              className="absolute"
              style={{
                bottom: 0,
                right: 0,
                width: 7,
                height: 7,
                borderRadius: 999,
                background: armed ? "var(--color-success)" : "var(--color-critical)",
                border: "1.5px solid var(--color-surface-sunken)"
              }}
            />
          </span>
        </button>
      </Tooltip>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onNavigate?.("clusters")}
      aria-label="Interruptor de corte · abrir gestión en Clústeres"
      className="flex w-full flex-col gap-2.5 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3 text-left transition-colors hover:border-[var(--color-border-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
    >
      <div className="flex items-center gap-2">
        <Power
          size={14}
          strokeWidth={1.75}
          style={{ color: armed ? "var(--color-success)" : "var(--color-critical)" }}
          aria-hidden="true"
        />
        <span className="text-[12px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
          Kill Switch
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-flex items-center rounded-[4px] px-1.5 py-0.5 text-[9px] font-[family-name:var(--font-caption)] font-semibold uppercase"
          style={{
            gap: 4,
            background: armed ? "var(--color-success-soft)" : "var(--color-critical-soft)",
            color: armed ? "var(--color-success-fg)" : "var(--color-critical-fg)",
            letterSpacing: "var(--tracking-wider)",
            border: `1px solid ${armed ? "var(--color-success-border)" : "var(--color-critical-border)"}`
          }}
        >
          {armed ? "Armado" : "Activo"}
        </span>
      </div>
      <p className="m-0 text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)]">
        Click para gestionar · regla de 2 personas
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
    case "domains":
      return <Suspense fallback={<SectionLoadingState />}><DomainsSection /></Suspense>;
    case "sender-pool":
      return <Suspense fallback={<SectionLoadingState />}><SenderPoolSection /></Suspense>;
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

/**
 * Footer profesional · Rebrand B/W 2026-05-28.
 *
 * Antes no había footer. Faltante crítico que el CTO marcó. Diseño Linear /
 * Vercel style:
 *   - Sticky bottom de la columna main (después del <main>, dentro del flex
 *     vertical), border-top hairline.
 *   - Altura compacta 40px.
 *   - 3 zonas: left (brand + env + build), center (flex spacer), right
 *     (audit chain hash + operator + status global).
 *   - Tipografía: caption uppercase 10px tracking-widest + mono 10px para
 *     valores técnicos.
 *
 * Esto cierra el frame del panel: topbar arriba + sidebar a la izquierda +
 * main al centro + footer abajo.
 */
function Footer({
  health,
  operatingNorth
}: {
  health?: DashboardData["health"];
  operatingNorth?: DashboardData["operatingNorth"];
}) {
  const env = health?.phase ?? operatingNorth?.releasePhase ?? operatingNorth?.phase ?? "mvp.local";
  const buildSha = (import.meta as { env?: { VITE_BUILD_SHA?: string } }).env?.VITE_BUILD_SHA ?? "dev";
  const buildShort = buildSha.length > 7 ? buildSha.slice(0, 7) : buildSha;
  const liveWritesEnabled = operatingNorth?.liveInfrastructureWritesEnabled ?? false;
  const dependenciesOk = (health?.postgres === "ok" || health?.postgres === undefined) && (health?.redis === "ok" || health?.redis === undefined);
  return (
    <footer
      className="flex items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 sm:px-5 md:px-6 lg:px-7"
      style={{ height: 40 }}
    >
      {/* === LEFT === Brand mark + env + build */}
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid h-5 w-5 place-items-center rounded-[4px] text-[9px] font-[family-name:var(--font-heading)] font-bold text-[var(--color-bg)]"
          style={{ background: "var(--color-text-primary)", letterSpacing: "-0.3px" }}
        >
          D
        </span>
        <span className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[var(--color-text-tertiary)]" style={{ letterSpacing: "var(--tracking-widest)" }}>
          Delivrix Control Plane
        </span>
        <span aria-hidden="true" className="hidden h-3 w-px bg-[var(--color-border)] sm:block" />
        <Tooltip hint={`Build SHA · ${buildSha}`} side="top">
          <span className="hidden text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)] sm:inline">
            {buildShort}
          </span>
        </Tooltip>
      </div>

      <span className="flex-1" aria-hidden="true" />

      {/* === CENTER === Status global */}
      <div className="hidden items-center gap-3 md:flex">
        <Tooltip
          hint={liveWritesEnabled ? "Live writes habilitados · acciones pueden tocar infraestructura real" : "Modo solo lectura · ninguna acción toca infraestructura real"}
          side="top"
        >
          <span className="inline-flex items-center gap-1.5 text-[10px] font-[family-name:var(--font-caption)] font-medium text-[var(--color-text-tertiary)]" style={{ letterSpacing: "var(--tracking-wide)" }}>
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: liveWritesEnabled ? "var(--color-warning)" : "var(--color-success)"
              }}
            />
            {liveWritesEnabled ? "Live writes" : "Read-only"}
          </span>
        </Tooltip>
        <span aria-hidden="true" className="h-3 w-px bg-[var(--color-border)]" />
        <Tooltip
          hint={dependenciesOk ? "Dependencias backend respondiendo" : "Alguna dependencia caída · revisar /safety"}
          side="top"
        >
          <span className="inline-flex items-center gap-1.5 text-[10px] font-[family-name:var(--font-caption)] font-medium text-[var(--color-text-tertiary)]" style={{ letterSpacing: "var(--tracking-wide)" }}>
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: dependenciesOk ? "var(--color-success)" : "var(--color-critical)"
              }}
            />
            {dependenciesOk ? "Stack healthy" : "Stack degraded"}
          </span>
        </Tooltip>
      </div>

      <span className="flex-1 md:flex-none" aria-hidden="true" />

      {/* === RIGHT === Env + legal */}
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)]">
          {env}
        </span>
        <span aria-hidden="true" className="hidden h-3 w-px bg-[var(--color-border)] sm:block" />
        <span className="hidden text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)] sm:inline" style={{ letterSpacing: "var(--tracking-wide)" }}>
          Audit chain · append-only · regla de 2 personas
        </span>
        <span aria-hidden="true" className="hidden h-3 w-px bg-[var(--color-border)] md:block" />
        <span className="hidden text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)] md:inline" style={{ letterSpacing: "var(--tracking-wide)" }}>
          © 2026 Delivrix
        </span>
      </div>
    </footer>
  );
}

/**
 * Chip de status de dependencia (postgres / redis). Codex 50876e5 expone
 * /health con `postgres` y `redis` evaluados con SELECT 1 / PING.
 *
 * - `ok`: dot verde + label compacto.
 * - `down`: dot crítico + label, tooltip con el message del backend.
 * - `undefined`: dot neutro mientras no llega health (loading o backend
 *   antiguo). No bloquea render del topbar.
 */
function DependencyChip({
  name,
  status,
  check
}: {
  name: "pg" | "redis";
  status?: "ok" | "down";
  check?: { status: "ok" | "down"; checkedAt: string; message?: string };
}) {
  const fullName = name === "pg" ? "Postgres" : "Redis";
  const dotColor =
    status === "ok"
      ? "var(--color-success)"
      : status === "down"
      ? "var(--color-critical)"
      : "var(--color-text-tertiary)";
  const fg =
    status === "down" ? "var(--color-critical)" : "var(--color-text-secondary)";
  const hint = (() => {
    if (!status) return `${fullName} · sin datos`;
    if (status === "ok") {
      const ts = check?.checkedAt ? new Date(check.checkedAt).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "ahora";
      return `${fullName} OK · checked ${ts}`;
    }
    return `${fullName} DOWN · ${check?.message ?? "no responde"}`;
  })();
  return (
    <Tooltip hint={hint} side="bottom">
      <span
        className="inline-flex items-center gap-1.5 rounded-[4px] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-2 py-1.5 sm:px-2.5"
        aria-label={hint}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: dotColor
          }}
        />
        <span
          className="hidden text-[11px] font-[family-name:var(--font-mono)] md:inline"
          style={{ color: fg }}
        >
          {name}
        </span>
      </span>
    </Tooltip>
  );
}
