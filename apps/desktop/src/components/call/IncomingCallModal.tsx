/**
 * Incoming-call prompt (Phase 4 Lot 3). Raised globally when a CALL_RING arrives:
 * shows the caller and Accept / Decline. Accept joins the same call room; Decline
 * signals the caller (CALL_END). Dismisses on CALL_END if the caller cancels.
 */

import { useEffect } from "react";

import { getRingtoneFile } from "../../lib/ringtoneFiles";
import { startRinging, startRingingBlob } from "../../lib/ringtones";
import { useCallStore } from "../../stores/useCallStore";
import { useMediaSettingsStore } from "../../stores/useMediaSettingsStore";
import { usePresenceStore } from "../../stores/usePresenceStore";
import { Avatar } from "../messaging/Avatar";
import { Icon } from "../ui";
import "./call.css";

export function IncomingCallModal() {
  const incoming = useCallStore((s) => s.incoming);
  const accept = useCallStore((s) => s.acceptIncoming);
  const decline = useCallStore((s) => s.declineIncoming);

  // Ring while the prompt is up — the contact's override wins, DND is silent.
  // Keyed on callId so a new ring restarts cleanly; stop() runs on
  // accept/decline/cancel (incoming cleared) and on unmount.
  const callId = incoming?.callId ?? null;
  const from = incoming?.from ?? null;
  useEffect(() => {
    if (!callId || !from) return;
    if (usePresenceStore.getState().myStatus === "DND") return;
    const media = useMediaSettingsStore.getState();
    const tone = media.contactRingtones[from] ?? media.ringtone;
    let stop: (() => void) | null = null;
    let cancelled = false;
    if (tone === "custom") {
      // The contact's own audio file; falls back to the default synth if the
      // file vanished from IndexedDB.
      void getRingtoneFile(from).then((f) => {
        if (cancelled) return;
        stop = f
          ? startRingingBlob(f.blob, media.ringVolume)
          : startRinging(media.ringtone, media.ringVolume);
      });
    } else {
      stop = startRinging(tone, media.ringVolume);
    }
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [callId, from]);

  if (!incoming) return null;

  return (
    <div className="incoming-call" role="dialog" aria-label="Appel entrant">
      <span className="incoming-call__avatar">
        <Avatar name={incoming.fromName} size={48} />
      </span>
      <div className="incoming-call__text">
        <span className="incoming-call__name">{incoming.fromName}</span>
        <span className="incoming-call__sub">
          Appel {incoming.media === "video" ? "vidéo" : "vocal"} entrant…
        </span>
      </div>
      <div className="incoming-call__actions">
        <button
          type="button"
          className="incoming-call__btn incoming-call__decline"
          onClick={decline}
          aria-label="Refuser"
          title="Refuser"
        >
          <Icon name="phone" size={18} />
        </button>
        <button
          type="button"
          className="incoming-call__btn incoming-call__accept"
          onClick={accept}
          aria-label="Accepter"
          title="Accepter"
        >
          <Icon name="phone" size={18} />
        </button>
      </div>
    </div>
  );
}
