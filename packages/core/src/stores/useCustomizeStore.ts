import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Background modes. Gradients are CSS; image/video come from IndexedDB. */
export type BgKind = "solid" | "aurora" | "ember" | "mesh" | "image" | "video";
export type AvatarShape = "circle" | "rounded" | "square";
export type MsgStyle = "bubbles" | "flat";
export type FontChoice = "manrope" | "grotesk" | "plex" | "mono";
export type NavSide = "left" | "right";
/** Independently glass-able surfaces. */
export type Region = "rail" | "list" | "main" | "members" | "composer" | "modal" | "card";

export const REGIONS: { key: Region; label: string }[] = [
  { key: "rail", label: "Serveurs" },
  { key: "list", label: "Conversations" },
  { key: "main", label: "Chat" },
  { key: "members", label: "Membres" },
  { key: "composer", label: "Composer" },
  { key: "modal", label: "Modales" },
  { key: "card", label: "Conteneurs" },
];

/** CSS backgrounds for the gradient presets (painted by <AppBackground/>). */
export const BG_GRADIENTS: Record<string, string> = {
  solid: "none",
  aurora: "linear-gradient(135deg, #0d2033 0%, #123a52 45%, #1f7a63 100%)",
  ember: "linear-gradient(135deg, #1c1210 0%, #5a231a 55%, #c05a2e 100%)",
  mesh:
    "radial-gradient(at 18% 22%, #15443c 0, transparent 55%)," +
    "radial-gradient(at 82% 26%, #1a2b54 0, transparent 55%)," +
    "radial-gradient(at 50% 84%, #123a2c 0, transparent 55%)",
};

const AVATAR_RADIUS: Record<AvatarShape, string> = {
  circle: "50%",
  rounded: "30%",
  square: "14%",
};
const FONT_STACKS: Record<FontChoice, string> = {
  manrope: '"Manrope", system-ui, -apple-system, sans-serif',
  grotesk: '"Space Grotesk", "Manrope", system-ui, sans-serif',
  plex: '"IBM Plex Sans", "Manrope", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
};

export interface CustomizeState {
  bgKind: BgKind;
  mediaType: "image" | "video" | null;
  /** Per-surface opacity (1 = opaque, lower = glassier). */
  alpha: Record<Region, number>;
  blur: number;
  accent: string;
  /** Primary text colour override; "" keeps the theme default. */
  textColor: string;
  radiusScale: number;
  avatarShape: AvatarShape;
  msgStyle: MsgStyle;
  font: FontChoice;
  baseSize: number;
  navSide: NavSide;
  /** Glass — accent tint mixed into frosted surfaces (0 = none). */
  glassTint: number;
  /** Glass — specular edge highlight on rounded surfaces. */
  glassEdge: boolean;
  /** Glass — subtle frost grain overlay. */
  glassGrain: boolean;
  /** Épaisseur (px) des séparateurs structurels (rail, listes, header, membres). */
  borderWidth: number;
  /** Couleurs libres par rôle de texte ("" = défaut du thème, appliqué clair ET sombre). */
  text2Color: string;
  text3Color: string;
  /** Graisse de base du texte (300-700). */
  textWeight: number;
  /** Graisse des titres/gras (500-900) — pilote --weight-bold/--weight-semibold. */
  headingWeight: number;
  /** Contour du texte : épaisseur (0 = aucun) et couleur. */
  textOutlineWidth: number;
  textOutlineColor: string;

