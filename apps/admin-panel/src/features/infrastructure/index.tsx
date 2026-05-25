/**
 * Infraestructura — Hito 5.12 Multi-provider inventory MVP.
 *
 * Vista unificada read-only de los proveedores que Delivrix gobierna:
 * Webdock × 3 cuentas + AWS Route53 + AWS Domains + IONOS Cloud DNS + servidor
 * físico (placeholder). Datos vienen del endpoint unificado
 * GET /v1/infrastructure/inventory (Codex backend Hito 5.12).
 *
 * Mientras el endpoint no esté expuesto el feature muestra empty/error state
 * apropiado. Sin datos quemados.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Cloud,
  Database,
  Globe,
  HardDrive,
  Loader,
  RefreshCw,
  Server,
  TriangleAlert
} from "lucide-react";
import { LiveIndicator, SectionDivider } from "../../shared/ui/v2/index.ts";

/* ============================================================
 * Tipos del contrato Hito 5.12 § 2.3 (Codex backend)
 * ============================================================ */

export type ProviderKind = "compute" | "dns" | "domain-registrar" | "physical";

export type ProviderStatus = "active" | "paused" | "error" | "planned";

export interface InventoryItem {
  id: string;
  kind: string;
  displayName: string;
  status: string;
  /** rico para drilldown — opcional */
  detail?: Record<string, unknown>;
}

export interface ProviderEntry {
  id: string;
  displayName: string;
  kind: ProviderKind;
  status: ProviderStatus;
  itemCount: number;
  lastFetched: string | null;
  fetchSourceKind: "live" | "mock" | null;
  errorReason?: string;
  /** capabilities habilitadas (read-only en MVP) */
  capabilities: string[];
  /** Items expandidos cuando el cliente pide drilldown */
  items?: InventoryItem[];
}

export interface InventoryPayload {
  providers: ProviderEntry[];
  generatedAt: string;
}

/* ============================================================
 * Hook que consume el endpoint unificado
 * ============================================================ */

type FetchState =
  | { status: "loading" }
  | { status: "ok"; payload: InventoryPayload; lastUpdateAt: number }
  | { status: "error"; message: string };

function useInventory(pollMs = 30_000): FetchState {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      try {
        const res = await fetch("/v1/infrastructure/inventory", { headers: { accept: "application/json" } });
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = (await res.json()) as InventoryPayload;
        if (cancelled) return;
        setState({ status: "ok", payload, lastUpdateAt: Date.now() });
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "error",
          message: e instanceof Error ? e.message : "no se pudo obtener el inventario"
        });
      } finally {
        if (!cancelled) timer = window.setTimeout(tick, pollMs);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [pollMs]);

  return state;
}

/* ============================================================
 * <InfrastructureSection> — root
 * ============================================================ */

export function InfrastructureSection() {
  const state = useInventory(30_000);
  const lastUpdate = state.status === "ok" ? state.lastUpdateAt : Date.now();

  return (
    <section className="flex flex-col" style={{ gap: 20 }}>
      <Hero lastUpdateMs={lastUpdate} />
      <SectionDivider
        title="Proveedores activos"
        caption="Multi-provider inventory · GET /v1/infrastructure/inventory"
        countTone={state.status === "ok" ? "success" : state.status === "error" ? "critical" : "warning"}
        count={state.status === "ok" ? state.payload.providers.length : undefined}
      />
      <Body state={state} />
    </section>
  );
}

function Hero({ lastUpdateMs }: { lastUpdateMs: number }) {
  return (
    <header className="flex items-start" style={{ gap: 16 }}>
      <div className="flex flex-col min-w-0 flex-1" style={{ gap: 6 }}>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-bold text-[var(--color-accent-tertiary)]"
          style={{ letterSpacing: "1.2px" }}
        >
          HITO 5.12 · MULTI-PROVIDER
        </span>
        <h1
          className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[var(--color-text-primary)]"
          style={{ letterSpacing: "-0.4px" }}
        >
          Toda tu infraestructura, en una sola vista.
        </h1>
        <p
          className="m-0 text-[14px] font-[family-name:var(--font-sans)] leading-[1.5] text-[var(--color-text-secondary)]"
        >
          Webdock × 3 cuentas, AWS Route53, AWS Domains, IONOS Cloud DNS y el servidor
          físico. Solo lectura. Cada fetch queda en audit chain.
        </p>
      </div>
      <div className="shrink-0">
        <LiveIndicator pollIntervalSec={30} lastUpdateAt={lastUpdateMs} tone="success" />
      </div>
    </header>
  );
}

