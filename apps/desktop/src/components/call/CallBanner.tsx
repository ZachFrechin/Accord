/**
 * Bandeau d'appel v2 (façon Discord), affiché à la place du header du chat :
 *  - barre d'infos + contrôles (micro, caméra, partage, périphériques, raccrocher) ;
 *  - bande PARTICIPANTS jamais tronquée (défilement horizontal), anneau de prise
 *    de parole, badge muet, clic → volume de la voix PAR personne (persisté) ;
 *  - scène optionnelle : une tuile agrandie (plein écran natif possible) ;
 *  - bande MÉDIAS en bas : caméras et partages d'écran, avec par tuile
 *    agrandir / fenêtre séparée / volume du stream (partages avec audio).
 */

import { useEffect, useRef, useState } from "react";
import type { Track } from "livekit-client";

import { memberProfiles, type MemberProfile } from "../../stores/messagingActions";
import { openCallTilePopout } from "../../lib/popout";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import { useCallStore } from "../../stores/useCallStore";
import { useMediaSettingsStore } from "../../stores/useMediaSettingsStore";
import { Avatar } from "../messaging/Avatar";
import { Icon, Popover } from "../ui";
import { CameraGlyph } from "./CameraGlyph";
import { MicGlyph } from "./MicGlyph";
import { SharedCallMedia } from "./SharedCallMedia";
import "./call.css";

/** A participant's live video, attached to a real <video> via the LiveKit track.
 * Muted (audio plays through the hidden sink); the local camera is mirrored. */
function VideoTile({ track, mirror }: { track: Track; mirror: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return (
    <video ref={ref} className="call-banner__video" autoPlay playsInline muted data-mirror={mirror} />
  );
}

/** Live device pickers bound to the media settings store — switching applies
 * to the call IN PLACE (hot switch in useCallStore), no rejoin needed. */
function DeviceMenu() {
  const micId = useMediaSettingsStore((s) => s.micId);
  const camId = useMediaSettingsStore((s) => s.camId);
  const speakerId = useMediaSettingsStore((s) => s.speakerId);
  const store = useMediaSettingsStore;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => {});
  }, []);
  const pick = (
    label: string,
    kind: MediaDeviceKind,
    value: string | null,
    onChange: (id: string | null) => void,
  ) => (
    <label className="call-devices__field">
      <span>{label}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Par défaut</option>
        {devices
          .filter((d) => d.kind === kind)
          .map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId.slice(0, 8)}
            </option>
          ))}
      </select>
    </label>
  );
  return (
    <div className="call-devices">
      {pick("Micro", "audioinput", micId, (id) => store.getState().setMic(id))}
      {pick("Caméra", "videoinput", camId, (id) => store.getState().setCam(id))}
      {pick("Sortie", "audiooutput", speakerId, (id) => store.getState().setSpeaker(id))}
      <p className="call-devices__hint">Appliqué à l'appel en cours.</p>
    </div>
  );
}