  setBgKind: (k: BgKind) => void;
  setMedia: (t: "image" | "video") => void;
  clearMedia: () => void;
  setAlphaFor: (r: Region, a: number) => void;
  setAllAlpha: (a: number) => void;
  setBlur: (b: number) => void;
  setAccent: (hex: string) => void;
  setTextColor: (hex: string) => void;
  setRadius: (scale: number) => void;
  setAvatarShape: (s: AvatarShape) => void;
  setMsgStyle: (s: MsgStyle) => void;
  setFont: (f: FontChoice) => void;
  setBaseSize: (px: number) => void;
  setNavSide: (s: NavSide) => void;
  setGlassTint: (t: number) => void;
  setGlassEdge: (on: boolean) => void;
  setGlassGrain: (on: boolean) => void;
  setBorderWidth: (px: number) => void;
  setText2Color: (hex: string) => void;
  setText3Color: (hex: string) => void;
  setTextWeight: (w: number) => void;
  setHeadingWeight: (w: number) => void;
  setTextOutlineWidth: (px: number) => void;
  setTextOutlineColor: (hex: string) => void;
  applyGlassPreset: (preset: GlassPreset) => void;
  /** Bumped whenever the background media BLOB changes (same kind, new file) —
   * AppBackground re-reads the store on it. */
  mediaRev: number;
  bumpMediaRev: () => void;
  /** Applique un snapshot complet (personnalisation sauvegardée). */
  applySnapshot: (s: CustomizeSnapshot) => void;
  reset: () => void;
}

/** Les champs sérialisables d'une personnalisation (sans les actions). */
export interface CustomizeSnapshot {
  bgKind: BgKind;
  mediaType: "image" | "video" | null;
  alpha: Record<Region, number>;
  blur: number;
  accent: string;
  textColor: string;
  radiusScale: number;
  avatarShape: AvatarShape;
  msgStyle: MsgStyle;
  font: FontChoice;
  baseSize: number;
  navSide: NavSide;
  glassTint: number;
  glassEdge: boolean;
  glassGrain: boolean;
  borderWidth: number;
  text2Color: string;
  text3Color: string;
  textWeight: number;
  headingWeight: number;
  textOutlineWidth: number;
  textOutlineColor: string;
}

/** Capture l'état actuel en snapshot (pour la sauvegarde). */
export function snapshotCustomize(s: CustomizeState): CustomizeSnapshot {
  return {
    bgKind: s.bgKind,
    mediaType: s.mediaType,
    alpha: { ...s.alpha },
    blur: s.blur,
    accent: s.accent,
    textColor: s.textColor,
    radiusScale: s.radiusScale,
    avatarShape: s.avatarShape,
    msgStyle: s.msgStyle,
    font: s.font,
    baseSize: s.baseSize,
    navSide: s.navSide,
    glassTint: s.glassTint,
    glassEdge: s.glassEdge,
    glassGrain: s.glassGrain,
    borderWidth: s.borderWidth ?? 1,
    text2Color: s.text2Color ?? "",
    text3Color: s.text3Color ?? "",
    textWeight: s.textWeight ?? 400,
    headingWeight: s.headingWeight ?? 700,
    textOutlineWidth: s.textOutlineWidth ?? 0,
    textOutlineColor: s.textOutlineColor ?? "#000000",
  };
}

/** One-click glass looks (transparency + blur + tint + edge together). */
export type GlassPreset = "none" | "clear" | "frosted" | "tinted";
const GLASS_PRESETS: Record<GlassPreset, { alpha: number; blur: number; glassTint: number; glassEdge: boolean; glassGrain: boolean }> = {
  none: { alpha: 1, blur: 0, glassTint: 0, glassEdge: false, glassGrain: false },
  clear: { alpha: 0.32, blur: 20, glassTint: 0.06, glassEdge: true, glassGrain: false },
  frosted: { alpha: 0.55, blur: 14, glassTint: 0.16, glassEdge: true, glassGrain: true },
  tinted: { alpha: 0.42, blur: 16, glassTint: 0.6, glassEdge: true, glassGrain: true },
};

const fullAlpha = (): Record<Region, number> => ({
  rail: 1,
  list: 1,
  main: 1,
  members: 1,
  composer: 1,
  modal: 1,
  card: 1,
});

const DEFAULTS = {
  bgKind: "solid" as BgKind,
  mediaType: null as "image" | "video" | null,
  alpha: fullAlpha(),
  blur: 0,
  accent: "",
  textColor: "",
  radiusScale: 1,
  avatarShape: "circle" as AvatarShape,
  msgStyle: "bubbles" as MsgStyle,
  font: "manrope" as FontChoice,
  baseSize: 16,
  navSide: "left" as NavSide,
  glassTint: 0,
  glassEdge: false,
  glassGrain: false,
  borderWidth: 1,
  text2Color: "",
  text3Color: "",
  textWeight: 400,
  headingWeight: 700,
  textOutlineWidth: 0,
  textOutlineColor: "#000000",
};

