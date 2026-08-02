import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Visible label text. */
  label: ReactNode;
  /** Optional error message; presence flags the input as invalid. */
  error?: string;
  /** Optional helper text shown when there is no error. */
  hint?: string;
}

/**
 * Field — a labelled text input with inline validation messaging.
 *
 * Bundles <label>, <input>, and an error/hint region, wiring the ids for
 * accessibility (aria-describedby, aria-invalid). This is the canonical single
 * text-input control; use it instead of a bare <input>.
 */
export const Field = forwardRef<HTMLInputElement, FieldProps>(
  ({ label, error, hint, id, className, ...rest }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    const describedBy = error
      ? `${inputId}-error`
      : hint
        ? `${inputId}-hint`
        : undefined;

    return (
      <div className="field">
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          className={["input", className ?? ""].filter(Boolean).join(" ")}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
        />
        {error ? (
          <span id={`${inputId}-error`} className="field__error" role="alert">
            {error}
          </span>
        ) : hint ? (
          <span id={`${inputId}-hint`} className="field__hint">
            {hint}
          </span>
        ) : null}
      </div>
    );
  },
);
Field.displayName = "Field";
