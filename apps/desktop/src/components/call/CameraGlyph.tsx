/** Hand-authored camera glyph (the icon set has no video-off). Slashed when off. */
export function CameraGlyph({ off, size = 18 }: { off: boolean; size?: number }) {
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
      <rect x="2" y="6" width="14" height="12" rx="2.5" />
      <path d="M16 10l5-3v10l-5-3z" />
      {off && <line x1="4" y1="3.5" x2="20" y2="20.5" stroke="currentColor" />}
    </svg>
  );
}
