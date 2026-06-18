import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search, ShieldAlert } from "lucide-react";
import { getJsonWithQuery, READ_ENDPOINTS } from "../../shared/api/client";
import {
  BodySm,
  Button,
  Caption,
  Card,
  EmptyState,
  MonoCode,
  MonoData,
  Pill,
  SectionHead,
  Stat
} from "../components/primitives";
import { PageHead } from "./_PageHead";

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

export function MxtoolboxHealthV5() {
  const [target, setTarget] = useState("8.8.8.8");
  const [type, setType] = useState<(typeof lookupTypes)[number]>("blacklist");
  const [lookupParams, setLookupParams] = useState({ target: "8.8.8.8", type: "blacklist" });

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

  const summary = daily.data?.summary ?? { clean: 0, warning: 0, listed: 0, error: 0 };
  const criticalAlerts = daily.data?.criticalAlerts ?? [];

  return (
    <section className="mx-auto flex w-full max-w-[1320px] flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
      <PageHead
        eyebrow="MXToolbox · Read-only"
        title="Salud · Blacklist"
        body="Diagnóstico de reputación y DNS para IPs y dominios del sender pool autorizado. El panel consume solo contratos GET del Gateway."
        meta={
          daily.data?.generatedAt
            ? `reporte ${formatDateTime(daily.data.generatedAt)}`
            : "sin reporte"
        }
        trailing={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void daily.refetch();
              void lookup.refetch();
            }}
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
            Actualizar
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Card padding="compact"><Stat label="Clean" value={summary.clean} tone="success" hint="checks sin fallos" /></Card>
        <Card padding="compact"><Stat label="Warning" value={summary.warning} tone="warning" hint="señales a revisar" /></Card>
        <Card padding="compact"><Stat label="Listed" value={summary.listed} tone="critical" hint="requiere atención" /></Card>
        <Card padding="compact"><Stat label="Error" value={summary.error} tone="critical" hint="timeout o API" /></Card>
        <Card padding="compact">
          <Stat
            label="Quota"
            value={daily.data?.usage?.remaining ?? "n/a"}
            hint={daily.data?.usage?.limit ? `${daily.data.usage.used ?? 0}/${daily.data.usage.limit} usado` : "usage no disponible"}
          />
        </Card>
      </div>

      {criticalAlerts.length > 0 ? (
        <section className="flex flex-col gap-3">
          <SectionHead
            eyebrow="Reputación"
            title="Alertas críticas"
            count={criticalAlerts.length}
            countTone="critical"
          />
          <Card padding="none" className="overflow-hidden border-critical/40">
            <div className="divide-y divide-border">
              {criticalAlerts.map((alert) => (
                <div key={`${alert.command}:${alert.target}`} className="grid gap-3 px-4 py-3 md:grid-cols-[1.4fr_0.8fr_1.8fr_auto] md:items-center">
                  <div className="flex min-w-0 items-center gap-2">
                    <ShieldAlert size={16} strokeWidth={1.75} className="shrink-0 text-critical" aria-hidden="true" />
                    <MonoData className="truncate">{alert.target}</MonoData>
                  </div>
                  <Pill tone="critical">{alert.command}</Pill>
                  <BodySm className="truncate">{alert.failedChecks.join(", ") || "listed"}</BodySm>
                  <Caption>{formatDateTime(alert.checkedAt)}</Caption>
                </div>
              ))}
            </div>
          </Card>
        </section>
      ) : null}

      <Card padding="compact">
        <form
          className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_180px_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            setLookupParams({ target: target.trim(), type });
          }}
        >
          <label className="flex min-w-0 flex-col gap-1">
            <Caption>Target</Caption>
            <input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              className="h-9 rounded-md border border-border bg-surface px-3 font-mono text-[13px] text-fg outline-none transition-colors focus:border-border-strong"
            />
          </label>
          <label className="flex flex-col gap-1">
            <Caption>Tipo</Caption>
            <select
              value={type}
              onChange={(event) => setType(event.target.value as (typeof lookupTypes)[number])}
              className="h-9 rounded-md border border-border bg-surface px-3 font-sans text-[13px] text-fg outline-none transition-colors focus:border-border-strong"
            >
              {lookupTypes.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <Button type="submit" variant="primary" size="md" className="w-full lg:w-auto">
              <Search size={14} strokeWidth={1.75} aria-hidden="true" />
              Consultar
            </Button>
          </div>
        </form>
      </Card>

      <section className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Diagnóstico"
          title="Targets"
          count={rows.length}
          caption={lookup.data ? `consulta ${lookup.data.source}` : undefined}
        />
        <Card padding="none" className="overflow-hidden">
          {rows.length === 0 ? (
            <EmptyState
              eyebrow="MXToolbox"
              title={daily.isError ? "No se pudo cargar el reporte" : "Sin targets reportados"}
              body={daily.isError ? errorMessage(daily.error) : "El Gateway no encontró sender nodes activos o warming para escanear."}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] border-collapse text-left">
                <thead className="border-b border-border bg-surface-sunken">
                  <tr className="font-mono text-[10px] uppercase text-fg-subtle">
                    <th className="px-4 py-2 font-medium">Target</th>
                    <th className="px-3 py-2 font-medium">Tipo</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Checks</th>
                    <th className="px-3 py-2 font-medium">Timeouts</th>
                    <th className="px-3 py-2 font-medium">Raw ref</th>
                    <th className="px-4 py-2 font-medium">Checked</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row) => (
                    <tr key={`${row.command}:${row.target}`} className="text-[13px]">
                      <td className="max-w-[260px] px-4 py-3"><MonoData className="truncate">{row.target}</MonoData></td>
                      <td className="px-3 py-3"><Pill tone="neutral">{row.command}</Pill></td>
                      <td className="px-3 py-3"><Pill tone={statusTone(row.status)}>{row.status}</Pill></td>
                      <td className="max-w-[320px] px-3 py-3">
                        <BodySm className="truncate">
                          {row.failedChecks.length > 0
                            ? row.failedChecks.join(", ")
                            : row.warningChecks.length > 0
                              ? row.warningChecks.join(", ")
                              : `${row.passedCount} passed`}
                        </BodySm>
                      </td>
                      <td className="px-3 py-3"><MonoData>{row.timeoutCount}</MonoData></td>
                      <td className="px-3 py-3"><MonoCode>{row.rawRef.slice(0, 12)}</MonoCode></td>
                      <td className="px-4 py-3"><Caption>{formatDateTime(row.checkedAt)}</Caption></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </section>
  );
}

function statusTone(status: MxtoolboxStatus): "success" | "warning" | "critical" {
  if (status === "clean") return "success";
  if (status === "warning") return "warning";
  return "critical";
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
