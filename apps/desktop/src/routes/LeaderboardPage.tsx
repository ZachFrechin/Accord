/**
 * Classement — le leaderboard XP de l'instance : top de la semaine ou de
 * toujours, avec rang in-app, niveau et XP. L'XP se gagne en discutant
 * (anti-spam serveur) et en appel à plusieurs.
 */

import { useEffect, useState } from "react";

import type { LeaderboardEntry } from "../api/ApiClient";
import { rankForLevel } from "../lib/levels";
import { Avatar } from "../components/messaging/Avatar";
import { ProfileDialog } from "../components/messaging/ProfileDialog";
import { EmptyState } from "../components/ui";
import { useConnection } from "../realtime/ConnectionProvider";
import { activeInstance, useInstanceStore } from "../stores/useInstanceStore";
import "./page.css";
import "./LeaderboardPage.css";

type Period = "week" | "all";

export default function LeaderboardPage() {
  const { client } = useConnection();
  const myUserId = useInstanceStore(activeInstance)?.account?.userId ?? null;
  const [period, setPeriod] = useState<Period>("week");
  const [items, setItems] = useState<LeaderboardEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setFailed(false);
    client
      .leaderboard(period)
      .then((res) => alive && setItems(res.items))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [client, period]);

  const name = (e: LeaderboardEntry) => e.display_name?.trim() || e.username;

  return (
    <div className="page">
      <div className="leaderboard">
        <header className="leaderboard__head">
          <h1 className="page__title">Classement</h1>
          <div className="leaderboard__periods" role="tablist" aria-label="Période">
            <button
              type="button"
              role="tab"
              aria-selected={period === "week"}
              data-active={period === "week"}
              onClick={() => setPeriod("week")}
            >
              Cette semaine
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={period === "all"}
              data-active={period === "all"}
              onClick={() => setPeriod("all")}
            >
              Depuis toujours
            </button>
          </div>
        </header>

        {failed ? (
          <EmptyState
            title="Classement indisponible"
            description="Impossible de charger le classement pour le moment."
          />
        ) : items === null ? (
          <p className="home__hint">Chargement…</p>
        ) : items.length === 0 ? (
          <EmptyState
            title="Personne au classement"
            description={
              period === "week"
                ? "Aucune XP gagnée cette semaine — envoyez un message !"
                : "L'aventure commence : discutez et passez des appels pour gagner de l'XP."
            }
          />
        ) : (
          <ol className="leaderboard__list">
            {items.map((e, i) => {
              const rank = rankForLevel(e.level);
              return (
                <li
                  key={e.user_id}
                  className="leaderboard__row"
                  data-me={e.user_id === myUserId}
                  data-podium={i < 3 ? i + 1 : undefined}
                >
                  <span className="leaderboard__pos">{i + 1}</span>
                  <ProfileDialog
                    userId={e.user_id}
                    name={name(e)}
                    isMe={e.user_id === myUserId}
                    triggerClassName="leaderboard__profile-btn"
                  >
                    <Avatar name={name(e)} size={34} src={e.avatar_url} />
                  </ProfileDialog>
                  <div className="leaderboard__id">
                    <span className="leaderboard__name">{name(e)}</span>
                    <span className="leaderboard__sub">
                      {rank.name} · niveau {e.level}
                    </span>
                  </div>
                  <img className="leaderboard__rank-img" src={rank.img} alt="" title={rank.name} />
                  <span className="leaderboard__xp">{e.xp.toLocaleString("fr-FR")} XP</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
