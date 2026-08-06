/**
 * Fiche d'une personne, ouverte en touchant son avatar ou son nom.
 *
 * Reprend ce que montre le bureau : bannière, photo, nom, rôles de l'instance,
 * niveau et rangs de jeu, description — plus l'action qui compte sur téléphone,
 * envoyer un message.
 */

import { useEffect, useState } from "react";

import { presenceOf as presenceFrom, usePresenceStore } from "@accord/core/stores/usePresenceStore";
import type { LevelDto, ProfileDto } from "@accord/core/api/ApiClient";
import { GAME_LABELS, faceitRankLabel, lolRankLabel, lolTierImg } from "@accord/core/lib/games";
import { levelProgress, rankForLevel } from "@accord/core/lib/levels";
import { Icon } from "@accord/core/ui/Icon";
import { useConnection } from "@accord/core/realtime/ConnectionProvider";
import { openDmWith } from "@accord/core/stores/messagingActions";

import { Avatar } from "./Avatar";
import { Sheet } from "./Sheet";

interface GameRow {
  game: string;
  external_name: string;
  rank: Record<string, unknown>;
}

export function ProfileSheet({
  userId,
  fallbackName,
  onClose,
  onOpenConversation,
}: {
  userId: string | null;
  fallbackName: string;
  onClose: () => void;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { client } = useConnection();
  const presenceState = usePresenceStore();
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [level, setLevel] = useState<LevelDto | null>(null);
  const [games, setGames] = useState<GameRow[]>([]);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setProfile(null);
    setLevel(null);
    setGames([]);
    void client.getProfile(userId).then((p) => alive && setProfile(p)).catch(() => {});
    void client.userLevel(userId).then((l) => alive && setLevel(l)).catch(() => {});
    void client
      .userGames(userId)
      .then((g) => alive && setGames(g.accounts as GameRow[]))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, userId]);

  const name = profile?.display_name?.trim() || profile?.username || fallbackName;

  return (
    <Sheet open={userId !== null} onClose={onClose}>
      <div className="pcard">
        {profile?.banner_url ? (
          <img className="pcard__banner" src={profile.banner_url} alt="" />
        ) : (
          <span className="pcard__banner pcard__banner--empty" />
        )}

        <div className="pcard__head">
          <Avatar
            name={name}
            size={76}
            src={profile?.avatar_url}
            presence={userId ? presenceFrom(presenceState, userId) : undefined}
          />
          <div className="pcard__id">
            <span className="pcard__name">
              {name}
              {profile?.is_admin && (
                <span className="pcard__crown" title="Administrateur">
                  <Icon name="crown-simple" size={14} />
                </span>
              )}
            </span>
            <span className="pcard__handle">@{profile?.username ?? fallbackName}</span>
          </div>
        </div>

        {(profile?.roles?.length ?? 0) > 0 && (
          <div className="pcard__chips">
            {profile?.roles?.map((r) => (
              <span
                key={r.id}
                className="chip"
                style={r.color ? { ["--chip-c" as string]: r.color } : undefined}
              >
                {r.name}
              </span>
            ))}
          </div>
        )}

        {level && (
          <div className="pcard__level">
            <img className="pcard__rank" src={rankForLevel(level.level).img} alt="" />
            <div className="pcard__level-body">
              <span className="pcard__level-line">
                <strong>{rankForLevel(level.level).name}</strong> · niveau {level.level}
              </span>
              {(() => {
                const p = levelProgress(level.xp);
                return (
                  <span className="pcard__bar">
                    <span
                      className="pcard__bar-fill"
                      style={{ width: `${Math.min(100, Math.round((p.into / p.needed) * 100))}%` }}
                    />
                  </span>
                );
              })()}
            </div>
          </div>
        )}

        {games.length > 0 && (
          <div className="pcard__games">
            {games.map((g) => (
              <div key={g.game} className="pcard__game">
                {g.game === "lol" && lolTierImg(g.rank) ? (
                  <img className="pcard__game-emblem" src={lolTierImg(g.rank)!} alt="" />
                ) : (
                  <span className="pcard__game-emblem" />
                )}
                <span className="pcard__game-body">
                  <span className="pcard__game-rank">
                    {g.game === "lol"
                      ? lolRankLabel(g.rank)
                      : g.game === "cs2"
                        ? faceitRankLabel(g.rank)
                        : "—"}
                  </span>
                  <span className="pcard__game-sub">
                    {GAME_LABELS[g.game] ?? g.game} · {g.external_name}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}

        {profile?.bio?.trim() && <p className="pcard__bio">{profile.bio}</p>}

        {userId && onOpenConversation && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              const target = userId;
              onClose();
              void openDmWith(target).then((id) => id && onOpenConversation(id));
            }}
          >
            <Icon name="chat-circle-dots" size={18} /> Envoyer un message
          </button>
        )}
      </div>
    </Sheet>
  );
}
