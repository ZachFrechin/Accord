/**
 * FriendsAside — the right panel while on the Amis page: every friend with
 * live presence and custom status, online first. Clicking one opens the DM.
 */

import { useNavigate } from "react-router";

import { openDmWith } from "../../stores/messagingActions";
import { useFriendsStore } from "../../stores/useFriendsStore";
import { Avatar } from "../messaging/Avatar";

export function FriendsAside() {
  const friends = useFriendsStore((s) => s.friends);
  const navigate = useNavigate();

  const online = friends.filter((f) => f.presence && f.presence !== "OFFLINE");
  const offline = friends.filter((f) => !f.presence || f.presence === "OFFLINE");

  const row = (f: (typeof friends)[number]) => (
    <button
      key={f.user_id}
      type="button"
      className="details__member details__member--btn"
      onClick={() => {
        void openDmWith(f.user_id);
        navigate("/");
      }}
      title={`Écrire à ${f.display_name?.trim() || f.username}`}
    >
      <Avatar
        name={f.display_name?.trim() || f.username}
        size={36}
        presence={f.presence}
        src={f.avatar_url}
      />
      <div className="details__member-body">
        <span className="details__member-name">{f.display_name?.trim() || f.username}</span>
        {f.status_text && <span className="details__member-sub">{f.status_text}</span>}
      </div>
    </button>
  );

  return (
    <div className="details">
      <h2 className="details__title">Amis</h2>
      {friends.length === 0 && (
        <p className="details__section-label">Aucun ami pour le moment.</p>
      )}
      {online.length > 0 && (
        <>
          <div className="details__section-label">En ligne — {online.length}</div>
          {online.map(row)}
        </>
      )}
      {offline.length > 0 && (
        <>
          <div className="details__section-label">Hors ligne — {offline.length}</div>
          {offline.map(row)}
        </>
      )}
    </div>
  );
}
