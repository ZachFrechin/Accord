/**
 * Niveaux d'instance — miroir de la courbe backend (domain/xp.rs : coût du
 * niveau n→n+1 = 5n² + 50n + 100) et les 15 rangs in-app avec leurs logos.
 * Si la courbe change côté serveur, changez-la ici aussi.
 */

import rank01 from "../assets/ranks/rank-01-novice.png";
import rank02 from "../assets/ranks/rank-02-adepte.png";
import rank03 from "../assets/ranks/rank-03-avance.png";
import rank04 from "../assets/ranks/rank-04-orateur.png";
import rank05 from "../assets/ranks/rank-05-ecrivain.png";
import rank06 from "../assets/ranks/rank-06-lanceur-d-alerte.png";
import rank07 from "../assets/ranks/rank-07-moulin-a-parole.png";
import rank08 from "../assets/ranks/rank-08-tendinite.png";
import rank09 from "../assets/ranks/rank-09-modo.png";
import rank10 from "../assets/ranks/rank-10-createur-de-la-parole.png";
import rank11 from "../assets/ranks/rank-11-omnipotent.png";
import rank12 from "../assets/ranks/rank-12-legende-illustre.png";
import rank13 from "../assets/ranks/rank-13-parole-divine.png";
import rank14 from "../assets/ranks/rank-14-maitre-absolu.png";
import rank15 from "../assets/ranks/rank-15-le-tout-et-le-rien.png";

export interface AppRank {
  /** Level at which the rank is reached. */
  minLevel: number;
  name: string;
  img: string;
}

/** Les 15 rangs, du premier au dernier. */
export const RANKS: AppRank[] = [
  { minLevel: 0, name: "Novice", img: rank01 },
  { minLevel: 3, name: "Adepte", img: rank02 },
  { minLevel: 6, name: "Avancé", img: rank03 },
  { minLevel: 10, name: "Orateur", img: rank04 },
  { minLevel: 15, name: "Écrivain", img: rank05 },
  { minLevel: 20, name: "Lanceur d'alerte", img: rank06 },
  { minLevel: 25, name: "Moulin à parole", img: rank07 },
  { minLevel: 30, name: "Tendinite", img: rank08 },
  { minLevel: 40, name: "Modo", img: rank09 },
  { minLevel: 50, name: "Créateur de la parole", img: rank10 },
  { minLevel: 60, name: "Omnipotent", img: rank11 },
  { minLevel: 75, name: "Légende illustre", img: rank12 },
  { minLevel: 90, name: "Parole divine", img: rank13 },
  { minLevel: 110, name: "Maître absolu", img: rank14 },
  { minLevel: 130, name: "Le Tout et le Rien", img: rank15 },
];

export function rankForLevel(level: number): AppRank {
  let current = RANKS[0];
  for (const r of RANKS) {
    if (level >= r.minLevel) current = r;
    else break;
  }
  return current;
}

/** Le prochain rang à atteindre (null au sommet). */
export function nextRank(level: number): AppRank | null {
  return RANKS.find((r) => r.minLevel > level) ?? null;
}

function levelCost(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

export function levelForXp(xp: number): number {
  let level = 0;
  let remaining = xp;
  while (remaining >= levelCost(level) && level < 500) {
    remaining -= levelCost(level);
    level += 1;
  }
  return level;
}

/** XP total requis pour ATTEINDRE `level`. */
export function xpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < level; l++) total += levelCost(l);
  return total;
}

/** Progression dans le niveau courant, pour la barre du profil. */
export function levelProgress(xp: number): { level: number; into: number; needed: number } {
  const level = levelForXp(xp);
  const floor = xpForLevel(level);
  return { level, into: xp - floor, needed: levelCost(level) };
}
