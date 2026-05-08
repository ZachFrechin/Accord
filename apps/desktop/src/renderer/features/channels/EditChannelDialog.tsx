import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import {
  ChannelPermissionOverwriteTargetType,
  ChannelType,
  Permission,
  type ChannelPermissionOverwrite,
  type ChannelSummary,
  type ServerRole,
  type UpdateChannelPermissionOverwriteInput,
} from '@discord2/shared';
import { Dialog } from '../../components/Dialog';
import type { ApiClient } from '../../lib/api-client';

type EditChannelTab = 'general' | 'permissions';
type PermState = 'allow' | 'deny' | 'inherit';
type OverwriteMap = Map<string, { allow: Permission[]; deny: Permission[] }>;

const TEXT_PERMISSIONS: Permission[] = [
  Permission.ViewChannel,
  Permission.SendMessages,
  Permission.AttachFiles,
  Permission.ManageMessages,
  Permission.MentionEveryone,
];

const VOICE_PERMISSIONS: Permission[] = [
  Permission.ViewChannel,
  Permission.ConnectVoice,
  Permission.SpeakVoice,
];

const PERMISSION_LABELS: Record<Permission, string> = {
  [Permission.Administrator]: 'Administrateur',
  [Permission.ManageServer]: 'Gérer le serveur',
  [Permission.ManageRoles]: 'Gérer les rôles',
  [Permission.ManageChannels]: 'Gérer les salons',
  [Permission.CreateInvites]: 'Créer des invitations',
  [Permission.ViewChannel]: 'Voir le salon',
  [Permission.SendMessages]: 'Envoyer des messages',
  [Permission.AttachFiles]: 'Joindre des fichiers',
  [Permission.ConnectVoice]: 'Rejoindre le vocal',
  [Permission.SpeakVoice]: 'Parler en vocal',
  [Permission.ManageMessages]: 'Gérer les messages',
  [Permission.MentionEveryone]: 'Mentionner @everyone',
  [Permission.KickMembers]: 'Expulser des membres',
  [Permission.BanMembers]: 'Bannir des membres',
};

