import * as RadixSeparator from "@radix-ui/react-separator";
import { forwardRef } from "react";
import { cn } from "../lib/cn.ts";

export const Separator = forwardRef<
  React.ElementRef<typeof RadixSeparator.Root>,
  React.ComponentPropsWithoutRef<typeof RadixSeparator.Root>
>(function Separator({ className, orientation = "horizontal", decorative = true, ...props }, ref) {
  return (
    <RadixSeparator.Root
      ref={ref}
      orientation={orientation}
      decorative={decorative}
      className={cn(
        "shrink-0 bg-[var(--color-border)]",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className
      )}
      {...props}
    />
  );
});
