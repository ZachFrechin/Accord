/** Hand-authored mic glyph (the icon set has no microphone). Slashed when muted. */
export function MicGlyph({ muted, size = 18 }: { muted: boolean; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="10" rx="3" fill="currentColor" stroke="none" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <line x1="8.5" y1="21" x2="15.5" y2="21" />
      {muted && <line x1="4" y1="3.5" x2="20" y2="20.5" stroke="currentColor" />}
    </svg>
  );
}
