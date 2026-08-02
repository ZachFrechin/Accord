import type { CSSProperties } from "react";

export interface SkeletonProps {
  /** CSS width (e.g. "100%", 120). */
  width?: string | number;
  /** CSS height (e.g. "1em", 40). */
  height?: string | number;
  /** Border radius override (e.g. "50%" for avatars). */
  radius?: string;
}

/**
 * Skeleton — an animated loading placeholder.
 *
 * A shimmering block used while real content loads. Sized via width/height and
 * marked aria-hidden since it conveys no information to assistive tech.
 */
export function Skeleton({ width = "100%", height = "1em", radius }: SkeletonProps) {
  const style: CSSProperties = {
    width,
    height,
    ...(radius ? { borderRadius: radius } : null),
  };
  return <span className="skeleton" style={style} aria-hidden="true" />;
}
