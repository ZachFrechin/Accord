/** Full profile view, opened by clicking a person's avatar or name anywhere in
 * the app. Unlike a compact hovercard, this is the complete profile page: the
 * banner, a large avatar, display name + @handle, presence, custom status, bio,
 * and a primary action (message them, or edit your own profile). Presence for
 * peers comes from the live store; a DM action opens the direct conversation. */

import * as RadixDialog from "@radix-ui/react-dialog";
import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import type { GameAccount, LevelDto, ProfileDto } from "../../api/ApiClient";
import {
  GAME_LABELS,
  faceitLevel,
  faceitLevelColor,
  faceitRankLabel,
  lolRankLabel,
  lolTierImg,
} from "../../lib/games";
import { verifyPeerKey } from "../../lib/keyTransparency";
import { levelProgress, nextRank, rankForLevel } from "../../lib/levels";
import { useConnection } from "../../realtime/ConnectionProvider";
import type { PresenceStatus } from "../../realtime/wireSchema";
import { useFriendsStore } from "../../stores/useFriendsStore";
import { openDmWith } from "../../stores/messagingActions";
import { useOngoingCallsStore } from "../../stores/useOngoingCallsStore";
import { usePresenceStore } from "../../stores/usePresenceStore";
import { Icon } from "../ui";
import { Avatar, hueFor } from "./Avatar";

/** How another person's status reads (self uses "Invisible" for OFFLINE elsewhere). */
const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  ONLINE: "En ligne",
  AWAY: "Absent",
  DND: "Ne pas déranger",
  OFFLINE: "Hors ligne",
};

