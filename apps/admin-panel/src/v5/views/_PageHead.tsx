import type { ReactNode } from "react";
import { Body, Caption, Eyebrow, H1 } from "../components/primitives";

export interface PageHeadProps {
  eyebrow: string;
  title: string;
  body?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
}

export function PageHead({ eyebrow, title, body, meta, trailing }: PageHeadProps) {
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 max-w-[760px] flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Eyebrow>{eyebrow}</Eyebrow>
          {meta ? <Caption>{meta}</Caption> : null}
        </div>
        <H1>{title}</H1>
        {typeof body === "string" ? <Body>{body}</Body> : body}
      </div>
      {trailing ? <div className="flex shrink-0 items-start justify-start lg:justify-end">{trailing}</div> : null}
    </header>
  );
}
