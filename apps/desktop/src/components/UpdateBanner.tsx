/**
 * Update banner — surfaces an available app update (Tauri only) with a one-click
 * install-and-restart. Mounted in AppRoot so it shows on the onboarding screen
 * too, not just once signed in. Checks at launch, then every few hours.
 */

import { useEffect } from "react";

import { isTauri } from "../lib/isTauri";
import { useUpdateStore } from "../stores/useUpdateStore";
import { Button, Icon } from "./ui";
import "./UpdateBanner.css";

const RECHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export function UpdateBanner() {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  const notes = useUpdateStore((s) => s.notes);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const dismissedVersion = useUpdateStore((s) => s.dismissedVersion);
  const check = useUpdateStore((s) => s.check);
  const install = useUpdateStore((s) => s.install);
  const dismiss = useUpdateStore((s) => s.dismiss);

  useEffect(() => {
    if (!isTauri()) return;
    void check();
    const timer = setInterval(() => void check(), RECHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [check]);

  if (phase === "idle") return null;
  if (phase === "available" && version && version === dismissedVersion) return null;

  const pct = progress != null ? Math.round(progress * 100) : null;

  return (
    <div className="update-banner" role="status" aria-live="polite" data-phase={phase}>
      <span className="update-banner__icon" aria-hidden="true">
        <Icon name="sparkle" size={16} />
      </span>

      {phase === "available" && (
        <>
          {/* The notes' first line is the changelog title; the full bullet list
              rides along as a native tooltip so the strip stays one line. */}
          <span className="update-banner__text" title={notes ?? undefined}>
            Mise à jour <strong>{version}</strong> disponible
            {notes ? <> — {notes.split("\n")[0]}</> : null}
          </span>
          <div className="update-banner__actions">
            <Button size="sm" onClick={() => void install()}>
              Installer et redémarrer
            </Button>
            <button
              type="button"
              className="update-banner__close"
              aria-label="Ignorer cette mise à jour"
              onClick={dismiss}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </>
      )}

      {phase === "downloading" && (
        <span className="update-banner__text">
          Téléchargement de la mise à jour{pct != null ? ` — ${pct} %` : "…"}
        </span>
      )}

      {phase === "installing" && (
        <span className="update-banner__text">Installation — l'application va redémarrer…</span>
      )}

      {phase === "error" && (
        <>
          <span className="update-banner__text">
            La mise à jour a échoué{error ? ` : ${error}` : "."}
          </span>
          <div className="update-banner__actions">
            <Button size="sm" variant="outline" onClick={() => void install()}>
              Réessayer
            </Button>
            <button
              type="button"
              className="update-banner__close"
              aria-label="Fermer"
              onClick={dismiss}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
