import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  RefreshCw, Search, ShieldAlert, CircleCheck, TriangleAlert, Ban, Gauge,
  type LucideIcon,
} from "lucide-react";
import { getJsonWithQuery, READ_ENDPOINTS } from "../../shared/api/client";
import {
  Card,
  SectionHead,
  KpiCard,
  StateBadge,
  Button,
  Pill,
  Eyebrow,
  stateNeedsLeftBorder,
  stateColor,
} from "../../shared/ui/aivora";

type MxtoolboxStatus = "clean" | "warning" | "listed" | "error";

interface MxtoolboxHealthSummary {
  target: string;
  command: string;
  checkedAt: string;
  status: MxtoolboxStatus;
  failedChecks: string[];
  warningChecks: string[];
  passedCount: number;
  timeoutCount: number;
  rawRef: string;
}

interface MxtoolboxHealthResponse {
  source: "live" | "cached";
  cachedAt?: string;
  result: MxtoolboxHealthSummary;
}

interface MxtoolboxDailyReportResponse {
  generatedAt: string;
  totalTargets: number;
  summary: Record<MxtoolboxStatus, number>;
  results: MxtoolboxHealthSummary[];
  criticalAlerts: MxtoolboxHealthSummary[];
  usage?: {
    used?: number;
    limit?: number;
    remaining?: number;
    checkedAt: string;
  };
}

const lookupTypes = ["blacklist", "smtp", "mx", "spf", "dkim", "dmarc", "ptr"] as const;

/* mxtoolbox status → clave visual del StateBadge del molde (color/ícono §4), con el
 * término real de mxtoolbox como label. No hay estilo nuevo: se reusa el primitivo.
 *   clean   → active      (success · circle-check)
 *   warning → degraded    (warning ámbar · triangle-alert)  — único uso legítimo del ámbar
 *   listed  → quarantined (danger caliente · shield-alert)  — accionable ya
 *   error   → BLOCKED     (neutral frío · ban)              — check no resuelto */
const STATUS_BADGE: Record<MxtoolboxStatus, string> = {
  clean: "active",
  warning: "degraded",
  listed: "quarantined",
  error: "BLOCKED",
};

/* Left-border de fila/card por el helper del molde (§4/DoD-6), NO hand-rolled:
 * degraded gana su borde ámbar; quarantined el rojo caliente accionable; BLOCKED el
 * neutro frío (no compite con quarantined); clean/active sin borde. Un único origen. */
function statusBorder(status: MxtoolboxStatus): string {
  const badge = STATUS_BADGE[status];
  return stateNeedsLeftBorder(badge)
    ? `2px solid ${stateColor(badge)}`
    : "2px solid transparent";
}

/* estilos inline SOLO con tokens (theme-aware). Nada de hex ni paletas nuevas. */
const eyebrowStyle: CSSProperties = {
  fontSize: 11, letterSpacing: ".16em", textTransform: "uppercase",
  color: "var(--color-text-tertiary)", fontWeight: 600,
};
const fieldLabel: CSSProperties = {
  fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase",
  color: "var(--color-text-tertiary)", fontWeight: 600,
};
const inputStyle: CSSProperties = {
  height: 38, width: "100%", borderRadius: 10,
  border: "1px solid var(--color-border)", background: "var(--color-surface-sunken)",
  padding: "0 12px", color: "var(--color-text-primary)", fontSize: 13, outline: "none",
};
const truncate: CSSProperties = {
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
};
const cellMuted: CSSProperties = { fontSize: 12.5, color: "var(--color-text-secondary)" };
const cellFaint: CSSProperties = { fontSize: 12, color: "var(--color-text-tertiary)" };
/* IDs/targets/timestamps: familia ÚNICA vía token (--font-mono = Inter) + tabular-nums.
 * Sin stacks de fuente ad-hoc: el look "mono" lo da la alineación tabular, no otra familia. */
const monoCell: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
};

const ROW_COLS = "minmax(160px,1.5fr) 96px 132px minmax(160px,1.6fr) 84px 116px 130px";

