/**
 * Layout application helper.
 *
 * Turns layout state (density + panel widths + visibility) into CSS custom
 * properties on :root. Density is REAL: it scales --density-scale, which every
 * --space-* token multiplies through calc(), so changing density genuinely
 * reflows padding/gaps rather than just swapping a class.
 */

export type Density = "compact" | "cozy" | "comfortable";

/** Multiplier applied to --density-scale for each density level. */
export const DENSITY_SCALE: Record<Density, number> = {
  compact: 0.85,
  cozy: 1,
  comfortable: 1.18,
};

/** Hard bounds for resizable panels (px), enforced by store + resize hook. */
export const PANEL_BOUNDS = {
  list: { min: 220, max: 440 },
  aside: { min: 240, max: 460 },
} as const;

/** The subset of layout state that maps directly onto CSS variables. */
export interface LayoutVars {
  railVisible: boolean;
  asideVisible: boolean;
  listWidth: number;
  asideWidth: number;
  density: Density;
}

/**
 * Write layout variables to a root element. Hidden regions collapse to a 0px
 * track so the CSS Grid template stays stable (no re-declaration of areas).
 *
 * @param vars  Current layout values.
 * @param root  Target element (defaults to document.documentElement).
 */
export function applyLayout(
  vars: LayoutVars,
  root: HTMLElement = document.documentElement,
): void {
  const style = root.style;
  style.setProperty("--density-scale", String(DENSITY_SCALE[vars.density]));
  style.setProperty("--rail-w", vars.railVisible ? "64px" : "0px");
  style.setProperty("--list-w", `${vars.listWidth}px`);
  style.setProperty(
    "--aside-w",
    vars.asideVisible ? `${vars.asideWidth}px` : "0px",
  );
  // Expose visibility as attributes so regions can hide their content/borders.
  root.setAttribute("data-rail", vars.railVisible ? "on" : "off");
  root.setAttribute("data-aside", vars.asideVisible ? "on" : "off");
}

/** Clamp a candidate width to the given panel's bounds. */
export function clampPanel(panel: keyof typeof PANEL_BOUNDS, px: number): number {
  const { min, max } = PANEL_BOUNDS[panel];
  return Math.min(max, Math.max(min, Math.round(px)));
}
