/**
 * accord:// deep links. The OS hands the URL to the running app (or launches
 * it — getCurrent covers the cold start; on Windows the single-instance plugin
 * forwards the second process's argv). One action for now:
 *
 *   accord://join?server=https://accord.example.com
 *     → opens the onboarding prefilled with that server URL, so an invitation
 *       link is all a newcomer needs.
 */

import { isTauri } from "./isTauri";
import { useUiStore } from "../stores/useUiStore";

let inited = false;

/** Install the deep-link listener (idempotent; no-op outside Tauri). */
export function initDeepLinks(): void {
  if (!isTauri() || inited) return;
  inited = true;
  void (async () => {
    try {
      const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
      const handle = (urls: string[] | null) => {
        for (const url of urls ?? []) route(url);
      };
      handle(await getCurrent().catch(() => null)); // link that launched the app
      await onOpenUrl(handle);
    } catch {
      /* plugin unavailable — deep links just don't resolve */
    }
  })();
}

function route(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== "accord:") return;
  // accord://join?… parses with host "join"; accord:join?… with pathname.
  const action = url.host || url.pathname.replace(/^\/+/, "");
  if (action === "join") {
    const server = url.searchParams.get("server") ?? "";
    if (!/^https?:\/\//i.test(server)) return; // only http(s) API bases
    useUiStore.getState().setPendingServerUrl(server);
    useUiStore.getState().openOnboarding();
  }
}
