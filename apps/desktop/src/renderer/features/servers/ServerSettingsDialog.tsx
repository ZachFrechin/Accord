import { useEffect, useState } from 'react';
import { Check, Search, Settings, Shield, Users } from 'lucide-react';
import type { ServerMemberProfile, ServerRole, ServerSummary } from '@discord2/shared';
import { AvatarImage } from '../../components/AvatarImage';
import { Dialog } from '../../components/Dialog';
import { uploadPublicImage } from '../../lib/storage-upload';
import type { SupabaseBrowserClient } from '../../lib/supabase';

type ServerSettingsTab = 'general' | 'roles' | 'members';

interface ServerSettingsDialogProps {
  server: ServerSummary;
  supabase: SupabaseBrowserClient;
  isSaving: boolean;
  roles: ServerRole[];
  members: ServerMemberProfile[];
  isLoadingRoles: boolean;
  isSavingRole: boolean;
  isRemovingMember?: boolean;
  onClose: () => void;
  onSave: (input: { name: string; avatarUrl: string | null }) => Promise<void>;
  onCreateRole: (input: { name: string; color: string; mentionable: boolean }) => Promise<void>;
  onUpdateRole: (
    roleId: string,
    input: { name: string; color: string; mentionable: boolean },
  ) => Promise<void>;
  onDeleteRole: (roleId: string) => Promise<void>;
  onUpdateMemberRoles: (userId: string, roleIds: string[]) => Promise<void>;
  onRemoveMember?: (userId: string) => Promise<void>;
}

