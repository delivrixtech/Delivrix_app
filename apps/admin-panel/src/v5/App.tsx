/**
 * v5 App — Cablea Shell + Vista General + lazy fallback al panel viejo
 * para las 10 vistas que aún no se reescribieron.
 *
 * Estrategia incremental segura: el shell y la sección activa son v5;
 * cuando el usuario navega a una vista no migrada, montamos el viejo
 * SectionView dentro del shell v5. Cuando aprobemos cada vista nueva,
 * el switch va sustituyendo entradas.
 */

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  Cloud,
  Database,
  GitBranch,
  Globe,
  GraduationCap,
  HardDrive,
  Inbox,
  Layers,
  LayoutGrid,
  Network,
  Power,
  Send,
  Server,
  Shield,
  ShieldCheck,
  Sparkles,
  Workflow
} from "lucide-react";
import { Toaster } from "sonner";
import { loadDashboardData } from "../shared/api/client";
import {
  CommandPaletteProvider,
  OpenClawIntentProvider,
  ToastProvider,
  useCommandPalette,
  type PaletteCommand
} from "../shared/ui/v2";
import { TooltipProvider } from "../shared/ui/tooltip";
import { Shell, type NavGroup } from "./shell/Shell";
import { OverviewV5 } from "./views/Overview";
import { CanvasLiveV5 } from "./views/CanvasLive";
import { SenderPoolV5 } from "./views/SenderPool";
import { OnboardingV5 } from "./views/Onboarding";

const HardwareV5 = lazy(async () => ({ default: (await import("./views/Hardware")).HardwareV5 }));
const CollectorV5 = lazy(async () => ({ default: (await import("./views/Collector")).CollectorV5 }));
const ClustersV5 = lazy(async () => ({ default: (await import("./views/Clusters")).ClustersV5 }));
const LearningV5 = lazy(async () => ({ default: (await import("./views/Learning")).LearningV5 }));
const SafetyV5 = lazy(async () => ({ default: (await import("./views/Safety")).SafetyV5 }));
const InfrastructureV5 = lazy(async () => ({ default: (await import("./views/Infrastructure")).InfrastructureV5 }));
const DomainsV5 = lazy(async () => ({ default: (await import("./views/Domains")).DomainsV5 }));

type SectionId =
  | "overview"
  | "onboarding"
  | "canvas"
  | "hardware"
  | "collector"
  | "clusters"
  | "learning"
  | "safety"
  | "infrastructure"
  | "domains"
  | "sender-pool";

function isSection(id: string): id is SectionId {
  return [
    "overview",
    "onboarding",
    "canvas",
    "hardware",
    "collector",
    "clusters",
    "learning",
    "safety",
    "infrastructure",
    "domains",
    "sender-pool"
  ].includes(id);
}

const navGroups: NavGroup[] = [
  {
    id: "estado",
    label: "Estado",
    items: [{ id: "overview", label: "Vista general", icon: <LayoutGrid size={14} strokeWidth={1.75} /> }]
  },
  {
    id: "operacion",
    label: "Operación",
    items: [
      { id: "onboarding", label: "Onboarding", icon: <Workflow size={14} strokeWidth={1.75} /> },
      { id: "canvas", label: "Canvas Live", icon: <Sparkles size={14} strokeWidth={1.75} /> },
      { id: "hardware", label: "Hardware", icon: <HardDrive size={14} strokeWidth={1.75} /> },
      { id: "collector", label: "Recolector", icon: <Inbox size={14} strokeWidth={1.75} /> },
      { id: "infrastructure", label: "Infraestructura", icon: <Cloud size={14} strokeWidth={1.75} /> },
      { id: "domains", label: "Dominios", icon: <Globe size={14} strokeWidth={1.75} /> },
      { id: "sender-pool", label: "Sender Pool", icon: <Send size={14} strokeWidth={1.75} /> }
    ]
  },
  {
    id: "barandillas",
    label: "Barandillas",
    items: [
      { id: "clusters", label: "Clústeres", icon: <Boxes size={14} strokeWidth={1.75} /> },
      { id: "learning", label: "Aprendizaje", icon: <GraduationCap size={14} strokeWidth={1.75} /> },
      { id: "safety", label: "Seguridad", icon: <Shield size={14} strokeWidth={1.75} /> }
    ]
  }
];

const sectionsById: Record<SectionId, { label: string; group: string }> = {
  overview: { label: "Vista general", group: "Estado" },
  onboarding: { label: "Onboarding", group: "Operación" },
  canvas: { label: "Canvas Live", group: "Operación" },
  hardware: { label: "Hardware", group: "Operación" },
  collector: { label: "Recolector", group: "Operación" },
  infrastructure: { label: "Infraestructura", group: "Operación" },
  domains: { label: "Dominios", group: "Operación" },
  "sender-pool": { label: "Sender Pool", group: "Operación" },
  clusters: { label: "Clústeres", group: "Barandillas" },
  learning: { label: "Aprendizaje", group: "Barandillas" },
  safety: { label: "Seguridad", group: "Barandillas" }
};

