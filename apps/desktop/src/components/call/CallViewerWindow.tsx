/**
 * Fenêtre spectateur d'appel : une caméra ou un partage d'écran de l'appel,
 * seul, dans sa propre fenêtre Tauri (plusieurs streams = plusieurs fenêtres).
 *
 * Elle rejoint l'appel avec une identité SPECTATEUR (device marqué VIEWER_MARK,
 * filtrée du roster du bandeau) : jamais de micro, jamais de publication —
 * VIDÉO SEULE. L'audio (voix + streams) reste dans la fenêtre principale, où
 * vivent les curseurs de volume — pas de double lecture. E2EE identique au
 * bandeau (clé exporter MLS, moteur natif partagé par le process).
 */

import { useEffect, useRef, useState } from "react";
import type { Room as LkRoom, Track as LkTrack } from "livekit-client";

import { isTauri } from "../../lib/isTauri";
import {
  joinCallAsViewer,
  leaveCallAsViewer,
  memberNames,
  messagingReady,
  requestCallKey,
} from "../../stores/messagingActions";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import "./call.css";

export function CallViewerWindow({
  conversationId,
  tile,
}: {
  conversationId: string;
  tile: string;
}) {
  const myId = useInstanceStore((s) => activeInstance(s)?.account?.userId ?? null);
  const [track, setTrack] = useState<LkTrack | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let alive = true;
    let room: LkRoom | null = null;
    let worker: Worker | null = null;
    let viewerDevice: string | null = null;

    const closeSelf = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      } catch {
        /* browser dev — nothing to close */
      }
    };

    void (async () => {
      const lk = await import("livekit-client");
      // Cette fenêtre monte AVANT la fin de l'init messaging (identité, MLS,
      // ws) — attendre le runtime, sinon la clé d'appel échoue à tort.
      const ready = await messagingReady();
      if (!alive) return;
      if (!ready) {
        setError("Connexion au compte indisponible");
        return;
      }
      const key = await requestCallKey(conversationId).catch(() => null);
      if (!alive) return;
      if (!key && isTauri()) {
        setError("Chiffrement de l'appel indisponible");
        return;
      }
      const joined = await joinCallAsViewer(conversationId);
      if (!alive || !joined) {
        if (!joined) setError("Appel introuvable — il est peut-être terminé.");
        return;
      }
      viewerDevice = joined.viewerDevice;

      let e2ee: { keyProvider: InstanceType<typeof lk.ExternalE2EEKeyProvider>; worker: Worker } | undefined;
      if (key && lk.isE2EESupported()) {
        try {
          const keyProvider = new lk.ExternalE2EEKeyProvider();
          const { default: E2EEWorker } = await import("livekit-client/e2ee-worker?worker");
          worker = new E2EEWorker();
          e2ee = { keyProvider, worker };
        } catch {
          worker?.terminate();
          worker = null;
          e2ee = undefined;
        }
      }
      if (key && !e2ee && isTauri()) {
        setError("Chiffrement de l'appel indisponible");
        void leaveCallAsViewer(conversationId, viewerDevice);
        return;
      }

      const r = new lk.Room({ adaptiveStream: true, e2ee });
      room = r;
      if (e2ee && key) {
        try {
          await e2ee.keyProvider.setKey(key.buffer);
          await r.setE2EEEnabled(true);
        } catch {
          setError("Chiffrement de l'appel indisponible");
          void leaveCallAsViewer(conversationId, viewerDevice);
          return;
        }
      }

      const wantedKey = (identity: string, source: unknown) =>
        source === lk.Track.Source.ScreenShare ? `${identity}#screen` : identity;
      r.on(lk.RoomEvent.TrackSubscribed, (t, _pub, participant) => {
        if (t.kind === lk.Track.Kind.Video && wantedKey(participant.identity, t.source) === tile) {
          if (alive) setTrack(t);
        }
      })
        .on(lk.RoomEvent.TrackUnsubscribed, (t) => {
          if (alive) setTrack((cur) => (cur === t ? null : cur));
        })
        // L'appel se termine (ou le serveur nous coupe) → la fenêtre se ferme.
        .on(lk.RoomEvent.Disconnected, () => {
          void closeSelf();
        });

      try {
        await r.connect(joined.creds.url, joined.creds.token);
      } catch {
        if (alive) setError("Connexion à l'appel impossible");
        void leaveCallAsViewer(conversationId, viewerDevice);
        return;
      }

      const names = await memberNames(conversationId).catch(() => ({}) as Record<string, string>);
      if (!alive) return;
      const userId = tile.split(":")[0];
      const base = myId && userId === myId ? "Vous" : (names[userId] ?? "Membre");
      const name = tile.endsWith("#screen") ? `${base} · écran` : base;
      setLabel(name);
      document.title = name;
    })();

    // Fermeture de la fenêtre : on quitte le roster (best-effort — un viewer
    // sans heartbeat est de toute façon purgé par TTL côté serveur).
    const onUnload = () => {
      if (viewerDevice) void leaveCallAsViewer(conversationId, viewerDevice);
    };
    window.addEventListener("beforeunload", onUnload);

    return () => {
      alive = false;
      window.removeEventListener("beforeunload", onUnload);
      if (viewerDevice) void leaveCallAsViewer(conversationId, viewerDevice);
      room?.removeAllListeners();
      void room?.disconnect();
      worker?.terminate();
    };
  }, [conversationId, tile, myId]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <div className="callview">
      {track ? (
        <video ref={videoRef} className="callview__video" autoPlay playsInline muted />
      ) : (
        <div className="callview__empty">
          {error ?? "En attente du flux…"}
        </div>
      )}
      {label && <span className="callview__name">{label}</span>}
      <span className="callview__hint">Le son reste dans la fenêtre principale</span>
    </div>
  );
}
