import { create } from "zustand";
import { persist } from "zustand/middleware";
import { clampPanel, type Density } from "../layout/applyLayout";

/** Named layout presets that set several fields at once. */
export type LayoutPreset = "compact" | "comfort" | "focus" | "rail";

/** Persisted layout state + mutators. */
interface LayoutState {
  railVisible: boolean;
  asideVisible: boolean;
  listWidth: number;
  asideWidth: number;
  density: Density;
  preset: LayoutPreset;

  /** Show/hide the left rail (maskable region). */
  toggleRail: () => void;
  /** Show/hide the right aside (maskable region). */
  toggleAside: () => void;
  /** Set the conversation-list width (clamped to bounds). */
  setListWidth: (px: number) => void;
  /** Set the aside width (clamped to bounds). */
  setAsideWidth: (px: number) => void;
  /** Change UI density (drives real spacing via --density-scale). */
  setDensity: (density: Density) => void;
  /** Apply a named preset (sets visibility, widths, density together). */
  applyPreset: (preset: LayoutPreset) => void;
}

/** Concrete values each preset writes. */
const PRESETS: Record<
  LayoutPreset,
  Pick<
    LayoutState,
    "railVisible" | "asideVisible" | "listWidth" | "asideWidth" | "density"
  >
> = {
  compact: {
    railVisible: true,
    asideVisible: false,
    listWidth: 240,
    asideWidth: 300,
    density: "compact",
  },
  comfort: {
    railVisible: true,
    asideVisible: true,
    listWidth: 320,
    asideWidth: 340,
    density: "comfortable",
  },
  focus: {
    railVisible: false,
    asideVisible: false,
    listWidth: 288,
    asideWidth: 300,
    density: "cozy",
  },
  rail: {
    railVisible: true,
    asideVisible: false,
    listWidth: 260,
    asideWidth: 300,
    density: "cozy",
  },
};

/**
 * useLayoutStore — persisted shell layout (key "accord.layout.v1").
 *
 * Drives the CSS Grid shell in App.tsx. The store is the single source of truth;
 * App subscribes and calls applyLayout() to reflect changes onto :root.
 */
export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      railVisible: true,
      asideVisible: true,
      listWidth: 288,
      asideWidth: 300,
      density: "cozy",
      preset: "comfort",

      toggleRail: () => set((s) => ({ railVisible: !s.railVisible })),
      toggleAside: () => set((s) => ({ asideVisible: !s.asideVisible })),

      setListWidth: (px) => set({ listWidth: clampPanel("list", px) }),
      setAsideWidth: (px) => set({ asideWidth: clampPanel("aside", px) }),

      setDensity: (density) => set({ density }),

      applyPreset: (preset) => set({ ...PRESETS[preset], preset }),
    }),
    {
      name: "accord.layout.v1",
      version: 1,
    },
  ),
);
