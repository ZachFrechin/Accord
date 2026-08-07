import { useEffect, useMemo, useRef, useState } from "react";

import {
  driftCorrectionSeconds,
  isYoutubeBridgeMessage,
  parseYouTubeVideoId,
} from "@accord/core/lib/callMedia";
import {
  deletePersonalSound,
  listPersonalSounds,
  normalizePersonalSound,
  savePersonalSound,
  type PersonalSoundClip,
} from "@accord/core/lib/soundboard";

import { useCallMediaStore, BUILTIN_SOUNDS, currentExpectedPositionSeconds } from "../../stores/useCallMediaStore";
import { useCallStore } from "../../stores/useCallStore";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";

type Consent = "unknown" | "accepted" | "declined";

function savedConsent(): Consent {
  const value = localStorage.getItem("accord.youtube-privacy-v1");
  return value === "accepted" || value === "declined" ? value : "unknown";
}

export function SharedCallMedia({ compact = false }: { compact?: boolean }) {
  const available = useCallMediaStore((s) => s.available);
  const bridgeUrl = useCallMediaStore((s) => s.bridgeUrl);
  const shared = useCallMediaStore((s) => s.shared);
  const serverClockOffsetMs = useCallMediaStore((s) => s.serverClockOffsetMs);
  const musicVolume = useCallMediaStore((s) => s.musicVolume);
  const musicMuted = useCallMediaStore((s) => s.musicMuted);
  const effectsVolume = useCallMediaStore((s) => s.effectsVolume);
  const effectsMuted = useCallMediaStore((s) => s.effectsMuted);
  const audioBlocked = useCallMediaStore((s) => s.audioBlocked);
  const youtubeError = useCallMediaStore((s) => s.youtubeError);
  const playerHidden = useCallMediaStore((s) => s.playerHidden);
  const mutate = useCallMediaStore((s) => s.mutate);
  const triggerBuiltin = useCallMediaStore((s) => s.triggerBuiltin);
  const triggerCustom = useCallMediaStore((s) => s.triggerCustom);
  const participants = useCallStore((s) => s.participants);
  const names = useCallStore((s) => s.names);
  const myUserId = useInstanceStore((s) => activeInstance(s)?.account?.userId ?? null);

  const [consent, setConsent] = useState<Consent>(savedConsent);
  const [input, setInput] = useState("");
  const [clips, setClips] = useState<PersonalSoundClip[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const channelRef = useRef(crypto.randomUUID().replaceAll("-", ""));
  const loadedVideoRef = useRef<string | null>(null);

  const current = shared?.queue.find((item) => item.id === shared.currentItemId) ?? null;
  const bridgeOrigin = useMemo(() => {
    try {
      return bridgeUrl ? new URL(bridgeUrl).origin : null;
    } catch {
      return null;
    }
  }, [bridgeUrl]);
  const frameSrc = bridgeUrl
    ? `${bridgeUrl}?channel=${encodeURIComponent(channelRef.current)}`
    : null;

  const post = (type: string, detail: Record<string, unknown> = {}) => {
    if (!bridgeOrigin) return;
    iframeRef.current?.contentWindow?.postMessage(
      { source: "accord-parent", channel: channelRef.current, type, ...detail },
      bridgeOrigin,
    );
  };

  useEffect(() => {
    if (!compact) void listPersonalSounds().then(setClips).catch(() => setClips([]));
  }, [compact]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!bridgeOrigin || !isYoutubeBridgeMessage(event, {
        origin: bridgeOrigin,
        source: iframeRef.current?.contentWindow ?? null,
        channel: channelRef.current,
      })) return;
      if (event.data.type === "READY" || event.data.type === "HELLO_ACK") {
        setBridgeReady(true);
      } else if (event.data.type === "AUTOPLAY_BLOCKED") {
        useCallMediaStore.getState().setAudioBlocked(true);
      } else if (event.data.type === "ERROR") {
        useCallMediaStore.getState().setYoutubeError(Number(event.data.code));
      } else if (event.data.type === "USER_SEEK") {
        void mutate({
          type: "seek",
          positionSeconds: Math.max(0, Number(event.data.positionSeconds) || 0),
          serverNowMs: Date.now() + serverClockOffsetMs,
        });
      } else if (event.data.type === "STATE_CHANGE" && !event.data.remotelyApplied) {
        const position = Math.max(0, Number(event.data.positionSeconds) || 0);
        const serverNowMs = Date.now() + serverClockOffsetMs;
        const state = Number(event.data.state);
        if (state === 1) void mutate({ type: "play", positionSeconds: position, serverNowMs });
        else if (state === 2) void mutate({ type: "pause", positionSeconds: position, serverNowMs });
        else if (state === 0) {
          const leader = [...new Set(participants.map((identity) => identity.split(":")[0]))].sort()[0];
          if (myUserId && leader === myUserId) void mutate({ type: "skip", serverNowMs });
        }
      } else if (event.data.type === "STATE") {
        const actual = Number(event.data.positionSeconds) || 0;
        const correction = driftCorrectionSeconds(actual, currentExpectedPositionSeconds());
        if (correction !== null) post("SEEK", { positionSeconds: correction });
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [bridgeOrigin, mutate, myUserId, participants, serverClockOffsetMs]);

  useEffect(() => {
    if (!bridgeReady || !current || playerHidden) return;
    const positionSeconds = currentExpectedPositionSeconds();
    if (loadedVideoRef.current !== current.videoId) {
      loadedVideoRef.current = current.videoId;
      post("LOAD", { videoId: current.videoId, positionSeconds });
    } else {
      post("SEEK", { positionSeconds });
    }
    post(shared?.status === "playing" ? "PLAY" : "PAUSE");
  }, [bridgeReady, current?.videoId, playerHidden, shared?.status, shared?.anchorServerTimeMs]);

  useEffect(() => {
    if (!bridgeReady || playerHidden) return;
    post("VOLUME", { volume: Math.round(musicVolume * 100) });
    post(musicMuted ? "MUTE" : "UNMUTE");
  }, [bridgeReady, musicMuted, musicVolume, playerHidden]);

  useEffect(() => {
    if (!bridgeReady || playerHidden) return;
    const timer = setInterval(() => post("GET_STATE"), 1_000);
    return () => clearInterval(timer);
  }, [bridgeReady, playerHidden]);

  useEffect(() => () => post("PAUSE"), [bridgeOrigin]);

  if (!available) return null;

  const decideConsent = (next: Exclude<Consent, "unknown">) => {
    localStorage.setItem("accord.youtube-privacy-v1", next);
    setConsent(next);
  };

  const enqueue = () => {
    const videoId = parseYouTubeVideoId(input);
    if (!videoId || !myUserId) return;
    void mutate({
      type: "enqueue",
      item: { id: crypto.randomUUID(), videoId, contributedBy: myUserId },
    });
    setInput("");
  };

  const importClip = async (file: File | undefined) => {
    if (!file) return;
    setImportError(null);
    try {
      const clip = await normalizePersonalSound(file);
      await savePersonalSound(clip);
      setClips(await listPersonalSounds());
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import impossible");
    }
  };

  const hidePlayer = () => {
    post("PAUSE");
    useCallMediaStore.getState().setPlayerHidden(true);
  };

  const player = consent === "accepted" && current && !playerHidden && frameSrc ? (
    <div className="shared-media__player-wrap">
      <iframe
        ref={iframeRef}
        className="shared-media__player"
        src={frameSrc}
        title="Lecteur YouTube partagé"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => post("HELLO")}
      />
      <button type="button" className="shared-media__hide" onClick={hidePlayer}>Masquer</button>
    </div>
  ) : null;

  return (
    <section className={`shared-media ${compact ? "shared-media--compact" : ""}`} aria-label="Musique et sons partagés">
      {consent === "unknown" && (
        <div className="shared-media__privacy" role="dialog" aria-label="Confidentialité YouTube">
          <p>YouTube recevra l'adresse IP et les données habituelles d'un lecteur intégré. Accord ne transmet aucun jeton d'authentification.</p>
          <div>
            <button type="button" onClick={() => decideConsent("accepted")}>Autoriser YouTube</button>
            <button type="button" onClick={() => decideConsent("declined")}>Non merci</button>
          </div>
        </div>
      )}
      {player}
      {consent === "declined" && !compact && (
        <p className="shared-media__notice">YouTube est désactivé sur cet appareil. Le soundboard reste disponible.</p>
      )}
      {playerHidden && current && consent === "accepted" && (
        <button type="button" className="shared-media__reopen" onClick={() => useCallMediaStore.getState().setPlayerHidden(false)}>
          Afficher le lecteur partagé
        </button>
      )}
      {audioBlocked && (
        <button type="button" className="shared-media__enable" onClick={() => {
          void useCallMediaStore.getState().enableAudio();
          post("PLAY");
        }}>Activer l'audio partagé</button>
      )}
      {youtubeError && [100, 101, 150, 153].includes(youtubeError) && (
        <p className="shared-media__error">Cette vidéo est privée, indisponible ou non intégrable (erreur {youtubeError}).</p>
      )}

      {!compact && (
        <div className="shared-media__body">
          <div className="shared-media__music">
            <div className="shared-media__heading"><strong>Musique</strong><span>{shared?.queue.length ?? 0}/50</span></div>
            {consent === "accepted" && (
              <div className="shared-media__add">
                <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && enqueue()} placeholder="Lien YouTube" aria-label="Lien YouTube" />
                <button type="button" onClick={enqueue} disabled={!parseYouTubeVideoId(input)}>Ajouter</button>
              </div>
            )}
            <div className="shared-media__transport">
              <button type="button" onClick={() => void mutate({
                type: shared?.status === "playing" ? "pause" : "play",
                positionSeconds: currentExpectedPositionSeconds(),
                serverNowMs: Date.now() + serverClockOffsetMs,
              })} disabled={!current}>{shared?.status === "playing" ? "Pause" : "Lecture"}</button>
              <button type="button" onClick={() => void mutate({ type: "skip", serverNowMs: Date.now() + serverClockOffsetMs })} disabled={!current}>Suivant</button>
              <button type="button" onClick={() => useCallMediaStore.getState().setMusicMuted(!musicMuted)}>{musicMuted ? "Réactiver" : "Couper"}</button>
              <input type="range" min={0} max={100} value={Math.round(musicVolume * 100)} onChange={(event) => useCallMediaStore.getState().setMusicVolume(Number(event.target.value) / 100)} aria-label="Volume de la musique" />
            </div>
            <ol className="shared-media__queue">
              {shared?.queue.map((item, index) => (
                <li key={item.id} data-current={item.id === shared.currentItemId}>
                  <span>{item.videoId}</span>
                  <small>{names[item.contributedBy] ?? (item.contributedBy === myUserId ? "Vous" : "Membre")}</small>
                  <button type="button" onClick={() => void mutate({ type: "reorder", itemId: item.id, toIndex: index - 1 })} disabled={index === 0}>↑</button>
                  <button type="button" onClick={() => void mutate({ type: "reorder", itemId: item.id, toIndex: index + 1 })} disabled={index === (shared?.queue.length ?? 0) - 1}>↓</button>
                  <button type="button" onClick={() => void mutate({ type: "remove", itemId: item.id })} aria-label="Retirer">×</button>
                </li>
              ))}
            </ol>
          </div>

          <div className="shared-media__sounds">
            <div className="shared-media__heading"><strong>Soundboard</strong></div>
            <div className="shared-media__transport">
              <button type="button" onClick={() => useCallMediaStore.getState().setEffectsMuted(!effectsMuted)}>{effectsMuted ? "Réactiver" : "Couper"}</button>
              <input type="range" min={0} max={100} value={Math.round(effectsVolume * 100)} onChange={(event) => useCallMediaStore.getState().setEffectsVolume(Number(event.target.value) / 100)} aria-label="Volume des effets" />
            </div>
            <div className="shared-media__sound-grid">
              {BUILTIN_SOUNDS.map((sound) => <button type="button" key={sound.id} onClick={() => void triggerBuiltin(sound.id)}>{sound.label}</button>)}
              {clips.map((clip) => (
                <span className="shared-media__custom" key={clip.id}>
                  <button type="button" onClick={() => void triggerCustom(clip)}>{clip.label}</button>
                  <button type="button" aria-label={`Supprimer ${clip.label}`} onClick={() => void deletePersonalSound(clip.id).then(() => listPersonalSounds()).then(setClips)}>×</button>
                </span>
              ))}
            </div>
            <label className="shared-media__import">
              Importer un son
              <input type="file" accept="audio/*" onChange={(event) => void importClip(event.target.files?.[0])} />
            </label>
            {importError && <p className="shared-media__error">{importError}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
