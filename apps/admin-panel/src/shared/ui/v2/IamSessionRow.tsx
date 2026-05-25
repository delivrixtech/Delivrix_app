import { cn } from "../../lib/cn.ts";

export type IamSessionTransport = "vpn" | "internal" | "mfa";
export type IamSessionRisk = "low" | "medium" | "high";

export interface IamSessionRowProps {
  actor: string;
  location: string;
  transport: IamSessionTransport;
  lastSeenLabel: string;
  risk: IamSessionRisk;
  className?: string;
}

const riskMap: Record<IamSessionRisk, { bg: string; fg: string }> = {
  low: { bg: "var(--color-success-soft)", fg: "var(--color-success)" },
  medium: { bg: "var(--color-warning-soft)", fg: "var(--color-warning)" },
  high: { bg: "var(--color-critical-soft)", fg: "var(--color-critical)" }
};

const transportLabel: Record<IamSessionTransport, string> = {
  vpn: "VPN",
  internal: "interno",
  mfa: "MFA"
};

export function IamSessionRow({
  actor,
  location,
  transport,
  lastSeenLabel,
  risk,
  className
}: IamSessionRowProps) {
  const r = riskMap[risk];
  return (
    <article
      className={cn("flex items-center", className)}
      style={{
        gap: 12,
        padding: "10px 12px",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-surface-sunken)"
      }}
    >
      <span
        aria-hidden="true"
        className="shrink-0"
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: "var(--color-accent-tertiary)"
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <div className="flex items-center" style={{ gap: 6 }}>
          <span
            className="font-[family-name:var(--font-mono)] font-semibold leading-none truncate"
            style={{ fontSize: 12, color: "var(--color-text-primary)" }}
          >
            {actor}
          </span>
          <span
            className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold leading-none shrink-0"
            style={{
              padding: "1px 6px",
              borderRadius: "var(--radius-sm)",
              background: r.bg,
              color: r.fg,
              fontSize: 9,
              letterSpacing: 0.5
            }}
          >
            {risk}
          </span>
        </div>
        <span
          className="font-[family-name:var(--font-mono)] leading-none truncate"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {location} · {transportLabel[transport]} · {lastSeenLabel}
        </span>
      </div>
    </article>
  );
}
