/**
 * v5 PageHead — wrapper consistente para todas las vistas.
 * Eyebrow + Display/H1 + Body + opcional LiveIndicator / CTA / KPI side.
 */
import type { ReactNode } from "react";
import { Body, Display, Eyebrow, H1, MonoCode } from "../components/primitives";

export interface PageHeadProps {
  eyebrow?: string;
  meta?: ReactNode;
  title: string;
  body?: string | ReactNode;
  trailing?: ReactNode;
  size?: "display" | "h1";
  className?: string;
}

export function PageHead({
  eyebrow,
  meta,
  title,
  body,
  trailing,
  size = "h1",
  className
}: PageHeadProps) {
  return (
    <header className={`flex items-start gap-6 ${className ?? ""}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {(eyebrow || meta) && (
          <div className="flex items-center gap-2">
            {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
            {eyebrow && meta && (
              <span
                aria-hidden="true"
                className="inline-block size-[3px] rounded-full bg-border-strong"
              />
            )}
            {meta && (typeof meta === "string" ? <MonoCode>{meta}</MonoCode> : meta)}
          </div>
        )}
        {size === "display" ? <Display>{title}</Display> : <H1>{title}</H1>}
        {body && (typeof body === "string" ? <Body className="max-w-[640px]">{body}</Body> : body)}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </header>
  );
}
