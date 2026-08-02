import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export interface TooltipProps {
  /** Tooltip text. */
  label: ReactNode;
  /** The element the tooltip describes (wrapped asChild). */
  children: ReactNode;
  /** Preferred side (defaults to "bottom"). */
  side?: "top" | "right" | "bottom" | "left";
}

/**
 * Tooltip — a hover/focus hint built on Radix Tooltip.
 *
 * Self-contained: it includes its own Provider so callers can drop a Tooltip
 * anywhere. Radix handles the show delay, keyboard focus, and pointer-safe
 * dismissal. Wrap a single focusable child (button, link).
 */
export function Tooltip({ label, children, side = "bottom" }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={300}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className="tooltip__content"
            side={side}
            sideOffset={6}
          >
            {label}
            <RadixTooltip.Arrow className="tooltip__arrow" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
