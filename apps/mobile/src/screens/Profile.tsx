/**
 * Profil : ce que les autres voient de vous, modifiable depuis le téléphone.
 *
 * Photo (prise dans la galerie ou l'appareil photo), nom affiché, description.
 * Les appels d'API sont ceux du bureau — l'envoi de la photo passe par un
 * ticket signé, l'image ne transite jamais par le serveur d'application.
 */

import { useEffect, useRef, useState } from "react";

import type { LeaderboardEntry, LevelDto, ProfileDto, SessionDto } from "@accord/core/api/ApiClient";
import { levelProgress, nextRank, rankForLevel } from "@accord/core/lib/levels";
import { setPresenceStatus } from "@accord/core/stores/messagingActions";
import { usePresenceStore } from "@accord/core/stores/usePresenceStore";
import { Icon } from "@accord/core/ui/Icon";
import { useConnection } from "@accord/core/realtime/ConnectionProvider";
import { activeInstance, useInstanceStore } from "@accord/core/stores/useInstanceStore";
import { useSessionStore } from "@accord/core/stores/useSessionStore";

import { Avatar } from "../ui/Avatar";
import { Appearance } from "./Appearance";
import { Admin, Backup, Changelog, Notifications } from "./More";

export function Profile() {
  const { client } = useConnection();
  const instance = useInstanceStore(activeInstance);
  const username = instance?.account?.username ?? "Compte";

  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<
    | "profil"
    | "apparence"
    | "compte"
    | "classement"
    | "notifications"
    | "sauvegarde"
    | "nouveautes"
    | "admin"
  >("profil");
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [level, setLevel] = useState<LevelDto | null>(null);
  const myStatus = usePresenceStore((st) => st.myStatus);
  const fileRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);

  const userId = instance?.account?.userId;
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    void client
      .getProfile(userId)
      .then((p) => {
        if (!alive) return;
        setProfile(p);
        setDisplayName(p.display_name ?? "");
        setBio(p.bio ?? "");
      })
      .catch(() => {});
    void client.levelsMe().then((l) => alive && setLevel(l)).catch(() => {});
    void client.sessions().then((x) => alive && setSessions(x)).catch(() => {});
    void client
      .leaderboard("week", 20)
      .then((r) => alive && setBoard(r.items))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, userId]);

  async function save(): Promise<void> {
    setBusy(true);
    setSaved(false);
    try {
      const next = await client.updateProfile({
        display_name: displayName.trim(),
        bio: bio.trim(),
      });
      setProfile(next);
      setSaved(true);
    } catch {
      /* le champ garde la saisie ; l'utilisateur peut réessayer */
    } finally {
      setBusy(false);
    }
  }

  /** Envoi d'une image : ticket signé, dépôt direct, puis validation.
   * L'image ne transite jamais par le serveur d'application. */
  async function uploadImage(file: File, kind: "avatar" | "banner"): Promise<void> {
    setBusy(true);
    try {
      const ticket =
        kind === "avatar"
          ? await client.requestAvatarUpload(file.size)
          : await client.requestBannerUpload(file.size);
      await fetch(ticket.upload_url, { method: "PUT", body: file });
      setProfile(
        kind === "avatar"
          ? await client.commitAvatar(ticket.version)
          : await client.commitBanner(ticket.version),
      );
    } catch {
      /* échec silencieux : l'image précédente reste en place */
    } finally {
      setBusy(false);
    }
  }

  const shown = displayName.trim() || username;

  return (
    <div className="screen">
      <header className="topbar">
        <h1 className="topbar__title">Profil</h1>
      </header>

      {/* Les onglets défilent : sept entrées ne tiennent pas sur une largeur
          de téléphone, et les tronquer les rendrait illisibles. */}
      <div className="seg seg--scroll" role="tablist">
        {([
          ["profil", "Profil"],
          ["apparence", "Apparence"],
          ["compte", "Compte"],
          ["classement", "Classement"],
          ["notifications", "Notifications"],
          ["sauvegarde", "Sauvegarde"],
          ["nouveautes", "Nouveautés"],
          ["admin", "Admin"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-active={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "apparence" && <Appearance />}
      {tab === "notifications" && <Notifications />}
      {tab === "sauvegarde" && <Backup />}
      {tab === "nouveautes" && <Changelog />}
      {tab === "admin" && <Admin />}

      {(tab === "profil" || tab === "compte" || tab === "classement") && (
      <div className="page">
        {tab === "profil" && (
          <>
        <button
          type="button"
          className="banner"
          onClick={() => bannerRef.current?.click()}
          aria-label="Changer la bannière"
        >
          {profile?.banner_url ? <img src={profile.banner_url} alt="" /> : <span className="banner__empty" />}
          <span className="banner__edit"><Icon name="camera" size={15} /></span>
        </button>
        <div className="profile-hero">
          <button
            type="button"
            className="profile-hero__avatar"
            onClick={() => fileRef.current?.click()}
            aria-label="Changer la photo"
          >
            <Avatar name={shown} size={92} src={profile?.avatar_url} />
            <span className="profile-hero__edit">
              <Icon name="camera" size={15} />
            </span>
          </button>
          <h2 className="brand__name">{shown}</h2>
          <p className="brand__sub">@{profile?.username ?? username}</p>
          {(profile?.avatar_url || profile?.banner_url) && (
            <div className="hero-actions">
              {profile?.avatar_url && (
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => void client.deleteAvatar().then(setProfile).catch(() => {})}
                >
                  Retirer la photo
                </button>
              )}
              {profile?.banner_url && (
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => void client.deleteBanner().then(setProfile).catch(() => {})}
                >
                  Retirer la bannière
                </button>
              )}
            </div>
          )}
        </div>

        {level && (
          <div className="card">
            <div className="pcard__level">
              <img className="pcard__rank" src={rankForLevel(level.level).img} alt="" />
              <div className="pcard__level-body">
                <span className="pcard__level-line">
                  <strong>{rankForLevel(level.level).name}</strong> · niveau {level.level}
                </span>
                {(() => {
                  const p = levelProgress(level.xp);
                  const next = nextRank(level.level);
                  return (
                    <>
                      <span className="pcard__bar">
                        <span
                          className="pcard__bar-fill"
                          style={{ width: `${Math.min(100, Math.round((p.into / p.needed) * 100))}%` }}
                        />
                      </span>
                      <span className="pcard__game-sub">
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

        <div className="card">
          <span className="field__label">Présence</span>
          <div className="seg seg--inline">
            {([
              ["ONLINE", "En ligne"],
              ["AWAY", "Absent"],
              ["DND", "Ne pas déranger"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                data-active={myStatus === value}
                onClick={() => setPresenceStatus(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <label className="field">
            <span className="field__label">Nom affiché</span>
            <input
              className="field__input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={username}
              enterKeyHint="done"
            />
          </label>
          <label className="field">
            <span className="field__label">À propos</span>
            <textarea
              className="field__input field__input--area"
              value={bio}
              rows={3}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Quelques mots sur vous"
            />
          </label>
          <button className="btn" type="button" disabled={busy} onClick={() => void save()}>
            {busy ? "Enregistrement…" : saved ? "Enregistré" : "Enregistrer"}
          </button>
        </div>
          </>
        )}

        {tab === "compte" && (
          <>

        <div className="card">
          <div className="row">
            <span className="row__label">Serveur</span>
            <span className="row__value">{instance?.url.replace(/^https?:\/\//, "")}</span>
          </div>
          <div className="row">
            <span className="row__label">Chiffrement</span>
            <span className="row__value">
              <Icon name="lock" size={14} /> Bout en bout (MLS)
            </span>
          </div>
        </div>

        <div className="card">
          <span className="field__label">Appareils connectés</span>
          {sessions.length === 0 && <p className="hint">Aucune autre session.</p>}
          {sessions.map((sess) => (
            <div key={sess.id} className="row">
              <span className="row__label" style={{ flex: 1, minWidth: 0 }}>
                {sess.user_agent || "Appareil inconnu"}
              </span>
              <button
                type="button"
                className="iconbtn"
                aria-label="Révoquer cette session"
                onClick={() => {
                  void client
                    .revokeSession(sess.id)
                    .then(() => setSessions((p) => p.filter((x) => x.id !== sess.id)))
                    .catch(() => {});
                }}
              >
                <Icon name="x" size={17} />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => instance && useSessionStore.getState().markUnauthed(instance.id)}
        >
          <Icon name="sign-out" size={18} /> Se déconnecter
        </button>
          </>
        )}

        {tab === "classement" && (
          <div className="card">
            <span className="field__label">Cette semaine</span>
            {board.length === 0 && <p className="hint">Personne au classement pour l'instant.</p>}
            {board.map((e, i) => {
              const who = e.display_name?.trim() || e.username;
              return (
                <div key={e.user_id} className="board-row">
                  <span className="board-row__pos" data-podium={i < 3 ? i + 1 : undefined}>
                    {i + 1}
                  </span>
                  <Avatar name={who} size={34} src={e.avatar_url} />
                  <span className="board-row__body">
                    <span className="conv__title">{who}</span>
                    <span className="conv__sub">
                      {rankForLevel(e.level).name} · niveau {e.level}
                    </span>
                  </span>
                  <img className="board-row__rank" src={rankForLevel(e.level).img} alt="" />
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      <input
        ref={bannerRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void uploadImage(f, "banner");
        }}
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void uploadImage(f, "avatar");
        }}
      />
    </div>
  );
}
