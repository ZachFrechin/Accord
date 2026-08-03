/** Réglages du groupe, dans un menu de l'en-tête.
 *
 * Ces actions vivaient dans la barre des membres, où elles n'avaient rien à
 * faire : cette colonne sert à voir qui est là, pas à administrer. Des boutons
 * à libellé long y débordaient de la largeur — « Modifier la description » était
 * tronqué — et rien n'indiquait qu'il fallait chercher un réglage à cet endroit.
 *
 * Une roue crantée dans l'en-tête est le geste attendu partout ailleurs.
 */

import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";

import type { MemberDto } from "../../api/ApiClient";
import {
  addMember,
  renameGroup,
  updateGroupProfile,
  uploadGroupAvatar,
} from "../../stores/messagingActions";
import { processAvatar } from "../profile/ProfileSection";
import { useConnection } from "../../realtime/ConnectionProvider";
import { useConversationsStore } from "../../stores/useConversationsStore";
import { useFriendsStore } from "../../stores/useFriendsStore";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import { Button, Field, Icon, Popover, useToast } from "../ui";
import { Avatar } from "./Avatar";

export function GroupSettings({ conversationId }: { conversationId: string }) {
  const { client } = useConnection();
  const { toast } = useToast();
  const conv = useConversationsStore((s) => s.conversations.find((c) => c.id === conversationId));
  const title = useConversationsStore((s) => s.titles[conversationId]);
  const friends = useFriendsStore((s) => s.friends);
  const myId = useInstanceStore((s) => activeInstance(s)?.account?.userId ?? null);

  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [descEditing, setDescEditing] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarRef = useRef<HTMLInputElement>(null);

  // La liste des membres n'est chargée qu'à l'ouverture : elle ne sert qu'à
  // savoir si on peut administrer et qui reste à inviter.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void client
      .conversationMembers(conversationId)
      .then((r) => alive && setMembers(r.members))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, client, conversationId]);

  const isAdmin = members.find((m) => m.user_id === myId)?.role === "admin";
  const addable = friends.filter((f) => !members.some((m) => m.user_id === f.user_id));

  const reload = async (): Promise<void> => {
    const r = await client.conversationMembers(conversationId).catch(() => null);
    if (r) setMembers(r.members);
  };

  const rename = (e: FormEvent): void => {
    e.preventDefault();
    if (newName.trim()) void renameGroup(conversationId, newName.trim());
    setRenaming(false);
  };

  const saveDescription = (e: FormEvent): void => {
    e.preventDefault();
    setDescEditing(false);
    void updateGroupProfile(conversationId, { description: descDraft.trim() }).catch(() =>
      toast({ title: "Échec de la mise à jour de la description" }),
    );
  };

  const onPickAvatar = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAvatarBusy(true);
    try {
      const { blob, mime } = await processAvatar(file);
      await uploadGroupAvatar(conversationId, blob, mime);
    } catch (err) {
      toast({
        title: "Échec de l'avatar",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <Popover
      align="end"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          className="chat__action"
          type="button"
          title="Réglages du groupe"
          aria-label="Réglages du groupe"
        >
          <Icon name="gear" size={19} />
        </button>
      }
    >
      <div className="group-settings">
        <div className="group-settings__title">Réglages du groupe</div>

        {!isAdmin && (
          <p className="group-settings__hint">
            Seuls les administrateurs du groupe peuvent le modifier.
          </p>
        )}

        {isAdmin && (
          <>
            {renaming ? (
              <form className="group-settings__form" onSubmit={rename}>
                <Field label="Nom" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <Button size="sm" type="submit">
                  Enregistrer
                </Button>
              </form>
            ) : (
              <button
                className="group-settings__item"
                type="button"
                onClick={() => {
                  setNewName(title ?? "");
                  setRenaming(true);
                }}
              >
                <Icon name="pencil-simple" size={17} />
                Renommer le groupe
              </button>
            )}

            {descEditing ? (
              <form className="group-settings__form" onSubmit={saveDescription}>
                <Field
                  label="Description"
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                />
                <Button size="sm" type="submit">
                  Enregistrer
                </Button>
              </form>
            ) : (
              <button
                className="group-settings__item"
                type="button"
                onClick={() => {
                  setDescDraft(conv?.description ?? "");
                  setDescEditing(true);
                }}
              >
                <Icon name="text-aa" size={17} />
                Modifier la description
              </button>
            )}

            <button
              className="group-settings__item"
              type="button"
              disabled={avatarBusy}
              onClick={() => avatarRef.current?.click()}
            >
              <Icon name="image" size={17} />
              {avatarBusy ? "Envoi…" : "Changer l'avatar"}
            </button>
            <input
              ref={avatarRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(e) => void onPickAvatar(e)}
            />

            {addable.length > 0 && (
              <>
                <div className="group-settings__label">Ajouter un ami</div>
                <div className="group-settings__people">
                  {addable.map((f) => (
                    <div key={f.user_id} className="group-settings__person">
                      <Avatar name={f.username} size={28} presence={f.presence} src={f.avatar_url} />
                      <span className="group-settings__person-name">{f.username}</span>
                      <Button
                        size="sm"
                        onClick={() => void addMember(conversationId, f.user_id).then(reload)}
                      >
                        Ajouter
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Popover>
  );
}
