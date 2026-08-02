/**
 * Réglages → Jeux : lier ses comptes (LoL via Riot ID, CS2 via pseudo FACEIT)
 * pour afficher ses rangs sur le profil. Un jeu sans clé API serveur apparaît
 * « non configuré » ; Valorant et Rocket League arrivent en phase suivante.
 */

import { useCallback, useEffect, useState } from "react";

import type { GameAccount, GameAccountsMine } from "../../api/ApiClient";
import { ApiError } from "../../api/http";
import {
  GAME_LABELS,
  LOL_PLATFORMS,
  faceitLevel,
  faceitLevelColor,
  faceitRankLabel,
  lolRankLabel,
  lolTierImg,
} from "../../lib/games";
import { useConnection } from "../../realtime/ConnectionProvider";
import { Button, Field, useToast } from "../ui";

export function GameAccountsSection() {
  const { client } = useConnection();
  const { toast } = useToast();
  const [data, setData] = useState<GameAccountsMine | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [riotId, setRiotId] = useState("");
  const [platform, setPlatform] = useState("euw1");
  const [faceitNick, setFaceitNick] = useState("");

  const reload = useCallback(() => {
    client
      .gamesMine()
      .then(setData)
      .catch(() => {});
  }, [client]);
  useEffect(() => {
    reload();
  }, [reload]);

  const accountOf = (game: string): GameAccount | undefined =>
    data?.accounts.find((a) => a.game === game);
  const configured = (game: string): boolean => data?.configured[game] === true;

  const run = async (game: string, action: () => Promise<unknown>) => {
    setBusy(game);
    try {
      await action();
      reload();
    } catch (err) {
      toast({
        title: "Action impossible",
        description: err instanceof ApiError ? err.message : "Réessayez dans un instant.",
      });
    } finally {
      setBusy(null);
    }
  };

  const linkedCard = (game: string, acc: GameAccount, visual: React.ReactNode, rankText: string) => (
    <div className="games__linked">
      {visual}
      <div className="games__linked-body">
        <span className="games__linked-rank">{rankText}</span>
        <span className="games__linked-name">
          {acc.external_name}
          {acc.rank_updated_at &&
            ` · mis à jour le ${new Date(acc.rank_updated_at).toLocaleDateString("fr-FR")} à ${new Date(acc.rank_updated_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`}
        </span>
      </div>
      <div className="games__linked-actions">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy === game}
          onClick={() => void run(game, () => client.refreshGame(game))}
        >
          Actualiser
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy === game}
          onClick={() => void run(game, () => client.unlinkGame(game))}
        >
          Délier
        </Button>
      </div>
    </div>
  );

  const lolAcc = accountOf("lol");
  const cs2Acc = accountOf("cs2");

  return (
    <div className="games">
      <p className="home__hint">
        Liez vos comptes pour afficher vos rangs sur votre profil. Les clés API restent côté
        serveur ; vous pouvez délier à tout moment.
      </p>

      {/* ── League of Legends ── */}
      <section className="games__game">
        <h3 className="games__title">{GAME_LABELS.lol}</h3>
        {!configured("lol") ? (
          <p className="home__hint">Non configuré sur ce serveur (clé API Riot absente).</p>
        ) : lolAcc ? (
          linkedCard(
            "lol",
            lolAcc,
            lolTierImg(lolAcc.rank) ? (
              <img className="games__emblem" src={lolTierImg(lolAcc.rank)!} alt="" />
            ) : (
              <span className="games__emblem games__emblem--empty" />
            ),
            lolRankLabel(lolAcc.rank),
          )
        ) : (
          <form
            className="games__form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!riotId.trim()) return;
              void run("lol", () => client.linkGame("lol", { riot_id: riotId.trim(), platform }));
            }}
          >
            <Field
              label="Riot ID"
              value={riotId}
              onChange={(e) => setRiotId(e.target.value)}
              placeholder="Pseudo#TAG"
            />
            <label className="games__region">
              <span>Région</span>
              <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                {LOL_PLATFORMS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" type="submit" disabled={busy === "lol" || !riotId.trim()}>
              Lier
            </Button>
          </form>
        )}
      </section>

      {/* ── CS2 / FACEIT ── */}
      <section className="games__game">
        <h3 className="games__title">{GAME_LABELS.cs2}</h3>
        {!configured("cs2") ? (
          <p className="home__hint">Non configuré sur ce serveur (clé API FACEIT absente).</p>
        ) : cs2Acc ? (
          linkedCard(
            "cs2",
            cs2Acc,
            <span
              className="games__faceit-badge"
              style={{ ["--faceit-c" as string]: faceitLevelColor(faceitLevel(cs2Acc.rank)) }}
            >
              {faceitLevel(cs2Acc.rank) || "?"}
            </span>,
            faceitRankLabel(cs2Acc.rank),
          )
        ) : (
          <form
            className="games__form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!faceitNick.trim()) return;
              void run("cs2", () => client.linkGame("cs2", { nickname: faceitNick.trim() }));
            }}
          >
            <Field
              label="Pseudo FACEIT"
              value={faceitNick}
              onChange={(e) => setFaceitNick(e.target.value)}
              placeholder="votre pseudo FACEIT"
            />
            <Button size="sm" type="submit" disabled={busy === "cs2" || !faceitNick.trim()}>
              Lier
            </Button>
          </form>
        )}
      </section>

      {/* ── À venir ── */}
      <section className="games__game games__game--soon">
        <h3 className="games__title">{GAME_LABELS.valorant}</h3>
        <p className="home__hint">Bientôt disponible.</p>
      </section>
      <section className="games__game games__game--soon">
        <h3 className="games__title">{GAME_LABELS["rocket-league"]}</h3>
        <p className="home__hint">Bientôt disponible.</p>
      </section>
    </div>
  );
}
