/**
 * Contenedor "Gobierno" (reorg A13) — reúne el gobierno de la autonomía de
 * OpenClaw en pestañas: Seguridad · Aprendizaje.
 *
 * Re-layout de contenedor sobre vistas existentes. El kill switch / gates viven
 * en la pestaña "Seguridad" (Safety), que es la pestaña por defecto del grupo.
 *
 * Sin header de grupo propio: cada vista envuelta ya renderiza su PageHead y el
 * contexto de grupo lo dan el breadcrumb del Shell + la TabsList. Evita el doble
 * header (dos H1 / dos border-bottom apilados).
 */

import { Suspense, lazy } from "react";
import type { DashboardData } from "../../shared/api/client.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../shared/ui/tabs.tsx";
import { gobiernoTabs } from "../../app/sections.ts";
import { TabFallback } from "./_TabFallback.tsx";

const SafetySection = lazy(async () => ({ default: (await import("../../features/safety/index.tsx")).SafetySection }));
const LearningSection = lazy(async () => ({ default: (await import("../../features/learning/index.tsx")).LearningSection }));

export interface GobiernoViewProps {
  data: DashboardData;
  activeTab: string | null;
  onSelectTab: (tab: string) => void;
}

export function GobiernoView({ data, activeTab, onSelectTab }: GobiernoViewProps) {
  const value = gobiernoTabs.some((t) => t.id === activeTab) ? (activeTab as string) : gobiernoTabs[0].id;

  return (
    <div className="flex flex-col gap-6">
      <Tabs value={value} onValueChange={onSelectTab}>
        <TabsList className="flex flex-wrap">
          {gobiernoTabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="safety">
          <Suspense fallback={<TabFallback />}>
            <SafetySection data={data} />
          </Suspense>
        </TabsContent>
        <TabsContent value="learning">
          <Suspense fallback={<TabFallback />}>
            <LearningSection data={data} />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
