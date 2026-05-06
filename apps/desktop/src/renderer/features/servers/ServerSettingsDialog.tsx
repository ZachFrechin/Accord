import { useEffect, useState } from 'react';
import type { ServerMemberProfile, ServerRole, ServerSummary } from '@discord2/shared';
import { AvatarImage } from '../../components/AvatarImage';
import { Dialog } from '../../components/Dialog';
import { uploadPublicImage } from '../../lib/storage-upload';

interface ServerSettingsDialogProps {
  server: ServerSummary;
  isSaving: boolean;
  roles: ServerRole[];
  members: ServerMemberProfile[];
  isLoadingRoles: boolean;
  isSavingRole: boolean;
  onClose: () => void;
  onSave: (input: { name: string; avatarUrl: string | null }) => Promise<void>;
  onCreateRole: (input: { name: string; color: string; mentionable: boolean }) => Promise<void>;
  onUpdateRole: (
    roleId: string,
    input: { name: string; color: string; mentionable: boolean },
  ) => Promise<void>;
  onDeleteRole: (roleId: string) => Promise<void>;
  onUpdateMemberRoles: (userId: string, roleIds: string[]) => Promise<void>;
}

export function ServerSettingsDialog({
  server,
  isSaving,
  roles,
  members,
  isLoadingRoles,
  isSavingRole,
  onClose,
  onSave,
  onCreateRole,
  onUpdateRole,
  onDeleteRole,
  onUpdateMemberRoles,
}: ServerSettingsDialogProps): React.JSX.Element {
  const [name, setName] = useState(server.name);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(server.avatarUrl);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleColor, setNewRoleColor] = useState('#8b9cff');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!avatarFile) {
      setPreviewUrl(null);
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(avatarFile);
    setPreviewUrl(nextPreviewUrl);

    return () => URL.revokeObjectURL(nextPreviewUrl);
  }, [avatarFile]);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    try {
      const uploadedAvatarUrl = avatarFile
        ? await uploadPublicImage('server-icons', server.id, avatarFile)
        : avatarUrl;
      await onSave({
        name: name.trim(),
        avatarUrl: uploadedAvatarUrl,
      });
      setAvatarUrl(uploadedAvatarUrl);
      setAvatarFile(null);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : 'Impossible de sauvegarder le serveur.',
      );
    }
  }

  async function createRole(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!newRoleName.trim()) {
      return;
    }

    await onCreateRole({
      name: newRoleName.trim(),
      color: newRoleColor,
      mentionable: true,
    });
    setNewRoleName('');
    setNewRoleColor('#8b9cff');
  }

  return (
    <Dialog title="Paramètres serveur" onClose={onClose}>
      <form className="settings-section" onSubmit={(event) => void submit(event)}>
        <div className="avatar-field">
          <AvatarImage className="settings-avatar" label={name} src={previewUrl ?? avatarUrl} />
          <label className="file-field">
            <span>Photo du serveur</span>
            <span className="file-picker">
              <span className="file-picker-button">Choisir une image</span>
              <span className="file-picker-name">{avatarFile?.name ?? 'Aucune image choisie'}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => setAvatarFile(event.target.files?.[0] ?? null)}
              />
            </span>
          </label>
        </div>
        <label>
          Nom du serveur
          <input
            value={name}
            minLength={1}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="form-actions">
          <button type="submit" disabled={isSaving || !name.trim()}>
            Sauvegarder le serveur
          </button>
        </div>
      </form>
      <section className="settings-section">
        <h3>Rôles</h3>
        <form className="role-create-row" onSubmit={(event) => void createRole(event)}>
          <input
            value={newRoleName}
            maxLength={40}
            placeholder="Nom du rôle"
            onChange={(event) => setNewRoleName(event.target.value)}
          />
          <input
            type="color"
            value={newRoleColor}
            aria-label="Couleur du rôle"
            onChange={(event) => setNewRoleColor(event.target.value)}
          />
          <button type="submit" disabled={isSavingRole || !newRoleName.trim()}>
            Ajouter
          </button>
        </form>
        <div className="role-list">
          {roles.map((role) => (
            <RoleEditor
              key={role.id}
              role={role}
              disabled={isSavingRole}
              onSave={onUpdateRole}
              onDelete={onDeleteRole}
            />
          ))}
          {!isLoadingRoles && roles.length === 0 ? (
            <p className="muted">Aucun rôle personnalisé.</p>
          ) : null}
        </div>
      </section>
      <section className="settings-section">
        <h3>Membres</h3>
        <div className="member-role-list">
          {members.map((member) => (
            <div className="member-role-row" key={member.userId}>
              <AvatarImage
                className="member-role-avatar"
                label={member.profile.displayName}
                src={member.profile.avatarUrl}
              />
              <div>
                <strong>{member.profile.displayName}</strong>
                <span>{member.role}</span>
              </div>
              <div className="member-role-pills">
                {roles.map((role) => {
                  const checked = member.roleIds.includes(role.id);
                  return (
                    <label className="role-check" key={role.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isSavingRole}
                        onChange={(event) => {
                          const nextRoleIds = event.target.checked
                            ? [...member.roleIds, role.id]
                            : member.roleIds.filter((roleId) => roleId !== role.id);
                          void onUpdateMemberRoles(member.userId, nextRoleIds);
                        }}
                      />
                      <span style={{ '--role-color': role.color } as React.CSSProperties}>
                        {role.name}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>
    </Dialog>
  );
}

interface RoleEditorProps {
  role: ServerRole;
  disabled: boolean;
  onSave: (
    roleId: string,
    input: { name: string; color: string; mentionable: boolean },
  ) => Promise<void>;
  onDelete: (roleId: string) => Promise<void>;
}

function RoleEditor({ role, disabled, onSave, onDelete }: RoleEditorProps): React.JSX.Element {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color);
  const [mentionable, setMentionable] = useState(role.mentionable);

  return (
    <div className="role-editor">
      <input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
      <input
        type="color"
        value={color}
        aria-label={`Couleur ${role.name}`}
        onChange={(event) => setColor(event.target.value)}
      />
      <label className="role-mentionable">
        <input
          type="checkbox"
          checked={mentionable}
          onChange={(event) => setMentionable(event.target.checked)}
        />
        Mentionnable
      </label>
      <button
        type="button"
        disabled={disabled || !name.trim()}
        onClick={() => void onSave(role.id, { name: name.trim(), color, mentionable })}
      >
        Sauver
      </button>
      <button
        type="button"
        className="delete-link-btn"
        disabled={disabled}
        onClick={() => void onDelete(role.id)}
      >
        Supprimer
      </button>
    </div>
  );
}