export function ProfileDialog({
  userId,
  name,
  isMe,
  children,
  triggerClassName = "msg__avatar-btn",
}: {
  userId: string | null;
  name: string;
  isMe: boolean;
  /** The trigger (the inline avatar, or the author name). */
  children: ReactNode;
  /** Class for the trigger button (defaults to the avatar button). */
  triggerClassName?: string;
}) {
  const navigate = useNavigate();
  const { client } = useConnection();
  const peerStatus = usePresenceStore((s) => (userId ? s.statuses[userId] : undefined));
  const myStatus = usePresenceStore((s) => s.myStatus);
  const myStatusText = usePresenceStore((s) => s.myStatusText);
  // Peers' custom text arrives via the /friends pull (PRESENCE_UPDATE is self-only).
  const friendText = useFriendsStore((s) =>
    userId ? s.friends.find((f) => f.user_id === userId)?.status_text : undefined,
  );
  const presence: PresenceStatus = isMe ? myStatus : (peerStatus ?? "OFFLINE");
  const statusText = (isMe ? myStatusText : friendText) ?? "";
  // Live activity: is this person currently in a call we know about (any
  // shared conversation)? Updates in real time while the dialog is open.
  const inCall = useOngoingCallsStore((s) =>
    userId ? Object.values(s.calls).some((c) => c.participants.includes(userId)) : false,
  );

  // Fetch the fuller profile (display name / bio / banner / accent) when it opens.
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [level, setLevel] = useState<LevelDto | null>(null);
  const [games, setGames] = useState<GameAccount[]>([]);
  useEffect(() => {
    if (!open || !userId) return;
    let alive = true;
    client
      .getProfile(userId)
      .then((p) => alive && setProfile(p))
      .catch(() => {});
    client
      .userLevel(userId)
      .then((l) => alive && setLevel(l))
      .catch(() => {});
    client
      .userGames(userId)
      .then((g) => alive && setGames(g.accounts))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, userId, client]);

  // Key transparency (Phase 3 · Lot 6): prove each of the peer's published device
  // keys is really in the append-only log, anchored to a signed head.
  const [ktStatus, setKtStatus] = useState<"loading" | "verified" | "unverified" | null>(null);
  useEffect(() => {
    if (!open || !userId || isMe) {
      setKtStatus(null);
      return;
    }
    let alive = true;
    setKtStatus("loading");
    (async () => {
      try {
        const bundle = await client.keyBundle(userId);
        if (!alive) return;
        if (bundle.devices.length === 0) {
          setKtStatus(null); // no published keys yet → nothing to attest
          return;
        }
        const results = await Promise.all(
          bundle.devices.map((d) => verifyPeerKey(client, userId, d.device_id, d.public_key)),
        );
        if (alive) setKtStatus(results.every((r) => r.ok) ? "verified" : "unverified");
      } catch {
        if (alive) setKtStatus(null); // transparency unreachable → show nothing
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, userId, isMe, client]);

  const displayName = profile?.display_name?.trim() || name;
  const handle = profile?.username ?? name;
  const bio = profile?.bio?.trim();
  const accent = profile?.accent_color ?? undefined;

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Trigger asChild>
        <button type="button" className={triggerClassName} aria-label={`Profil de ${name}`}>
          {children}
        </button>
      </RadixDialog.Trigger>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog__overlay" />
        <RadixDialog.Content
          className="profile-view"
          style={{ ["--accent" as string]: accent }}
        >
          <RadixDialog.Close className="profile-view__close" aria-label="Fermer">
            <Icon name="x" size={18} />
          </RadixDialog.Close>

          <div className="profile-view__banner" data-empty={!profile?.banner_url}>
            {profile?.banner_url && <img src={profile.banner_url} alt="" />}
          </div>

          <div className="profile-view__body">
            <div className="profile-view__avatar">
              <Avatar
                name={displayName}
                size={88}
                presence={userId ? presence : undefined}
                src={profile?.avatar_url}
              />
            </div>

            <RadixDialog.Title asChild>
              <h2
                className="profile-view__name"
                style={{ ["--author-h" as string]: hueFor(displayName) }}
              >
                {displayName}
                {ktStatus === "verified" && (
                  <span
                    className="profile-view__verified"
                    title="Clés attestées par le journal de transparence"
                  >
                    <Icon name="seal-check" size={18} />
                  </span>
                )}
              </h2>
            </RadixDialog.Title>
            <p className="profile-view__handle">@{handle}</p>

            <div className="profile-view__presence" data-status={presence}>
              <span className="profile-view__dot" />
              {isMe ? "Vous" : PRESENCE_LABEL[presence]}
            </div>

            {statusText && <p className="profile-view__custom">{statusText}</p>}

            {inCall && (
              <div className="profile-view__activity">
                <span className="profile-view__activity-pulse" />
                <Icon name="phone" size={14} />
                {isMe ? "Vous êtes en appel" : "En appel en ce moment"}
              </div>
            )}

            {(profile?.is_admin || (profile?.roles?.length ?? 0) > 0) && (
              <div className="profile-view__section">
                <span className="profile-view__section-label">Rôles</span>
                <div className="profile-view__roles">
                  {profile?.is_admin && (
                    <span className="profile-view__role profile-view__role--admin">
                      <Icon name="crown-simple" size={12} /> Admin
                    </span>
                  )}
                  {profile?.roles?.map((r) => (
                    <span
                      key={r.id}
                      className="profile-view__role"
                      style={r.color ? { ["--role-c" as string]: r.color } : undefined}
                    >
                      <span className="profile-view__role-dot" /> {r.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {level && (
              <div className="profile-view__section">
                <span className="profile-view__section-label">Niveau</span>
                <div className="profile-view__level">
                  <img
                    className="profile-view__rank-img"
                    src={rankForLevel(level.level).img}
                    alt=""
                    title={rankForLevel(level.level).name}
                  />
                  <div className="profile-view__level-body">
                    <span className="profile-view__level-line">
                      <strong>{rankForLevel(level.level).name}</strong> · niveau {level.level}
                    </span>
                    {(() => {
                      const p = levelProgress(level.xp);
                      const next = nextRank(level.level);
                      return (
                        <>
                          <div
                            className="profile-view__level-bar"
                            role="progressbar"
                            aria-valuenow={p.into}
                            aria-valuemax={p.needed}
                          >
                            <div
                              className="profile-view__level-fill"
                              style={{ width: `${Math.min(100, Math.round((p.into / p.needed) * 100))}%` }}
                            />
                          </div>
                          <span className="profile-view__level-sub">
                            {p.into.toLocaleString("fr-FR")} / {p.needed.toLocaleString("fr-FR")} XP
                            {next ? ` — ${next.name} au niveau ${next.minLevel}` : " — rang maximal"}
                          </span>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}

            {games.length > 0 && (
              <div className="profile-view__section">
                <span className="profile-view__section-label">Jeux</span>
                <div className="profile-view__games">
                  {games.map((g) => (
                    <div key={g.game} className="profile-view__game">
                      {g.game === "lol" && lolTierImg(g.rank) ? (
                        <img className="profile-view__game-emblem" src={lolTierImg(g.rank)!} alt="" />
                      ) : g.game === "cs2" ? (
                        <span
                          className="profile-view__faceit"
                          style={{ ["--faceit-c" as string]: faceitLevelColor(faceitLevel(g.rank)) }}
                        >
                          {faceitLevel(g.rank) || "?"}
                        </span>
                      ) : (
                        <span className="profile-view__game-emblem profile-view__game-emblem--empty" />
                      )}
                      <div className="profile-view__game-body">
                        <span className="profile-view__game-rank">
                          {g.game === "lol"
                            ? lolRankLabel(g.rank)
                            : g.game === "cs2"
                              ? faceitRankLabel(g.rank)
                              : "—"}
                        </span>
                        <span className="profile-view__game-sub">
                          {GAME_LABELS[g.game] ?? g.game} · {g.external_name}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="profile-view__section">
              <span className="profile-view__section-label">À propos</span>
              {bio ? (
                <p className="profile-view__bio">{bio}</p>
              ) : (
                <p className="profile-view__bio profile-view__bio--empty">
                  Aucune description pour le moment.
                </p>
              )}
            </div>

            {isMe ? (
              <RadixDialog.Close asChild>
                <button
                  type="button"
                  className="profile-view__action"
                  onClick={() => navigate("/settings")}
                >
                  <Icon name="gear" size={16} />
                  Modifier mon profil
                </button>
              </RadixDialog.Close>
            ) : userId ? (
              <>
                <RadixDialog.Close asChild>
                  <button
                    type="button"
                    className="profile-view__action"
                    onClick={() => {
                      void openDmWith(userId);
                      navigate("/");
                    }}
                  >
                    <Icon name="chat-circle-dots" size={16} />
                    Envoyer un message
                  </button>
                </RadixDialog.Close>
              </>
            ) : null}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
