import * as RadixTabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

/** One tab: its trigger label and panel content. */
export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
}

export interface TabsProps {
  /** Tabs to render, in order. */
  items: TabItem[];
  /** Initially-selected value (uncontrolled). */
  defaultValue?: string;
  /** Accessible label for the tab list. */
  "aria-label"?: string;
}

/**
 * Tabs — a tabbed panel built on Radix Tabs.
 *
 * Radix supplies roving-tabindex keyboard navigation and the aria-controls
 * relationships. We render triggers from the `items` array and their matching
 * panels; styling is token-driven.
 */
export function Tabs({ items, defaultValue, ...aria }: TabsProps) {
  return (
    <RadixTabs.Root
      className="tabs"
      defaultValue={defaultValue ?? items[0]?.value}
    >
      <RadixTabs.List className="tabs__list" aria-label={aria["aria-label"]}>
        {items.map((t) => (
          <RadixTabs.Trigger
            key={t.value}
            className="tabs__trigger"
            value={t.value}
          >
            {t.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((t) => (
        <RadixTabs.Content
          key={t.value}
          className="tabs__content"
          value={t.value}
        >
          {t.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
