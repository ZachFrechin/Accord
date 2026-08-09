import { useEffect, useMemo, useRef, useState } from "react";

import {
  activeSharedMediaQueue,
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
import { Icon } from "../ui";

type Consent = "unknown" | "accepted" | "declined";
type OpenPanel = "youtube" | "soundboard" | null;

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
  const prepareCustom = useCallMediaStore((s) => s.prepareCustom);
  const triggerCustom = useCallMediaStore((s) => s.triggerCustom);
  const mediaConversationId = useCallMediaStore((s) => s.conversationId);
  const participants = useCallStore((s) => s.participants);
  const names = useCallStore((s) => s.names);
  const myUserId = useInstanceStore((s) => activeInstance(s)?.account?.userId ?? null);

  const [consent, setConsent] = useState<Consent>(savedConsent);
  const [input, setInput] = useState("");
  const [clips, setClips] = useState<PersonalSoundClip[]>([]);
  const [preparingClipIds, setPreparingClipIds] = useState<Set<string>>(() => new Set());
  const [importError, setImportError] = useState<string | null>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const channelRef = useRef(crypto.randomUUID().replaceAll("-", ""));
  const loadedItemRef = useRef<string | null>(null);
  const bridgeProtocolVersionRef = useRef(1);

  const visibleQueue = useMemo(() => shared ? activeSharedMediaQueue(shared) : [], [shared]);
  const current = visibleQueue[0] ?? null;
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
      if (event.data.type === "READY") {
        bridgeProtocolVersionRef.current = Math.max(1, Number(event.data.protocolVersion) || 1);
        setBridgeReady(true);
      } else if (event.data.type === "HELLO_ACK") {
        const protocolVersion = Math.max(1, Number(event.data.protocolVersion) || 1);
        bridgeProtocolVersionRef.current = protocolVersion;
        if (protocolVersion < 2) {
          const source = event.source;
          window.setTimeout(() => {
            if (iframeRef.current?.contentWindow === source) setBridgeReady(true);
          }, 500);
        }
      } else if (event.data.type === "AUTOPLAY_BLOCKED") {
        if (event.data.mediaItemId && event.data.mediaItemId !== current?.id) return;
        useCallMediaStore.getState().setAudioBlocked(true);
      } else if (event.data.type === "ERROR") {
        if (event.data.mediaItemId && event.data.mediaItemId !== current?.id) return;
        useCallMediaStore.getState().setYoutubeError(Number(event.data.code));
      } else if (event.data.type === "USER_SEEK") {
        if (event.data.mediaItemId && event.data.mediaItemId !== current?.id) return;
        void mutate({
          type: "seek",
          positionSeconds: Math.max(0, Number(event.data.positionSeconds) || 0),
          serverNowMs: Date.now() + serverClockOffsetMs,
        });
      } else if (event.data.type === "STATE_CHANGE") {
        if (event.data.mediaItemId && event.data.mediaItemId !== current?.id) return;
        if (event.data.videoId && event.data.videoId !== current?.videoId) return;
        const position = Math.max(0, Number(event.data.positionSeconds) || 0);
        const serverNowMs = Date.now() + serverClockOffsetMs;
        const state = Number(event.data.state);
        if (state === 1) useCallMediaStore.getState().setAudioBlocked(false);
        if (event.data.remotelyApplied) return;
        if (state === 1) void mutate({ type: "play", positionSeconds: position, serverNowMs });
        else if (state === 2) void mutate({ type: "pause", positionSeconds: position, serverNowMs });
        else if (state === 0) {
          const leader = [...new Set(participants.map((identity) => identity.split(":")[0]))].sort()[0];
          if (myUserId && leader === myUserId) void mutate({ type: "skip", serverNowMs });
        }
      } else if (event.data.type === "STATE") {
        if (event.data.mediaItemId && event.data.mediaItemId !== current?.id) return;
        const state = Number(event.data.state);
        if (state !== 1 && state !== 2) return;
        const actual = Number(event.data.positionSeconds) || 0;
        const correction = driftCorrectionSeconds(actual, currentExpectedPositionSeconds());
        if (correction !== null) post("SEEK", { positionSeconds: correction });
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [bridgeOrigin, current?.id, current?.videoId, mutate, myUserId, participants, serverClockOffsetMs]);

  useEffect(() => {
    if (current) return;
    loadedItemRef.current = null;
    bridgeProtocolVersionRef.current = 1;
    setBridgeReady(false);
  }, [current?.id]);

  useEffect(() => {
    if (!bridgeReady || !current || playerHidden) return;
    const positionSeconds = currentExpectedPositionSeconds();
    const playing = shared?.status === "playing";
    if (loadedItemRef.current !== current.id) {
      loadedItemRef.current = current.id;
      useCallMediaStore.getState().setYoutubeError(null);
      post("LOAD", {
        mediaItemId: current.id,
        videoId: current.videoId,
        positionSeconds,
        playing,
      });
      if (playing && bridgeProtocolVersionRef.current < 2) {
        const compatibilityRetry = window.setTimeout(() => post("PLAY"), 900);
        return () => window.clearTimeout(compatibilityRetry);
      }
    } else {
      post("SEEK", { positionSeconds });
      post(playing ? "PLAY" : "PAUSE");
    }
  }, [bridgeReady, current?.id, current?.videoId, playerHidden, shared?.status, shared?.anchorServerTimeMs]);

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
      serverNowMs: Date.now() + serverClockOffsetMs,
    });
    setInput("");
    setOpenPanel("youtube");
  };

  const prepareClip = async (clip: PersonalSoundClip) => {
    if (!mediaConversationId || clip.attachments[mediaConversationId] || preparingClipIds.has(clip.id)) return;
    setPreparingClipIds((ids) => new Set(ids).add(clip.id));
    try {
      const prepared = await prepareCustom(clip);
      if (prepared) {
        setClips((items) => items.map((item) => item.id === prepared.id ? prepared : item));
      }
    } catch {
      setImportError("Le son est conservé localement, mais sa préparation pour l’appel a échoué.");
    } finally {
      setPreparingClipIds((ids) => {
        const next = new Set(ids);
        next.delete(clip.id);
        return next;
      });
    }
  };

  const importClip = async (file: File | undefined) => {
    if (!file) return;
    setImportError(null);
    try {
      const clip = await normalizePersonalSound(file);
      await savePersonalSound(clip);
      setClips(await listPersonalSounds());
      void prepareClip(clip);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import impossible");
    }
  };

  const hidePlayer = () => {
    post("PAUSE");
    setBridgeReady(false);
    loadedItemRef.current = null;
    bridgeProtocolVersionRef.current = 1;
    useCallMediaStore.getState().setPlayerHidden(true);
  };

  const reopenPlayer = () => {
    setBridgeReady(false);
    loadedItemRef.current = null;
    bridgeProtocolVersionRef.current = 1;
    useCallMediaStore.getState().setPlayerHidden(false);
  };

  const togglePanel = (panel: Exclude<OpenPanel, null>) => {
    setOpenPanel((open) => open === panel ? null : panel);
    if (panel === "youtube" && playerHidden) reopenPlayer();
  };

  const enablePlayback = () => {
    void useCallMediaStore.getState().enableAudio().then(() => post("PLAY"));
  };

  const player = consent === "accepted" && current && !playerHidden && frameSrc ? (
    <div className="shared-media__player-card">
      <div className="shared-media__player-wrap">
        <iframe
          ref={iframeRef}
          className="shared-media__player"
          src={frameSrc}
          title="Lecteur YouTube partagé"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => {
            setBridgeReady(false);
            loadedItemRef.current = null;
            bridgeProtocolVersionRef.current = 1;
            post("HELLO");
          }}
        />
      </div>
      <div className="shared-media__player-footer">
        <span><i data-playing={shared?.status === "playing"} />{shared?.status === "playing" ? "Lecture partagée" : "En pause"}</span>
        <button type="button" onClick={hidePlayer}>Masquer sur cet appareil</button>
      </div>
    </div>
  ) : null;

  if (compact && !current) return null;

  const youtubeStatus = consent === "declined"
    ? "Désactivé sur cet appareil"
    : current
      ? shared?.status === "playing" ? "Lecture partagée" : "En pause"
      : visibleQueue.length > 0 ? `${visibleQueue.length} dans la file` : "Ajouter une vidéo";
  const soundCount = BUILTIN_SOUNDS.length + clips.length;

  return (
    <section
      className={`shared-media ${compact ? "shared-media--compact" : ""}`}
      data-panel={openPanel ?? "closed"}
      aria-label="Musique et sons partagés"
    >
      {!compact && (
        <div className="shared-media__launchers" role="group" aria-label="Outils audio de l'appel">
          <button
            type="button"
            className="shared-media__launcher shared-media__launcher--youtube"
            data-active={openPanel === "youtube"}
            aria-expanded={openPanel === "youtube"}
            aria-controls="shared-media-youtube"
            onClick={() => togglePanel("youtube")}
          >
            <span className="shared-media__launcher-icon"><Icon name="play" size={20} /></span>
            <span className="shared-media__launcher-copy"><strong>YouTube</strong><small>{youtubeStatus}</small></span>
            <span className="shared-media__launcher-count">{visibleQueue.length}</span>
          </button>
          <button
            type="button"
            className="shared-media__launcher shared-media__launcher--soundboard"
            data-active={openPanel === "soundboard"}
            aria-expanded={openPanel === "soundboard"}
            aria-controls="shared-media-soundboard"
            onClick={() => togglePanel("soundboard")}
          >
            <span className="shared-media__launcher-icon"><Icon name="music-note" size={21} /></span>
            <span className="shared-media__launcher-copy"><strong>Soundboard</strong><small>{soundCount} sons disponibles</small></span>
            <span className="shared-media__launcher-count">{soundCount}</span>
          </button>
        </div>
      )}

      {consent === "unknown" && (current || openPanel === "youtube") && (
        <div className="shared-media__privacy" role="dialog" aria-label="Confidentialité YouTube">
          <span className="shared-media__privacy-icon"><Icon name="play" size={18} /></span>
          <div className="shared-media__privacy-copy">
            <strong>Charger le lecteur YouTube ?</strong>
            <p>YouTube recevra l’adresse IP et les données habituelles d’un lecteur intégré. Accord ne transmet aucun jeton d’authentification.</p>
          </div>
          <div className="shared-media__privacy-actions">
            <button type="button" className="shared-media__primary" onClick={() => decideConsent("accepted")}>Autoriser</button>
            <button type="button" onClick={() => decideConsent("declined")}>Pas maintenant</button>
          </div>
        </div>
      )}

      {playerHidden && current && consent === "accepted" && (
        <button type="button" className="shared-media__reopen" onClick={reopenPlayer}>
          <Icon name="play" size={16} /> Afficher la vidéo partagée
        </button>
      )}
      {audioBlocked && (
        <div className="shared-media__status" role="status">
          <span>La lecture automatique est bloquée sur cet appareil.</span>
          <button type="button" className="shared-media__enable" onClick={enablePlayback}>Démarrer la lecture</button>
        </div>
      )}
      {youtubeError && [100, 101, 150, 153].includes(youtubeError) && (
        <p className="shared-media__error">Cette vidéo est privée, indisponible ou non intégrable (erreur {youtubeError}).</p>
      )}

      <div className={`shared-media__workspace shared-media__workspace--${openPanel ?? "closed"}`}>
        {player}

        {!compact && openPanel === "youtube" && (
          <div id="shared-media-youtube" className="shared-media__panel shared-media__music">
            <div className="shared-media__heading">
              <span><strong>File YouTube</strong><small>Partagée avec le vocal</small></span>
              <b>{visibleQueue.length}<small>/50</small></b>
            </div>
            {consent === "accepted" ? (
              <div className="shared-media__add">
                <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && enqueue()} placeholder="Coller un lien YouTube" aria-label="Lien YouTube" />
                <button type="button" className="shared-media__primary" onClick={enqueue} disabled={!parseYouTubeVideoId(input)}><Icon name="plus" size={15} />Ajouter</button>
              </div>
            ) : consent === "declined" ? (
              <div className="shared-media__notice">
                <span>YouTube est désactivé sur cet appareil. La soundboard reste disponible.</span>
                <button type="button" onClick={() => decideConsent("accepted")}>Réactiver YouTube</button>
              </div>
            ) : null}

            <div className="shared-media__transport">
              <button type="button" className="shared-media__transport-main" onClick={() => void mutate({
                type: shared?.status === "playing" ? "pause" : "play",
                positionSeconds: currentExpectedPositionSeconds(),
                serverNowMs: Date.now() + serverClockOffsetMs,
              })} disabled={!current}><Icon name={shared?.status === "playing" ? "stop" : "play"} size={15} />{shared?.status === "playing" ? "Pause" : "Lecture"}</button>
              <button type="button" onClick={() => void mutate({ type: "skip", serverNowMs: Date.now() + serverClockOffsetMs })} disabled={!current}>Suivant</button>
              <button type="button" onClick={() => useCallMediaStore.getState().setMusicMuted(!musicMuted)}><Icon name="speaker-high" size={15} />{musicMuted ? "Réactiver" : "Couper"}</button>
            </div>
            <label className="shared-media__volume">
              <span>Volume de la musique <b>{Math.round(musicVolume * 100)}%</b></span>
              <input type="range" min={0} max={100} value={Math.round(musicVolume * 100)} onChange={(event) => useCallMediaStore.getState().setMusicVolume(Number(event.target.value) / 100)} />
            </label>

            <ol className="shared-media__queue">
              {visibleQueue.map((item, index) => (
                <li key={item.id} data-current={item.id === shared?.currentItemId} aria-current={item.id === shared?.currentItemId ? "true" : undefined}>
                  <span className="shared-media__queue-index">{index + 1}</span>
                  <span className="shared-media__queue-copy"><strong>Vidéo {index + 1}</strong><code>{item.videoId}</code></span>
                  <small title={names[item.contributedBy] ?? "Membre"}>{item.contributedBy === myUserId ? "Vous" : names[item.contributedBy] ?? "Membre"}</small>
                  <span className="shared-media__queue-actions">
                    <button type="button" aria-label="Monter dans la file" onClick={() => void mutate({ type: "reorder", itemId: item.id, toIndex: index - 1 })} disabled={index <= 1}>↑</button>
                    <button type="button" aria-label="Descendre dans la file" onClick={() => void mutate({ type: "reorder", itemId: item.id, toIndex: index + 1 })} disabled={index === 0 || index === visibleQueue.length - 1}>↓</button>
                    <button type="button" onClick={() => void mutate({ type: "remove", itemId: item.id, serverNowMs: Date.now() + serverClockOffsetMs })} aria-label="Retirer de la file"><Icon name="x" size={12} /></button>
                  </span>
                </li>
              ))}
              {visibleQueue.length === 0 && <li className="shared-media__empty">Collez un lien pour lancer la première vidéo chez tout le monde.</li>}
            </ol>
          </div>
        )}

        {!compact && openPanel === "soundboard" && (
          <div id="shared-media-soundboard" className="shared-media__panel shared-media__sounds">
            <div className="shared-media__heading">
              <span><strong>Soundboard</strong><small>Un clic, un son pour tout le vocal</small></span>
              <b>{soundCount}</b>
            </div>
            <div className="shared-media__transport">
              <button type="button" onClick={() => useCallMediaStore.getState().setEffectsMuted(!effectsMuted)}><Icon name="speaker-high" size={15} />{effectsMuted ? "Réactiver" : "Couper"}</button>
            </div>
            <label className="shared-media__volume">
              <span>Volume des effets <b>{Math.round(effectsVolume * 100)}%</b></span>
              <input type="range" min={0} max={100} value={Math.round(effectsVolume * 100)} onChange={(event) => useCallMediaStore.getState().setEffectsVolume(Number(event.target.value) / 100)} />
            </label>
            <div className="shared-media__sound-grid">
              {BUILTIN_SOUNDS.map((sound) => <button type="button" key={sound.id} title={sound.label} onClick={() => void triggerBuiltin(sound.id)}><span>{sound.label}</span></button>)}
              {clips.map((clip) => (
                <span className="shared-media__custom" key={clip.id}>
                  <button
                    type="button"
                    title={preparingClipIds.has(clip.id) ? `${clip.label} — préparation en cours` : clip.label}
                    data-preparing={preparingClipIds.has(clip.id)}
                    onPointerEnter={() => void prepareClip(clip)}
                    onFocus={() => void prepareClip(clip)}
                    onClick={() => void triggerCustom(clip)}
                  ><span>{preparingClipIds.has(clip.id) ? "Préparation…" : clip.label}</span></button>
                  <button type="button" aria-label={`Supprimer ${clip.label}`} onClick={() => void deletePersonalSound(clip.id).then(() => listPersonalSounds()).then(setClips)}><Icon name="x" size={10} /></button>
                </span>
              ))}
            </div>
            <label className="shared-media__import">
              <Icon name="plus" size={15} /> Importer un son personnel
              <input type="file" accept="audio/*" onChange={(event) => void importClip(event.target.files?.[0])} />
            </label>
            {importError && <p className="shared-media__error">{importError}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