function readInitial(): SectionId {
  if (typeof window === "undefined") return "overview";
  const slug = window.location.pathname.split("/").filter(Boolean)[0];
  return slug && isSection(slug) ? slug : "overview";
}

export function AppV5() {
  const [activeSection, setActiveSection] = useState<SectionId>(readInitial);
  useEffect(() => {
    const onPop = () => setActiveSection(readInitial());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const selectSection = (id: string) => {
    if (!isSection(id)) return;
    setActiveSection(id);
    const nextPath = id === "overview" ? "/" : `/${id}`;
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath);
    }
  };

  const dashboard = useQuery({
    queryKey: ["admin-panel", "dashboard"],
    queryFn: loadDashboardData,
    refetchInterval: 30_000,
    staleTime: 10_000
  });

  const data = dashboard.data;
  const breadcrumb = sectionsById[activeSection];

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    return navGroups.flatMap((g) =>
      g.items.map((item) => ({
        id: `nav:${item.id}`,
        label: `Ir a ${item.label}`,
        group: g.label,
        keywords: [item.id, item.label.toLowerCase()],
        action: (close) => {
          selectSection(item.id);
          close();
        }
      }))
    );
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <ToastProvider>
        <OpenClawIntentProvider onNavigate={(s) => selectSection(s)}>
          <CommandPaletteProvider commands={paletteCommands}>
            <V5Inner
              activeSection={activeSection}
              selectSection={selectSection}
              breadcrumb={breadcrumb}
              dashboard={dashboard}
              data={data}
            />
            <Toaster
              theme="dark"
              position="bottom-right"
              richColors={false}
              closeButton
              toastOptions={{
                style: {
                  background: "var(--color-surface)",
                  color: "var(--color-text-primary)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  fontFamily: "var(--font-sans)",
                  fontSize: 13
                }
              }}
            />
          </CommandPaletteProvider>
        </OpenClawIntentProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}

function V5Inner({
  activeSection,
  selectSection,
  breadcrumb,
  dashboard,
  data
}: {
  activeSection: SectionId;
  selectSection: (id: string) => void;
  breadcrumb: { label: string; group: string };
  dashboard: ReturnType<typeof useQuery<Awaited<ReturnType<typeof loadDashboardData>>>>;
  data: Awaited<ReturnType<typeof loadDashboardData>> | undefined;
}) {
  const palette = useCommandPalette();
  const enrichedGroups: NavGroup[] = useMemo(() => {
    return navGroups.map((g) => ({
      ...g,
      items: g.items.map((item) => ({
        ...item,
        active: item.id === activeSection
      }))
    }));
  }, [activeSection]);

  const killSwitchArmed = data ? !data.killSwitch.enabled : true;
  return (
    <Shell
      groups={enrichedGroups}
      activeSection={activeSection}
      onSelect={selectSection}
      breadcrumb={{ group: breadcrumb.group, section: breadcrumb.label }}
      agentState="idle"
      killSwitchArmed={killSwitchArmed}
      killSwitchOnClick={() => selectSection("clusters")}
      envLabel={data?.health.phase ?? "mvp.local"}
      buildSha="dev"
      postgresOk={data?.health.postgres !== "down"}
      redisOk={data?.health.redis !== "down"}
      onRefresh={async () => {
        await dashboard.refetch();
      }}
      isRefreshing={dashboard.isFetching}
      onOpenCommand={() => palette.open()}
      user={{ initial: "J", label: "operador" }}
    >
      <Suspense fallback={<div className="px-2 py-4 text-fg-subtle text-[12px]">Cargando vista…</div>}>
        {dashboard.isLoading ? (
          <div className="px-2 py-4 text-fg-subtle text-[12px]">Cargando datos…</div>
        ) : !data ? (
          <div className="px-2 py-4 text-fg-subtle text-[12px]">Sin datos del backend.</div>
        ) : activeSection === "overview" ? (
          <OverviewV5 data={data} onNavigate={selectSection} />
        ) : activeSection === "canvas" ? (
          <CanvasLiveV5 />
        ) : activeSection === "sender-pool" ? (
          <SenderPoolV5 />
        ) : activeSection === "onboarding" ? (
          <OnboardingV5 data={data} />
        ) : activeSection === "hardware" ? (
          <HardwareV5 data={data} />
        ) : activeSection === "collector" ? (
          <CollectorV5 data={data} />
        ) : activeSection === "infrastructure" ? (
          <InfrastructureV5 />
        ) : activeSection === "domains" ? (
          <DomainsV5 />
        ) : activeSection === "clusters" ? (
          <ClustersV5 data={data} />
        ) : activeSection === "learning" ? (
          <LearningV5 data={data} />
        ) : (
          <SafetyV5 data={data} />
        )}
      </Suspense>
    </Shell>
  );
}
