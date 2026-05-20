import type { AuditEvent, AuditRiskLevel } from "./audit-log.ts";
import { buildRealTimeMeta, type RealTimeMeta } from "./realtime-meta.ts";

/**
 * Compliance status — contrato GET-only para la fila "Compliance row" del
 * panel de Seguridad. Devuelve 3 controles canónicos (privacy, operational,
 * sin acciones reales) con su estado actual en formato literal.
 */

export type ComplianceControlState = "ok" | "warning" | "info" | "critical";
export type ComplianceControlMetrics = Record<string, boolean | number | string>;

export interface ComplianceControl {
  id: string;
  title: string;
  state: ComplianceControlState;
  lines: string[];
  runbookRef?: string;
  evaluatedAt?: string;
  metrics?: ComplianceControlMetrics;
}

export interface ComplianceStatusContract {
  controls: ComplianceControl[];
  meta: RealTimeMeta;
}

export interface ComplianceStatusSource {
  auditEvents?: AuditEvent[];
  chainOk?: boolean;
  killSwitchArmed?: boolean;
  now?: Date;
}

const CONTROLS: readonly ComplianceControl[] = Object.freeze([
  {
    id: "gdpr",
    title: "GDPR · Privacidad",
    state: "ok" as ComplianceControlState,
    lines: [
      "Sin envíos reales · no hay datos PII fluyendo",
      "Cookies del panel: solo sesión local, no analítica",
      "Audit log encriptado en reposo · SHA-256 encadenado"
    ],
    runbookRef: "privacy-runbook.md"
  },
  {
    id: "operational",
    title: "Cumplimiento operativo",
    state: "warning" as ComplianceControlState,
    lines: [
      "31 gates del MVP · 7 requieren revisión humana",
      "Dry-run obligatorio antes de cualquier escritura real",
      "Kill switch global probado en simulación"
    ],
    runbookRef: "operating-north-runbook.md"
  },
  {
    id: "anti-abuse",
    title: "Sin acciones reales",
    state: "info" as ComplianceControlState,
    lines: [
      "Panel GET-only · 0 mutaciones expuestas en el bundle",
      "SMTP, SSH, DNS, NFC y Proxmox bloqueados por norte",
      "Promoción de habilidades requiere panel humano de 4 firmas"
    ],
    runbookRef: "north-operativo.md"
  }
] as const);

export function buildComplianceStatus(source: ComplianceStatusSource = {}): ComplianceStatusContract {
  const now = source.now ?? new Date();
  const events = source.auditEvents;

  if (!events?.length) {
    return fallbackComplianceStatus(now);
  }

  const evaluatedAt = now.toISOString();
  const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const twentyFourHoursAgo = now.getTime() - 24 * 60 * 60 * 1000;
  const events30d = events.filter((event) => occurredAtMs(event) >= thirtyDaysAgo);
  const events24h = events.filter((event) => occurredAtMs(event) >= twentyFourHoursAgo);
  const chainOk = source.chainOk !== false;
  const killSwitchState = source.killSwitchArmed === false ? "disabled" : "armed";

  const smtpSendReal30d = events30d.filter((event) => event.action.includes("smtp.send.real")).length;
  const bypassAttempts30d = events30d.filter(isBypassAttempt).length;
  const prohibitedRejections30d = events30d.filter(isProhibitedRejection).length;
  const proposalMetrics = proposalApprovalMetrics(events24h);

  const gdprState: ComplianceControlState = !chainOk ? "critical" : smtpSendReal30d > 0 ? "warning" : "ok";
  const operationalState: ComplianceControlState =
    killSwitchState === "disabled" && proposalMetrics.pendingProposals > 0
      ? "critical"
      : proposalMetrics.humanApprovedRate < 1
        ? "warning"
        : "ok";
  const antiAbuseState: ComplianceControlState =
    bypassAttempts30d > 0 ? "critical" : prohibitedRejections30d > 0 ? "warning" : "ok";

  return {
    controls: [
      enrichControl("gdpr", gdprState, evaluatedAt, [
        `Última verificación: ${smtpSendReal30d} envíos reales en 30d; audit chain ${chainOk ? "OK" : "rota"}`
      ], {
        smtpSendReal30d,
        chainOk
      }),
      enrichControl("operational", operationalState, evaluatedAt, [
        `Última verificación: ${proposalMetrics.approvedProposals}/${proposalMetrics.totalProposals} propuestas medium+ aprobadas en 24h; kill switch ${killSwitchState}`
      ], {
        humanApprovedRate: proposalMetrics.humanApprovedRate,
        approvedProposals: proposalMetrics.approvedProposals,
        totalProposals: proposalMetrics.totalProposals,
        pendingProposals: proposalMetrics.pendingProposals,
        killSwitchState
      }),
      enrichControl("anti-abuse", antiAbuseState, evaluatedAt, [
        `Última verificación: ${bypassAttempts30d} bypass y ${prohibitedRejections30d} rechazos prohibited_action en 30d`
      ], {
        bypassAttempts30d,
        prohibitedRejections30d
      })
    ],
    meta: buildRealTimeMeta({ dataSource: "live", now })
  };
}

