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

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Cloud,
  Database,
  Globe,
  HardDrive,
  RefreshCw,
  Server,
  TriangleAlert
} from "lucide-react";
import { getJson } from "../../shared/api/client.ts";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary.ts";
import {
  LiveIndicator,
  SectionDivider,
  SkeletonKpiGrid
} from "../../shared/ui/v2/index.ts";

/* ============================================================
 * Tipos del contrato Hito 5.12 § 2.3.
 *
 * Mirror del paquete @delivrix/domain (packages/domain/src/infrastructure-inventory.ts,
 * commit c972b15). Los nombres coinciden 1:1 con el contract canónico — si
 * Codex actualiza el paquete, este mirror debe sincronizarse.
 *
 * Patrón del panel admin: cada feature copia los types del contract en vez
 * de depender directamente del paquete domain, para mantener el bundle del
 * panel acotado y evitar imports cross-workspace.
 * ============================================================ */

export type ProviderKind = "compute" | "dns" | "domain-registrar" | "physical";

export type ProviderStatus = "active" | "paused" | "error" | "planned";

export type ProviderFetchSourceKind = "live" | "mock";

export interface InventoryItem {
  id: string;
  kind: string;
  displayName: string;
  status: string;
  /** rico para drilldown — opcional */
  detail?: Record<string, unknown>;
}

export interface Provider {
  id: string;
  displayName: string;
  kind: ProviderKind;
  status: ProviderStatus;
  itemCount: number;
  lastFetched: string | null;
  fetchSourceKind: ProviderFetchSourceKind | null;
  errorReason?: string;
  /** capabilities habilitadas (read-only en MVP) */
  capabilities: string[];
  /** Items expandidos cuando el cliente pide drilldown */
  items?: InventoryItem[];
}

export interface InfrastructureInventoryResponse {
  generatedAt: string;
  providers: Provider[];
}

/* ============================================================
 * Hook que consume el endpoint unificado vía react-query.
 *
 * Beneficios sobre el fetch manual previo:
 * - Cache automático compartido entre componentes.
 * - Background refetch coordinado con el resto del panel.
 * - Dedup de requests si el componente re-monta.
 * - Devtools visibles en react-query.
 * ============================================================ */

const POLL_MS = 30_000;

type FetchState =
  | { status: "loading" }
  | { status: "ok"; payload: InfrastructureInventoryResponse; lastUpdateAt: number }
  | { status: "error"; message: string };

function useInventory(): FetchState {
  const query = useQuery({
    queryKey: ["infrastructure", "inventory"],
    queryFn: () => getJson<InfrastructureInventoryResponse>(READ_ENDPOINTS.infrastructureInventory),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS / 2
  });

  if (query.isLoading) return { status: "loading" };
  if (query.isError) {
    return {
      status: "error",
      message: query.error instanceof Error ? query.error.message : "no se pudo obtener el inventario"
    };
  }
  if (query.data) {
    return {
      status: "ok",
      payload: query.data,
      lastUpdateAt: query.dataUpdatedAt
    };
  }
  return { status: "loading" };
}

/* ============================================================
 * <InfrastructureSection> — root
 * ============================================================ */

