import type { ReactNode } from "react";
import { Caption, Eyebrow } from "../../shared/ui/aivora";

export interface PageHeadProps {
  eyebrow: string;
  title: string;
  body?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
}

/**
 * Cabecera de página al MOLDE del demo (features/overview): eyebrow uppercase +
 * h1 peso 300 (30px) + subcopy secundaria, con hairline inferior. Primitivos de
 * aivora (Eyebrow/Caption) — sin dependencia de los primitivos B/N de v5.
 */
export function PageHead({ eyebrow, title, body, meta, trailing }: PageHeadProps) {
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 max-w-[760px] flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Eyebrow>{eyebrow}</Eyebrow>
          {meta ? <Caption>{meta}</Caption> : null}
        </div>
        <h1
          className="m-0 text-fg"
          style={{ fontSize: 30, fontWeight: 300, letterSpacing: "-0.02em", lineHeight: 1.1 }}
        >
          {title}
        </h1>
        {typeof body === "string" ? (
          <p className="m-0 font-sans text-[13.5px] leading-[1.55] text-fg-muted">{body}</p>
        ) : (
          body
        )}
      </div>
      {trailing ? (
        <div className="flex shrink-0 items-start justify-start lg:justify-end">{trailing}</div>
      ) : null}
    </header>
  );
}