export function MxtoolboxHealthV5() {
  const [target, setTarget] = useState("");
  const [type, setType] = useState<(typeof lookupTypes)[number]>("blacklist");
  const [lookupParams, setLookupParams] = useState({ target: "", type: "blacklist" });

  const daily = useQuery({
    queryKey: ["mxtoolbox", "daily-report"],
    queryFn: () => getJsonWithQuery<MxtoolboxDailyReportResponse>(READ_ENDPOINTS.mxtoolboxDailyReport, {}),
    refetchInterval: 120_000,
    staleTime: 60_000
  });

  const lookup = useQuery({
    queryKey: ["mxtoolbox", "health", lookupParams],
    queryFn: () => getJsonWithQuery<MxtoolboxHealthResponse>(READ_ENDPOINTS.mxtoolboxHealth, lookupParams),
    enabled: lookupParams.target.trim().length > 0,
    staleTime: 60_000
  });

  const rows = useMemo(() => {
    const reportRows = daily.data?.results ?? [];
    const lookupRow = lookup.data?.result;
    if (!lookupRow) return reportRows;
    const key = `${lookupRow.command}:${lookupRow.target}`;
    return [
      lookupRow,
      ...reportRows.filter((row) => `${row.command}:${row.target}` !== key)
    ];
  }, [daily.data?.results, lookup.data?.result]);

  const summary = daily.data?.summary;
  const criticalAlerts = daily.data?.criticalAlerts ?? [];
  const usage = daily.data?.usage;

  /* Sin reporte real → "—" (nunca ceros fabricados que parezcan "todo limpio"). */
  const kpis: { key: string; label: string; value: number | string; icon: LucideIcon }[] = [
    { key: "clean", label: "Clean", value: summary?.clean ?? "—", icon: CircleCheck },
    { key: "warning", label: "Warning", value: summary?.warning ?? "—", icon: TriangleAlert },
    { key: "listed", label: "Listed", value: summary?.listed ?? "—", icon: ShieldAlert },
    { key: "error", label: "Error", value: summary?.error ?? "—", icon: Ban },
  ];

  return (
    <section
      className="mxt-shell"
      style={{
        display: "flex", flexDirection: "column",
        maxWidth: 1320, margin: "0 auto", width: "100%",
        color: "var(--color-text-primary)", fontVariantNumeric: "tabular-nums",
      }}
    >
      <style>{`
        .mxt-row:hover{ background: color-mix(in srgb, var(--color-text-primary) 3%, transparent); }
        .mxt-input:focus-visible{ outline: 2px solid var(--color-accent); outline-offset: 1px; border-color: var(--color-accent); }
        /* Shell: gutter/gap desktop canónico; se reducen solo en móvil (< sm) */
        .mxt-shell{ padding: 28px; gap: 24px; }
        /* Fila de alerta crítica: 4 tracks en desktop, apila a 1 col en móvil */
        .mxt-alert-row{ display: grid; grid-template-columns: minmax(0,1.4fr) auto minmax(0,1.8fr) auto; gap: 12px; align-items: center; padding: 12px 20px; }
        /* Scroll horizontal de la tabla con momentum en iOS */
        .mxt-scroll{ overflow-x: auto; -webkit-overflow-scrolling: touch; }
        @media (max-width: 639px){
          .mxt-shell{ padding: 16px; gap: 20px; }
          .mxt-alert-row{ grid-template-columns: 1fr; gap: 6px; align-items: start; padding: 12px 16px; }
        }
      `}</style>

      <SectionHead
        eyebrow="MXToolbox · Read-only"
        title="Salud · Blacklist"
        subtitle="Diagnóstico de reputación y DNS para IPs y dominios del sender pool autorizado. El panel consume solo contratos GET del Gateway."
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={cellFaint}>
              {daily.data?.generatedAt
                ? `reporte ${formatDateTime(daily.data.generatedAt)}`
                : daily.isLoading
                  ? "cargando…"
                  : daily.isError
                    ? "reporte no disponible"
                    : "sin reporte"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void daily.refetch();
                void lookup.refetch();
              }}
            >
              <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
              Actualizar
            </Button>
          </div>
        }
      />

      {/* KPI grid — números neutros del molde; sin sparkline (no hay serie real) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 20 }}>
        {kpis.map((k) => (
          <KpiCard key={k.key} label={k.label} value={k.value} icon={k.icon} />
        ))}
        <KpiCard
          label="Quota restante"
          value={usage?.remaining ?? "—"}
          suffix={usage?.limit ? `/ ${usage.limit}` : undefined}
          icon={Gauge}
        />
      </div>

      {criticalAlerts.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <SectionHead
            eyebrow="Reputación"
            title="Alertas críticas"
            subtitle={`${criticalAlerts.length} objetivo(s) en lista negra o con error de check`}
          />
          <Card style={{ overflow: "hidden" }}>
            {criticalAlerts.map((alert, i) => (
              <div
                key={`${alert.command}:${alert.target}`}
                className="mxt-alert-row"
                style={{
                  borderLeft: statusBorder(alert.status),
                  borderBottom: i < criticalAlerts.length - 1 ? "1px solid var(--color-border)" : "none",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <ShieldAlert size={15} strokeWidth={1.8} color={stateColor(STATUS_BADGE[alert.status])} style={{ flex: "none" }} aria-hidden="true" />
                  <span style={{ ...truncate, ...monoCell, fontSize: 13, color: "var(--color-text-primary)" }}>{alert.target}</span>
                </span>
                <StateBadge status={STATUS_BADGE[alert.status]} label={alert.status} />
                <span style={{ ...truncate, ...cellMuted }}>{alert.failedChecks.join(", ") || "listed"}</span>
                <span style={cellFaint}>{formatDateTime(alert.checkedAt)}</span>
              </div>
            ))}
          </Card>
        </div>
      ) : null}

      {/* Lookup en vivo */}
      <Card style={{ padding: 20 }}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setLookupParams({ target: target.trim(), type });
          }}
          style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 220px", minWidth: 0 }}>
            <span style={fieldLabel}>Target</span>
            <input
              className="mxt-input"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="IP o dominio del sender pool"
              style={{ ...inputStyle, ...monoCell }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "0 1 180px" }}>
            <span style={fieldLabel}>Tipo</span>
            <select
              className="mxt-input"
              value={type}
              onChange={(event) => setType(event.target.value as (typeof lookupTypes)[number])}
              style={inputStyle}
            >
              {lookupTypes.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="primary" style={{ height: 38 }} disabled={target.trim().length === 0}>
            <Search size={14} strokeWidth={1.75} aria-hidden="true" />
            Consultar
          </Button>
        </form>
      </Card>

      {/* Tabla de targets */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <SectionHead
          eyebrow="Diagnóstico"
          title="Targets"
          subtitle={
            lookup.isError
              ? `${rows.length} objetivo(s) · consulta con error`
              : lookupParams.target.trim().length > 0 && lookup.isFetching
                ? `${rows.length} objetivo(s) · consultando…`
                : lookup.data
                  ? `${rows.length} objetivo(s) · consulta ${lookup.data.source}`
                  : `${rows.length} objetivo(s)`
          }
        />
        {lookup.isError ? (
          <Card
            style={{
              display: "flex", alignItems: "flex-start", gap: 10,
              padding: "12px 20px", borderLeft: `2px solid ${stateColor("BLOCKED")}`,
            }}
          >
            <TriangleAlert size={15} strokeWidth={1.8} color={stateColor("BLOCKED")} style={{ flex: "none", marginTop: 1 }} aria-hidden="true" />
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>
                Falló la consulta de <span style={monoCell}>{lookupParams.target}</span>
              </span>
              <span style={cellMuted}>{errorMessage(lookup.error)}</span>
            </div>
          </Card>
        ) : null}
        <Card style={{ overflow: "hidden" }}>
          {rows.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", padding: "28px 20px" }}>
              <Eyebrow>MXToolbox</Eyebrow>
              <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>
                {daily.isError
                  ? "No se pudo cargar el reporte"
                  : daily.isLoading || lookup.isLoading
                    ? "Cargando reporte…"
                    : "Sin targets reportados"}
              </div>
              <div style={{ fontSize: 13, color: "var(--color-text-secondary)", maxWidth: 520 }}>
                {daily.isError
                  ? errorMessage(daily.error)
                  : daily.isLoading || lookup.isLoading
                    ? "Consultando los contratos GET del Gateway."
                    : "El Gateway no encontró sender nodes activos o warming para escanear."}
              </div>
            </div>
          ) : (
            <div className="mxt-scroll">
              <div style={{ minWidth: 920 }}>
                <div
                  style={{
                    display: "grid", gridTemplateColumns: ROW_COLS, gap: 12,
                    padding: "8px 20px", borderBottom: "1px solid var(--color-border)",
                    ...eyebrowStyle, fontSize: 11, letterSpacing: ".05em",
                  }}
                >
                  <span>Target</span>
                  <span>Tipo</span>
                  <span>Status</span>
                  <span>Checks</span>
                  <span style={{ textAlign: "right" }}>Timeouts</span>
                  <span>Raw ref</span>
                  <span style={{ textAlign: "right" }}>Checked</span>
                </div>
                {rows.map((row, i) => (
                  <div
                    key={`${row.command}:${row.target}`}
                    className="mxt-row"
                    style={{
                      display: "grid", gridTemplateColumns: ROW_COLS, gap: 12, alignItems: "center",
                      padding: "12px 20px",
                      borderBottom: i < rows.length - 1 ? "1px solid var(--color-border)" : "none",
                      borderLeft: statusBorder(row.status),
                    }}
                  >
                    <span style={{ ...truncate, ...monoCell, fontSize: 13, color: "var(--color-text-primary)" }}>{row.target}</span>
                    <Pill tone="neutral" style={{ justifySelf: "start", ...monoCell }}>
                      {row.command}
                    </Pill>
                    <span><StateBadge status={STATUS_BADGE[row.status]} label={row.status} /></span>
                    <span style={{ ...truncate, ...cellMuted }}>
                      {row.failedChecks.length > 0
                        ? row.failedChecks.join(", ")
                        : row.warningChecks.length > 0
                          ? row.warningChecks.join(", ")
                          : `${row.passedCount} passed`}
                    </span>
                    {/* ámbar reservado a warning/paused (§4): un timeout>0 se enfatiza con
                     * peso/primario neutro, nunca con color de estado. */}
                    <span
                      style={{
                        ...monoCell, textAlign: "right", fontSize: 13,
                        fontWeight: row.timeoutCount > 0 ? 600 : 400,
                        color: row.timeoutCount > 0 ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
                      }}
                    >
                      {row.timeoutCount}
                    </span>
                    <span style={{ ...truncate, ...monoCell, fontSize: 11.5, color: "var(--color-text-tertiary)" }}>{row.rawRef.slice(0, 12)}</span>
                    <span style={{ ...cellFaint, textAlign: "right" }}>{formatDateTime(row.checkedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>
    </section>
  );
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "No se pudo cargar MXToolbox.";
}
