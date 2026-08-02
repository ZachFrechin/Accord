/** Keyboard-shortcuts cheatsheet (⌘/) — the discoverability layer for the
 * keyboard-first navigation. Opened from useUiStore or the command palette. */

import { Dialog } from "../ui";
import { useUiStore } from "../../stores/useUiStore";

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? "⌘" : "Ctrl";

const GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: "Général",
    items: [
      { keys: [MOD, "K"], label: "Palette de commandes" },
      { keys: [MOD, "/"], label: "Afficher cette aide" },
      { keys: [MOD, ","], label: "Ouvrir les réglages" },
      { keys: ["Esc"], label: "Fermer un panneau" },
      { keys: ["Alt", "↑/↓"], label: "Conversation précédente / suivante" },
      { keys: ["Alt", "⇧", "↓"], label: "Prochaine conversation non lue" },
      { keys: ["↑"], label: "Modifier son dernier message (champ vide)" },
    ],
  },
  {
    title: "Palette de commandes",
    items: [
      { keys: ["↑", "↓"], label: "Naviguer" },
      { keys: ["↵"], label: "Ouvrir / lancer" },
    ],
  },
];

export function ShortcutsCheatsheet() {
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Raccourcis clavier"
      description="Naviguez Accord sans quitter le clavier."
    >
      <div className="shortcuts">
        {GROUPS.map((g) => (
          <div className="shortcuts__group" key={g.title}>
            <div className="shortcuts__title">{g.title}</div>
            {g.items.map((it) => (
              <div className="shortcuts__row" key={it.label}>
                <span>{it.label}</span>
                <span className="shortcuts__keys">
                  {it.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
