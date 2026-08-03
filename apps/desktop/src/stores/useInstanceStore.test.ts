/**
 * `updateAccount` est appelé à chaque rafraîchissement de jeton — toutes les dix
 * minutes — avec presque toujours les mêmes valeurs.
 *
 * Il écrivait quand même dans le state, reconstruisant un objet neuf à chaque
 * fois. Tout ce qui dépendait de cet objet se croyait alors face à un compte
 * différent : le câblage temps réel se démontait et se remontait, son nettoyage
 * vidait la liste des conversations, et l'utilisateur se retrouvait renvoyé au
 * menu — y compris en pleine conversation vocale.
 *
 * D'où ces tests : la stabilité de l'objet n'est pas un détail d'optimisation,
 * c'est ce qui garde l'écran en place.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useInstanceStore } from "./useInstanceStore";

const ACCOUNT = {
  userId: "u-1",
  username: "zach",
  email: "zach@example.test",
  role: "member" as const,
};

describe("useInstanceStore.updateAccount", () => {
  let id: string;

  beforeEach(() => {
    useInstanceStore.setState({ instances: [], activeInstanceId: null });
    id = useInstanceStore.getState().addInstance({ url: "https://accord.example.test" }).id;
    useInstanceStore.getState().updateAccount(id, ACCOUNT);
  });

  const instance = () => useInstanceStore.getState().instances.find((i) => i.id === id);

  it("ne réécrit rien quand le compte est identique", () => {
    const before = instance();
    // Un objet DIFFÉRENT portant les mêmes valeurs : c'est exactement ce que
    // renvoie un rafraîchissement de jeton.
    useInstanceStore.getState().updateAccount(id, { ...ACCOUNT });
    expect(instance()).toBe(before);
    expect(instance()?.account).toBe(before?.account);
  });

  it("écrit quand une valeur change vraiment", () => {
    const before = instance();
    useInstanceStore.getState().updateAccount(id, { ...ACCOUNT, role: "admin" });
    expect(instance()).not.toBe(before);
    expect(instance()?.account?.role).toBe("admin");
  });

  it("écrit quand le rôle disparaît", () => {
    // `role` est optionnel : le passage de « admin » à absent est un vrai
    // changement, qu'une comparaison négligente laisserait passer.
    useInstanceStore.getState().updateAccount(id, { ...ACCOUNT, role: "admin" });
    const before = instance();
    const { role: _omitted, ...withoutRole } = ACCOUNT;
    useInstanceStore.getState().updateAccount(id, withoutRole);
    expect(instance()).not.toBe(before);
    expect(instance()?.account?.role).toBeUndefined();
  });
});
