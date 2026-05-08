import { useEffect, useState } from 'react';
import {
  Ban,
  Check,
  Hash,
  Mic,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import {
  ChannelType,
  Permission,
  type ChannelSummary,
  type ServerBanRecord,
  type ServerMemberProfile,
  type ServerRole,
  type ServerSummary,
} from '@discord2/shared';
import { AvatarImage } from '../../components/AvatarImage';
import { Dialog } from '../../components/Dialog';
import type { ApiClient } from '../../lib/api-client';

type ServerSettingsTab = 'general' | 'roles' | 'channels' | 'members' | 'bans';

const PERMISSION_GROUPS: Array<{ title: string; permissions: Permission[] }> = [
  {
    title: 'Général',
    permissions: [
      Permission.Administrator,
      Permission.ManageServer,
      Permission.ManageRoles,
      Permission.ManageChannels,
      Permission.CreateInvites,
    ],
  },
  {
    title: 'Messages',
    permissions: [
      Permission.ViewChannel,
      Permission.SendMessages,
      Permission.AttachFiles,
      Permission.ManageMessages,
      Permission.MentionEveryone,
    ],
  },
  {
    title: 'Vocal',
    permissions: [Permission.ConnectVoice, Permission.SpeakVoice],
  },
  {
    title: 'Modération',
    permissions: [Permission.KickMembers, Permission.BanMembers],
  },
];

const PERMISSION_LABELS: Record<Permission, string> = {
  [Permission.Administrator]: 'Administrateur',
  [Permission.ManageServer]: 'Gérer le serveur',
  [Permission.ManageRoles]: 'Gérer les rôles',
  [Permission.ManageChannels]: 'Gérer les salons',
  [Permission.CreateInvites]: 'Créer des invitations',
  [Permission.ViewChannel]: 'Voir les salons',
  [Permission.SendMessages]: 'Envoyer des messages',
  [Permission.AttachFiles]: 'Joindre des fichiers',
  [Permission.ConnectVoice]: 'Rejoindre le vocal',
  [Permission.SpeakVoice]: 'Parler en vocal',
  [Permission.ManageMessages]: 'Gérer les messages',
  [Permission.MentionEveryone]: 'Mentionner @everyone',
  [Permission.KickMembers]: 'Expulser des membres',
  [Permission.BanMembers]: 'Bannir des membres',
};

interface ServerSettingsDialogProps {
  server: ServerSummary;
  api: ApiClient;
  isSaving: boolean;
  roles: ServerRole[];
  channels: ChannelSummary[];
  members: ServerMemberProfile[];
  isLoadingRoles: boolean;
  isSavingRole: boolean;
  isRemovingMember?: boolean;
  onClose: () => void;
  onSave: (input: { name: string; avatarUrl: string | null }) => Promise<void>;
  onCreateRole: (input: { name: string; color: string; mentionable: boolean }) => Promise<void>;
  onUpdateRole: (
    roleId: string,
    input: { name: string; color: string; mentionable: boolean; permissions: Permission[] },
  ) => Promise<void>;
  onDeleteRole: (roleId: string) => Promise<void>;
  onUpdateMemberRoles: (userId: string, roleIds: string[]) => Promise<void>;
  onRemoveMember?: (userId: string) => Promise<void>;
  onBanMember?: (userId: string, reason: string | null) => Promise<void>;
  onEditChannel: (channel: ChannelSummary) => void;
}

export function ServerSettingsDialog({
  server,
  api,
  isSaving,
  roles,
  channels,
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
  onBanMember,
  onEditChannel,
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
  const [confirmBanId, setConfirmBanId] = useState<string | null>(null);
  const [bans, setBans] = useState<ServerBanRecord[]>([]);
  const [isLoadingBans, setIsLoadingBans] = useState(false);
  const [bansError, setBansError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManageMembers = server.role === 'owner' || server.role === 'admin';

  function selectAvatarFile(file: File | undefined): void {
    setError(null);
    setAvatarFile(file ?? null);
  }

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

  useEffect(() => {
    if (activeTab !== 'bans') return;
    let cancelled = false;
    setIsLoadingBans(true);
    setBansError(null);
    api.servers
      .listBans(server.id)
      .then((records) => {
        if (!cancelled) setBans(records);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setBansError(
            loadError instanceof Error
              ? loadError.message
              : 'Impossible de charger les bannissements.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingBans(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, api, server.id]);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    try {
      const uploadedAvatarUrl = avatarFile
        ? (await api.files.uploadServerIcon(server.id, avatarFile)).url
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
            active={activeTab === 'channels'}
            icon={<SlidersHorizontal size={16} />}
            label="Salons"
            onClick={() => setActiveTab('channels')}
          />
          <SettingsTab
            active={activeTab === 'members'}
            icon={<Users size={16} />}
            label="Membres"
            onClick={() => setActiveTab('members')}
          />
          <SettingsTab
            active={activeTab === 'bans'}
            icon={<Ban size={16} />}
            label="Bans"
            onClick={() => setActiveTab('bans')}
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
                      onChange={(event) => {
                        selectAvatarFile(event.target.files?.[0]);
                        event.target.value = '';
                      }}
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

          {activeTab === 'channels' ? (
            <section className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <h3>Salons</h3>
                  <p>Ouvre les paramètres d’un salon pour régler ses overrides de permissions.</p>
                </div>
              </div>
              <div className="server-channel-settings-list">
                {channels.map((channel) => (
                  <button
                    type="button"
                    className="server-channel-settings-row"
                    key={channel.id}
                    onClick={() => onEditChannel(channel)}
                  >
                    {channel.type === ChannelType.Voice ? <Mic size={16} /> : <Hash size={16} />}
                    <span>{channel.name}</span>
                    <small>{channel.type === ChannelType.Voice ? 'Vocal' : 'Texte'}</small>
                    <SlidersHorizontal size={16} />
                  </button>
                ))}
                {channels.length === 0 ? <p className="muted">Aucun salon.</p> : null}
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
                        </button>
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
                      {canManageMembers && selectedMember.role !== 'owner' ? (
                        <div className="member-admin-actions">
                          {confirmBanId === selectedMember.userId ? (
                            <>
                              <span>Bannir ce membre ?</span>
                              <button
                                type="button"
                                className="danger-button"
                                disabled={isRemovingMember}
                                onClick={() => {
                                  void onBanMember?.(selectedMember.userId, null).then(() => {
                                    setConfirmBanId(null);
                                    setSelectedMemberId(null);
                                  });
                                }}
                              >
                                Confirmer
                              </button>
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={isRemovingMember}
                                onClick={() => setConfirmBanId(null)}
                              >
                                Annuler
                              </button>
                            </>
                          ) : (
                            <>
                              {onRemoveMember ? (
                                <button
                                  type="button"
                                  className="secondary-button"
                                  disabled={isRemovingMember}
                                  onClick={() => {
                                    void onRemoveMember(selectedMember.userId).then(() =>
                                      setSelectedMemberId(null),
                                    );
                                  }}
                                >
                                  Expulser
                                </button>
                              ) : null}
                              {onBanMember ? (
                                <button
                                  type="button"
                                  className="danger-button"
                                  disabled={isRemovingMember}
                                  onClick={() => setConfirmBanId(selectedMember.userId)}
                                >
                                  Bannir
                                </button>
                              ) : null}
                            </>
                          )}
                        </div>
                      ) : null}
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

          {activeTab === 'bans' ? (
            <section className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <h3>Bannissements</h3>
                  <p>Les membres bannis ne peuvent plus rejoindre le serveur via invitation.</p>
                </div>
              </div>
              {bansError ? <div className="form-error">{bansError}</div> : null}
              <div className="ban-list">
                {isLoadingBans ? <p className="muted">Chargement des bannissements...</p> : null}
                {!isLoadingBans && bans.length === 0 ? (
                  <p className="muted">Aucun membre banni.</p>
                ) : null}
                {bans.map((ban) => (
                  <div className="ban-row" key={ban.userId}>
                    <AvatarImage
                      className="member-role-avatar"
                      label={ban.profile?.displayName ?? ban.userId}
                      src={ban.profile?.avatarUrl ?? null}
                    />
                    <span>
                      <strong>{ban.profile?.displayName ?? ban.userId}</strong>
                      <small>{ban.reason || 'Aucune raison indiquée'}</small>
                    </span>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        void api.servers.unbanMember(server.id, ban.userId).then(() => {
                          setBans((current) =>
                            current.filter((item) => item.userId !== ban.userId),
                          );
                        });
                      }}
                    >
                      Débannir
                    </button>
                  </div>
                ))}
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
    input: { name: string; color: string; mentionable: boolean; permissions: Permission[] },
  ) => Promise<void>;
  onDelete: (roleId: string) => Promise<void>;
}

function RoleEditor({ role, disabled, onSave, onDelete }: RoleEditorProps): React.JSX.Element {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color);
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [permissions, setPermissions] = useState<Permission[]>(role.permissions ?? []);

  function togglePermission(perm: Permission): void {
    setPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  }

  return (
    <div className="role-editor">
      <div className="role-editor-row">
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
        <div className="role-editor-actions">
          <button
            type="button"
            className="primary-button"
            disabled={disabled || !name.trim()}
            onClick={() =>
              void onSave(role.id, { name: name.trim(), color, mentionable, permissions })
            }
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
      </div>
      <div className="role-permissions-editor">
        {PERMISSION_GROUPS.map((group) => (
          <section className="permission-group" key={group.title}>
            <h4>{group.title}</h4>
            <div className="permission-chip-grid">
              {group.permissions.map((perm) => {
                const selected = permissions.includes(perm);
                return (
                  <button
                    type="button"
                    key={perm}
                    className={`permission-chip${selected ? ' selected' : ''}`}
                    aria-pressed={selected}
                    disabled={disabled}
                    onClick={() => togglePermission(perm)}
                  >
                    <span className="permission-chip-label">{PERMISSION_LABELS[perm]}</span>
                    <span className="permission-chip-toggle" aria-hidden="true">
                      <span className="permission-chip-knob" />
                      <span>{selected ? 'On' : 'Off'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        <div className="role-permissions-footer">
          <span>
            {permissions.length} permission{permissions.length > 1 ? 's' : ''} activée
            {permissions.length > 1 ? 's' : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
