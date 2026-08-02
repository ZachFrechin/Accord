import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export interface MenuProps {
  /** Element that opens the menu (wrapped asChild). */
  trigger: ReactNode;
  /** Menu items (MenuItem / MenuSeparator). */
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

/**
 * Menu — a dropdown menu built on Radix DropdownMenu.
 *
 * Radix handles positioning, keyboard navigation, and outside-click dismissal.
 * Content is portalled so it escapes the shell's overflow. Use for per-row
 * action menus (e.g. a conversation's "…" actions).
 */
export function Menu({ trigger, children, side = "bottom", align = "end" }: MenuProps) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className="menu__content" side={side} align={align} sideOffset={6}>
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export interface MenuItemProps {
  /** Optional leading icon. */
  icon?: IconName;
  /** Danger styling (destructive action). */
  danger?: boolean;
  disabled?: boolean;
  /** Invoked when the item is chosen (click or Enter). */
  onSelect: () => void;
  children: ReactNode;
}

export function MenuItem({ icon, danger, disabled, onSelect, children }: MenuItemProps) {
  return (
    <RadixMenu.Item
      className="menu__item"
      data-danger={danger || undefined}
      disabled={disabled}
      // Defer so the menu fully closes (and returns focus) before any dialog the
      // action may open — avoids Radix focus-return fighting the new overlay.
      onSelect={() => setTimeout(onSelect, 0)}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      <span>{children}</span>
    </RadixMenu.Item>
  );
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="menu__separator" />;
}
