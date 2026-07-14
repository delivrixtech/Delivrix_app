/**
 * Contenedor "Infraestructura" (reorg A13) — reúne la gestión de servidores/hosts
 * en pestañas: Inventario · Alta de servidor · Captura manual.
 *
 * Re-layout de contenedor sobre vistas existentes. La captura manual (Collector)
 * queda accesible como pestaña visible. A14: Hardware NO se incluye (mock que
 * duplica la card de servidor físico del Inventario); su componente sigue en el
 * repo pero fuera del nav.
 *
 * Sin header de grupo propio: cada vista envuelta ya renderiza su PageHead y el
 * contexto de grupo lo dan el breadcrumb del Shell + la TabsList. Evita el doble
 * header (dos H1 / dos border-bottom apilados).
 */

import { Suspense, lazy } from "react";
import type { DashboardData } from "../../shared/api/client.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../shared/ui/tabs.tsx";
import { infraestructuraTabs } from "../../app/sections.ts";
import { TabFallback } from "./_TabFallback.tsx";

const InfrastructureV5 = lazy(async () => ({ default: (await import("./Infrastructure.tsx")).InfrastructureV5 }));
const OnboardingSection = lazy(async () => ({ default: (await import("../../features/onboarding/index.tsx")).OnboardingSection }));
const CollectorSection = lazy(async () => ({ default: (await import("../../features/collector/index.tsx")).CollectorSection }));

export interface InfraestructuraViewProps {
  data: DashboardData;
  activeTab: string | null;
  onSelectTab: (tab: string) => void;
}

export function InfraestructuraView({ data, activeTab, onSelectTab }: InfraestructuraViewProps) {
  const value = infraestructuraTabs.some((t) => t.id === activeTab)
    ? (activeTab as string)
    : infraestructuraTabs[0].id;

  return (
    <div className="flex flex-col gap-6">
      <Tabs value={value} onValueChange={onSelectTab}>
        <TabsList className="flex flex-wrap">
          {infraestructuraTabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="infrastructure">
          <Suspense fallback={<TabFallback />}>
            <InfrastructureV5 />
          </Suspense>
        </TabsContent>
        <TabsContent value="onboarding">
          <Suspense fallback={<TabFallback />}>
            <OnboardingSection data={data} />
          </Suspense>
        </TabsContent>
        <TabsContent value="collector">
          <Suspense fallback={<TabFallback />}>
            <CollectorSection data={data} />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
