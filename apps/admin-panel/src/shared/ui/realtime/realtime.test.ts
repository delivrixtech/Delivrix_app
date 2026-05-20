import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

type RealtimeModule = {
  EmptyEventsCard: ComponentType<{ pollIntervalSeconds?: number }>;
  EmptyEvidenceCard: ComponentType<{ pollIntervalSeconds?: number }>;
  EmptySessionsCard: ComponentType<{ pollIntervalSeconds?: number }>;
  FallbackBanner: ComponentType;
  RealtimeTick: ComponentType<{ active: boolean }>;
  SkeletonKpiCard: ComponentType;
  SkeletonRow: ComponentType;
  StaleBadge: ComponentType<{ minutesAgo: number }>;
  formatStaleBadgeLabel: (minutesAgo: number) => string;
  isCachedMeta: (meta: unknown) => boolean;
  isFallbackMeta: (meta: unknown) => boolean;
  staleMinutesFromMeta: (meta: unknown) => number;
};

let server: ViteDevServer | null = null;

async function loadRealtimeModule() {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });

  return server.ssrLoadModule("/src/shared/ui/realtime/index.ts") as Promise<RealtimeModule>;
}

after(async () => {
  await server?.close();
});

test("realtime components render the literal degraded-state labels", async () => {
  const {
    EmptyEventsCard,
    EmptyEvidenceCard,
    EmptySessionsCard,
    FallbackBanner,
    RealtimeTick,
    SkeletonKpiCard,
    SkeletonRow,
    StaleBadge
  } = await loadRealtimeModule();

  const stale = renderToStaticMarkup(React.createElement(StaleBadge, { minutesAgo: 12 }));
  assert.match(stale, /Hace 12 min/);
  assert.match(stale, /--color-warning-soft/);

  const fallback = renderToStaticMarkup(React.createElement(FallbackBanner));
  assert.match(fallback, /Mostrando valores de respaldo/);
  assert.match(fallback, /Agente no disponible · datos pueden estar desactualizados/);

  const skeleton = renderToStaticMarkup(React.createElement(SkeletonKpiCard));
  assert.match(skeleton, /width:220px/);
  assert.match(skeleton, /width:80px/);
  assert.match(skeleton, /width:60px/);
  assert.match(skeleton, /width:120px/);

  const rowSkeleton = renderToStaticMarkup(React.createElement(SkeletonRow));
  assert.match(rowSkeleton, /Cargando fila/);
  assert.match(rowSkeleton, /width:80px/);
  assert.match(rowSkeleton, /width:160px/);
  assert.match(rowSkeleton, /width:60px/);

  const idleTick = renderToStaticMarkup(React.createElement(RealtimeTick, { active: false }));
  const activeTick = renderToStaticMarkup(React.createElement(RealtimeTick, { active: true }));
  assert.doesNotMatch(idleTick, /realtime-tick-halo/);
  assert.match(activeTick, /realtime-tick-halo/);

  const empty = renderToStaticMarkup(React.createElement(EmptySessionsCard, { pollIntervalSeconds: 30 }));
  assert.match(empty, /Sin sesiones activas/);
  assert.match(empty, /Sin actividad de operador en los últimos 15 minutos/);
  assert.match(empty, /Refresca cada 30 s/);

  const emptyEvents = renderToStaticMarkup(React.createElement(EmptyEventsCard, { pollIntervalSeconds: 30 }));
  assert.match(emptyEvents, /Sin eventos del agente/);
  assert.match(emptyEvents, /OpenClaw no registró actividad nueva en los últimos 30 minutos/);
  assert.match(emptyEvents, /Refresca cada 30 s/);

  const emptyEvidence = renderToStaticMarkup(React.createElement(EmptyEvidenceCard, { pollIntervalSeconds: 30 }));
  assert.match(emptyEvidence, /Sin evidencia curada/);
  assert.match(emptyEvidence, /OpenClaw no ha promovido lecciones nuevas/);
  assert.match(emptyEvidence, /Refresca cada 30 s/);
});

test("realtime meta helpers map cached and fallback states", async () => {
  const {
    formatStaleBadgeLabel,
    isCachedMeta,
    isFallbackMeta,
    staleMinutesFromMeta
  } = await loadRealtimeModule();

  assert.equal(formatStaleBadgeLabel(12.8), "Hace 12 min");
  assert.equal(formatStaleBadgeLabel(Number.NaN), "Hace 0 min");
  assert.equal(isFallbackMeta({ dataSource: "fallback", staleSinceMs: null, evaluatedAt: "2026-05-20T00:00:00.000Z" }), true);
  assert.equal(isCachedMeta({ dataSource: "cached", staleSinceMs: 125_000, evaluatedAt: "2026-05-20T00:00:00.000Z" }), true);
  assert.equal(staleMinutesFromMeta({ dataSource: "cached", staleSinceMs: 125_000, evaluatedAt: "2026-05-20T00:00:00.000Z" }), 2);
});
