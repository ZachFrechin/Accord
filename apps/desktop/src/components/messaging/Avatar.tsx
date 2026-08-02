/** Avatar: a profile image when set, else initials, with an optional presence dot. */

import type { PresenceStatus } from "../../realtime/wireSchema";

interface AvatarProps {
  name: string;
  size?: number;
  presence?: PresenceStatus;
  /** Profile avatar URL; falls back to the initials disc when absent/failed. */
  src?: string | null;
}

/** Deterministic hue from a name so a user keeps the same colour. */
export function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/** Vivid per-user colour (Clay): used for avatars AND matching author names. */
export function colorFor(name: string): string {
  return `hsl(${hueFor(name)} 68% 62%)`;
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function Avatar({ name, size = 36, presence, src }: AvatarProps) {
  return (
    <span className="avatar" style={{ width: size, height: size }} aria-hidden>
      {src ? (
        <img className="avatar__img" src={src} alt="" width={size} height={size} loading="lazy" />
      ) : (
        <span
          className="avatar__disc"
          style={{
            background: colorFor(name),
            fontSize: Math.round(size * 0.4),
          }}
        >
          {initials(name)}
        </span>
      )}
      {presence && presence !== "OFFLINE" && (
        <span className="avatar__dot" data-status={presence} />
      )}
    </span>
  );
}