export function CallBanner() {
  const status = useCallStore((s) => s.status);
  const participants = useCallStore((s) => s.participants);
  const localIdentity = useCallStore((s) => s.localIdentity);
  const activeSpeakers = useCallStore((s) => s.activeSpeakers);
  const names = useCallStore((s) => s.names);
  const micEnabled = useCallStore((s) => s.micEnabled);
  const cameraEnabled = useCallStore((s) => s.cameraEnabled);
  const screenEnabled = useCallStore((s) => s.screenEnabled);
  const toggleScreenShare = useCallStore((s) => s.toggleScreenShare);
  const videoParticipants = useCallStore((s) => s.videoParticipants);
  const getVideoTrack = useCallStore((s) => s.getVideoTrack);
  const encrypted = useCallStore((s) => s.encrypted);
  const mutedMics = useCallStore((s) => s.mutedMics);
  const screenVolumes = useCallStore((s) => s.screenVolumes);
  const setScreenVolume = useCallStore((s) => s.setScreenVolume);
  const setVoiceVolume = useCallStore((s) => s.setVoiceVolume);
  const focusedTile = useCallStore((s) => s.focusedTile);
  const setFocusedTile = useCallStore((s) => s.setFocusedTile);
  const error = useCallStore((s) => s.error);
  const audioBlocked = useCallStore((s) => s.audioBlocked);
  const toggleMic = useCallStore((s) => s.toggleMic);
  const toggleCamera = useCallStore((s) => s.toggleCamera);
  const leaveCall = useCallStore((s) => s.leaveCall);
  const resumeAudio = useCallStore((s) => s.resumeAudio);
  const conversationId = useCallStore((s) => s.conversationId);
  const voiceVolumes = useMediaSettingsStore((s) => s.voiceVolumes);
  const myId = useInstanceStore((s) => activeInstance(s)?.account?.userId ?? null);

  const stageRef = useRef<HTMLDivElement>(null);

  // Profile pictures for the roster (cached fetch; identities are userId:device).
  const [profiles, setProfiles] = useState<Record<string, MemberProfile>>({});
  useEffect(() => {
    if (!conversationId) {
      setProfiles({});
      return;
    }
    let alive = true;
    void memberProfiles(conversationId)
      .then((p) => alive && setProfiles(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [conversationId]);
  const avatarOf = (identity: string): string | null =>
    profiles[identity.split(":")[0]]?.avatarUrl ?? null;

  const displayName = (identity: string): string => {
    // Screen-share tiles ride a pseudo-identity: `userId:device#screen`.
    const isScreen = identity.endsWith("#screen");
    const userId = identity.split(":")[0];
    const base = myId && userId === myId ? "Vous" : (names[userId] ?? "Membre");
    return isScreen ? `${base} · écran` : base;
  };

  const people = participants.length > 0 ? participants : myId ? [myId] : ["moi"];
  const mediaTiles = videoParticipants;
  const stageTile = focusedTile && mediaTiles.includes(focusedTile) ? focusedTile : null;
  const hasVideo = mediaTiles.length > 0;
  const sub =
    status === "connecting"
      ? "Connexion…"
      : status === "error"
        ? (error ?? "Échec")
        : hasVideo
          ? "Appel vidéo"
          : "Appel vocal";

  const fullscreenStage = () => {
    const el = stageRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => void })
      | null;
    if (!el) return;
    if (el.requestFullscreen) void el.requestFullscreen().catch(() => {});
    else el.webkitRequestFullscreen?.();
  };

  const popOut = (tile: string) => {
    if (!conversationId) return;
    void openCallTilePopout(conversationId, tile, displayName(tile));
  };

  /** Overlay controls shared by strip tiles and the stage. */
  const tileControls = (tile: string, onStage: boolean) => {
    const isScreen = tile.endsWith("#screen");
    return (
      <div className="call-tile__controls">
        {isScreen && (
          <Popover
            side="top"
            trigger={
              <button type="button" className="call-tile__btn" title="Volume du stream" aria-label="Volume du stream">
                <Icon name="speaker-high" size={14} />
              </button>
            }
          >
            <div className="call-volume">
              <span className="call-volume__label">
                Volume du stream — {Math.round((screenVolumes[tile] ?? 1) * 100)} %
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((screenVolumes[tile] ?? 1) * 100)}
                onChange={(e) => setScreenVolume(tile, Number(e.target.value) / 100)}
                aria-label="Volume du stream"
              />
            </div>
          </Popover>
        )}
        <button
          type="button"
          className="call-tile__btn"
          title="Fenêtre séparée"
          aria-label="Ouvrir dans une fenêtre séparée"
          onClick={() => popOut(tile)}
        >
          <Icon name="arrow-up-right" size={14} />
        </button>
        {onStage ? (
          <>
            <button
              type="button"
              className="call-tile__btn"
              title="Plein écran"
              aria-label="Plein écran"
              onClick={fullscreenStage}
            >
              <Icon name="corners-out" size={14} />
            </button>
            <button
              type="button"
              className="call-tile__btn"
              title="Réduire"
              aria-label="Réduire"
              onClick={() => setFocusedTile(null)}
            >
              <Icon name="x" size={14} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="call-tile__btn"
            title="Agrandir"
            aria-label="Agrandir"
            onClick={() => setFocusedTile(tile)}
          >
            <Icon name="corners-out" size={14} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      className="call-banner"
      data-status={status}
      data-has-video={hasVideo}
      role="region"
      aria-label="Appel"
    >
      {/* ── Barre d'infos + contrôles ── */}
      <div className="call-banner__bar">
        <div className="call-banner__info">
          <Icon name={hasVideo ? "video-camera" : "phone"} size={14} className="call-banner__icon" />
          <span>{sub}</span>
          {status === "in-call" &&
            (encrypted ? (
              <span className="call-banner__e2ee" title="Chiffré de bout en bout (MLS)">
                <Icon name="lock" size={13} />
              </span>
            ) : (
              <span
                className="call-banner__e2ee call-banner__e2ee--warn"
                title="Média non chiffré — conversation sans groupe MLS (dev)"
              >
                non chiffré
              </span>
            ))}
        </div>
        <div className="call-banner__controls">
          {audioBlocked && (
            <button type="button" className="call-banner__resume" onClick={() => void resumeAudio()}>
              Activer le son
            </button>
          )}
          <button
            type="button"
            className="call-ctl call-ctl--sm"
            data-off={!micEnabled}
            onClick={() => void toggleMic()}
            disabled={status !== "in-call"}
            aria-pressed={micEnabled}
            aria-label={micEnabled ? "Couper le micro" : "Activer le micro"}
            title={micEnabled ? "Couper le micro" : "Activer le micro"}
          >
            <MicGlyph muted={!micEnabled} />
          </button>
          <button
            type="button"
            className="call-ctl call-ctl--sm"
            data-off={!cameraEnabled}
            onClick={() => void toggleCamera()}
            disabled={status !== "in-call"}
            aria-pressed={cameraEnabled}
            aria-label={cameraEnabled ? "Couper la caméra" : "Activer la caméra"}
            title={cameraEnabled ? "Couper la caméra" : "Activer la caméra"}
          >
            <CameraGlyph off={!cameraEnabled} />
          </button>
          <button
            type="button"
            className="call-ctl call-ctl--sm"
            data-off={!screenEnabled}
            data-sharing={screenEnabled}
            onClick={() => void toggleScreenShare()}
            disabled={status !== "in-call"}
            aria-pressed={screenEnabled}
            aria-label={screenEnabled ? "Arrêter le partage d'écran" : "Partager l'écran"}
            title={screenEnabled ? "Arrêter le partage d'écran" : "Partager l'écran"}
          >
            <Icon name="monitor" size={16} />
          </button>
          <Popover
            side="bottom"
            align="end"
            trigger={
              <button
                type="button"
                className="call-ctl call-ctl--sm"
                disabled={status !== "in-call"}
                aria-label="Périphériques"
                title="Périphériques (appliqués en direct)"
              >
                <Icon name="gear" size={15} />
              </button>
            }
          >
            <DeviceMenu />
          </Popover>
          <button
            type="button"
            className="call-ctl call-ctl--sm call-ctl--hangup"
            onClick={leaveCall}
            aria-label="Raccrocher"
            title="Raccrocher"
          >
            <Icon name="phone" size={16} />
          </button>
        </div>
      </div>

      {/* ── Bande participants (jamais tronquée : elle défile) ── */}
      <div className="call-banner__people" role="list" aria-label="Participants">
        {people.map((identity) => {
          const isSelf = identity === localIdentity;
          const userId = identity.split(":")[0];
          const volume = Math.round((voiceVolumes[userId] ?? 1) * 100);
          const chip = (
            <div
              className="call-peer"
              role="listitem"
              data-speaking={activeSpeakers.includes(identity)}
              data-muted={mutedMics.includes(identity)}
              title={displayName(identity)}
            >
              <span className="call-peer__avatar">
                <Avatar name={displayName(identity)} size={36} src={avatarOf(identity)} />
                {mutedMics.includes(identity) && (
                  <span className="call-peer__muted">
                    <MicGlyph muted />
                  </span>
                )}
              </span>
              <span className="call-peer__name">{displayName(identity)}</span>
            </div>
          );
          // Son propre chip n'a pas de volume ; les autres : clic → slider.
          return isSelf ? (
            <div key={identity} className="call-peer__wrap">
              {chip}
            </div>
          ) : (
            <Popover
              key={identity}
              side="bottom"
              trigger={
                <button type="button" className="call-peer__wrap" aria-label={`Volume de ${displayName(identity)}`}>
                  {chip}
                </button>
              }
            >
              <div className="call-volume">
                <span className="call-volume__label">
                  Volume de {displayName(identity)} — {volume} %
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={volume}
                  onChange={(e) => setVoiceVolume(identity, Number(e.target.value) / 100)}
                  aria-label={`Volume de ${displayName(identity)}`}
                />
              </div>
            </Popover>
          );
        })}
      </div>

      {/* ── Scène (tuile agrandie) ── */}
      {stageTile && (
        <div className="call-stage" ref={stageRef}>
          {(() => {
            const track = getVideoTrack(stageTile);
            return track ? (
              <VideoTile track={track} mirror={stageTile === localIdentity} />
            ) : null;
          })()}
          <span className="call-stage__name">{displayName(stageTile)}</span>
          {tileControls(stageTile, true)}
        </div>
      )}

      {/* ── Bande médias (caméras + streams) ── */}
      {mediaTiles.length > 0 && (
        <div className="call-banner__media" role="list" aria-label="Caméras et partages">
          {mediaTiles.map((tile) => {
            const track = getVideoTrack(tile);
            if (!track) return null;
            return (
              <div
                key={tile}
                className="call-tile"
                role="listitem"
                data-focused={tile === stageTile}
                data-speaking={activeSpeakers.includes(tile.split("#")[0])}
                onDoubleClick={() => setFocusedTile(tile === focusedTile ? null : tile)}
              >
                <VideoTile track={track} mirror={tile === localIdentity} />
                <span className="call-tile__name">{displayName(tile)}</span>
                {tileControls(tile, false)}
              </div>
            );
          })}
        </div>
      )}
      {status === "in-call" && <SharedCallMedia />}
    </div>
  );
}
