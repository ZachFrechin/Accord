/**
 * Desktop notifications. Inside Tauri they go through our native module
 * (src-tauri/src/notifications.rs): the OS attributes them to Accord itself —
 * which is what puts the app in the system notification settings — and a click
 * carries the conversation id back to us (see the listener in App.tsx). In a
 * plain browser (dev) we fall back to the web Notification API with its
 * per-notification onClick. Message previews are decrypted client-side — the
 * server never sees them — so what we show here never leaves the device.
 */

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "./isTauri";

export interface ShowNotificationOptions {
  /** Clicking the notification opens this conversation (native path). */
  conversationId?: string;
  /** Web-only click handler (the native path routes through the Tauri event). */
  onClick?: () => void;
}

export function notificationsSupported(): boolean {
  if (isTauri()) return true;
  return typeof window !== "undefined" && "Notification" in window;
}

/** Current permission state (async because the native side has to be asked). */
export async function getNotificationPermission(): Promise<NotificationPermission> {
  if (isTauri()) {
    try {
      return (await invoke<string>("notif_permission_state")) as NotificationPermission;
    } catch {
      return "denied";
    }
  }
  return notificationsSupported() ? Notification.permission : "denied";
}

/** Ask for permission (must be called from a user gesture). Returns whether granted. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invoke<boolean>("notif_request_permission");
    } catch {
      return false;
    }
  }
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** Show a notification if permission allows. */
export function showNotification(
  title: string,
  body: string,
  opts?: ShowNotificationOptions,
): void {
  if (isTauri()) {
    void invoke("notif_show", {
      title,
      body,
      conversationId: opts?.conversationId ?? null,
    }).catch(() => {
      /* native layer unavailable — nothing sensible to do */
    });
    return;
  }
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag: title });
    n.onclick = () => {
      window.focus();
      opts?.onClick?.();
      n.close();
    };
  } catch {
    /* some webviews throw on construction — ignore */
  }
}