/** Write the customization vars to :root. Runs after applyTheme so its overrides
 * win; called on every change and at bootstrap. */
export function applyCustomize(s: CustomizeState | typeof DEFAULTS): void {
  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  // Accessibility: prefers-reduced-transparency falls back to solid surfaces, no
  // blur, no tint — the glass is a pleasure, never a legibility barrier.
  const reduceTransp = window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
  const a = reduceTransp ? fullAlpha() : (s.alpha ?? fullAlpha());
  const blur = reduceTransp ? 0 : s.blur;
  set("--alpha-rail", String(a.rail));
  set("--alpha-list", String(a.list));
  set("--alpha-main", String(a.main));
  set("--alpha-members", String(a.members));
  set("--alpha-composer", String(a.composer));
  set("--alpha-modal", String(a.modal));
  // Conteneurs internes (héro du chat, cartes Réglages/Amis/Admin, classement) :
  // transparence indépendante des régions.
  set("--alpha-card", String(a.card ?? 1));
  // Séparateurs structurels réglables (0 = invisibles).
  set("--shell-border-w", `${s.borderWidth ?? 1}px`);
  set("--ui-blur", `${blur}px`);
  // Depth: the rail blurs less, modals more, so layering reads by blur not just border.
  set("--blur-rail", `${(blur * 0.55).toFixed(1)}px`);
  set("--blur-modal", `${(blur * 1.5).toFixed(1)}px`);
  // Glass treatments: accent tint mixed into frosted surfaces + a matching saturation
  // boost; edge highlight + grain toggled via data-attributes (see App.css).
  const glassTint = reduceTransp ? 0 : (s.glassTint ?? 0);
  set("--glass-tint", String(glassTint));
  set("--glass-sat", `${(100 + glassTint * 90).toFixed(0)}%`);
  root.dataset.glassEdge = !reduceTransp && s.glassEdge ? "on" : "off";
  root.dataset.glassGrain = !reduceTransp && s.glassGrain ? "on" : "off";
  set("--app-bg-gradient", BG_GRADIENTS[s.bgKind] ?? "none");
  set("--ui-radius-scale", String(s.radiusScale));
  set("--avatar-radius", AVATAR_RADIUS[s.avatarShape]);
  set("--font-body", FONT_STACKS[s.font]);
  set("--root-fs", `${s.baseSize}px`);
  if (s.msgStyle === "flat") {
    set("--msg-bubble-bg", "transparent");
    set("--msg-bubble-border", "transparent");
  } else {
    root.style.removeProperty("--msg-bubble-bg");
    root.style.removeProperty("--msg-bubble-border");
  }
  root.dataset.msg = s.msgStyle; // flat mode strips the whole container (see messaging.css)
  if (s.accent) set("--accent", s.accent);
  else root.style.removeProperty("--accent");
  // Couleurs de texte par rôle — liberté totale demandée : appliquées dans les
  // DEUX schémas (la lisibilité devient la responsabilité du réglage).
  if (s.textColor) set("--text-1", s.textColor);
  else root.style.removeProperty("--text-1");
  if (s.text2Color) set("--text-2", s.text2Color);
  else root.style.removeProperty("--text-2");
  if (s.text3Color) set("--text-3", s.text3Color);
  else root.style.removeProperty("--text-3");
  // Graisses : base du corps + gras/titres (pilote les tokens de poids).
  set("--weight-user-base", String(s.textWeight ?? 400));
  const hw = s.headingWeight ?? 700;
  if (hw !== 700) {
    set("--weight-bold", String(hw));
    set("--weight-semibold", String(Math.max(500, hw - 100)));
  } else {
    root.style.removeProperty("--weight-bold");
    root.style.removeProperty("--weight-semibold");
  }
  // Contour du texte (text-stroke hérité depuis body, voir global.css).
  const strokeW = s.textOutlineWidth ?? 0;
  if (strokeW > 0) {
    set("--text-stroke-w", `${strokeW}px`);
    set("--text-stroke-c", s.textOutlineColor || "#000000");
    root.dataset.textStroke = "on";
  } else {
    root.dataset.textStroke = "off";
  }
  root.dataset.bg = s.bgKind;
  root.dataset.nav = s.navSide;
}

