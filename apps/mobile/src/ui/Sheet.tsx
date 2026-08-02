/**
 * Feuille d'actions qui remonte du bas — le geste attendu sur téléphone quand
 * on maintient un élément. Elle remplace le menu contextuel du bureau, qui
 * suppose un clic droit.
 *
 * Elle s'ancre en bas (le pouce y est), se ferme au fond ou au bouton retour
 * d'Android, et ses lignes font 52 px.
 */

import { useEffect, useRef, type ReactNode } from "react";

import { pushBackHandler } from "../lib/backStack";

export interface SheetAction {
  label: string;
  onSelect: () => void;
  /** Action destructrice : teintée en rouge. */
  danger?: boolean;
}

export function Sheet({
  open,
  title,
  actions,
  onClose,
  children,
}: {
  open: boolean;
  title?: string;
  actions?: SheetAction[];
  onClose: () => void;
  children?: ReactNode;
}) {
  // Le retour ferme la feuille, et RIEN d'autre : la pile partagée garantit
  // qu'un seul niveau se referme à la fois.
  const back = useRef<ReturnType<typeof pushBackHandler> | null>(null);
  useEffect(() => {
    if (!open) return;
    back.current = pushBackHandler(onClose);
    return () => back.current?.detach();
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="sheet" role="dialog" aria-modal="true">
      <button
        type="button"
        className="sheet__scrim"
        aria-label="Fermer"
        onClick={() => back.current?.close()}
      />
      <div className="sheet__panel">
        <span className="sheet__grip" aria-hidden="true" />
        {title && <p className="sheet__title">{title}</p>}
        {children}
        {actions?.map((a) => (
          <button
            key={a.label}
            type="button"
            className="sheet__action"
            data-danger={a.danger}
            onClick={() => {
              // L'action AVANT la fermeture : ouvrir un sélecteur de fichier
              // exige un geste utilisateur, et la navigation arrière le rompt.
              a.onSelect();
              back.current?.close();
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