export function InfrastructureSection() {
  const state = useInventory();
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
    <header className="flex flex-col items-start sm:flex-row" style={{ gap: 16 }}>
      <div className="flex flex-col min-w-0 flex-1" style={{ gap: 6 }}>
        <span
          className="text-[11px] font-[family-name:var(--font-caption)] font-bold uppercase text-[var(--color-accent-tertiary)]"
          style={{ letterSpacing: "var(--tracking-widest)" }}
        >
          Hito 5.12 · Multi-provider
        </span>
        <h1
          className="m-0 text-[28px] font-[family-name:var(--font-heading)] font-bold leading-[1.1] text-[var(--color-text-primary)]"
          style={{ letterSpacing: "var(--tracking-tightest)" }}
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
      <div className="shrink-0 self-start sm:self-auto">
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
  // Skeleton placeholder con la misma estructura que ProvidersGrid: 4 cards
  // de tamaño KPI. Evita CLS cuando llega el payload real.
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <SkeletonKpiGrid count={4} />
      <span className="sr-only">Cargando inventario del gateway…</span>
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

function ProvidersGrid({ providers }: { providers: Provider[] }) {
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

/**
 * Resuelve el nombre del proveedor real (brand) a partir del slug del provider.
 * Antes la card mostraba el account label (`Claude · DK`) como title primary,
 * confundiendo al usuario que cree que "Claude" es el provider. Ahora la card
 * usa el brand name (Webdock / AWS / IONOS / Físico) como primary y el account
 * label como sufijo secundario.
 */
function brandName(provider: Provider): string {
  const id = provider.id.toLowerCase();
  if (id.startsWith("webdock")) return "Webdock";
  if (id.startsWith("aws-")) return "AWS";
  if (id.startsWith("ionos-")) return "IONOS";
  if (id.startsWith("physical-")) return "Servidor físico";
  // fallback: si el backend usa otro slug, intentar inferir del displayName.
  const dn = provider.displayName.toLowerCase();
  if (dn.includes("webdock")) return "Webdock";
  if (dn.includes("aws")) return "AWS";
  if (dn.includes("ionos")) return "IONOS";
  if (dn.includes("físico") || dn.includes("fisico")) return "Servidor físico";
  return provider.displayName;
}

/**
 * Devuelve el "account label" como sufijo cuando difiere del brand name.
 * Ej: brand="Webdock", displayName="Claude · DK" → sufijo "Claude · DK".
 *     brand="AWS", displayName="AWS Bedrock us-east-1" → sufijo "Bedrock us-east-1".
 * Si el displayName ES el brand name, no devuelve nada (evita duplicación).
 */
function accountSuffix(provider: Provider): string {
  const brand = brandName(provider);
  const dn = provider.displayName.trim();
  if (dn === brand) return "";
  // Si el displayName empieza con el brand, mostrar solo lo que sigue.
  if (dn.toLowerCase().startsWith(brand.toLowerCase())) {
    const rest = dn.slice(brand.length).trim().replace(/^[·:\-—]+/, "").trim();
    return rest;
  }
  return dn;
}

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
  provider: Provider;
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
          {/* Jerarquía: brand (Webdock/AWS/IONOS/Físico) primary, account label
              secondary, kind + slug en mono. Antes mostraba el account label
              como primary y confundía: "Claude · DK" parecía ser el provider. */}
          <div className="flex items-center min-w-0" style={{ gap: 6 }}>
            <span
              className="font-[family-name:var(--font-sans)] font-semibold truncate"
              style={{ fontSize: 14, color: "var(--color-text-primary)", letterSpacing: "var(--tracking-tight)" }}
            >
              {brandName(provider)}
            </span>
            {accountSuffix(provider) ? (
              <span
                className="font-[family-name:var(--font-sans)] truncate"
                style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
              >
                · {accountSuffix(provider)}
              </span>
            ) : null}
          </div>
          <span
            className="font-[family-name:var(--font-mono)] truncate"
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

function ProviderDrilldown({ provider }: { provider: Provider }) {
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
            Sin items en {brandName(provider)}{accountSuffix(provider) ? ` · ${accountSuffix(provider)}` : ""}.
            {provider.status === "planned" ? " Proveedor aún no online." : ""}
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
      <header className="flex flex-wrap items-center" style={{ gap: 8, marginBottom: 12 }}>
        <span
          className="font-[family-name:var(--font-sans)] font-semibold"
          style={{ fontSize: 13, color: "var(--color-text-primary)" }}
        >
          {brandName(provider)}
          {accountSuffix(provider) ? (
            <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>
              {" · "}{accountSuffix(provider)}
            </span>
          ) : null}
        </span>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {provider.items.length} {provider.items.length === 1 ? "item" : "items"}
        </span>
        <span className="flex-1" aria-hidden="true" />
        {provider.lastFetched ? (
          <span
            className="font-[family-name:var(--font-mono)]"
            style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
          >
            últ. fetch · {formatRelativeOrIso(provider.lastFetched)}
          </span>
        ) : null}
      </header>

      <div className="overflow-x-auto">
        <div style={{ minWidth: 720 }}>
          {/* Header de columnas */}
          <div
            className="grid items-center"
            style={{
              gridTemplateColumns: "minmax(0,1.5fr) 120px 110px 90px 130px",
              gap: 12,
              padding: "6px 12px",
              borderRadius: 4,
              background: "var(--color-surface-sunken)"
            }}
          >
            {["Servidor", "Estado", "Región", "Plan", "Último visto"].map((h, i) => (
              <span
                key={h}
                className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase text-[var(--color-text-tertiary)]"
                style={{ letterSpacing: "var(--tracking-wider)", textAlign: i === 4 ? "right" : "left" }}
              >
                {h}
              </span>
            ))}
          </div>

          <ul className="m-0 list-none p-0 flex flex-col" style={{ gap: 2, marginTop: 4 }}>
            {provider.items.map((it) => {
              const detail = (it.detail ?? {}) as Record<string, unknown>;
              const location = stringOrDash(detail.location);
              const plan = stringOrDash(detail.profileSlug);
              const image = stringOrDash(detail.imageSlug);
              const lastSeen = stringOrDash(detail.lastDataReceived) || stringOrDash(detail.createdAt);
              const statusKind = resolveItemStatusKind(it.status);
              return (
                <li
                  key={it.id}
                  className="grid items-center"
                  style={{
                    gridTemplateColumns: "minmax(0,1.5fr) 120px 110px 90px 130px",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 4,
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)"
                  }}
                >
                  <div className="flex flex-col min-w-0" style={{ gap: 2 }}>
                    <span
                      className="font-[family-name:var(--font-sans)] font-semibold truncate"
                      style={{ fontSize: 12, color: "var(--color-text-primary)" }}
                    >
                      {it.displayName}
                    </span>
                    <code
                      className="font-[family-name:var(--font-mono)] truncate"
                      style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
                    >
                      {it.id}
                      {image !== "—" ? ` · ${image}` : ""}
                    </code>
                  </div>
                  <span
                    className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold uppercase"
                    style={{
                      gap: 6,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: statusKind.bg,
                      color: statusKind.fg,
                      letterSpacing: "var(--tracking-wider)",
                      fontSize: 9,
                      width: "fit-content"
                    }}
                  >
                    <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, background: statusKind.fg }} />
                    {it.status}
                  </span>
                  <span
                    className="font-[family-name:var(--font-mono)] truncate"
                    style={{ fontSize: 11, color: "var(--color-text-secondary)" }}
                  >
                    {location}
                  </span>
                  <span
                    className="font-[family-name:var(--font-mono)] truncate"
                    style={{ fontSize: 11, color: "var(--color-text-secondary)" }}
                  >
                    {plan}
                  </span>
                  <span
                    className="font-[family-name:var(--font-mono)] truncate text-right"
                    style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
                  >
                    {lastSeen === "—" ? "—" : formatRelativeOrIso(lastSeen)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

function stringOrDash(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "—";
}

function resolveItemStatusKind(status: string): { bg: string; fg: string } {
  const lower = status.toLowerCase();
  if (lower === "running" || lower === "active") {
    return { bg: "var(--color-success-soft)", fg: "var(--color-success)" };
  }
  if (lower === "stopped" || lower === "paused" || lower === "suspended") {
    return { bg: "var(--color-warning-soft)", fg: "var(--color-warning)" };
  }
  if (lower === "error" || lower === "deleting") {
    return { bg: "var(--color-critical-soft)", fg: "var(--color-critical)" };
  }
  // provisioning, reinstalling, rebooting, planned, unknown
  return { bg: "var(--color-info-soft)", fg: "var(--color-info)" };
}

function formatRelativeOrIso(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return new Date(iso).toLocaleString("es-CO");
  if (diffMs < 60_000) return `hace ${Math.round(diffMs / 1000)}s`;
  if (diffMs < 3_600_000) return `hace ${Math.round(diffMs / 60_000)} min`;
  if (diffMs < 86_400_000) return `hace ${Math.round(diffMs / 3_600_000)} h`;
  if (diffMs < 86_400_000 * 30) return `hace ${Math.round(diffMs / 86_400_000)} d`;
  return new Date(iso).toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
}
