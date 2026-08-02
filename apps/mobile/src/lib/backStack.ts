/**
 * Pile de retour de l'application.
 *
 * Sur Android, le geste et le bouton « retour » arrivent tous les deux sous
 * forme d'un `popstate`. Si plusieurs écrans écoutent cet événement en même
 * temps, ils réagissent TOUS au même retour : fermer une feuille d'actions
 * refermait aussi la conversation derrière elle.
 *
 * Un seul écouteur, donc, et une pile : chaque surface empile son geste de
 * fermeture, et un retour ne dépile que celle du dessus.
 */

type Handler = () => void;

const stack: Handler[] = [];
let wired = false;

function ensureWired(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("popstate", () => {
    const top = stack.pop();
    top?.();
  });
}

/**
 * Empile un geste de fermeture et ajoute une entrée d'historique, de sorte que
 * le prochain retour ferme cette surface-là. Renvoie de quoi se retirer de la
 * pile — soit parce que la surface s'est fermée d'elle-même (`close()`), soit
 * parce qu'elle est démontée (`detach()`).
 */
export function pushBackHandler(onBack: Handler): { close: () => void; detach: () => void } {
  ensureWired();
  stack.push(onBack);
  window.history.pushState({ depth: stack.length }, "");

  return {
    // Fermeture demandée par l'interface (croix, action choisie) : on revient
    // en arrière et c'est l'écouteur unique qui dépile puis ferme. Passer par
    // le même chemin que le bouton système garde l'historique cohérent.
    close: () => window.history.back(),
    // Démontage pour une autre raison qu'un retour : on retire seulement le
    // geste de la pile, sans toucher à l'historique.
    detach: () => {
      const i = stack.lastIndexOf(onBack);
      if (i !== -1) stack.splice(i, 1);
    },
  };
}