interface EditChannelDialogProps {
  channel: ChannelSummary;
  serverId: string;
  api: ApiClient;
  roles: ServerRole[];
  isSubmitting: boolean;
  isDeleting: boolean;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

function overwritesToMap(overwrites: ChannelPermissionOverwrite[]): OverwriteMap {
  const map: OverwriteMap = new Map();
  for (const ow of overwrites) {
    map.set(ow.targetId ?? 'everyone', {
      allow: ow.allowPermissions,
      deny: ow.denyPermissions,
    });
  }
  return map;
}

function mapToOverwriteInput(map: OverwriteMap): UpdateChannelPermissionOverwriteInput[] {
  const result: UpdateChannelPermissionOverwriteInput[] = [];
  const everyone = map.get('everyone') ?? { allow: [], deny: [] };
  result.push({
    targetType: ChannelPermissionOverwriteTargetType.Everyone,
    targetId: null,
    allowPermissions: everyone.allow,
    denyPermissions: everyone.deny,
  });
  for (const [key, { allow, deny }] of map.entries()) {
    if (key === 'everyone') continue;
    if (allow.length === 0 && deny.length === 0) continue;
    result.push({
      targetType: ChannelPermissionOverwriteTargetType.Role,
      targetId: key,
      allowPermissions: allow,
      denyPermissions: deny,
    });
  }
  return result;
}

export function EditChannelDialog({
  channel,
  serverId,
  api,
  roles,
  isSubmitting,
  isDeleting,
  onClose,
  onSave,
  onDelete,
}: EditChannelDialogProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<EditChannelTab>('general');
  const [name, setName] = useState(channel.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<string>('everyone');
  const [localOverwrites, setLocalOverwrites] = useState<OverwriteMap>(new Map());
  const [isSavingPermissions, setIsSavingPermissions] = useState(false);
  const [permissionsError, setPermissionsError] = useState<string | null>(null);

  const normalizedName = name.trim();
  const kind = channel.type === ChannelType.Voice ? 'vocal' : 'texte';
  const title =
    channel.type === ChannelType.Voice ? 'Modifier le salon vocal' : 'Modifier le salon';
  const relevantPerms = channel.type === ChannelType.Voice ? VOICE_PERMISSIONS : TEXT_PERMISSIONS;

  const overwritesQuery = useQuery({
    queryKey: ['channel-permissions', serverId, channel.id],
    queryFn: () => api.channels.getPermissions(serverId, channel.id),
    enabled: activeTab === 'permissions',
  });

  useEffect(() => {
    if (overwritesQuery.data) {
      setLocalOverwrites(overwritesToMap(overwritesQuery.data));
    }
  }, [overwritesQuery.data]);

  function getPermState(targetKey: string, perm: Permission): PermState {
    const ow = localOverwrites.get(targetKey);
    if (!ow) return 'inherit';
    if (ow.allow.includes(perm)) return 'allow';
    if (ow.deny.includes(perm)) return 'deny';
    return 'inherit';
  }

  function cyclePermState(targetKey: string, perm: Permission, clicked: 'allow' | 'deny'): void {
    setLocalOverwrites((prev) => {
      const current = prev.get(targetKey) ?? { allow: [], deny: [] };
      const allow = current.allow.filter((p) => p !== perm);
      const deny = current.deny.filter((p) => p !== perm);
      const current_state = getPermState(targetKey, perm);
      if (clicked === 'allow' && current_state !== 'allow') allow.push(perm);
      if (clicked === 'deny' && current_state !== 'deny') deny.push(perm);
      const next = new Map(prev);
      next.set(targetKey, { allow, deny });
      return next;
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!normalizedName) return;
    await onSave(normalizedName);
  }

  async function handleDelete(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onDelete();
  }

  async function savePermissions(): Promise<void> {
    setIsSavingPermissions(true);
    setPermissionsError(null);
    try {
      await api.channels.updatePermissions(serverId, channel.id, {
        overwrites: mapToOverwriteInput(localOverwrites),
      });
    } catch (error) {
      setPermissionsError(error instanceof Error ? error.message : 'Impossible de sauvegarder.');
    } finally {
      setIsSavingPermissions(false);
    }
  }

  const targets = [
    { key: 'everyone', label: '@everyone' },
    ...roles.map((r) => ({ key: r.id, label: r.name })),
  ];
  const selectedTargetLabel =
    targets.find((target) => target.key === selectedTarget)?.label ?? '@everyone';

  if (showDeleteConfirm) {
    return (
      <Dialog title={title} onClose={onClose}>
        <form className="stack-form" onSubmit={(event) => void handleDelete(event)}>
          <p className="muted">
            Le salon {kind} <strong>{channel.name}</strong> sera supprimé pour tous les membres.
            Cette action est définitive.
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowDeleteConfirm(false)}
            >
              Annuler
            </button>
            <button type="submit" className="danger-button" disabled={isDeleting}>
              Supprimer
            </button>
          </div>
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <div className="edit-channel-tabs">
        <button
          type="button"
          className={`edit-channel-tab${activeTab === 'general' ? ' active' : ''}`}
          onClick={() => setActiveTab('general')}
        >
          Général
        </button>
        <button
          type="button"
          className={`edit-channel-tab${activeTab === 'permissions' ? ' active' : ''}`}
          onClick={() => setActiveTab('permissions')}
        >
          Permissions
        </button>
      </div>

      {activeTab === 'general' ? (
        <form className="stack-form" onSubmit={(event) => void submit(event)}>
          <label>
            Nom du salon
            <input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </label>
          <button type="submit" disabled={isSubmitting || !normalizedName}>
            Sauvegarder
          </button>
          <button
            type="button"
            className="delete-link-btn"
            disabled={isSubmitting || isDeleting}
            onClick={() => setShowDeleteConfirm(true)}
          >
            Supprimer le salon
          </button>
        </form>
      ) : (
        <div className="channel-perm-panel">
          {overwritesQuery.isLoading ? (
            <p className="muted">Chargement des permissions...</p>
          ) : (
            <>
              <div className="channel-perm-shell">
                <div className="channel-perm-targets">
                  {targets.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      className={`channel-perm-target${selectedTarget === t.key ? ' active' : ''}`}
                      onClick={() => setSelectedTarget(t.key)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="channel-perm-detail">
                  <div className="channel-perm-summary">
                    <strong>{selectedTargetLabel}</strong>
                    <span>
                      Autoriser force l’accès pour cette cible, refuser le bloque, et l’absence de
                      sélection hérite des permissions du serveur.
                    </span>
                  </div>
                  {relevantPerms.map((perm) => {
                    const state = getPermState(selectedTarget, perm);
                    return (
                      <div key={perm} className="perm-overwrite-row">
                        <span className="perm-overwrite-label">{PERMISSION_LABELS[perm]}</span>
                        <div className="perm-state-group">
                          <button
                            type="button"
                            className={`perm-state-btn perm-allow${state === 'allow' ? ' active' : ''}`}
                            title="Autoriser"
                            onClick={() => cyclePermState(selectedTarget, perm, 'allow')}
                          >
                            <Check size={15} />
                            <span>Autoriser</span>
                          </button>
                          <button
                            type="button"
                            className={`perm-state-btn perm-deny${state === 'deny' ? ' active' : ''}`}
                            title="Refuser"
                            onClick={() => cyclePermState(selectedTarget, perm, 'deny')}
                          >
                            <X size={15} />
                            <span>Refuser</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {permissionsError ? <div className="form-error">{permissionsError}</div> : null}
              <button
                type="button"
                disabled={isSavingPermissions}
                onClick={() => void savePermissions()}
              >
                Sauvegarder les permissions
              </button>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
