/**
 * Conversation pop-out: a secondary Tauri window loading the app with
 * `?popout=<conversationId>` — AppRoot then renders a minimal shell (just the
 * chat) instead of the full three-pane layout. One window per conversation
 * (stable label); re-invoking focuses the existing one. Both windows run in
 * the SAME process, so the native MLS engine and its per-group locks are
 * shared — only the per-window JS stores are independent.
 */

import { isTauri } from "./isTauri";

/** The conversation this WINDOW was popped out for (null in the main window). */
export function popoutConversationId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("popout");
}

export async function openConversationPopout(
  conversationId: string,
  title: string,
): Promise<void> {
  if (!isTauri()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = `popout-${conversationId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 24)}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow(label, {
    url: `/?popout=${encodeURIComponent(conversationId)}`,
    title,
    width: 760,
    height: 640,
    minWidth: 480,
    minHeight: 400,
  });
}

/** Marker inside a pop-out viewer's DEVICE id: such connections are call
 * SPECTATORS — filtered out of rosters, never ringing, never publishing. */
export const VIEWER_MARK = "~view~";

/** The call tile this WINDOW views (null in the main window). */
export function callViewParams(): { conversationId: string; tile: string } | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const conversationId = q.get("callview");
  const tile = q.get("tile");
  return conversationId && tile ? { conversationId, tile } : null;
}

/** Open a call tile (a camera or a screen share) in its own window. One window
 * per tile — several streams = several windows. The window joins the call as a
 * SPECTATOR device (video only; the audio stays in the main window). */
export async function openCallTilePopout(
  conversationId: string,
  tile: string,
  title: string,
): Promise<void> {
  if (!isTauri()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = `callview-${(conversationId + "-" + tile).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 48)}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow(label, {
    url: `/?callview=${encodeURIComponent(conversationId)}&tile=${encodeURIComponent(tile)}`,
    title,
    width: 960,
    height: 580,
    minWidth: 420,
    minHeight: 280,
  });
}
