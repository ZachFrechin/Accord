/**
 * Theme document model.
 *
 * A ThemeDocument is the serializable description of a user's theme. It is what
 * useThemeStore persists and what the ThemeProvider turns into CSS custom
 * properties on :root. Keeping it a plain, versioned document (rather than
 * imperative style calls) means themes can be exported, shared, and migrated.
 */

/** Motion profile — lets users dampen animation without OS-level settings. */
export type MotionProfile = "standard" | "reduced";

/**
 * A theme "base" is a starting palette. The five bases are what the /design
 * gallery renders every primitive against. `base` seeds the semantic --accent;
 * `tokenOverrides` then layers arbitrary per-token tweaks on top.
 */
export type ThemeBaseId =
  | "clay"
  | "atelier"
  | "phosphor"
  | "ember"
  | "graphite"
  | "orchid";

/** Optional per-family font overrides (CSS font-family stacks). */
export interface ThemeFonts {
  display?: string;
  body?: string;
  mono?: string;
}

/** The persisted, versioned theme description. */
export interface ThemeDocument {
  /** Bumped when the shape changes so the store can migrate old payloads. */
  schemaVersion: 1;
  /** Human label / color-scheme hint ("light" | "dark" | custom). */
  name: string;
  /** Starting palette. */
  base: ThemeBaseId;
  /** Arbitrary semantic-token overrides, keyed by CSS var name w/o leading --. */
  tokenOverrides: Record<string, string>;
  /** Animation intensity. */
  motion: MotionProfile;
  /** Optional font-stack overrides. */
  fonts: ThemeFonts;
}

/** Describes one selectable base: its accent in light and dark contexts. */
export interface ThemeBaseSpec {
  id: ThemeBaseId;
  label: string;
  /** Accent used on light surfaces. */
  accent: string;
  /** Accent used on dark surfaces (brighter for contrast). */
  accentDark: string;
}

/**
 * The five theme bases. `atelier` is the product identity; the rest re-tint the
 * accent so the gallery can show each primitive across the full range.
 */
export const THEME_BASES: Record<ThemeBaseId, ThemeBaseSpec> = {
  clay: {
    id: "clay",
    label: "Clay",
    accent: "#3DDC97",
    accentDark: "#3DDC97",
  },
  atelier: {
    id: "atelier",
    label: "Atelier",
    accent: "#5b6cff",
    accentDark: "#7c8cff",
  },
  phosphor: {
    id: "phosphor",
    label: "Phosphor",
    accent: "#2f9e57",
    accentDark: "#5cb574",
  },
  ember: {
    id: "ember",
    label: "Ember",
    accent: "#c6892f",
    accentDark: "#d9a949",
  },
  graphite: {
    id: "graphite",
    label: "Graphite",
    accent: "#5a6172",
    accentDark: "#8b93a7",
  },
  orchid: {
    id: "orchid",
    label: "Orchid",
    accent: "#9a4fd6",
    accentDark: "#b579e6",
  },
};

/** Ordered list of bases — the gallery iterates this to keep a stable order. */
export const THEME_BASE_ORDER: ThemeBaseId[] = [
  "clay",
  "atelier",
  "phosphor",
  "ember",
  "graphite",
  "orchid",
];

/**
 * Build a fresh, valid ThemeDocument. Callers can override any field; the rest
 * fall back to safe defaults (Atelier base, standard motion, no overrides).
 */
export function createThemeDocument(
  partial: Partial<ThemeDocument> = {},
): ThemeDocument {
  return {
    schemaVersion: 1,
    name: "dark",
    base: "clay",
    tokenOverrides: {},
    motion: "standard",
    fonts: {},
    ...partial,
  };
}
