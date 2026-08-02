import * as RadixSwitch from "@radix-ui/react-switch";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

export type SwitchProps = ComponentPropsWithoutRef<typeof RadixSwitch.Root>;

/**
 * Switch — a boolean toggle built on Radix Switch.
 *
 * Radix supplies the accessibility (role="switch", keyboard, data-state); we
 * only supply token-driven styling. Controlled via `checked`/`onCheckedChange`
 * or used uncontrolled with `defaultChecked`.
 */
export const Switch = forwardRef<
  React.ElementRef<typeof RadixSwitch.Root>,
  SwitchProps
>(({ className, ...rest }, ref) => (
  <RadixSwitch.Root
    ref={ref}
    className={["switch", className ?? ""].filter(Boolean).join(" ")}
    {...rest}
  >
    <RadixSwitch.Thumb className="switch__thumb" />
  </RadixSwitch.Root>
));
Switch.displayName = "Switch";
