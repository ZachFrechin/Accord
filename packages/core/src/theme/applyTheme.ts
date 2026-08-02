import {
  THEME_BASES,
  type ThemeDocument,
} from "./themeDocument";

/**
 * Translate a ThemeDocument into CSS custom properties on a root element.
 *
 * This is the ONE place that mutates :root for theming (the spec forbids a mega
 * effect scattered across components). It is idempotent and cheap: it sets the
 * base accent, then any explicit token overrides, then font stacks, and finally
 * flips `data-theme` for the light/dark token mapping in tokens.css.
 *
 * @param doc   The theme to apply.
 * @param root  Target element (defaults to document.documentElement).
 */
export function applyTheme(
  doc: ThemeDocument,
  root: HTMLElement = document.documentElement,
): void {
  const style = root.style;

  // 1. Seed the accent from the chosen base. tokens.css derives
  //    --accent-hover / --accent-soft from --accent via color-mix, so we only
  //    set the two accent primitives here.
  const base = THEME_BASES[doc.base] ?? THEME_BASES.atelier;
  style.setProperty("--accent", base.accent);
  // The dark mapping references --atelier-indigo-bright; override it too so the
  // base's dark accent is honored when data-theme resolves to dark.
  style.setProperty("--atelier-indigo", base.accent);
  style.setProperty("--atelier-indigo-bright", base.accentDark);

  // 2. Apply arbitrary semantic-token overrides. Keys are var names without the
  //    leading "--" (e.g. { "bg-app": "#101015" }).
  for (const [name, value] of Object.entries(doc.tokenOverrides)) {
    style.setProperty(`--${name}`, value);
  }

  // 3. Font-stack overrides, when present.
  if (doc.fonts.display) style.setProperty("--font-display", doc.fonts.display);
  if (doc.fonts.body) style.setProperty("--font-body", doc.fonts.body);
  if (doc.fonts.mono) style.setProperty("--font-mono", doc.fonts.mono);

  // 4. Light/dark selection. Only "light" | "dark" toggle the attribute; any
  //    other name leaves whatever the boot script set (defaults to dark).
  if (doc.name === "light" || doc.name === "dark") {
    root.setAttribute("data-theme", doc.name);
  }

  // 5. Motion profile — exposed as an attribute so CSS can opt out of motion.
  root.setAttribute("data-motion", doc.motion);
}

/**
 * Inline style object for previewing a single theme base in isolation (used by
 * the /design gallery to render primitives across all five bases without
 * touching :root).
 *
 * IMPORTANT — CSS custom-property resolution: a property whose value contains
 * `var(--accent)` (e.g. `--btn-primary-bg` or the color-mix `--accent-hover`) is
 * resolved on the element where it is DECLARED, then inherited as a fixed value.
 * Those tokens are declared on :root, so merely overriding `--accent` on a
 * scoped element would NOT re-tint them — buttons/inputs/focus would keep the
 * global accent (this is the bug this helper exists to avoid). So we re-declare
 * the whole accent-derived family here: on the scoped element their
 * `var(--accent)` / color-mix re-resolves against THIS base's accent. Mix ratios
 * mirror tokens.css so the preview matches the real theme exactly.
 */
export function baseAccentVars(
  baseId: keyof typeof THEME_BASES,
  scheme: "light" | "dark",
): Record<string, string> {
  const base = THEME_BASES[baseId] ?? THEME_BASES.atelier;
  const accent = scheme === "dark" ? base.accentDark : base.accent;
  const isDark = scheme === "dark";
  return {
    // Source of truth for this scope.
    "--accent": accent,
    "--atelier-indigo": base.accent,
    "--atelier-indigo-bright": base.accentDark,
    // Derived accent family — declared here so they re-resolve locally.
    "--accent-hover": isDark
      ? "color-mix(in srgb, var(--accent) 84%, var(--white))"
      : "color-mix(in srgb, var(--accent) 82%, var(--black))",
    "--accent-soft": isDark
      ? "color-mix(in srgb, var(--accent) 20%, transparent)"
      : "color-mix(in srgb, var(--accent) 14%, transparent)",
    "--focus-ring": "var(--accent)",
    // Accent-dependent component tokens (declared on :root otherwise).
    "--btn-primary-bg": "var(--accent)",
    "--btn-primary-bg-hover": "var(--accent-hover)",
    "--input-border-focus": "var(--accent)",
  };
}
