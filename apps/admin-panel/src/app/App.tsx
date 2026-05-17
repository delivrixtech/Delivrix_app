/**
 * Admin panel shell — Fase H (2026-05-17, rebrand Pencil + 5 secciones).
 *
 * Cada SectionView vive en su feature folder (src/features/<name>/index.tsx).
 * Este archivo se mantiene chico: shell + router + loading/error.
 */

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { loadDashboardData, type DashboardData } from "../shared/api/client.ts";
import { stateTone, type Tone } from "../shared/lib/formatters.ts";
import { cn } from "../shared/lib/cn.ts";
import {
  Badge as UiBadge,
  BrandBlock,
  Button,
  Card,
  CardContent,
  Eyebrow,
  FreshnessTag,
  ModeBadge,
  NoticeBanner,
  Separator,
  ThemeToggle,
  Tooltip,
  TooltipProvider
} from "../shared/ui/index.ts";
import {
  sectionGroupLabels,
  sectionGroupOrder,
  sections,
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
      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text-primary)]">
        <Topbar
          data={dashboard.data}
          isFetching={dashboard.isFetching}
          lastFetchedAt={dashboard.dataUpdatedAt || null}
          onRefresh={() => void dashboard.refetch()}
        />
        <div className="grid grid-cols-[240px_minmax(0,1fr)] min-h-[calc(100vh-57px)] max-md:grid-cols-1">
          <Sidebar activeSection={activeSection} onSelect={setActiveSection} data={dashboard.data} />
          <main className="min-w-0 px-6 py-6 md:px-8 md:py-8">
            {dashboard.isLoading ? <LoadingState /> : null}
            {dashboard.isError ? (
              <ErrorState message={errorMessage(dashboard.error)} onRefresh={() => void dashboard.refetch()} />
            ) : null}
            {dashboard.data && !dashboard.isLoading && !dashboard.isError ? (
              <SectionView section={activeSection} data={dashboard.data} />
            ) : null}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Topbar({
  data,
  isFetching,
  lastFetchedAt,
  onRefresh
}: {
  data: DashboardData | undefined;
  isFetching: boolean;
  lastFetchedAt: number | null;
  onRefresh: () => void;
}) {
  const operatingNorth = data?.operatingNorth;

  return (
    <header className="sticky top-0 z-40 flex items-center justify-between gap-6 px-6 md:px-8 h-14 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <BrandBlock />
      <div className="flex items-center gap-3">
        {operatingNorth ? (
          <ModeBadge
            liveInfrastructureWritesEnabled={operatingNorth.liveInfrastructureWritesEnabled}
            delivrixSendsRealEmail={operatingNorth.delivrixSendsRealEmail}
            nfcProductionWritesEnabled={operatingNorth.nfcProductionWritesEnabled}
          />
        ) : (
          <UiBadge tone="neutral">Mode loading</UiBadge>
        )}
        <FreshnessTag lastFetchedAt={lastFetchedAt} isFetching={isFetching} />
        <Tooltip hint="Actualizar datos">
          <Button variant="ghost" size="icon" aria-label="Actualizar datos" onClick={onRefresh}>
            <RefreshCw size={15} strokeWidth={1.75} className={isFetching ? "animate-spin" : ""} aria-hidden="true" />
          </Button>
        </Tooltip>
        <ThemeToggle />
      </div>
    </header>
  );
}

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
    <aside className="sticky top-14 self-start h-[calc(100vh-3.5rem)] overflow-y-auto flex flex-col justify-between gap-6 p-4 border-r border-[var(--color-border)] bg-[var(--color-surface)] max-md:static max-md:h-auto max-md:overflow-visible max-md:border-r-0 max-md:border-b">
      <nav className="flex flex-col gap-5" aria-label="Secciones del panel">
        {sectionGroupOrder.map((group) => {
          const items = sections.filter((section) => section.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="flex flex-col gap-1.5">
              <Eyebrow className="px-2">{sectionGroupLabels[group]}</Eyebrow>
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
                      "flex items-center justify-between gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-[13px] transition-colors",
                      active
                        ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] font-medium"
                        : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                      {section.navLabel}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "block h-1.5 w-1.5 rounded-full",
                        tone === "success" && "bg-[var(--color-success)]",
                        tone === "warning" && "bg-[var(--color-warning)]",
                        tone === "critical" && "bg-[var(--color-critical)]",
                        tone === "neutral" && "bg-[var(--color-text-tertiary)]"
                      )}
                    />
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>
      <div className="flex flex-col gap-2 px-2">
        <Separator />
        <UiBadge tone="outline" className="self-start">Read-only</UiBadge>
        <p className="m-0 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">
          Delivrix LLC · Desarrollado por JECT
        </p>
      </div>
    </aside>
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
          <Skeleton key={i} className="h-[86px] rounded-[var(--radius-md)]" />
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Skeleton className="h-64 rounded-[var(--radius-lg)]" />
        <Skeleton className="h-64 rounded-[var(--radius-lg)]" />
      </div>
    </section>
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
      <Card>
        <CardContent className="px-5 py-4">
          <p className="m-0 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
            El admin panel sirve solo lecturas desde el control plane. Si el gateway esta
            apagado, ninguna pantalla puede renderizar datos vivos. Verifica que el
            proceso <code className="font-mono">npm run dev:gateway</code> este arriba en
            el puerto 3000.
          </p>
        </CardContent>
      </Card>
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
      if (data.operatingNorth.liveInfrastructureWritesEnabled || data.killSwitch.enabled) return "critical";
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
