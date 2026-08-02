import {
  forwardRef,
  useId,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

export interface TextAreaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Optional visible label. */
  label?: ReactNode;
  /** Optional error message; flags the control invalid. */
  error?: string;
}

/**
 * TextArea — a multi-line text control matching Field's look and semantics.
 *
 * Optionally renders a label and error message with the correct id wiring. Used
 * for message composers, descriptions, and any free-form multi-line input.
 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ label, error, id, className, ...rest }, ref) => {
    const autoId = useId();
    const fieldId = id ?? autoId;
    const control = (
      <textarea
        ref={ref}
        id={fieldId}
        className={["textarea", className ?? ""].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        {...rest}
      />
    );

    if (!label && !error) return control;

    return (
      <div className="field">
        {label ? (
          <label className="field__label" htmlFor={fieldId}>
            {label}
          </label>
        ) : null}
        {control}
        {error ? (
          <span id={`${fieldId}-error`} className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    );
  },
);
TextArea.displayName = "TextArea";
