/**
 * Pièce jointe dans le fil.
 *
 * Les fichiers sont chiffrés : on les télécharge puis on les déchiffre sur
 * l'appareil avant de pouvoir les montrer. Les images s'affichent donc en
 * vignette une fois déchiffrées ; tout le reste devient une ligne à toucher.
 */

import { useEffect, useState } from "react";

import type { AttachmentRef } from "@accord/core/lib/messaging";
import { downloadAndDecrypt } from "@accord/core/lib/messaging";
import { Icon } from "@accord/core/ui/Icon";
import { useConnection } from "@accord/core/realtime/ConnectionProvider";

/** Taille lisible (« 2,4 Mo »). */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

export function Attachment({
  attachment,
  onOpenImage,
}: {
  attachment: AttachmentRef;
  onOpenImage: (url: string, name: string) => void;
}) {
  const { client } = useConnection();
  const isImage = attachment.mime.startsWith("image/");
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Les images se déchiffrent à l'affichage ; l'URL objet est libérée au démontage.
  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    let objectUrl: string | null = null;
    void downloadAndDecrypt(client, attachment)
      .then((bytes) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
        setUrl(objectUrl);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, attachment, isImage]);

  if (isImage && url) {
    return (
      <button
        type="button"
        className="att-image"
        onClick={() => onOpenImage(url, attachment.name)}
        aria-label={`Ouvrir ${attachment.name}`}
      >
        <img src={url} alt={attachment.name} loading="lazy" />
      </button>
    );
  }

  if (isImage && !failed) {
    return <div className="att-image att-image--loading" aria-label="Déchiffrement de l'image…" />;
  }

  return (
    <div className="att-file">
      <span className="att-file__icon">
        <Icon name={isImage ? "image" : "paperclip"} size={17} />
      </span>
      <span className="att-file__body">
        <span className="att-file__name">{attachment.name}</span>
        <span className="att-file__meta">
          {failed ? "Déchiffrement impossible" : humanSize(attachment.size)}
        </span>
      </span>
    </div>
  );
}
