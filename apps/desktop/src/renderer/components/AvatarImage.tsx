import { useState } from 'react';

interface AvatarImageProps {
  label: string;
  src?: string | null | undefined;
  className?: string;
}

export function AvatarImage({
  label,
  src,
  className = 'avatar',
}: AvatarImageProps): React.JSX.Element {
  const [hasImageError, setHasImageError] = useState(false);
  const initials = label.trim().slice(0, 2).toUpperCase() || '?';

  if (src && !hasImageError) {
    return (
      <img
        className={className}
        src={src}
        alt=""
        loading="lazy"
        onError={() => setHasImageError(true)}
      />
    );
  }

  return <div className={className}>{initials}</div>;
}
