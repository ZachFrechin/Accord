/**
 * Onboarding — connect to a backend and authenticate.
 *
 * A wizard: choose a server (URL) → sign in or create an account → (if new)
 * verify email by pasting the link → keep the one-time recovery codes → enter
 * the app. Only on a successful login is the instance registered and its tokens
 * stored, so a cancelled/failed attempt never leaves a half-added instance.
 */

import logoUrl from "@accord/core/assets/logo.png";
import { useEffect, useState, type FormEvent } from "react";

import {
  ApiError,
  extractToken,
  health,
  isMfaChallenge,
  login,
  register,
  resendVerification,
  verifyEmail,
  verifyTotp,
  type TokenResponse,
} from "../api/auth";
import { Button, Field, Icon, Tabs } from "../components/ui";
import { secureStore } from "../lib/secureStore";
import { useInstanceStore } from "../stores/useInstanceStore";
import { useSessionStore } from "../stores/useSessionStore";
import { useUiStore } from "../stores/useUiStore";
import "./Onboarding.css";

type Step = "server" | "auth" | "totp" | "verify" | "codes";

export default function Onboarding() {
  const [step, setStep] = useState<Step>("server");
  const [url, setUrl] = useState("");

  // An accord://join deep link prefills the server step (drained once used).
  const pendingServerUrl = useUiStore((s) => s.pendingServerUrl);
  useEffect(() => {
    if (!pendingServerUrl) return;
    setUrl(pendingServerUrl);
    setStep("server");
    useUiStore.getState().setPendingServerUrl(null);
  }, [pendingServerUrl]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Sign-in fields.
  const [identifier, setIdentifier] = useState("");
  const [signInPw, setSignInPw] = useState("");
  // Sign-up fields.
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [signUpPw, setSignUpPw] = useState("");
  // Verification.
  const [pastedCode, setPastedCode] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [pending, setPending] = useState<{ identifier: string; password: string }>({
    identifier: "",
    password: "",
  });
  const [codes, setCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  // 2FA: the challenge from a password-verified login + the code being entered.
  const [challenge, setChallenge] = useState("");
  const [totpCode, setTotpCode] = useState("");

  const addInstance = useInstanceStore((s) => s.addInstance);
  const updateAccount = useInstanceStore((s) => s.updateAccount);
  const setActive = useInstanceStore((s) => s.setActive);
  const instanceCount = useInstanceStore((s) => s.instances.length);
  const closeOnboarding = useUiStore((s) => s.closeOnboarding);

  function finalize(tokens: TokenResponse): void {
    const inst = addInstance({ url });
    updateAccount(inst.id, {
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
    setActive(inst.id);
    closeOnboarding();
  }

  async function onServer(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError("");
    setBusy(true);
    let target = url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(target)) target = `http://${target}`;
    setUrl(target);
    const ok = await health(target);
    setBusy(false);
    if (ok) setStep("auth");
    else setError("Impossible de joindre un serveur Accord à cette adresse.");
  }

  async function onSignIn(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await login(url, { username_or_email: identifier, password: signInPw });
      if (isMfaChallenge(result)) {
        // Password OK but 2FA required — go collect the code.
        setChallenge(result.challenge);
        setTotpCode("");
        setStep("totp");
      } else {
        finalize(result);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setPending({ identifier, password: signInPw });
        setStep("verify");
      } else {
        setError(err instanceof ApiError ? err.message : "Échec de la connexion.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function onTotp(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      finalize(await verifyTotp(url, { challenge, code: totpCode.trim() }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Code invalide.");
    } finally {
      setBusy(false);
    }
  }

  async function onSignUp(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await register(url, { username, email, password: signUpPw });
      setPending({ identifier: email, password: signUpPw });
      setStep("verify");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Échec de la création du compte.");
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError("");
    const token = extractToken(pastedCode);
    if (!token) {
      setError("Collez le code de confirmation reçu par e-mail.");
      return;
    }
    setBusy(true);
    try {
      const res = await verifyEmail(url, token);
      setCodes(res.recovery_codes);
      setStep("codes");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Échec de la vérification.");
    } finally {
      setBusy(false);
    }
  }

  async function onResend(): Promise<void> {
    setError("");
    setResendBusy(true);
    try {
      await resendVerification(url, pending.identifier);
      setResent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Échec du renvoi de l'e-mail.");
    } finally {
      setResendBusy(false);
    }
  }

  async function onFinishCodes(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const result = await login(url, {
        username_or_email: pending.identifier,
        password: pending.password,
      });
      if (isMfaChallenge(result)) {
        setChallenge(result.challenge);
        setTotpCode("");
        setStep("totp");
      } else {
        finalize(result);
      }
    } catch {
      setError("Votre compte est vérifié — veuillez vous connecter.");
      setStep("auth");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding__card">
        <div className="onboarding__brand">
          <img className="onboarding__mark" src={logoUrl} alt="" width={36} height={36} />
          <span className="onboarding__wordmark">Accord</span>
        </div>

        {step === "server" && (
          <form className="onboarding__form" onSubmit={onServer}>
            <h1 className="onboarding__title">Se connecter à un serveur</h1>
            <p className="onboarding__lede">
              Accord est auto-hébergé. Saisissez l'adresse du serveur que vous voulez rejoindre.
            </p>
            <Field
              label="Adresse du serveur"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://accord.example.com"
              autoFocus
              spellCheck={false}
            />
            {error && <p className="onboarding__error">{error}</p>}
            <Button type="submit" disabled={busy || !url.trim()}>
              {busy ? "Vérification…" : "Continuer"}
            </Button>
            {instanceCount > 0 && (
              <Button variant="ghost" onClick={closeOnboarding} disabled={busy}>
                Annuler
              </Button>
            )}
          </form>
        )}

        {step === "auth" && (
          <div className="onboarding__form">
            <h1 className="onboarding__title">{hostOf(url)}</h1>
            <Tabs
              aria-label="Se connecter ou créer un compte"
              items={[
                {
                  value: "signin",
                  label: "Se connecter",
                  content: (
                    <form className="onboarding__subform" onSubmit={onSignIn}>
                      <Field
                        label="Nom d'utilisateur ou e-mail"
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        autoComplete="username"
                      />
                      <Field
                        label="Mot de passe"
                        type="password"
                        value={signInPw}
                        onChange={(e) => setSignInPw(e.target.value)}
                        autoComplete="current-password"
                      />
                      {error && <p className="onboarding__error">{error}</p>}
                      <Button type="submit" disabled={busy || !identifier || !signInPw}>
                        {busy ? "Connexion…" : "Se connecter"}
                      </Button>
                    </form>
                  ),
                },
                {
                  value: "signup",
                  label: "Créer un compte",
                  content: (
                    <form className="onboarding__subform" onSubmit={onSignUp}>
                      <Field
                        label="Nom d'utilisateur"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        hint="3–32 caractères : a–z, 0–9, _"
                        autoComplete="username"
                      />
                      <Field
                        label="E-mail"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="email"
                      />
                      <Field
                        label="Mot de passe"
                        type="password"
                        value={signUpPw}
                        onChange={(e) => setSignUpPw(e.target.value)}
                        hint="Au moins 12 caractères"
                        autoComplete="new-password"
                      />
                      {error && <p className="onboarding__error">{error}</p>}
                      <Button type="submit" disabled={busy || !username || !email || signUpPw.length < 12}>
                        {busy ? "Création…" : "Créer un compte"}
                      </Button>
                    </form>
                  ),
                },
              ]}
            />
            <Button variant="ghost" onClick={() => setStep("server")} disabled={busy}>
              <Icon name="arrow-left" size={15} />
              Changer de serveur
            </Button>
          </div>
        )}

        {step === "totp" && (
          <form className="onboarding__form" onSubmit={onTotp}>
            <h1 className="onboarding__title">Vérification en deux étapes</h1>
            <p className="onboarding__lede">
              Saisissez le code à 6 chiffres de votre application d'authentification.
              Vous pouvez aussi utiliser l'un de vos codes de récupération.
            </p>
            <Field
              label="Code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              placeholder="123 456"
              autoFocus
              autoComplete="one-time-code"
              spellCheck={false}
            />
            {error && <p className="onboarding__error">{error}</p>}
            <Button type="submit" disabled={busy || !totpCode.trim()}>
              {busy ? "Vérification…" : "Vérifier"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setStep("auth");
                setError("");
              }}
              disabled={busy}
            >
              <Icon name="arrow-left" size={15} />
              Retour
            </Button>
          </form>
        )}

        {step === "verify" && (
          <form className="onboarding__form" onSubmit={onVerify}>
            <h1 className="onboarding__title">Vérifiez votre e-mail</h1>
            <p className="onboarding__lede">
              Nous avons envoyé un code de confirmation à <strong>{pending.identifier}</strong>.
              Copiez-le depuis votre boîte mail et collez-le ici.
            </p>
            <Field
              label="Code de confirmation"
              value={pastedCode}
              onChange={(e) => setPastedCode(e.target.value)}
              placeholder="Collez le code reçu par e-mail"
              autoFocus
              spellCheck={false}
            />
            {error && <p className="onboarding__error">{error}</p>}
            <Button type="submit" disabled={busy || !pastedCode.trim()}>
              {busy ? "Vérification…" : "Vérifier"}
            </Button>
            {resent ? (
              <p className="onboarding__lede">
                E-mail renvoyé — pensez à vérifier vos spams.
              </p>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={onResend}
                disabled={resendBusy || busy}
              >
                {resendBusy ? "Envoi…" : "Renvoyer l'e-mail"}
              </Button>
            )}
          </form>
        )}

        {step === "codes" && (
          <div className="onboarding__form">
            <h1 className="onboarding__title">Enregistrez vos codes de récupération</h1>
            <p className="onboarding__lede">
              Conservez-les en lieu sûr. Chacun peut servir une fois à récupérer votre compte
              si vous perdez l'accès à votre e-mail.
            </p>
            <ul className="onboarding__codes">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(codes.join("\n"));
                setCopied(true);
              }}
            >
              {copied ? "Codes copiés" : "Copier les codes"}
            </Button>
            {error && <p className="onboarding__error">{error}</p>}
            <Button onClick={onFinishCodes} disabled={busy}>
              {busy ? "Finalisation…" : "Je les ai enregistrés — continuer"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
