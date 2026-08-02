import { useId } from "react";

export interface ColorFieldProps {
  /** Visible label. */
  label: string;
  /** Current color as a hex string (#rrggbb). */
  value: string;
  /** Called with the new hex value. */
  onChange: (value: string) => void;
}

/**
 * ColorField — a labelled color picker with a hex readout.
 *
 * Wraps the native <input type="color"> (which gives us the OS picker for free)
 * and shows the current hex value beside the swatch. Used by the theming UI to
 * edit token overrides.
 */
export function ColorField({ label, value, onChange }: ColorFieldProps) {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="color-field">
        <input
          id={id}
          type="color"
          className="color-field__swatch"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="color-field__value">{value}</span>
      </div>
    </div>
  );
}