export const useCustomizeStore = create<CustomizeState>()(
  persist(
    (set, get) => {
      const apply = () => applyCustomize(get());
      const patch = (p: Partial<CustomizeState>) => {
        set(p as CustomizeState);
        apply();
      };
      return {
        ...DEFAULTS,
        setBgKind: (bgKind) => patch({ bgKind }),
        setMedia: (mediaType) => patch({ mediaType, bgKind: mediaType }),
        clearMedia: () => patch({ mediaType: null, bgKind: "solid" }),
        setAlphaFor: (r, v) => patch({ alpha: { ...get().alpha, [r]: v } }),
        setAllAlpha: (v) =>
          patch({
            alpha: { rail: v, list: v, main: v, members: v, composer: v, modal: v, card: v },
          }),
        setBlur: (blur) => patch({ blur }),
        setAccent: (accent) => patch({ accent }),
        setTextColor: (textColor) => patch({ textColor }),
        setRadius: (radiusScale) => patch({ radiusScale }),
        setAvatarShape: (avatarShape) => patch({ avatarShape }),
        setMsgStyle: (msgStyle) => patch({ msgStyle }),
        setFont: (font) => patch({ font }),
        setBaseSize: (baseSize) => patch({ baseSize }),
        setNavSide: (navSide) => patch({ navSide }),
        setGlassTint: (glassTint) => patch({ glassTint }),
        setGlassEdge: (glassEdge) => patch({ glassEdge }),
        setGlassGrain: (glassGrain) => patch({ glassGrain }),
        setBorderWidth: (borderWidth) => patch({ borderWidth }),
        setText2Color: (text2Color) => patch({ text2Color }),
        setText3Color: (text3Color) => patch({ text3Color }),
        setTextWeight: (textWeight) => patch({ textWeight }),
        setHeadingWeight: (headingWeight) => patch({ headingWeight }),
        setTextOutlineWidth: (textOutlineWidth) => patch({ textOutlineWidth }),
        setTextOutlineColor: (textOutlineColor) => patch({ textOutlineColor }),
        mediaRev: 0,
        bumpMediaRev: () => patch({ mediaRev: get().mediaRev + 1 }),
        applySnapshot: (s) => patch({ ...s, mediaRev: get().mediaRev + 1 }),
        applyGlassPreset: (preset) => {
          const g = GLASS_PRESETS[preset];
          patch({
            alpha: { rail: g.alpha, list: g.alpha, main: g.alpha, members: g.alpha, composer: g.alpha, modal: g.alpha, card: g.alpha },
            blur: g.blur,
            glassTint: g.glassTint,
            glassEdge: g.glassEdge,
            glassGrain: g.glassGrain,
          });
        },
        reset: () => {
          set({ ...DEFAULTS, alpha: fullAlpha() });
          apply();
        },
      };
    },
    {
      name: "accord.customize.v1",
      version: 3,
      migrate: (persisted) => {
        // v1 had a single surfaceAlpha; spread it across the new per-region map.
        const s = persisted as Partial<CustomizeState> & { surfaceAlpha?: number };
        if (s && !s.alpha) {
          const v = typeof s.surfaceAlpha === "number" ? s.surfaceAlpha : 1;
          s.alpha = { rail: v, list: v, main: v, members: v, composer: v, modal: v, card: v };
        }
        // v2 → v3 : le canal « Conteneurs » apparaît (défaut opaque).
        if (s?.alpha && typeof s.alpha.card !== "number") s.alpha.card = 1;
        return s as CustomizeState;
      },
      onRehydrateStorage: () => (state) => {
        if (state) applyCustomize(state);
      },
    },
  ),
);
