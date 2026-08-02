/**
 * EmojiPicker — the composer's full picker (the message menu keeps its own
 * quick-reaction grid). Curated set, category sections in one scroll list,
 * multi-pick friendly: picking inserts at the caret and the popover STAYS open
 * (outside click / Esc closes). Emoji are user CONTENT here — the SVG-only rule
 * applies to UI chrome, and the category labels are text for that reason.
 */

import * as RadixPopover from "@radix-ui/react-popover";
import type { ReactNode } from "react";

const CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: "Smileys",
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "🙂", "😉", "😊", "😇",
      "🥰", "😍", "🤩", "😘", "😗", "😚", "😋", "😛", "😜", "🤪", "😝", "🤑",
      "🤗", "🤭", "🤫", "🤔", "🫡", "🤐", "😐", "😑", "😶", "😏", "😒", "🙄",
      "😬", "🤥", "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮",
      "🥵", "🥶", "🥴", "😵", "🤯", "🤠", "🥳", "🥸", "😎", "🤓", "🧐", "😕",
      "😟", "🙁", "😮", "😯", "😲", "😳", "🥺", "😦", "😧", "😨", "😰", "😥",
      "😢", "😭", "😱", "😖", "😣", "😞", "😓", "😩", "😫", "🥱", "😤", "😡",
      "😠", "🤬", "😈", "👿", "💀", "☠️", "💩", "🤡", "👻", "👽", "🤖", "😺",
    ],
  },
  {
    label: "Gestes",
    emojis: [
      "👋", "🤚", "🖐️", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🫰", "🤟",
      "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛",
      "🤜", "👏", "🙌", "🫶", "👐", "🤲", "🤝", "🙏", "💪", "🦾", "🖕", "✍️",
    ],
  },
  {
    label: "Cœurs & symboles",
    emojis: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❤️‍🔥", "❣️",
      "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💯", "💢", "💥", "💫", "💦",
      "💨", "🕳️", "💣", "💬", "💤", "✨", "⭐", "🌟", "⚡", "🔥", "🎉", "🎊",
      "✅", "❌", "❓", "❗", "⚠️", "🚫", "♻️", "🔞", "📌", "🔒", "🔑", "🏆",
    ],
  },
  {
    label: "Nature",
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮",
      "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🦆", "🦅", "🦉", "🐺", "🐗", "🐴",
      "🦄", "🐝", "🦋", "🐌", "🐞", "🐜", "🕷️", "🐢", "🐍", "🦖", "🐙", "🦑",
      "🦀", "🐡", "🐬", "🐳", "🦈", "🌵", "🌲", "🌴", "🍀", "🌸", "🌻", "🌙",
      "🌈", "☀️", "☁️", "🌧️", "⛈️", "❄️", "🌊", "💧",
    ],
  },
  {
    label: "Miam",
    emojis: [
      "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍒", "🍑",
      "🥭", "🍍", "🥥", "🥝", "🍅", "🥑", "🥦", "🥕", "🌽", "🌶️", "🥐", "🍞",
      "🧀", "🥚", "🍳", "🥓", "🥩", "🍗", "🌭", "🍔", "🍟", "🍕", "🌮", "🌯",
      "🥗", "🍝", "🍜", "🍣", "🍤", "🍙", "🍚", "🍰", "🎂", "🧁", "🍩", "🍪",
      "🍫", "🍬", "🍿", "☕", "🍵", "🧃", "🥤", "🍺", "🍷", "🥂", "🍾", "🧊",
    ],
  },
  {
    label: "Objets & activités",
    emojis: [
      "⚽", "🏀", "🏈", "🎾", "🏐", "🎱", "🏓", "🥊", "🎮", "🕹️", "🎲", "🧩",
      "🎯", "🎳", "🎸", "🎹", "🥁", "🎺", "🎻", "🎤", "🎧", "🎬", "🎨", "📸",
      "💻", "🖥️", "⌨️", "🖱️", "📱", "🔋", "💡", "🔦", "🛠️", "🔧", "⚙️", "🧲",
      "💎", "💰", "💸", "🪙", "📦", "📚", "📖", "✏️", "📝", "📅", "⏰", "⌛",
      "🚀", "✈️", "🚗", "🏎️", "🚲", "🏠", "🏖️", "🗻", "🎁", "🎈", "🪩", "🧸",
    ],
  },
];

export function EmojiPicker({
  trigger,
  onPick,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  onPick: (emoji: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className="popover__content emoji-picker emoji-picker--full"
          side="top"
          align="end"
          sideOffset={8}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Multi-pick: inserting refocuses the textarea, which must not be
          // read as leaving the popover. Pointer interactions outside still close.
          onFocusOutside={(e) => e.preventDefault()}
        >
          <div className="emoji-picker__scroll">
            {CATEGORIES.map((cat) => (
              <section key={cat.label} className="emoji-picker__section">
                <div className="emoji-picker__title">{cat.label}</div>
                <div className="emoji-picker__grid">
                  {cat.emojis.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className="emoji-picker__btn"
                      onClick={() => onPick(e)}
                      aria-label={`Insérer ${e}`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
