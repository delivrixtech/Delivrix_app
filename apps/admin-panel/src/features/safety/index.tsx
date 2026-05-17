/**
 * Safety (Seguridad) feature: barandillas y norte operativo.
 *
 * 4 MetricCards leen booleanos de `operatingNorth` y `killSwitch` y mapean al
 * microcopy centralizado en `safetyCopy`. Las acciones permitidas/bloqueadas y
 * los gates pendientes salen directo del payload. Los roles tambien.
 */

import type { DashboardData } from "../../shared/api/client.ts";
import {
  compactLabel,
  formatNumber,
  type Tone
} from "../../shared/lib/formatters.ts";
import {
  pickBinary,
  safetyCopy
} from "../../shared/lib/domain-state-copy.ts";
import {
  Badge as UiBadge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  MetricCard as UiMetricCard,
  PageHeader
} from "../../shared/ui/index.ts";
import { formatEndpointBadge, getSection } from "../../app/sections.ts";

function ActionTokenList({
  items,
  tone,
  empty
}: {
  items: string[];
  tone: Extract<Tone, "success" | "warning" | "critical" | "neutral">;
  empty: string;
}) {
  if (items.length === 0) {
    return <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">{empty}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <UiBadge key={item} tone={tone}>
          {compactLabel(item)}
        </UiBadge>
      ))}
    </div>
  );
}

function RoleField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2.5">
      <dt className="m-0 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
        {label}
      </dt>
      <dd className="m-0 text-[13px] text-[var(--color-text-primary)]">{value}</dd>
    </div>
  );
}

export function SafetySection({ data }: { data: DashboardData }) {
  const killSwitchOn = data.killSwitch.enabled;
  const liveWritesOn = data.operatingNorth.liveInfrastructureWritesEnabled;
  const smtpRealOn = data.operatingNorth.delivrixSendsRealEmail;
  const nfcWritesOn = data.operatingNorth.nfcProductionWritesEnabled;
  const allBoundariesHeld = !liveWritesOn && !smtpRealOn && !nfcWritesOn;
  const gates = data.operatingNorth.gates ?? [];

  return (
    <section className="flex flex-col gap-5 max-w-[1200px]">
      <PageHeader
        eyebrow={getSection("safety").eyebrow}
        title={getSection("safety").title}
        description={
          allBoundariesHeld
            ? getSection("safety").description
            : "Hay al menos una frontera operativa habilitada. Revisar antes de continuar."
        }
        badge={{
          label: killSwitchOn ? "Kill switch on" : "Kill switch off",
          tone: killSwitchOn ? "critical" : "success"
        }}
        endpoint={formatEndpointBadge(getSection("safety").endpoint)}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <UiMetricCard
          label="Infra writes"
          value={liveWritesOn ? "Enabled" : "Disabled"}
          microcopy={pickBinary(safetyCopy.liveInfrastructureWrites, liveWritesOn).copy}
          microcopyTone={pickBinary(safetyCopy.liveInfrastructureWrites, liveWritesOn).tone}
        />
        <UiMetricCard
          label="SMTP real"
          value={smtpRealOn ? "Enabled" : "Disabled"}
          microcopy={pickBinary(safetyCopy.delivrixSendsRealEmail, smtpRealOn).copy}
          microcopyTone={pickBinary(safetyCopy.delivrixSendsRealEmail, smtpRealOn).tone}
        />
        <UiMetricCard
          label="NFC writes"
          value={nfcWritesOn ? "Enabled" : "Disabled"}
          microcopy={pickBinary(safetyCopy.nfcProductionWrites, nfcWritesOn).copy}
          microcopyTone={pickBinary(safetyCopy.nfcProductionWrites, nfcWritesOn).tone}
        />
        <UiMetricCard
          label="Kill switch"
          value={killSwitchOn ? "Active" : "Inactive"}
          microcopy={
            killSwitchOn
              ? `Activado por ${data.killSwitch.updatedBy || "system"}`
              : pickBinary(safetyCopy.killSwitchActive, false).copy
          }
          microcopyTone={pickBinary(safetyCopy.killSwitchActive, killSwitchOn).tone}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <div className="flex items-baseline justify-between gap-3">
              <CardTitle>Acciones permitidas</CardTitle>
              <UiBadge tone="success">{formatNumber(data.operatingNorth.allowedActions.length)}</UiBadge>
            </div>
          </CardHeader>
          <CardContent>
            <ActionTokenList
              items={data.operatingNorth.allowedActions}
              tone="success"
              empty="Sin acciones permitidas configuradas."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-baseline justify-between gap-3">
              <CardTitle>Acciones bloqueadas</CardTitle>
              <UiBadge tone="critical">{formatNumber(data.operatingNorth.blockedActions.length)}</UiBadge>
            </div>
          </CardHeader>
          <CardContent>
            <ActionTokenList
              items={data.operatingNorth.blockedActions}
              tone="critical"
              empty="Sin acciones bloqueadas explicitamente."
            />
          </CardContent>
        </Card>
      </div>

      {gates.length > 0 ? (
        <Card>
          <CardHeader>
            <div className="flex items-baseline justify-between gap-3">
              <CardTitle>Gates por cumplir</CardTitle>
              <UiBadge tone="warning">{formatNumber(gates.length)}</UiBadge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="m-0 mb-3 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
              Lista de gates declarados por el norte operativo. Subir volumen o autonomia exige cumplir
              cada gate y dejarlo auditado.
            </p>
            <ActionTokenList items={gates} tone="warning" empty="Sin gates pendientes." />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-baseline justify-between gap-3">
            <CardTitle>Roles del norte operativo</CardTitle>
            <UiBadge tone="outline">read-only</UiBadge>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <RoleField label="Delivrix" value={compactLabel(data.operatingNorth.delivrixRole)} />
            <RoleField label="OpenClaw" value={compactLabel(data.operatingNorth.openClawRole)} />
            <RoleField label="NFC" value={compactLabel(data.operatingNorth.nfcRole)} />
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}