function fallbackComplianceStatus(now: Date): ComplianceStatusContract {
  return {
    controls: cloneControls(CONTROLS),
    meta: buildRealTimeMeta({ dataSource: "fallback", now })
  };
}

function cloneControls(controls: readonly ComplianceControl[]): ComplianceControl[] {
  return controls.map((control) => ({
    ...control,
    lines: [...control.lines],
    metrics: control.metrics ? { ...control.metrics } : undefined
  }));
}

function enrichControl(
  id: string,
  state: ComplianceControlState,
  evaluatedAt: string,
  appendedLines: string[],
  metrics: ComplianceControlMetrics
): ComplianceControl {
  const base = CONTROLS.find((control) => control.id === id);
  if (!base) {
    throw new Error(`Unknown compliance control: ${id}`);
  }

  return {
    ...base,
    state,
    lines: [...base.lines, ...appendedLines],
    evaluatedAt,
    metrics
  };
}

function proposalApprovalMetrics(events24h: AuditEvent[]): {
  totalProposals: number;
  approvedProposals: number;
  pendingProposals: number;
  humanApprovedRate: number;
} {
  const proposalIds = new Set<string>();
  const approvedProposalIds = new Set<string>();

  for (const event of events24h) {
    const proposalId = proposalIdFor(event);
    if (!proposalId) {
      continue;
    }

    if (isMediumPlus(event.riskLevel) && isProposalEvent(event)) {
      proposalIds.add(proposalId);
    }

    if (event.humanApproved === true || event.action === "oc.approval.quorum_reached") {
      approvedProposalIds.add(proposalId);
    }
  }

  const approvedProposals = [...proposalIds].filter((proposalId) => approvedProposalIds.has(proposalId)).length;
  const totalProposals = proposalIds.size;
  const pendingProposals = Math.max(0, totalProposals - approvedProposals);

  return {
    totalProposals,
    approvedProposals,
    pendingProposals,
    humanApprovedRate: totalProposals === 0 ? 1 : approvedProposals / totalProposals
  };
}

function isProposalEvent(event: AuditEvent): boolean {
  return event.targetType === "proposal" || event.action.startsWith("oc.proposal.");
}

function proposalIdFor(event: AuditEvent): string | null {
  if (event.targetType === "proposal" && event.targetId) {
    return event.targetId;
  }
  return typeof event.metadata.proposalId === "string" ? event.metadata.proposalId : null;
}

function isMediumPlus(riskLevel: AuditRiskLevel): boolean {
  return riskLevel === "medium" || riskLevel === "high" || riskLevel === "critical";
}

function isBypassAttempt(event: AuditEvent): boolean {
  const action = event.action.toLowerCase();
  return action.includes("bypass") || event.metadata.bypass === true || event.metadata.bypassAttempt === true;
}

function isProhibitedRejection(event: AuditEvent): boolean {
  return event.rejectReason === "prohibited_action" || event.metadata.rejectReason === "prohibited_action";
}

function occurredAtMs(event: AuditEvent): number {
  const parsed = Date.parse(event.occurredAt);
  return Number.isFinite(parsed) ? parsed : 0;
}
