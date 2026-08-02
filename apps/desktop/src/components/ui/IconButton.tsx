import { forwardRef, type ButtonHTMLAttributes } from "react";

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon buttons have no text, so they must be labelled. */
  "aria-label": string;
  /** "sm" aligns with size="sm" Buttons; default matches --btn-height. */
  size?: "sm" | "md";
}

/**
 * IconButton — a square, icon-only button.
 *
 * Enforces an aria-label at the type level (icon-only controls are invisible to
 * screen readers otherwise). Supports aria-pressed toggling via CSS. Children
 * are the icon glyph/SVG.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, type, size = "md", ...rest }, ref) => {
    const classes = ["icon-btn", size === "sm" ? "icon-btn--sm" : "", className ?? ""]
      .filter(Boolean)
      .join(" ");
    return <button ref={ref} type={type ?? "button"} className={classes} {...rest} />;
  },
);
IconButton.displayName = "IconButton";
