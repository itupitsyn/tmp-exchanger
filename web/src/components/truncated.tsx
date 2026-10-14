"use client";

import { useRef, useState } from "react";
import { cn } from "cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Текст в одну строку с троеточием. Подсказка с полным значением появляется,
 * только если текст действительно обрезан.
 */
export function Truncated({
  children,
  full,
  className,
  tooltipClassName,
}: {
  children: React.ReactNode;
  /** Что показать в подсказке; по умолчанию сам текст. */
  full?: React.ReactNode;
  className?: string;
  tooltipClassName?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const el = ref.current;
        setOpen(next && Boolean(el && el.scrollWidth > el.clientWidth));
      }}
    >
      <TooltipTrigger render={<span ref={ref} className={cn("block truncate", className)} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent className={cn("max-w-md break-all", tooltipClassName)}>{full ?? children}</TooltipContent>
    </Tooltip>
  );
}