function Body({ state }: { state: FetchState }) {
  if (state.status === "loading") return <LoadingState />;
  if (state.status === "error") return <ErrorState message={state.message} />;
  if (state.payload.providers.length === 0) return <EmptyState />;
  return <ProvidersGrid providers={state.payload.providers} />;
}

/* ============================================================
 * Estados vacíos
 * ============================================================ */

function LoadingState() {
  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ padding: 48, gap: 12, color: "var(--color-text-tertiary)" }}
    >
      <Loader size={32} strokeWidth={1.25} style={{ animation: "spin 1.4s linear infinite" }} />
      <span
        className="font-[family-name:var(--font-body)]"
        style={{ fontSize: 13, color: "var(--color-text-secondary)" }}
      >
        Cargando inventario del gateway…
      </span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center text-center"
      style={{
        padding: 48,
        gap: 12,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 12
      }}
    >
      <span
        className="grid place-items-center"
        style={{
          width: 40,
          height: 40,
          borderRadius: 999,
          background: "var(--color-warning-soft)",
          color: "var(--color-warning)"
        }}
      >
        <TriangleAlert size={22} strokeWidth={1.5} />
      </span>
      <div className="flex flex-col" style={{ gap: 4, maxWidth: 440 }}>
        <span
          className="font-[family-name:var(--font-heading)] font-semibold"
          style={{ fontSize: 15, color: "var(--color-warning)" }}
        >
          Endpoint /v1/infrastructure/inventory no disponible
        </span>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)", lineHeight: 1.5 }}
        >
          {message} — el backend del Hito 5.12 todavía no expuso el endpoint unificado.
          Cuando Codex lo cabee, este panel se llena automáticamente sin redeploy.
        </span>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="flex flex-col items-center justify-center text-center"
      style={{
        padding: 48,
        gap: 12,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 12
      }}
    >
      <Cloud size={32} strokeWidth={1.25} style={{ color: "var(--color-text-tertiary)" }} />
      <div className="flex flex-col" style={{ gap: 4, maxWidth: 440 }}>
        <span
          className="font-[family-name:var(--font-heading)] font-semibold"
          style={{ fontSize: 15, color: "var(--color-text-secondary)" }}
        >
          Sin proveedores configurados
        </span>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>
          El registry está vacío. Agregá una API key (Webdock, AWS, IONOS) en
          <code style={{ margin: "0 4px", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            /etc/openclaw/skills.env
          </code>
          y recargá.
        </span>
      </div>
    </div>
  );
}

/* ============================================================
 * Grid de provider cards
 * ============================================================ */

function ProvidersGrid({ providers }: { providers: ProviderEntry[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selected) ?? null,
    [selected, providers]
  );

  return (
    <div
      className="grid"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}
    >
      {providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          active={p.id === selected}
          onSelect={() => setSelected(p.id === selected ? null : p.id)}
        />
      ))}
      {selectedProvider ? (
        <div style={{ gridColumn: "1 / -1" }}>
          <ProviderDrilldown provider={selectedProvider} />
        </div>
      ) : null}
    </div>
  );
}

const KIND_META: Record<ProviderKind, { label: string; icon: typeof Server }> = {
  compute: { label: "Compute", icon: Server },
  dns: { label: "DNS", icon: Globe },
  "domain-registrar": { label: "Domains", icon: Database },
  physical: { label: "Físico", icon: HardDrive }
};

const STATUS_META: Record<ProviderStatus, { label: string; bg: string; fg: string }> = {
  active: {
    label: "activo",
    bg: "var(--color-success-soft)",
    fg: "var(--color-success)"
  },
  paused: {
    label: "pausado",
    bg: "var(--color-warning-soft)",
    fg: "var(--color-warning)"
  },
  error: {
    label: "error",
    bg: "var(--color-critical-soft)",
    fg: "var(--color-critical)"
  },
  planned: {
    label: "planeado",
    bg: "var(--color-surface-sunken)",
    fg: "var(--color-text-tertiary)"
  }
};

