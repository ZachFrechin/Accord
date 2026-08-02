/**
 * The left rail — brand blob, connected-instance switcher, and quick actions.
 *
 * Each connected instance is a button that switches the active instance (without
 * logging out). A "+" opens onboarding to add another server; the bottom holds
 * settings and the current account avatar.
 */

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { hasUnseenChangelog } from "../../lib/changelog";
import { useConnection } from "../../realtime/ConnectionProvider";
import { useFriendsStore } from "../../stores/useFriendsStore";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import { usePresenceStore } from "../../stores/usePresenceStore";
import { useSessionStore } from "../../stores/useSessionStore";
import { useUiStore } from "../../stores/useUiStore";
import { Icon, Popover } from "../ui";
import { Avatar } from "../messaging/Avatar";
import { PresenceMenu } from "./PresenceMenu";
import "./InstanceRail.css";

export function InstanceRail() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const instances = useInstanceStore((s) => s.instances);
  const activeId = useInstanceStore((s) => s.activeInstanceId);
  const active = useInstanceStore(activeInstance);
  const setActive = useInstanceStore((s) => s.setActive);
  const authed = useSessionStore((s) => s.authed);
  const openOnboarding = useUiStore((s) => s.openOnboarding);
  const openCustomize = useUiStore((s) => s.openCustomize);
  const myStatus = usePresenceStore((s) => s.myStatus);
  const incoming = useFriendsStore((s) => s.incoming);
  const { client } = useConnection();

  const isAdmin = active?.account?.role === "admin";
  // Custom roles can grant panel access too: one probe per instance session
  // reveals the shield to role-holders (the backend stays the authority).
  const [panelOk, setPanelOk] = useState(false);
  useEffect(() => {
    setPanelOk(false);
    if (isAdmin) return;
    let alive = true;
    client
      .adminStats()
      .then(() => alive && setPanelOk(true))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, isAdmin, activeId]);
  const connected = instances.filter((i) => authed[i.id]);
  const profileName = active?.account?.username ?? active?.displayName ?? "Compte";

  // My own avatar for the rail (best-effort; refreshes on instance switch).
  const [myAvatar, setMyAvatar] = useState<string | null>(null);
  const myUserId = active?.account?.userId;
  useEffect(() => {
    if (!myUserId) {
      setMyAvatar(null);
      return;
    }
    let alive = true;
    client
      .getProfile(myUserId)
      .then((p) => alive && setMyAvatar(p.avatar_url))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, myUserId]);

  return (
    <div className="instance-rail">
      <button
        type="button"
        className="instance-rail__brand"
        title="Accord"
        aria-label="Accord"
        onClick={() => navigate("/")}
      >
        <Icon name="chat-circle-dots" size={22} />
      </button>

      <div className="instance-rail__divider" />

      {connected.map((i) => (
        <button
          key={i.id}
          type="button"
          className="instance-rail__item"
          data-active={i.id === activeId}
          title={i.displayName}
          onClick={() => setActive(i.id)}
        >
          {initials(i.displayName)}
        </button>
      ))}
      <button
        type="button"
        className="instance-rail__add"
        title="Ajouter un serveur"
        aria-label="Ajouter un serveur"
        onClick={openOnboarding}
      >
        <Icon name="plus" size={20} />
      </button>

      <div className="instance-rail__spacer" />

      <button
        type="button"
        className="instance-rail__nav"
        data-active={pathname === "/friends"}
        title="Amis"
        aria-label="Amis"
        onClick={() => navigate("/friends")}
      >
        <Icon name="users-three" size={22} />
        {incoming.length > 0 && (
          <span className="instance-rail__badge">{incoming.length > 9 ? "9+" : incoming.length}</span>
        )}
      </button>
      <button
        type="button"
        className="instance-rail__nav"
        data-active={pathname === "/leaderboard"}
        title="Classement"
        aria-label="Classement"
        onClick={() => navigate("/leaderboard")}
      >
        <Icon name="chart-bar" size={21} />
      </button>
      {(isAdmin || panelOk) && (
        <button
          type="button"
          className="instance-rail__nav"
          data-active={pathname === "/admin"}
          title="Administration"
          aria-label="Administration"
          onClick={() => navigate("/admin")}
        >
          <Icon name="shield-check" size={21} />
        </button>
      )}
      <button
        type="button"
        className="instance-rail__nav"
        data-active={pathname === "/changelog"}
        title="Nouveautés"
        aria-label="Nouveautés"
        onClick={() => navigate("/changelog")}
      >
        <Icon name="sparkle" size={21} />
        {pathname !== "/changelog" && hasUnseenChangelog() && (
          <span className="instance-rail__dot" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="instance-rail__nav"
        title="Personnaliser l'apparence"
        aria-label="Personnaliser l'apparence"
        onClick={openCustomize}
      >
        <Icon name="paint-brush" size={20} />
      </button>
      <button
        type="button"
        className="instance-rail__nav"
        title="Paramètres"
        aria-label="Paramètres"
        onClick={() => navigate("/settings")}
      >
        <Icon name="gear" size={22} />
      </button>
      <Popover
        side="right"
        align="end"
        trigger={
          <button
            type="button"
            className="instance-rail__avatar"
            title={profileName}
            aria-label="Compte et présence"
          >
            <Avatar name={profileName} size={36} presence={myStatus} src={myAvatar} />
          </button>
        }
      >
        <PresenceMenu
          name={profileName}
          subtitle={active?.url}
          avatarUrl={myAvatar}
          onOpenSettings={() => navigate("/settings")}
        />
      </Popover>
    </div>
  );
}

/** Selector re-exported for callers that only need the active instance name. */
export { activeInstance };

function initials(name: string): string {
  return name.replace(/^https?:\/\//, "").slice(0, 2).toUpperCase();
}
