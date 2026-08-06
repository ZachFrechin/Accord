/** L'écran d'appel : les visages, et les gestes qu'on fait d'une main.
 *
 *  Plein écran, sans compromis : en appel on ne fait rien d'autre, et les
 *  commandes doivent être atteignables au pouce — d'où les gros boutons ronds
 *  en bas plutôt qu'une barre d'icônes serrée en haut.
 */

import { useEffect, useRef } from "react";

import { Icon } from "@accord/core/ui/Icon";
import { useConversationsStore } from "@accord/core/stores/useConversationsStore";

import { Avatar } from "../ui/Avatar";
import { useCallStore } from "../stores/useCallStore";

/** Une tuile : la vidéo si elle existe, sinon l'avatar. */
function Tile({ identity, name, speaking, muted }: {
  identity: string;
  name: string;
  speaking: boolean;
  muted: boolean;
}) {
  const videoTrack = useCallStore((s) => s.videoTrack);
  const hasVideo = useCallStore((s) => s.videoParticipants.includes(identity));
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !hasVideo) return;
    const track = videoTrack(identity);
    if (!track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [identity, hasVideo, videoTrack]);

  return (
    <div className="call-tile" data-speaking={speaking}>
      {hasVideo ? (
        <video ref={ref} className="call-tile__video" autoPlay playsInline muted />
      ) : (
        <Avatar name={name} size={84} />
      )}
      <span className="call-tile__name">
        {muted && <Icon name="microphone" size={13} />}
        {name}
      </span>
    </div>
  );
}

/** La sonnerie d'un appel entrant. Deux boutons, rien d'autre : c'est la seule
 *  décision à prendre, et souvent en quelques secondes. */
export function IncomingCall() {
  const incoming = useCallStore((s) => s.incoming);
  const accept = useCallStore((s) => s.acceptIncoming);
  const decline = useCallStore((s) => s.declineIncoming);
  if (!incoming) return null;
  return (
    <div className="call call--ringing">
      <div className="call__ring">
        <Avatar name={incoming.fromName} size={110} />
        <span className="call__title">{incoming.fromName}</span>
        <span className="call__sub">
          {incoming.media === "video" ? "Appel vidéo entrant" : "Appel entrant"}
        </span>
      </div>
      <div className="call__actions">
        <button
          type="button"
          className="call-btn call-btn--hangup"
          onClick={decline}
          aria-label="Refuser"
        >
          <Icon name="phone-x" size={26} />
        </button>
        <button
          type="button"
          className="call-btn call-btn--accept"
          onClick={accept}
          aria-label="Répondre"
        >
          <Icon name="phone" size={26} />
        </button>
      </div>
    </div>
  );
}

export function Call() {
  const status = useCallStore((s) => s.status);
  const conversationId = useCallStore((s) => s.conversationId);
  const participants = useCallStore((s) => s.participants);
  const activeSpeakers = useCallStore((s) => s.activeSpeakers);
  const names = useCallStore((s) => s.names);
  const micEnabled = useCallStore((s) => s.micEnabled);
  const cameraEnabled = useCallStore((s) => s.cameraEnabled);
  const speakerOn = useCallStore((s) => s.speakerOn);
  const error = useCallStore((s) => s.error);
  const mutedMics = useCallStore((s) => s.mutedMics);
  const leave = useCallStore((s) => s.leave);
  const toggleMic = useCallStore((s) => s.toggleMic);
  const toggleCamera = useCallStore((s) => s.toggleCamera);
  const toggleSpeaker = useCallStore((s) => s.toggleSpeaker);
  const title = useConversationsStore((s) =>
    conversationId ? (s.titles[conversationId] ?? "Appel") : "Appel",
  );

  // L'écran reste allumé pendant un appel vidéo : le téléphone qui s'éteint au
  // milieu d'une conversation coupe la caméra sans prévenir.
  useEffect(() => {
    if (status !== "in-call") return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    void nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    return () => {
      void lock?.release().catch(() => {});
    };
  }, [status]);

  if (status === "idle") return null;

  const nameOf = (identity: string): string => {
    const userId = identity.split(":")[0];
    return names[userId] ?? "…";
  };

  return (
    <div className="call">
      <header className="call__head">
        <span className="call__title">{title}</span>
        <span className="call__sub">
          {status === "connecting" && "Connexion…"}
          {status === "error" && (error ?? "Échec")}
          {status === "in-call" && (
            <>
              <Icon name="lock" size={12} /> Chiffré · {participants.length}{" "}
              {participants.length > 1 ? "participants" : "participant"}
            </>
          )}
        </span>
      </header>

      <div className="call__grid" data-count={Math.min(participants.length, 4)}>
        {participants.map((id) => (
          <Tile
            key={id}
            identity={id}
            name={nameOf(id)}
            speaking={activeSpeakers.includes(id)}
            muted={mutedMics.includes(id)}
          />
        ))}
      </div>

      <div className="call__actions">
        <button
          type="button"
          className="call-btn"
          data-off={!micEnabled}
          onClick={() => void toggleMic()}
          aria-label={micEnabled ? "Couper le micro" : "Activer le micro"}
        >
          <Icon name="microphone" size={26} />
        </button>
        <button
          type="button"
          className="call-btn"
          data-off={!cameraEnabled}
          onClick={() => void toggleCamera()}
          aria-label={cameraEnabled ? "Couper la caméra" : "Activer la caméra"}
        >
          <Icon name="video-camera" size={26} />
        </button>
        <button
          type="button"
          className="call-btn"
          data-off={!speakerOn}
          onClick={() => void toggleSpeaker()}
          aria-label={speakerOn ? "Passer sur l'écouteur" : "Passer sur le haut-parleur"}
        >
          <Icon name="speaker-high" size={26} />
        </button>
        <button
          type="button"
          className="call-btn call-btn--hangup"
          onClick={leave}
          aria-label="Raccrocher"
        >
          <Icon name="phone-x" size={26} />
        </button>
      </div>
    </div>
  );
}
