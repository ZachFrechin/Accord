/**
 * Nouveautés — the in-app changelog. Entries live in lib/changelog.ts (newest
 * first); the CI version stamp refuses to build a tag that has no entry there,
 * so this page can't silently fall behind the released versions.
 */

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { CHANGELOG, markChangelogSeen } from "../lib/changelog";
import { isTauri } from "../lib/isTauri";
import "./page.css";
import "./changelog.css";

export default function ChangelogPage() {
  const [installed, setInstalled] = useState<string | null>(null);

  useEffect(() => {
    markChangelogSeen();
    if (isTauri()) {
      getVersion()
        .then(setInstalled)
        .catch(() => {});
    }
  }, []);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Nouveautés</h1>
          <p className="page__sub">Ce qui change à chaque version d'Accord.</p>
        </div>
        {installed && (
          <span className="changelog__installed">Version installée : {installed}</span>
        )}
      </header>

      <ol className="changelog">
        {CHANGELOG.map((entry) => (
          <li
            key={entry.version}
            className="changelog__entry"
            data-technical={entry.technical || undefined}
            data-current={installed === entry.version || undefined}
          >
            <div className="changelog__meta">
              <span className="changelog__version">{entry.version}</span>
              <time className="changelog__date" dateTime={entry.date}>
                {formatDate(entry.date)}
              </time>
              {installed === entry.version && (
                <span className="changelog__chip">installée</span>
              )}
            </div>
            <div className="changelog__body">
              <h2 className="changelog__title">{entry.title}</h2>
              <ul className="changelog__notes">
                {entry.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
