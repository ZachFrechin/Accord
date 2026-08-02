/**
 * The app background layer — a fixed pane behind the whole shell that paints the
 * chosen wallpaper (solid, gradient preset, uploaded image, or looping video).
 * The shell panels sit above it and, when surface opacity is < 1, let it show
 * through as frosted glass.
 */

import { useEffect, useState } from "react";

import { getBgMedia } from "../lib/bgStore";
import { useCustomizeStore } from "../stores/useCustomizeStore";

export function AppBackground() {
  const bgKind = useCustomizeStore((s) => s.bgKind);
  const mediaType = useCustomizeStore((s) => s.mediaType);
  // Re-read the blob when it CHANGES under the same kind (new upload, preset).
  const mediaRev = useCustomizeStore((s) => s.mediaRev ?? 0);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const wantsMedia = bgKind === "image" || bgKind === "video";
    if (!wantsMedia) {
      setUrl(null);
      return;
    }
    let objectUrl: string | null = null;
    let alive = true;
    void getBgMedia().then((blob) => {
      if (alive && blob) {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      }
    });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bgKind, mediaType, mediaRev]);

  return (
    <div className="app-bg" data-kind={bgKind} aria-hidden>
      {bgKind === "video" && url && (
        <video className="app-bg__media" src={url} autoPlay muted loop playsInline />
      )}
      {bgKind === "image" && url && <img className="app-bg__media" src={url} alt="" />}
      <div className="app-bg__scrim" />
    </div>
  );
}
