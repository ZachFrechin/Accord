/**
 * Rangs de jeu — libellés français, emblèmes LoL et aides d'affichage.
 * Les payloads `rank` viennent du backend (connecteurs Riot/FACEIT).
 */

import bronze from "../assets/games/lol/bronze.png";
import challenger from "../assets/games/lol/challenger.png";
import diamond from "../assets/games/lol/diamond.png";
import emerald from "../assets/games/lol/emerald.png";
import gold from "../assets/games/lol/gold.png";
import grandmaster from "../assets/games/lol/grandmaster.png";
import iron from "../assets/games/lol/iron.png";
import master from "../assets/games/lol/master.png";
import platinum from "../assets/games/lol/platinum.png";
import silver from "../assets/games/lol/silver.png";

export const GAME_LABELS: Record<string, string> = {
  lol: "League of Legends",
  cs2: "CS2 · FACEIT",
  valorant: "Valorant",
  "rocket-league": "Rocket League",
};

export const LOL_TIERS: Record<string, { label: string; img: string }> = {
  IRON: { label: "Fer", img: iron },
  BRONZE: { label: "Bronze", img: bronze },
  SILVER: { label: "Argent", img: silver },
  GOLD: { label: "Or", img: gold },
  PLATINUM: { label: "Platine", img: platinum },
  EMERALD: { label: "Émeraude", img: emerald },
  DIAMOND: { label: "Diamant", img: diamond },
  MASTER: { label: "Maître", img: master },
  GRANDMASTER: { label: "Grand Maître", img: grandmaster },
  CHALLENGER: { label: "Challenger", img: challenger },
};

export const LOL_PLATFORMS: { id: string; label: string }[] = [
  { id: "euw1", label: "Europe Ouest" },
  { id: "eune1", label: "Europe Nord & Est" },
  { id: "na1", label: "Amérique du Nord" },
  { id: "kr", label: "Corée" },
  { id: "br1", label: "Brésil" },
  { id: "jp1", label: "Japon" },
  { id: "tr1", label: "Turquie" },
  { id: "oc1", label: "Océanie" },
];

interface LolRank {
  tier?: string;
  division?: string;
  lp?: number;
  wins?: number;
  losses?: number;
}

/** « Émeraude II · 54 LP » / « Maître · 210 LP » / « Non classé ». */
export function lolRankLabel(rank: Record<string, unknown>): string {
  const r = rank as LolRank;
  const tier = LOL_TIERS[r.tier ?? ""];
  if (!tier) return "Non classé";
  const apex = r.tier === "MASTER" || r.tier === "GRANDMASTER" || r.tier === "CHALLENGER";
  const division = apex ? "" : ` ${r.division ?? ""}`;
  return `${tier.label}${division} · ${r.lp ?? 0} LP`;
}

export function lolTierImg(rank: Record<string, unknown>): string | null {
  return LOL_TIERS[(rank as LolRank).tier ?? ""]?.img ?? null;
}

/** Couleur du niveau FACEIT (1-10, jauge officielle approx.). */
export function faceitLevelColor(level: number): string {
  if (level >= 10) return "#e73a3a";
  if (level >= 8) return "#f28a2e";
  if (level >= 4) return "#e6b31e";
  if (level >= 2) return "#57c25f";
  return "#c9c9c9";
}

interface FaceitRank {
  elo?: number;
  level?: number;
}

/** « 1 850 elo · niveau 8 ». */
export function faceitRankLabel(rank: Record<string, unknown>): string {
  const r = rank as FaceitRank;
  if (!r.level && !r.elo) return "Non classé";
  return `${(r.elo ?? 0).toLocaleString("fr-FR")} elo · niveau ${r.level ?? "?"}`;
}

export function faceitLevel(rank: Record<string, unknown>): number {
  return Number((rank as FaceitRank).level ?? 0);
}
