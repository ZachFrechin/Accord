import * as RadixPopover from "@radix-ui/react-popover";
import type { ReactNode } from "react";

export interface PopoverProps {
  /** Element that toggles the popover (wrapped asChild). */
  trigger: ReactNode;
  /** Floating content. */
  children: ReactNode;
  /** Preferred side (defaults to "bottom"). */
  side?: "top" | "right" | "bottom" | "left";
  /** Alignment along the side (defaults to "center"). */
  align?: "start" | "center" | "end";
}

/**
 * Popover — non-modal floating panel built on Radix Popover.
 *
 * Used for lightweight editors and menus that don't warrant a modal. Radix
 * handles positioning, outside-click dismissal, and focus management. Content is
 * portalled and offset from the trigger.
 */
export function Popover({
  trigger,
  children,
  side = "bottom",
  align = "center",
}: PopoverProps) {
  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className="popover__content"
          side={side}
          align={align}
          sideOffset={8}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
