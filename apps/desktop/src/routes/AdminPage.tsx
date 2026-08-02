/**
 * Administration — a full dashboard page (was a settings tab). Instance overview
 * KPIs + user management. Gated to admins; the route entry and the backend both
 * enforce it, this guard is defense in depth.
 */

import { useEffect, useState } from "react";

import { AdministrationSection } from "../components/admin/AdministrationSection";
import { EmptyState } from "../components/ui";
import { useConnection } from "../realtime/ConnectionProvider";
import { activeInstance, useInstanceStore } from "../stores/useInstanceStore";
import "./page.css";

function hostOf(url: string | undefined): string {
  if (!url) return "cette instance";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default function AdminPage() {
  const instance = useInstanceStore(activeInstance);
  const isAdmin = instance?.account?.role === "admin";
  // Custom roles can grant panel access without the admin role: probe the API
  // instead of trusting the role flag alone (the backend is the authority).
  const { client } = useConnection();
  const [panelOk, setPanelOk] = useState<boolean | null>(isAdmin ? true : null);
  useEffect(() => {
    if (isAdmin) return;
    let alive = true;
    client
      .adminStats()
      .then(() => alive && setPanelOk(true))
      .catch(() => alive && setPanelOk(false));
    return () => {
      alive = false;
    };
  }, [client, isAdmin]);

  if (panelOk === false) {
    return (
      <div className="page">
        <EmptyState
          title="Accès réservé"
          description="Cette section demande le rôle administrateur ou un rôle avec permissions."
        />
      </div>
    );
  }
  if (panelOk === null) {
    return <div className="page" aria-busy="true" />;
  }

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Administration</h1>
          <p className="page__sub">
            Vue d'ensemble et gestion des comptes de {hostOf(instance?.url)}.
          </p>
        </div>
      </header>
      <AdministrationSection />
    </div>
  );
}
