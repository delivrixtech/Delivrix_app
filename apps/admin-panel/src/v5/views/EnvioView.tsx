/**
 * Contenedor "Envío" (reorg A13) — reúne el pipeline de envío en pestañas:
 * Sender Pool · Dominios · Warmup · Nodos · Reputación.
 *
 * Es re-layout de contenedor: envuelve las vistas v5 existentes tal cual
 * (sin reescribirlas) en `shared/ui/tabs.tsx`. El kill switch sigue accesible
 * desde la pestaña "Nodos" (Clusters).
 *
 * Sin header de grupo propio: cada vista envuelta ya renderiza su PageHead y el
 * contexto de grupo lo dan el breadcrumb del Shell + la TabsList. Evita el doble
 * header (dos H1 / dos border-bottom apilados).
 */

import { Suspense, lazy } from "react";
import type { DashboardData } from "../../shared/api/client.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../shared/ui/tabs.tsx";
import { envioTabs } from "../../app/sections.ts";
import { TabFallback } from "./_TabFallback.tsx";

const SenderPoolV5 = lazy(async () => ({ default: (await import("./SenderPool.tsx")).SenderPoolV5 }));
const DomainsV5 = lazy(async () => ({ default: (await import("./Domains.tsx")).DomainsV5 }));
const WarmupV5 = lazy(async () => ({ default: (await import("./Warmup.tsx")).WarmupV5 }));
const ClustersV5 = lazy(async () => ({ default: (await import("./Clusters.tsx")).ClustersV5 }));
const MxtoolboxHealthV5 = lazy(async () => ({ default: (await import("./MxtoolboxHealth.tsx")).MxtoolboxHealthV5 }));

export interface EnvioViewProps {
  data: DashboardData;
  /** Pestaña activa (id histórico). Si no es válida, cae en la primera. */
  activeTab: string | null;
  /** Notifica al router cuál pestaña quedó activa (para URL / deep-links). */
  onSelectTab: (tab: string) => void;
}

export function EnvioView({ data, activeTab, onSelectTab }: EnvioViewProps) {
  const value = envioTabs.some((t) => t.id === activeTab) ? (activeTab as string) : envioTabs[0].id;

  return (
    <div className="flex flex-col gap-6">
      <Tabs value={value} onValueChange={onSelectTab}>
        <TabsList className="flex flex-wrap">
          {envioTabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="sender-pool">
          <Suspense fallback={<TabFallback />}>
            <SenderPoolV5 />
          </Suspense>
        </TabsContent>
        <TabsContent value="domains">
          <Suspense fallback={<TabFallback />}>
            <DomainsV5 />
          </Suspense>
        </TabsContent>
        <TabsContent value="warmup">
          <Suspense fallback={<TabFallback />}>
            <WarmupV5 />
          </Suspense>
        </TabsContent>
        <TabsContent value="clusters">
          <Suspense fallback={<TabFallback />}>
            <ClustersV5 data={data} />
          </Suspense>
        </TabsContent>
        <TabsContent value="mxtoolbox">
          <Suspense fallback={<TabFallback />}>
            <MxtoolboxHealthV5 />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
