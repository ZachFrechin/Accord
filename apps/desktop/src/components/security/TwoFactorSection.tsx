/**
 * Two-factor (TOTP) settings — an inline section for the Security tab (not a modal,
 * so it stays put while you switch to your authenticator app and back).
 *
 * Enrollment is two-step (RFC 6238): request a secret, then prove possession with a
 * code before it takes effect. Enabling issues fresh one-time recovery codes, shown
 * once. Disabling re-authenticates with the account password.
 */

import { useEffect, useState } from "react";
import qrcode from "qrcode-generator";

import { ApiError } from "../../api/http";
import { useConnection } from "../../realtime/ConnectionProvider";
import { Button, Field, Icon } from "../ui";
import "./security.css";

type Phase = "loading" | "disabled" | "enrolling" | "codes" | "enabled" | "disabling";

export function TwoFactorSection() {
  const { client } = useConnection();

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState("");
  const [otpauth, setOtpauth] = useState("");
  const [qrSvg, setQrSvg] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [secretCopied, setSecretCopied] = useState(false);
  const [codesCopied, setCodesCopied] = useState(false);

  // Load the current status on mount / client change.
  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setError("");
    void client
      .totpStatus()
      .then((s) => !cancelled && setPhase(s.enabled ? "enabled" : "disabled"))
      .catch(() => !cancelled && setError("Impossible de charger l'état de sécurité."));
    return () => {
      cancelled = true;
    };
  }, [client]);

  async function beginEnroll() {
    setError("");
    setBusy(true);
    try {
      const res = await client.totpEnroll();
      setSecret(res.secret);
      setOtpauth(res.otpauth_uri);
      // Render the otpauth URI as a scannable QR (type 0 = auto-size, ECC "M").
      const qr = qrcode(0, "M");
      qr.addData(res.otpauth_uri);
      qr.make();
      setQrSvg(qr.createSvgTag(4, 2));
      setCode("");
      setPhase("enrolling");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Échec de l'activation.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll() {
    setError("");
    setBusy(true);
    try {
      const res = await client.totpConfirm(code.trim());
      setCodes(res.recovery_codes);
      setCodesCopied(false);
      setPhase("codes");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Code invalide.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDisable() {
    setError("");
    setBusy(true);
    try {
      await client.totpDisable(password);
      setPassword("");
      setPhase("disabled");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Mot de passe invalide.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sec-body">
      <span className="sec-title">
        <Icon name="lock" size={16} /> Double authentification
      </span>

      {phase === "loading" && <p className="sec-card__lede">Chargement…</p>}

      {phase === "disabled" && (
        <>
          <p className="sec-card__lede">
            Ajoutez un second facteur : à chaque connexion, un code temporaire de votre
            application d'authentification sera demandé en plus du mot de passe.
          </p>
          {error && <p className="sec-card__error">{error}</p>}
          <Button onClick={() => void beginEnroll()} disabled={busy}>
            {busy ? "…" : "Activer la double authentification"}
          </Button>
        </>
      )}

      {phase === "enrolling" && (
        <>
          <p className="sec-card__lede">
            Scannez ce QR code avec votre application d'authentification (ou saisissez la clé
            manuellement), puis entrez le code à 6 chiffres qu'elle affiche.
          </p>
          {qrSvg && (
            // Our own generated SVG from the otpauth URI — no user input, no injection.
            <div
              className="sec-qr"
              aria-label="QR code d'enrôlement"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          )}
          <div className="sec-secret" title="Clé secrète">
            <code>{secret}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(secret);
                setSecretCopied(true);
              }}
              aria-label="Copier la clé"
            >
              <Icon name="plus" size={14} /> {secretCopied ? "Copié" : "Copier"}
            </button>
          </div>
          <a className="sec-uri" href={otpauth}>
            Ouvrir dans une application
          </a>
          <Field
            label="Code à 6 chiffres"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123 456"
            autoComplete="one-time-code"
            spellCheck={false}
          />
          {error && <p className="sec-card__error">{error}</p>}
          <Button onClick={() => void confirmEnroll()} disabled={busy || !code.trim()}>
            {busy ? "Vérification…" : "Confirmer"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setError("");
              setPhase("disabled");
            }}
            disabled={busy}
          >
            Annuler
          </Button>
        </>
      )}

      {phase === "codes" && (
        <>
          <p className="sec-card__lede">
            La double authentification est activée. Conservez ces codes de récupération en lieu
            sûr — chacun sert une fois si vous perdez votre application.
          </p>
          <ul className="sec-codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(codes.join("\n"));
              setCodesCopied(true);
            }}
          >
            {codesCopied ? "Codes copiés" : "Copier les codes"}
          </Button>
          <Button onClick={() => setPhase("enabled")}>Je les ai enregistrés</Button>
        </>
      )}

      {phase === "enabled" && (
        <>
          <p className="sec-card__lede">
            <span className="sec-badge">
              <Icon name="shield-check" size={14} /> Activée
            </span>
            La double authentification protège votre connexion.
          </p>
          {error && <p className="sec-card__error">{error}</p>}
          <Button
            variant="outline"
            onClick={() => {
              setError("");
              setPhase("disabling");
            }}
            disabled={busy}
          >
            Désactiver
          </Button>
        </>
      )}

      {phase === "disabling" && (
        <>
          <p className="sec-card__lede">
            Confirmez avec votre mot de passe pour désactiver la double authentification.
          </p>
          <Field
            label="Mot de passe"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && <p className="sec-card__error">{error}</p>}
          <Button variant="outline" onClick={() => void confirmDisable()} disabled={busy || !password}>
            {busy ? "…" : "Désactiver la double authentification"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setError("");
              setPhase("enabled");
            }}
            disabled={busy}
          >
            Annuler
          </Button>
        </>
      )}
    </div>
  );
}
