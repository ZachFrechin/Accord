/**
 * Avatar mobile : la photo si elle existe, sinon les initiales sur une teinte
 * dérivée du nom — la même règle que sur le bureau, pour qu'une personne garde
 * la même couleur d'un écran à l'autre.
 */

/** Teinte stable dérivée du nom (0-359). */
export function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return hash;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).slice(0, 2);
  return words.map((w) => w[0] ?? "").join("").toUpperCase() || "?";
}

export function Avatar({
  name,
  size = 44,
  src,
}: {
  name: string;
  size?: number;
  src?: string | null;
}) {
  const hue = hueFor(name);
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        background: src ? undefined : `hsl(${hue} 40% 22%)`,
        color: src ? undefined : `hsl(${hue} 70% 72%)`,
      }}
    >
      {src ? <img src={src} alt="" loading="lazy" /> : initials(name)}
    </span>
  );
}
