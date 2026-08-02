import * as ToggleGroup from "@radix-ui/react-toggle-group";
import type { ReactNode } from "react";

/** One selectable option in a SegmentedControl. */
export interface SegmentedOption {
  value: string;
  label: ReactNode;
}

export interface SegmentedControlProps {
  /** Accessible group label. */
  "aria-label": string;
  /** Currently selected value. */
  value: string;
  /** Called with the new value (empty string when deselected — usually ignore). */
  onValueChange: (value: string) => void;
  /** The options rendered left-to-right. */
  options: SegmentedOption[];
}

/**
 * SegmentedControl — a single-select pill group built on Radix ToggleGroup.
 *
 * Ideal for small, mutually-exclusive choices (density, view mode). Uses the
 * "single" toggle type; Radix handles roving-tabindex keyboard navigation.
 */
export function SegmentedControl({
  value,
  onValueChange,
  options,
  ...aria
}: SegmentedControlProps) {
  return (
    <ToggleGroup.Root
      type="single"
      className="seg"
      value={value}
      onValueChange={onValueChange}
      aria-label={aria["aria-label"]}
    >
      {options.map((opt) => (
        <ToggleGroup.Item
          key={opt.value}
          className="seg__item"
          value={opt.value}
        >
          {opt.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
