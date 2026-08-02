import { useEffect, type ReactNode } from "react";
import { useThemeStore } from "../stores/useThemeStore";
import { applyTheme } from "./applyTheme";
import { applyCustomize, useCustomizeStore } from "../stores/useCustomizeStore";

/**
 * ThemeProvider — bridges the persisted theme document to the DOM.
 *
 * It subscribes to the theme store and, whenever the document changes, calls the
 * single applyTheme() helper to write CSS variables + data-theme onto :root. It
 * then re-applies the customization layer (accent, glass, fonts…) on top, since
 * applyTheme resets shared vars like --accent that the user may have overridden.
 * There is no React context here on purpose: components read tokens through CSS.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const document = useThemeStore((s) => s.document);
  const customize = useCustomizeStore();

  useEffect(() => {
    applyTheme(document);
    applyCustomize(useCustomizeStore.getState());
  }, [document, customize]);

  return <>{children}</>;
}
