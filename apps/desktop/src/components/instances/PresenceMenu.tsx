/**
 * PresenceMenu — the account/presence panel shown in a popover from the rail
 * avatar (Discord-style user panel). For now it switches presence; profile
 * controls will grow here later. Selecting an option closes the popover.
 */

import * as RadixPopover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";

import type { PresenceStatus } from "../../realtime/wireSchema";
import { setPresenceStatus, setPresenceStatusText } from "../../stores/messagingActions";
import { usePresenceStore } from "../../stores/usePresenceStore";
import { Avatar } from "../messaging/Avatar";

const OPTIONS: { value: PresenceStatus; label: string }[] = [
  { value: "ONLINE", label: "En ligne" },
  { value: "AWAY", label: "Absent" },
  { value: "DND", label: "Ne pas déranger" },
  { value: "OFFLINE", label: "Invisible" },
];

export function PresenceMenu({
  name,
  subtitle,
  avatarUrl,
  onOpenSettings,
}: {
  name: string;
  subtitle?: string;
  /** Photo de profil (le menu n'affichait que les initiales sans elle). */
  avatarUrl?: string | null;
  onOpenSettings: () => void;
}) {
  const myStatus = usePresenceStore((s) => s.myStatus);
  const myStatusText = usePresenceStore((s) => s.myStatusText);
  const [draft, setDraft] = useState(myStatusText);
  // Optional auto-clear delay (minutes as string; "" = keep until changed).
  const [duration, setDuration] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Mirror external changes (restore on connect / another device) — but never
  // clobber an edit in progress (only when the input isn't focused).
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(myStatusText);
  }, [myStatusText]);
  const expiryOf = (d: string): string | null =>
    d ? new Date(Date.now() + parseInt(d, 10) * 60_000).toISOString() : null;
  const commit = () => {
    const next = draft.trim();
    if (next !== myStatusText) setPresenceStatusText(next, expiryOf(duration));
  };
  return (
    <div className="presence-menu">
      <div className="presence-menu__head">
        <Avatar name={name} size={40} presence={myStatus} src={avatarUrl} />
        <div className="presence-menu__id">
          <span className="presence-menu__name">{name}</span>
          {subtitle && <span className="presence-menu__sub">{subtitle}</span>}
        </div>
      </div>

      <div className="presence-menu__label">Statut</div>
      <div className="presence-menu__options" role="group" aria-label="Statut de présence">
        {OPTIONS.map((o) => (
          <RadixPopover.Close asChild key={o.value}>
            <button
              type="button"
              className="presence-menu__option"
              data-active={myStatus === o.value}
              aria-pressed={myStatus === o.value}
              onClick={() => setPresenceStatus(o.value)}
            >
              <span className="presence-menu__dot" data-status={o.value} />
              {o.label}
            </button>
          </RadixPopover.Close>
        ))}
      </div>

      <div className="presence-menu__label">Statut personnalisé</div>
      <input
        ref={inputRef}
        className="presence-menu__status-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Blur commits via onBlur — don't also call commit() here or it fires
          // twice (blur() dispatches focusout synchronously → a double WS send).
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        placeholder="Définir un statut…"
        maxLength={100}
        aria-label="Statut personnalisé"
      />
      <select
        className="presence-menu__duration"
        value={duration}
        aria-label="Effacer le statut après"
        onChange={(e) => {
          const d = e.target.value;
          setDuration(d);
          // Re-commit with the new expiry when a status is already set.
          if (draft.trim()) setPresenceStatusText(draft.trim(), expiryOf(d));
        }}
      >
        <option value="">Ne pas effacer</option>
        <option value="30">Effacer dans 30 min</option>
        <option value="60">Effacer dans 1 h</option>
        <option value="240">Effacer dans 4 h</option>
        <option value="1440">Effacer dans 24 h</option>
      </select>

      <div className="presence-menu__sep" />
      <RadixPopover.Close asChild>
        <button type="button" className="presence-menu__action" onClick={onOpenSettings}>
          Paramètres
        </button>
      </RadixPopover.Close>
    </div>
  );
}
