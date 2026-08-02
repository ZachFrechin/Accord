import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  createThemeDocument,
  type ThemeBaseId,
  type ThemeDocument,
} from "../theme/themeDocument";

/** Shape of the theme store: the current document plus mutators. */
interface ThemeState {
  /** The active, persisted theme document. */
  document: ThemeDocument;
  /** Replace the whole document (e.g. importing a shared theme). */
  setDocument: (doc: ThemeDocument) => void;
  /** Switch the starting palette/base. */
  setBase: (base: ThemeBaseId) => void;
  /** Toggle between the built-in light and dark names. */
  toggleScheme: () => void;
  /** Set or clear a single semantic-token override. */
  setTokenOverride: (name: string, value: string | null) => void;
  /** Drop all token overrides, returning to the base palette. */
  resetOverrides: () => void;
}

/**
 * useThemeStore — persisted theme state (key "accord.theme.v1").
 *
 * Holds a single ThemeDocument. The ThemeProvider subscribes to `document` and
 * applies it to :root via applyTheme(); the store itself never touches the DOM.
 */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      document: createThemeDocument(),

      setDocument: (doc) => set({ document: doc }),

      setBase: (base) =>
        set((s) => ({ document: { ...s.document, base } })),

      toggleScheme: () =>
        set((s) => ({
          document: {
            ...s.document,
            name: s.document.name === "dark" ? "light" : "dark",
          },
        })),

      setTokenOverride: (name, value) =>
        set((s) => {
          const next = { ...s.document.tokenOverrides };
          if (value === null) delete next[name];
          else next[name] = value;
          return { document: { ...s.document, tokenOverrides: next } };
        }),

      resetOverrides: () =>
        set((s) => ({ document: { ...s.document, tokenOverrides: {} } })),
    }),
    {
      name: "accord.theme.v1",
      version: 2,
      // v2: Clay becomes the product default. Documents still on the old default
      // base ("atelier", untouched) adopt "clay"; explicit customizations
      // (overrides, motion, fonts, an intentionally different base) are kept.
      migrate: (persisted, from) => {
        const state = persisted as { document?: ThemeDocument } | undefined;
        if (from < 2 && state?.document && state.document.base === "atelier") {
          state.document = { ...state.document, base: "clay" };
        }
        return state as ThemeState;
      },
    },
  ),
);