function ProviderCard({
  provider,
  active,
  onSelect
}: {
  provider: ProviderEntry;
  active: boolean;
  onSelect: () => void;
}) {
  const kind = KIND_META[provider.kind];
  const status = STATUS_META[provider.status];
  const Icon = kind.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex flex-col text-left transition-colors hover:bg-[var(--color-surface-sunken)]"
      style={{
        gap: 10,
        padding: 16,
        borderRadius: 10,
        background: active ? "var(--color-surface-sunken)" : "var(--color-surface)",
        border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
        cursor: "pointer"
      }}
    >
      <header className="flex items-center" style={{ gap: 10 }}>
        <span
          aria-hidden="true"
          className="grid place-items-center"
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: status.bg,
            color: status.fg
          }}
        >
          <Icon size={18} strokeWidth={1.75} />
        </span>
        <div className="flex flex-col min-w-0" style={{ gap: 2 }}>
          <span
            className="font-[family-name:var(--font-heading)] font-semibold truncate"
            style={{ fontSize: 14, color: "var(--color-text-primary)" }}
          >
            {provider.displayName}
          </span>
          <span
            className="font-[family-name:var(--font-mono)]"
            style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
          >
            {kind.label} · {provider.id}
          </span>
        </div>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold"
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            background: status.bg,
            color: status.fg,
            fontSize: 10
          }}
        >
          {status.label}
        </span>
      </header>

      <div className="flex items-end" style={{ gap: 6 }}>
        <span
          className="font-[family-name:var(--font-mono)] font-bold leading-none"
          style={{ fontSize: 24, color: "var(--color-text-primary)" }}
        >
          {provider.itemCount}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] leading-none"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
        >
          items
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="font-[family-name:var(--font-mono)] leading-none"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {provider.fetchSourceKind === "live"
            ? "● live"
            : provider.fetchSourceKind === "mock"
              ? "○ mock"
              : "—"}
        </span>
      </div>

      <footer className="flex items-center" style={{ gap: 6 }}>
        {provider.errorReason ? (
          <span
            className="font-[family-name:var(--font-mono)] truncate"
            style={{ fontSize: 10, color: "var(--color-critical)" }}
          >
            {provider.errorReason}
          </span>
        ) : provider.lastFetched ? (
          <span
            className="font-[family-name:var(--font-mono)] truncate"
            style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
          >
            últ. fetch {provider.lastFetched}
          </span>
        ) : (
          <span
            className="font-[family-name:var(--font-mono)] truncate"
            style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
          >
            sin fetches todavía
          </span>
        )}
        <span className="flex-1" aria-hidden="true" />
        <span
          className="inline-flex items-center"
          style={{ gap: 4, fontSize: 11, color: "var(--color-text-secondary)" }}
        >
          {active ? "Ocultar" : "Ver items"}
          <ArrowRight size={12} strokeWidth={1.75} />
        </span>
      </footer>
    </button>
  );
}

function ProviderDrilldown({ provider }: { provider: ProviderEntry }) {
  if (!provider.items || provider.items.length === 0) {
    return (
      <div
        style={{
          padding: 24,
          borderRadius: 10,
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)"
        }}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          <RefreshCw size={14} strokeWidth={1.75} style={{ color: "var(--color-text-tertiary)" }} />
          <span
            className="font-[family-name:var(--font-mono)]"
            style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
          >
            Sin items en {provider.displayName}. El drilldown completo lo cabea Codex en el endpoint
            con query <code>?provider_id={provider.id}</code>.
          </span>
        </div>
      </div>
    );
  }
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 10,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)"
      }}
    >
      <header className="flex items-center" style={{ gap: 8, marginBottom: 12 }}>
        <span
          className="font-[family-name:var(--font-heading)] font-semibold"
          style={{ fontSize: 13, color: "var(--color-text-primary)" }}
        >
          Items de {provider.displayName}
        </span>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {provider.items.length} entradas
        </span>
      </header>
      <ul className="m-0 list-none p-0 flex flex-col" style={{ gap: 4 }}>
        {provider.items.map((it) => (
          <li
            key={it.id}
            className="flex items-center"
            style={{
              gap: 12,
              padding: "8px 12px",
              borderRadius: 6,
              background: "var(--color-surface-sunken)"
            }}
          >
            <span
              className="font-[family-name:var(--font-mono)]"
              style={{ fontSize: 11, color: "var(--color-text-primary)", fontWeight: 600 }}
            >
              {it.displayName}
            </span>
            <span style={{ flex: 1 }} />
            <span
              className="font-[family-name:var(--font-mono)]"
              style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
            >
              {it.kind}
            </span>
            <span
              className="font-[family-name:var(--font-caption)] font-semibold"
              style={{ fontSize: 10, color: "var(--color-text-secondary)" }}
            >
              {it.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
