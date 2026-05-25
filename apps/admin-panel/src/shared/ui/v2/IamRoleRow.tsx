import { cn } from "../../lib/cn.ts";

export type IamRoleColor = "amber" | "green" | "blue" | "violet" | "neutral";

export interface IamRoleRowProps {
  name: string;
  color: IamRoleColor;
  userCount: number;
  permsCount: number;
  className?: string;
}

const colorMap: Record<IamRoleColor, { bg: string; fg: string }> = {
  amber: { bg: "var(--color-warning-soft)", fg: "var(--color-warning)" },
  green: { bg: "var(--color-success-soft)", fg: "var(--color-success)" },
  blue: { bg: "var(--color-info-soft)", fg: "var(--color-info)" },
  violet: { bg: "var(--color-unknown-soft)", fg: "var(--color-unknown)" },
  neutral: { bg: "var(--color-surface-sunken)", fg: "var(--color-text-tertiary)" }
};

export function IamRoleRow({ name, color, userCount, permsCount, className }: IamRoleRowProps) {
  const c = colorMap[color];
  const initial = name.charAt(0).toUpperCase();
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
        className="flex items-center justify-center shrink-0 font-[family-name:var(--font-heading)] font-bold leading-none"
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: c.bg,
          color: c.fg,
          fontSize: 14
        }}
      >
        {initial}
      </span>
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <span
          className="font-[family-name:var(--font-body)] font-semibold leading-snug truncate"
          style={{ fontSize: 13, color: "var(--color-text-primary)" }}
        >
          {name}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] leading-none"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {permsCount} {permsCount === 1 ? "permiso" : "permisos"}
        </span>
      </div>
      <span
        className="inline-flex items-center justify-center font-[family-name:var(--font-mono)] font-bold leading-none shrink-0"
        style={{
          width: 36,
          height: 24,
          borderRadius: "var(--radius-sm)",
          background: c.bg,
          color: c.fg,
          fontSize: 12
        }}
        aria-label={`${userCount} usuarios`}
      >
        {userCount}
      </span>
    </article>
  );
}
