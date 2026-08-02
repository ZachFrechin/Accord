import { forwardRef, type ButtonHTMLAttributes } from "react";

/** Visual variants for Button. */
export type ButtonVariant = "primary" | "ghost" | "outline" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual treatment (defaults to "primary"). */
  variant?: ButtonVariant;
  /** Compact size. */
  size?: "sm" | "md";
}

/**
 * Button — the canonical action control.
 *
 * A thin wrapper over <button> that maps variant/size to token-driven classes.
 * It forwards refs and native props so it composes with Radix (asChild slots,
 * form submission) and the shared global focus outline.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className, type, ...rest }, ref) => {
    const classes = [
      "btn",
      `btn--${variant}`,
      size === "sm" ? "btn--sm" : "",
      className ?? "",
    ]
      .filter(Boolean)
      .join(" ");
    return <button ref={ref} type={type ?? "button"} className={classes} {...rest} />;
  },
);
Button.displayName = "Button";
