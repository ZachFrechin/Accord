import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

import { Icon } from "./Icon";

export interface DialogProps {
  /** Controlled open state (optional; can be uncontrolled). */
  open?: boolean;
  /** Open-state change handler. */
  onOpenChange?: (open: boolean) => void;
  /** The element that opens the dialog (wrapped in Radix Trigger asChild). */
  trigger?: ReactNode;
  /** Dialog heading. */
  title: ReactNode;
  /** Optional supporting description. */
  description?: ReactNode;
  /** Dialog body content. */
  children: ReactNode;
}

/**
 * Dialog — a modal built on Radix Dialog.
 *
 * Radix manages focus trapping, scroll locking, Escape/overlay dismissal, and
 * ARIA wiring. We provide the token-styled overlay + content and a portal so the
 * modal escapes the shell's overflow. Pass a `trigger` for uncontrolled use or
 * drive it with `open`/`onOpenChange`.
 */
export function Dialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? (
        <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>
      ) : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog__overlay" />
        <RadixDialog.Content className="dialog__content">
          <RadixDialog.Close className="dialog__close" aria-label="Fermer">
            <Icon name="x" size={18} />
          </RadixDialog.Close>
          <RadixDialog.Title className="dialog__title">
            {title}
          </RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="dialog__desc">
              {description}
            </RadixDialog.Description>
          ) : null}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Re-export the Radix Close so callers can dismiss from inside the body. */
export const DialogClose = RadixDialog.Close;
