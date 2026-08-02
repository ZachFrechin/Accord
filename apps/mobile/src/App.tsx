/**
 * Racine de l'application mobile.
 *
 * Tant qu'aucun compte n'est connecté, on affiche l'écran de connexion ; sinon
 * la messagerie, montée dans le fournisseur de connexion partagé avec le
 * desktop (client API + socket temps réel de l'instance active).
 */

import { useEffect, useState } from "react";

import { AppBackground } from "@accord/core/ui/AppBackground";
import { ConnectionProvider } from "@accord/core/realtime/ConnectionProvider";
import { hydrateSecureStore } from "@accord/core/lib/secureStore";
import { activeInstance, useInstanceStore } from "@accord/core/stores/useInstanceStore";
import { useSessionStore } from "@accord/core/stores/useSessionStore";

import { SignIn } from "./screens/SignIn";
import { Home } from "./screens/Home";
import "./styles.css";

export default function App() {
  const instance = useInstanceStore(activeInstance);
  const instances = useInstanceStore((s) => s.instances);
  const authed = useSessionStore((s) => (instance ? (s.authed[instance.id] ?? false) : false));

  // Les jetons vivent dans le stockage sécurisé natif : il faut les charger
  // AVANT de décider quel écran afficher, sinon on renvoie vers la connexion
  // un utilisateur déjà authentifié.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void hydrateSecureStore(instances.map((i) => i.id))
      .catch(() => {})
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) {
    return (
      <div className="app">
        <div className="centered">
          <p className="hint">Ouverture du coffre sécurisé…</p>
        </div>
      </div>
    );
  }

  if (!instance || !authed)
    return (
      <>
        <AppBackground />
        <SignIn />
      </>
    );

  return (
    <ConnectionProvider key={instance.id} instance={instance}>
      <AppBackground />
      <Home />
    </ConnectionProvider>
  );
}
