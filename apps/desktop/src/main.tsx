import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AppRoot from "./AppRoot";
import { ThemeProvider } from "./theme/ThemeProvider";
import { ConfirmProvider, ToastProvider } from "./components/ui";
import { useLayoutStore } from "./stores/useLayoutStore";
import { useThemeStore } from "./stores/useThemeStore";
import { useInstanceStore } from "./stores/useInstanceStore";
import { hydrateSessions } from "./stores/useSessionStore";
import { hydrateSecureStore } from "./lib/secureStore";
import { hydrateDeviceIdentity } from "./lib/deviceIdentity";
import { applyLayout } from "./layout/applyLayout";
import { applyTheme } from "./theme/applyTheme";
import { applyCustomize, useCustomizeStore } from "./stores/useCustomizeStore";
import { isTauri } from "./lib/isTauri";
import "./styles/global.css";
import "./components/ui/ui.css";

/**
 * Apply persisted theme + layout to :root BEFORE React mounts, load the
 * persisted refresh tokens out of the secure backend, then seed the session
 * flags so the gate renders the right surface on the first frame (no flash of
 * onboarding for an already signed-in instance).
 */
async function bootstrap(): Promise<void> {
  // Expose the OS to CSS before the first frame — macOS pads the titlebar past
  // the native traffic lights (Overlay style). Tauri only: the browser dev
  // build has no window chrome to clear.
  if (isTauri()) {
    const ua = navigator.userAgent;
    document.documentElement.dataset.platform = ua.includes("Mac")
      ? "mac"
      : ua.includes("Win")
        ? "windows"
        : "linux";
  }

  const layout = useLayoutStore.getState();
  applyLayout({
    railVisible: layout.railVisible,
    asideVisible: layout.asideVisible,
    listWidth: layout.listWidth,
    asideWidth: layout.asideWidth,
    density: layout.density,
  });
  applyTheme(useThemeStore.getState().document);
  // Customization vars ride on top of the theme (accent/background/glass/…).
  applyCustomize(useCustomizeStore.getState());

  const instanceIds = useInstanceStore.getState().instances.map((i) => i.id);
  await Promise.all([hydrateSecureStore(instanceIds), hydrateDeviceIdentity(instanceIds)]);
  hydrateSessions(instanceIds);
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

// Theme/layout are already on :root (applied synchronously above the await), so
// the page background is themed; only the app UI waits for token hydration.
void bootstrap().then(() => {
  createRoot(rootEl).render(
    <StrictMode>
      <ThemeProvider>
        <ToastProvider>
          <ConfirmProvider>
            <AppRoot />
          </ConfirmProvider>
        </ToastProvider>
      </ThemeProvider>
    </StrictMode>,
  );
});