export function ServerSettingsDialog({
  server,
  supabase,
  isSaving,
  roles,
  members,
  isLoadingRoles,
  isSavingRole,
  isRemovingMember = false,
  onClose,
  onSave,
  onCreateRole,
  onUpdateRole,
  onDeleteRole,
  onUpdateMemberRoles,
  onRemoveMember,
}: ServerSettingsDialogProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<ServerSettingsTab>('general');
  const [name, setName] = useState(server.name);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(server.avatarUrl);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleColor, setNewRoleColor] = useState('#8b9cff');
  const [memberSearch, setMemberSearch] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(
    members[0]?.userId ?? null,
  );
  const [confirmKickId, setConfirmKickId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManageMembers = server.role === 'owner' || server.role === 'admin';

  const filteredMembers = members.filter((member) =>
    member.profile.displayName.toLocaleLowerCase().includes(memberSearch.toLocaleLowerCase()),
  );
  const selectedMember =
    members.find((member) => member.userId === selectedMemberId) ?? filteredMembers[0] ?? null;

  useEffect(() => {
    if (!avatarFile) {
      setPreviewUrl(null);
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(avatarFile);
    setPreviewUrl(nextPreviewUrl);

    return () => URL.revokeObjectURL(nextPreviewUrl);
  }, [avatarFile]);

  useEffect(() => {
    const firstMember = members[0];
    if (!selectedMemberId && firstMember) {
      setSelectedMemberId(firstMember.userId);
    }
  }, [members, selectedMemberId]);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    try {
      const uploadedAvatarUrl = avatarFile
        ? await uploadPublicImage(supabase, 'server-icons', server.id, avatarFile)
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
      <div className="server-settings-shell">
        <nav className="settings-tabs" aria-label="Sections des paramètres serveur">
          <SettingsTab
            active={activeTab === 'general'}
            icon={<Settings size={16} />}
            label="Général"
            onClick={() => setActiveTab('general')}
          />
          <SettingsTab
            active={activeTab === 'roles'}
            icon={<Shield size={16} />}
            label="Rôles"
            onClick={() => setActiveTab('roles')}
          />
          <SettingsTab
            active={activeTab === 'members'}
            icon={<Users size={16} />}
            label="Membres"
            onClick={() => setActiveTab('members')}
          />
        </nav>

        <div className="server-settings-panel">
          {activeTab === 'general' ? (
            <form className="settings-section" onSubmit={(event) => void submit(event)}>
              <div className="avatar-field">
                <AvatarImage
                  className="settings-avatar"
                  label={name}
                  src={previewUrl ?? avatarUrl}
                />
                <label className="file-field">
                  <span>Photo du serveur</span>
                  <span className="file-picker">
                    <span className="file-picker-button">Choisir une image</span>
                    <span className="file-picker-name">
                      {avatarFile?.name ?? 'Aucune image choisie'}
                    </span>
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
          ) : null}

          {activeTab === 'roles' ? (
            <section className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <h3>Rôles</h3>
                  <p>Définis les rôles visibles dans le chat et mentionnables.</p>
                </div>
              </div>
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
          ) : null}

          {activeTab === 'members' ? (
            <section className="settings-section members-settings">
              <div className="settings-section-heading">
                <div>
                  <h3>Membres</h3>
                  <p>Sélectionne un membre puis ajuste ses rôles sans matrice de cases.</p>
                </div>
              </div>
              <div className="members-management">
                <div className="member-picker">
                  <label className="search-field">
                    <Search size={15} />
                    <input
                      value={memberSearch}
                      aria-label="Rechercher un membre"
                      placeholder="Rechercher un membre"
                      onChange={(event) => setMemberSearch(event.target.value)}
                    />
                  </label>
                  <div className="member-picker-list">
                    {filteredMembers.map((member) => (
                      <div className="member-picker-row-wrap" key={member.userId}>
                        {confirmKickId === member.userId ? (
                          <div className="member-kick-confirm">
                            <span>Retirer {member.profile.displayName} ?</span>
                            <button
                              type="button"
                              className="kick-confirm-btn"
                              disabled={isRemovingMember}
                              onClick={() => {
                                void onRemoveMember?.(member.userId).then(() => {
                                  setConfirmKickId(null);
                                  if (selectedMemberId === member.userId) {
                                    setSelectedMemberId(null);
                                  }
                                });
                              }}
                            >
                              Confirmer
                            </button>
                            <button
                              type="button"
                              className="kick-cancel-btn"
                              disabled={isRemovingMember}
                              onClick={() => setConfirmKickId(null)}
                            >
                              Annuler
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className={`member-picker-row${
                              selectedMember?.userId === member.userId ? ' active' : ''
                            }`}
                            aria-pressed={selectedMember?.userId === member.userId}
                            onClick={() => setSelectedMemberId(member.userId)}
                          >
                            <AvatarImage
                              className="member-role-avatar"
                              label={member.profile.displayName}
                              src={member.profile.avatarUrl}
                            />
                            <span>
                              <strong>{member.profile.displayName}</strong>
                              <small>{member.role}</small>
                            </span>
                            {canManageMembers && member.role !== 'owner' && onRemoveMember ? (
                              <button
                                type="button"
                                className="member-kick-btn"
                                title="Retirer du serveur"
                                disabled={isRemovingMember}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmKickId(member.userId);
                                }}
                              >
                                ✕
                              </button>
                            ) : null}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="member-role-detail">
                  {selectedMember ? (
                    <>
                      <div className="member-detail-header">
                        <AvatarImage
                          className="member-detail-avatar"
                          label={selectedMember.profile.displayName}
                          src={selectedMember.profile.avatarUrl}
                        />
                        <div>
                          <strong>{selectedMember.profile.displayName}</strong>
                          <span>{selectedMember.role}</span>
                        </div>
                      </div>
                      <div className="role-toggle-grid">
                        {roles.map((role) => {
                          const selected = selectedMember.roleIds.includes(role.id);
                          const nextRoleIds = selected
                            ? selectedMember.roleIds.filter((roleId) => roleId !== role.id)
                            : [...selectedMember.roleIds, role.id];

                          return (
                            <button
                              type="button"
                              className={`role-toggle-card${selected ? ' selected' : ''}`}
                              disabled={isSavingRole}
                              aria-pressed={selected}
                              key={role.id}
                              style={{ '--role-color': role.color } as React.CSSProperties}
                              onClick={() =>
                                void onUpdateMemberRoles(selectedMember.userId, nextRoleIds)
                              }
                            >
                              <span className="role-toggle-color" />
                              <span>{role.name}</span>
                              {selected ? <Check size={15} /> : null}
                            </button>
                          );
                        })}
                        {roles.length === 0 ? (
                          <p className="muted">Crée un rôle avant d’en assigner aux membres.</p>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <p className="muted">Aucun membre trouvé.</p>
                  )}
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

interface SettingsTabProps {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

function SettingsTab({ active, icon, label, onClick }: SettingsTabProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`settings-tab${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
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
        <span className="toggle-switch" aria-hidden="true" />
        <span className="toggle-label">Mentionnable</span>
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
