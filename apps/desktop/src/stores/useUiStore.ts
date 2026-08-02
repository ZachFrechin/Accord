/** Transient UI state (not persisted): overlays that more than one place opens. */

import { create } from "zustand";

interface UiState {
  /** Onboarding flow (to add another instance). */
  onboardingOpen: boolean;
  openOnboarding: () => void;
  closeOnboarding: () => void;
  /** Customize (appearance) panel. */
  customizeOpen: boolean;
  openCustomize: () => void;
  setCustomizeOpen: (open: boolean) => void;
  /** Command palette (⌘K). */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  /** Keyboard-shortcuts cheatsheet (⌘/). */
  shortcutsOpen: boolean;
  openShortcuts: () => void;
  setShortcutsOpen: (open: boolean) => void;
  /** Message id to scroll to + flash after a search result opens its conversation. */
  searchScrollTo: string | null;
  setSearchScrollTo: (messageId: string | null) => void;
  /** Server URL carried by an accord://join deep link — the onboarding drains it. */
  pendingServerUrl: string | null;
  setPendingServerUrl: (url: string | null) => void;
  /** Message id asked to enter inline-edit mode (↑ in an empty composer). */
  editRequestId: string | null;
  setEditRequestId: (messageId: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  onboardingOpen: false,
  openOnboarding: () => set({ onboardingOpen: true }),
  closeOnboarding: () => set({ onboardingOpen: false }),
  customizeOpen: false,
  openCustomize: () => set({ customizeOpen: true }),
  setCustomizeOpen: (customizeOpen) => set({ customizeOpen }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  shortcutsOpen: false,
  openShortcuts: () => set({ shortcutsOpen: true }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  searchScrollTo: null,
  setSearchScrollTo: (searchScrollTo) => set({ searchScrollTo }),
  pendingServerUrl: null,
  setPendingServerUrl: (pendingServerUrl) => set({ pendingServerUrl }),
  editRequestId: null,
  setEditRequestId: (editRequestId) => set({ editRequestId }),
}));
