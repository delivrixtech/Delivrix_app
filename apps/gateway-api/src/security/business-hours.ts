const operatorTimeZone = process.env.DELIVRIX_OPERATOR_TZ ?? "America/Bogota";
const businessHoursStart = 8;
const businessHoursEnd = 20;

export interface QuorumResolution {
  requiredApprovals: 1 | 2;
  mode: "business_hours" | "off_hours";
  serverTime: string;
  operatorLocalHour: number;
}

export function resolveBusinessHoursQuorum(now: Date, runbookId: string): QuorumResolution {
  if (runbookId !== "incident-quarantine") {
    throw new Error("resolveBusinessHoursQuorum only applies to incident-quarantine.");
  }

  const operatorLocalHour = getOperatorLocalHour(now);
  const isBusinessHours = operatorLocalHour >= businessHoursStart && operatorLocalHour < businessHoursEnd;

  return {
    requiredApprovals: isBusinessHours ? 1 : 2,
    mode: isBusinessHours ? "business_hours" : "off_hours",
    serverTime: now.toISOString(),
    operatorLocalHour
  };
}

export function resolveGatewayNow(now = new Date()): Date {
  if (process.env.NODE_ENV !== "development") {
    return now;
  }

  const override = process.env.DELIVRIX_NOW_OVERRIDE;

  if (!override) {
    return now;
  }

  const overridden = new Date(override);
  return Number.isNaN(overridden.getTime()) ? now : overridden;
}

function getOperatorLocalHour(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: operatorTimeZone,
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);

  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Could not resolve operator local hour for ${operatorTimeZone}.`);
  }

  return hour;
}
