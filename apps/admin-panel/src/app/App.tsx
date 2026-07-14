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

import { RefreshCw } from "lucide-react";
import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { loadDashboardData, type DashboardData } from "../shared/api/client.ts";
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
  envioTabs,
  gobiernoTabs,
  groupTabs,
  infraestructuraTabs,
  isGroupSection,
  navGroupLabelFor,
  navGroups,
  navSections,
  navSectionsById,
  resolveTarget,
  type NavSectionId
} from "./sections.ts";
import { Shell, type NavGroup } from "../v5/shell/Shell.tsx";

const chatOpenStorageKey = "delivrix.openclaw.chat.open";

const OverviewSection = lazy(async () => ({ default: (await import("../features/overview/index.tsx")).OverviewSection }));
const CanvasV4 = lazy(async () => ({ default: (await import("../features/canvas/canvas-v4.tsx")).CanvasV4 }));
const CanvasV5Preview = lazy(async () => ({ default: (await import("../features/canvas/CanvasV5Preview.tsx")).CanvasV5Preview }));
const EnvioView = lazy(async () => ({ default: (await import("../v5/views/EnvioView.tsx")).EnvioView }));
const InfraestructuraView = lazy(async () => ({ default: (await import("../v5/views/InfraestructuraView.tsx")).InfraestructuraView }));
const GobiernoView = lazy(async () => ({ default: (await import("../v5/views/GobiernoView.tsx")).GobiernoView }));
const ChatWidget = lazy(async () => ({ default: (await import("../features/chat/ChatWidget.tsx")).ChatWidget }));

interface RouteState {
  section: NavSectionId;
  tab: string | null;
}

function readInitialRoute(): RouteState {
  return readRouteFromLocation();
}

function readRouteFromLocation(): RouteState {
  if (typeof window === "undefined") return { section: "overview", tab: null };
  const slug = window.location.pathname.split("/").filter(Boolean)[0] ?? "overview";
  const resolved = resolveTarget(slug);
  // Un slug que YA es una sección-contenedora puede traer la pestaña por ?tab=.
  if (slug in navSectionsById && isGroupSection(resolved.section)) {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    const validTab = tabParam
      ? groupTabs[resolved.section].some((t) => t.id === tabParam)
      : false;
    return { section: resolved.section, tab: validTab ? tabParam : null };
  }
  return resolved;
}

function writeRouteToHistory({ section, tab }: RouteState) {
  if (typeof window === "undefined") return;
  const base = section === "overview" ? "/" : `/${section}`;
  const nextPath = tab && isGroupSection(section) ? `${base}?tab=${tab}` : base;
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === nextPath) return;
  window.history.pushState(null, "", nextPath);
}

const shellGroups: NavGroup[] = navGroups.map((group) => ({
  id: group.id,
  label: group.label,
  items: group.items.map((id) => {
    const section = navSectionsById[id];
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
  const [route, setRoute] = useState<RouteState>(readInitialRoute);
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
      setRoute(readRouteFromLocation());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  /**
   * Navega a cualquier target (id de nav, id viejo de sección, intent de
   * OpenClaw). Resuelve a sección-contenedora + pestaña y sincroniza la URL.
   */
  const navigateTo = (target: string) => {
    const next = resolveTarget(target);
    setRoute(next);
    writeRouteToHistory(next);
  };

  /** Cambio de pestaña dentro de una sección-contenedora (mantiene la sección). */
  const selectTab = (section: NavSectionId, tab: string) => {
    const next: RouteState = { section, tab };
    setRoute(next);
    writeRouteToHistory(next);
  };

  /**
   * Comandos del palette cmd+k. Los 5 navs + cada pestaña histórica alcanzable
   * (para que "Ir a Warmup" siga funcionando tras la reorg) + acciones globales.
   * useMemo para no recrear el array en cada render (rompería el provider).
   */
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const navCmds: PaletteCommand[] = navSections.map((s) => ({
      id: `nav:${s.id}`,
      label: `Ir a ${s.navLabel}`,
      group: "Navegación",
      keywords: [s.id, s.navLabel.toLowerCase()],
      action: (close) => {
        navigateTo(s.id);
        close();
      }
    }));
    const tabCmds: PaletteCommand[] = [
      ...envioTabs.map((t) => ({ tab: t, parent: "Envío" as const })),
      ...infraestructuraTabs.map((t) => ({ tab: t, parent: "Infraestructura" as const })),
      ...gobiernoTabs.map((t) => ({ tab: t, parent: "Gobierno" as const }))
    ].map(({ tab, parent }) => ({
      id: `tab:${tab.id}`,
      label: `Ir a ${tab.label}`,
      group: "Navegación",
      keywords: [tab.id, tab.label.toLowerCase(), parent.toLowerCase()],
      action: (close) => {
        navigateTo(tab.id);
        close();
      }
    }));
    const sectionCmds: PaletteCommand[] = [...navCmds, ...tabCmds];
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
      <OpenClawIntentProvider onNavigate={(s) => navigateTo(s)}>
      <CommandPaletteProvider commands={paletteCommands}>
        <AppShellFrame
          route={route}
          chatOpen={chatOpen}
          dashboard={dashboard}
          onNavigate={navigateTo}
          onSelectTab={selectTab}
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
  route,
  chatOpen,
  dashboard,
  onNavigate,
  onSelectTab,
  onToggleChat,
  onCloseChat
}: {
  route: RouteState;
  chatOpen: boolean;
  dashboard: UseQueryResult<DashboardData, Error>;
  onNavigate: (target: string) => void;
  onSelectTab: (section: NavSectionId, tab: string) => void;
  onToggleChat: () => void;
  onCloseChat: () => void;
}) {
  const palette = useCommandPalette();
  const { toast } = useToast();
  const activeSection = route.section;
  const section = navSectionsById[activeSection];
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
        onSelect={(id) => onNavigate(id)}
        breadcrumb={{ group: navGroupLabelFor(activeSection), section: section.navLabel }}
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
            <SectionView
              route={route}
              data={dashboard.data}
              onNavigate={onNavigate}
              onSelectTab={onSelectTab}
            />
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

function SectionView({
  route,
  data,
  onNavigate,
  onSelectTab
}: {
  route: RouteState;
  data: DashboardData;
  onNavigate: (target: string) => void;
  onSelectTab: (section: NavSectionId, tab: string) => void;
}) {
  const { section, tab } = route;
  switch (section) {
    case "overview":
      return (
        <Suspense fallback={<SectionLoadingState />}>
          <OverviewSection data={data} onNavigate={(s) => onNavigate(s)} />
        </Suspense>
      );
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
    case "envio":
      return (
        <Suspense fallback={<SectionLoadingState />}>
          <EnvioView data={data} activeTab={tab} onSelectTab={(t) => onSelectTab("envio", t)} />
        </Suspense>
      );
    case "infraestructura":
      return (
        <Suspense fallback={<SectionLoadingState />}>
          <InfraestructuraView data={data} activeTab={tab} onSelectTab={(t) => onSelectTab("infraestructura", t)} />
        </Suspense>
      );
    case "gobierno":
      return (
        <Suspense fallback={<SectionLoadingState />}>
          <GobiernoView data={data} activeTab={tab} onSelectTab={(t) => onSelectTab("gobierno", t)} />
        </Suspense>
      );
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


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "No se pudo cargar el panel.";
}

function readChatOpenPreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(chatOpenStorageKey) === "1";
}
