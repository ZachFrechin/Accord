import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** Optional glyph/illustration shown above the title. */
  icon?: ReactNode;
  /** Primary message. */
  title: ReactNode;
  /** Optional supporting copy. */
  description?: ReactNode;
  /** Optional call-to-action (e.g. a Button). */
  action?: ReactNode;
}

/**
 * EmptyState — a centered placeholder for empty lists, zero results, and
 * first-run screens. Constrains its text to --measure for readable line length.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon">{icon}</div> : null}
      <div className="empty-state__title">{title}</div>
      {description ? (
        <p className="empty-state__desc">{description}</p>
      ) : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}
