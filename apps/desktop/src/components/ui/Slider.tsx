import * as RadixSlider from "@radix-ui/react-slider";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

export type SliderProps = ComponentPropsWithoutRef<typeof RadixSlider.Root> & {
  /** Accessible label for the (single) thumb. */
  "aria-label"?: string;
};

/**
 * Slider — a range input built on Radix Slider.
 *
 * Renders a single thumb by default (one value). Radix provides keyboard
 * support and the value model; styling comes from token-driven classes.
 * Controlled via `value`/`onValueChange` (arrays) or uncontrolled.
 */
export const Slider = forwardRef<
  React.ElementRef<typeof RadixSlider.Root>,
  SliderProps
>(({ className, ...rest }, ref) => (
  <RadixSlider.Root
    ref={ref}
    className={["slider", className ?? ""].filter(Boolean).join(" ")}
    {...rest}
  >
    <RadixSlider.Track className="slider__track">
      <RadixSlider.Range className="slider__range" />
    </RadixSlider.Track>
    <RadixSlider.Thumb className="slider__thumb" aria-label={rest["aria-label"]} />
  </RadixSlider.Root>
));
Slider.displayName = "Slider";
