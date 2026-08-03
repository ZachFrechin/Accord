/**
 * Connexion — écran d'entrée de l'application mobile.
 *
 * Deux étapes plutôt qu'un formulaire fleuve : d'abord le serveur (Accord est
 * auto-hébergeable, l'adresse n'est pas connue d'avance), puis les identifiants.
 * Le second facteur, quand il est activé, s'insère comme une troisième étape.
 *
 * Toute la logique vient du paquet partagé avec le desktop : mêmes appels, même
 * stockage sécurisé des jetons, mêmes règles.
 */

import logoUrl from "@accord/core/assets/logo.png";
import { useState, type FormEvent } from "react";


import { health, isMfaChallenge, login, verifyTotp, type TokenResponse } from "@accord/core/api/auth";
import { secureStore } from "@accord/core/lib/secureStore";
import { useInstanceStore } from "@accord/core/stores/useInstanceStore";
import { useSessionStore } from "@accord/core/stores/useSessionStore";

type Step = "server" | "credentials" | "totp";

/** Complète une adresse saisie à la va-vite (« mon-serveur.fr ») en URL. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function SignIn() {
  const [step, setStep] = useState<Step>("server");
  const [url, setUrl] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /** Enregistre l'instance + les jetons, ce qui fait basculer l'app vers la messagerie. */
  function finalize(tokens: TokenResponse): void {
    const store = useInstanceStore.getState();
    const inst = store.addInstance({ url });
    store.updateAccount(inst.id, {
      userId: tokens.user.id,
      username: tokens.user.username,
      email: tokens.user.email,
      role: tokens.user.role,
    });
    secureStore.set(inst.id, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    });
    useSessionStore.getState().markAuthed(inst.id);
    store.setActive(inst.id);
  }

  async function submitServer(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError("");
    const target = normalizeUrl(url);
    setUrl(target);
    setBusy(true);
    const reachable = await health(target).catch(() => false);
    setBusy(false);
    if (!reachable) {
      setError("Serveur injoignable. Vérifiez l'adresse et votre connexion.");
      return;
    }
    setStep("credentials");
  }

  async function submitCredentials(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await login(url, { username_or_email: identifier, password });
      if (isMfaChallenge(result)) {
        setChallenge(result.challenge);
        setStep("totp");
        return;
      }
      finalize(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connexion refusée.");
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      finalize(await verifyTotp(url, { challenge, code }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Code refusé.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="centered">
      <div className="brand">
        <img className="brand__mark" src={logoUrl} alt="" width={64} height={64} />
        <h1 className="brand__name">Accord</h1>
        <p className="brand__sub">
          {step === "server"
            ? "À quel serveur voulez-vous vous connecter ?"
            : step === "credentials"
              ? url.replace(/^https?:\/\//, "")
              : "Vérification en deux étapes"}
        </p>
      </div>

      {step === "server" && (
        <form className="form" onSubmit={(e) => void submitServer(e)}>
          <label className="field">
            <span className="field__label">Adresse du serveur</span>
            <input
              className="field__input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="accordapi.exemple.fr"
              autoCapitalize="none"
              autoCorrect="off"
              inputMode="url"
              enterKeyHint="next"
              autoFocus
            />
          </label>
          <button className="btn" type="submit" disabled={busy || !url.trim()}>
            {busy ? "Vérification…" : "Continuer"}
          </button>
        </form>
      )}

      {step === "credentials" && (
        <form className="form" onSubmit={(e) => void submitCredentials(e)}>
          <label className="field">
            <span className="field__label">Pseudo ou e-mail</span>
            <input
              className="field__input"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              enterKeyHint="next"
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field__label">Mot de passe</span>
            <input
              className="field__input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              enterKeyHint="go"
            />
          </label>
          <button className="btn" type="submit" disabled={busy || !identifier || !password}>
            {busy ? "Connexion…" : "Se connecter"}
          </button>
          <button className="btn btn--quiet" type="button" onClick={() => setStep("server")}>
            Changer de serveur
          </button>
        </form>
      )}

      {step === "totp" && (
        <form className="form" onSubmit={(e) => void submitTotp(e)}>
          <label className="field">
            <span className="field__label">Code à six chiffres</span>
            <input
              className="field__input field__input--code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
              inputMode="numeric"
              enterKeyHint="go"
              autoFocus
            />
          </label>
          <button className="btn" type="submit" disabled={busy || code.length < 6}>
            {busy ? "Vérification…" : "Valider"}
          </button>
          <p className="hint">Un code de secours fonctionne aussi.</p>
        </form>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
