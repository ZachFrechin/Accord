import { Copy } from 'lucide-react';
import type { InviteRecord } from '@discord2/shared';
import { Dialog } from '../../components/Dialog';

interface InviteDialogProps {
  invite: InviteRecord | null;
  isCreating: boolean;
  onCreate: () => void;
  onClose: () => void;
}

export function InviteDialog({
  invite,
  isCreating,
  onCreate,
  onClose,
}: InviteDialogProps): React.JSX.Element {
  async function copyInvite(): Promise<void> {
    if (!invite) {
      return;
    }

    await navigator.clipboard.writeText(invite.code);
  }

  return (
    <Dialog title="Invitation serveur" onClose={onClose}>
      <div className="invite-dialog">
        {invite ? (
          <>
            <label>
              Code d’invitation
              <div className="copy-row">
                <input value={invite.code} readOnly />
                <button type="button" onClick={() => void copyInvite()} aria-label="Copier">
                  <Copy size={18} />
                </button>
              </div>
            </label>
            <p className="muted">Envoie ce code à un utilisateur déjà inscrit.</p>
          </>
        ) : (
          <button type="button" disabled={isCreating} onClick={onCreate}>
            {isCreating ? 'Création...' : 'Générer une invitation'}
          </button>
        )}
      </div>
    </Dialog>
  );
}
