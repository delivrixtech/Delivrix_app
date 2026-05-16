import { CircleDot } from "lucide-react";
import { Badge } from "./badge.tsx";
import { Tooltip } from "./tooltip.tsx";

/**
 * Persistent indicator that the panel is in mock / dry-run mode.
 * Sits in the topbar globally so sponsor always sees the contract.
 */

export interface ModeBadgeProps {
  liveInfrastructureWritesEnabled: boolean;
  delivrixSendsRealEmail: boolean;
  nfcProductionWritesEnabled: boolean;
}

export function ModeBadge(props: ModeBadgeProps) {
  const allMock = !props.liveInfrastructureWritesEnabled && !props.delivrixSendsRealEmail && !props.nfcProductionWritesEnabled;
  const tone = allMock ? "warning" : "critical";
  const label = allMock ? "Mock · Dry-run" : "Live writes";
  const hint = allMock
    ? "El panel y el control plane no ejecutan acciones reales. Sin SMTP, sin infra writes, sin NFC writes."
    : "Hay writes en vivo habilitados. Revisar Seguridad antes de continuar.";

  return (
    <Tooltip hint={hint}>
      <span>
        <Badge tone={tone} className="cursor-default">
          <CircleDot size={11} aria-hidden="true" />
          {label}
        </Badge>
      </span>
    </Tooltip>
  );
}
