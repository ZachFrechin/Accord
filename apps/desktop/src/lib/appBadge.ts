/**
 * App-icon unread badge. macOS/Linux get the native dock badge (app-wide);
 * Windows gets a taskbar overlay icon with the count drawn on a canvas. Both
 * calls are attempted and the unsupported one fails silently, so there is no
 * platform sniffing. Counts follow the ACTIVE instance's conversations (other
 * instances' data isn't loaded while inactive). No-ops outside Tauri.
 */

import { isTauri } from "./isTauri";
import { useConversationsStore } from "../stores/useConversationsStore";

let last = -1;
let inited = false;

/** Subscribe the badge to the conversations store (idempotent). */
export function initAppBadge(): void {
  if (!isTauri() || inited) return;
  inited = true;
  const total = (): number =>
    useConversationsStore
      .getState()
      .conversations.reduce((sum, c) => sum + (c.unread || 0), 0);
  useConversationsStore.subscribe(() => void syncAppBadge(total()));
  void syncAppBadge(total());
}

async function syncAppBadge(count: number): Promise<void> {
  if (count === last) return;
  last = count;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    // Dock badge (macOS/Linux) — undefined clears it. Rejects on Windows.
    void win.setBadgeCount(count > 0 ? count : undefined).catch(() => {});
    // Taskbar overlay (Windows only) — rejects elsewhere.
    if (count > 0) {
      const icon = await drawOverlay(count);
      void win.setOverlayIcon(icon).catch(() => {});
    } else {
      void win.setOverlayIcon(undefined).catch(() => {});
    }
  } catch {
    /* API unavailable — never let the badge break messaging flows */
  }
}

/** A red bubble with the count, as PNG bytes (32×32, drawn in the webview). */
function drawOverlay(count: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("canvas 2d unavailable"));
  ctx.fillStyle = "#e5484d";
  ctx.beginPath();
  ctx.arc(16, 16, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${count > 9 ? 15 : 18}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(count > 99 ? "99+" : String(count), 16, 17);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("toBlob failed"));
      void blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
    }, "image/png");
  });
}
