/** Conversation details (shell `aside` region): member presence + group mgmt. */

import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";

import type { MemberDto } from "../../api/ApiClient";
import type { PresenceStatus } from "../../realtime/wireSchema";
import {
  addMember,
  removeMember,
  renameGroup,
  updateGroupProfile,
  uploadGroupAvatar,
} from "../../stores/messagingActions";
import { processAvatar } from "../profile/ProfileSection";
import { useConnection } from "../../realtime/ConnectionProvider";
import { useConversationsStore } from "../../stores/useConversationsStore";
import { useFriendsStore } from "../../stores/useFriendsStore";
import { useMessagesStore } from "../../stores/useMessagesStore";
import { useUiStore } from "../../stores/useUiStore";
import { usePresenceStore } from "../../stores/usePresenceStore";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import { Button, Field, Icon, IconButton, useConfirm, useToast } from "../ui";
import { Avatar } from "./Avatar";
import { ProfileDialog } from "./ProfileDialog";

const STATUS_LABEL: Record<PresenceStatus, string> = {
  ONLINE: "En ligne",
  AWAY: "Absent",
  DND: "Ne pas déranger",
  OFFLINE: "Hors ligne",
};

export function ConversationDetails() {
  const { client } = useConnection();
  const { toast } = useToast();
  const confirm = useConfirm();
  const activeId = useConversationsStore((s) => s.activeId);
  const conv = useConversationsStore((s) => s.conversations.find((c) => c.id === s.activeId));
  const title = useConversationsStore((s) => (s.activeId ? s.titles[s.activeId] : undefined));
  const friends = useFriendsStore((s) => s.friends);
  const presences = usePresenceStore((s) => s.statuses);
  const myStatus = usePresenceStore((s) => s.myStatus);
  const myStatusText = usePresenceStore((s) => s.myStatusText);
  const statusTexts = usePresenceStore((s) => s.statusTexts);
  const myId = useInstanceStore((s) => activeInstance(s)?.account?.userId ?? null);
  const activeMsgs = useMessagesStore((s) => (activeId ? s.byConversation[activeId] : undefined));
  const setSearchScrollTo = useUiStore((s) => s.setSearchScrollTo);
  const pinnedMsgs = (activeMsgs ?? []).filter((m) => m.pinned && !m.deleted);

  const [members, setMembers] = useState<MemberDto[]>([]);
  const [membersError, setMembersError] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  // Group profile (avatar + description) — admin-editable.
  const groupAvatarRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [descEditing, setDescEditing] = useState(false);
  const [descDraft, setDescDraft] = useState("");

  useEffect(() => {
    if (!activeId) {
      setMembers([]);
      setMembersError(false);
      return;
    }
    let alive = true;
    setMembersError(false);
    client
      .conversationMembers(activeId)
      .then((r) => alive && setMembers(r.members))
      // A silent failure blanks the panel (controls derive from members), reading
      // as a memberless group — surface it with a retry instead.
      .catch(() => alive && setMembersError(true));
    return () => {
      alive = false;
    };
  }, [client, activeId, conv]);

  const retryMembers = () => {
    if (!activeId) return;
    setMembersError(false);
    client
      .conversationMembers(activeId)
      .then((r) => setMembers(r.members))
      .catch(() => setMembersError(true));
  };

  if (!activeId || !conv) {
    return <div className="details details--empty">Sélectionnez une conversation</div>;
  }

  const isGroup = conv.kind === "group";
  const isAdmin = members.find((m) => m.user_id === myId)?.role === "admin";
  const addable = friends.filter((f) => !members.some((m) => m.user_id === f.user_id));

  // Prefer a friend's live presence, else the presence store (covers non-friend group
  // members, who otherwise always looked offline), else offline.
  const presenceOf = (userId: string): PresenceStatus =>
    userId === myId
      ? myStatus
      : friends.find((f) => f.user_id === userId)?.presence ?? presences[userId] ?? "OFFLINE";

  // Custom status text: mine locally, peers' via the /friends pull (or the WS
  // store as a fallback — self-only today, so effectively friends carry it).
  const statusTextOf = (userId: string): string =>
    userId === myId
      ? myStatusText
      : (friends.find((f) => f.user_id === userId)?.status_text ?? statusTexts[userId] ?? "");

  const online = members.filter((m) => presenceOf(m.user_id) !== "OFFLINE");
  const offline = members.filter((m) => presenceOf(m.user_id) === "OFFLINE");

  const reloadMembers = async () => {
    const r = await client.conversationMembers(activeId).catch(() => null);
    if (r) setMembers(r.members);
  };
  const doAdd = async (userId: string) => {
    await addMember(activeId, userId);
    await reloadMembers();
  };
  const doRemove = async (member: MemberDto) => {
    if (
      await confirm({
        title: `Retirer ${member.display_name?.trim() || member.username} ?`,
        description: "Ce membre sera retiré du groupe et perdra l'accès aux prochains messages.",
        confirmLabel: "Retirer",
        danger: true,
      })
    ) {
      await removeMember(activeId, member.user_id);
      await reloadMembers();
    }
  };
  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (newName.trim()) void renameGroup(activeId, newName.trim());
    setRenaming(false);
  };

  const onPickGroupAvatar = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAvatarBusy(true);
    try {
      const { blob, mime } = await processAvatar(file);
      await uploadGroupAvatar(activeId, blob, mime);
    } catch (err) {
      toast({
        title: "Échec de l'avatar",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveDescription = (e: FormEvent) => {
    e.preventDefault();
    setDescEditing(false);
    void updateGroupProfile(activeId, { description: descDraft.trim() }).catch(() =>
      toast({ title: "Échec de la mise à jour de la description" }),
    );
  };

  const memberRow = (m: MemberDto) => {
    const presence = presenceOf(m.user_id);
    const shownName = m.display_name?.trim() || m.username;
    return (
      <div key={m.user_id} className="details__member" data-offline={presence === "OFFLINE"}>
        <ProfileDialog
          userId={m.user_id}
          name={shownName}
          isMe={m.user_id === myId}
          triggerClassName="details__member-trigger"
        >
          <>
            <Avatar name={shownName} size={36} presence={presence} src={m.avatar_url} />
            <div className="details__member-body">
              <span className="details__member-name">
                {shownName}
                {m.user_id === myId ? " (vous)" : ""}
              </span>
              <span className="details__member-status">
                {statusTextOf(m.user_id) || STATUS_LABEL[presence]}
              </span>
            </div>
          </>
        </ProfileDialog>
        {m.role === "admin" && (
          <span className="details__role" title="Admin">
            <Icon name="crown-simple" size={16} />
          </span>
        )}
        {isGroup && isAdmin && m.user_id !== myId && (
          <IconButton aria-label={`Retirer ${m.username}`} onClick={() => void doRemove(m)}>
            <Icon name="x" size={16} />
          </IconButton>
        )}
      </div>
    );
  };

  return (
    <div className="details">
      {isGroup && (conv.avatar_url || conv.description) && (
        <div className="details__group-head">
          {conv.avatar_url && <Avatar name={title ?? "Groupe"} size={48} src={conv.avatar_url} />}
          {conv.description && <p className="details__description">{conv.description}</p>}
        </div>
      )}

      <h2 className="details__title">Membres</h2>

      {membersError && members.length === 0 && (
        <div className="details__members-error">
          <p>Impossible de charger les membres.</p>
          <Button size="sm" variant="outline" onClick={retryMembers}>
            Réessayer
          </Button>
        </div>
      )}

      {online.length > 0 && (
        <>
          <div className="details__section-label">En ligne — {online.length}</div>
          {online.map(memberRow)}
        </>
      )}
      {offline.length > 0 && (
        <>
          <div className="details__section-label">Hors ligne — {offline.length}</div>
          {offline.map(memberRow)}
        </>
      )}

      {pinnedMsgs.length > 0 && (
        <div className="details__pins">
          <div className="details__section-label">Épinglés — {pinnedMsgs.length}</div>
          {pinnedMsgs.map((m) => (
            <button
              key={m.id}
              type="button"
              className="details__pin"
              title="Aller au message"
              onClick={() => setSearchScrollTo(m.id)}
            >
              <Icon name="push-pin" size={14} />
              <span className="details__pin-text">
                {m.content?.text?.slice(0, 90) || "Pièce jointe"}
              </span>
            </button>
          ))}
        </div>
      )}

      {isGroup && isAdmin && addable.length > 0 && (
        <>
          <div className="details__section-label">Ajouter un ami</div>
          {addable.map((f) => (
            <div key={f.user_id} className="details__member">
              <Avatar name={f.username} size={36} presence={f.presence} />
              <div className="details__member-body">
                <span className="details__member-name">{f.username}</span>
              </div>
              <Button size="sm" onClick={() => void doAdd(f.user_id)}>
                Ajouter
              </Button>
            </div>
          ))}
        </>
      )}

      {isGroup && isAdmin && (
        <div className="details__rename">
          {renaming ? (
            <form className="details__rename" onSubmit={rename} style={{ width: "100%" }}>
              <Field
                label="Renommer"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <Button size="sm" type="submit">
                OK
              </Button>
            </form>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setNewName(title ?? "");
                setRenaming(true);
              }}
            >
              Renommer le groupe
            </Button>
          )}
          {descEditing ? (
            <form className="details__rename" onSubmit={saveDescription} style={{ width: "100%" }}>
              <Field
                label="Description"
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
              />
              <Button size="sm" type="submit">
                OK
              </Button>
            </form>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDescDraft(conv.description ?? "");
                setDescEditing(true);
              }}
            >
              Modifier la description
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={avatarBusy}
            onClick={() => groupAvatarRef.current?.click()}
          >
            {avatarBusy ? "Envoi…" : "Changer l'avatar"}
          </Button>
          <input
            ref={groupAvatarRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => void onPickGroupAvatar(e)}
          />
        </div>
      )}

    </div>
  );
}
