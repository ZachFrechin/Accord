/**
 * Réglages → Audio & vidéo, en trois groupes :
 *  1. Périphériques — micro / caméra / sortie, avec un test micro à vu-mètre live.
 *  2. Sonnerie d'appel — chips sélectionnables (cliquer = choisir ET écouter),
 *     volume avec aperçu.
 *  3. Sonnerie par ami — table recherchable ; par ami : sonnerie synthé ou
 *     fichier audio importé (nom + durée affichés, lecture/arrêt, suppression).
 *
 * Un seul lecteur d'aperçu global : démarrer un aperçu arrête le précédent,
 * un fichier illisible remonte un toast au lieu d'échouer en silence.
 */

import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  deleteRingtoneFile,
  ensureRingtoneDuration,
  getRingtoneFile,
  listRingtoneFiles,
  saveRingtoneFile,
} from "../../lib/ringtoneFiles";
import {
  RINGTONES,
  ringtoneLoopSeconds,
  startRinging,
  type ContactTone,
  type RingtoneId,
} from "../../lib/ringtones";
import { searchNormalize } from "../../lib/searchText";
import { useFriendsStore } from "../../stores/useFriendsStore";
import { useMediaSettingsStore } from "../../stores/useMediaSettingsStore";
import { Avatar } from "../messaging/Avatar";
import { Button, Icon, IconButton, useToast } from "../ui";

interface DeviceLists {
  mics: MediaDeviceInfo[];
  cams: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  /** Labels are empty until mic/cam permission has been granted once. */
  needsPermission: boolean;
}

async function listDevices(): Promise<DeviceLists> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    mics: all.filter((d) => d.kind === "audioinput"),
    cams: all.filter((d) => d.kind === "videoinput"),
    speakers: all.filter((d) => d.kind === "audiooutput"),
    needsPermission: all.length > 0 && all.every((d) => !d.label),
  };
}

function fmtDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Key of whatever preview is playing: "tone:carillon" | "friend:<userId>". */
type PlayKey = string;

export function MediaSettingsSection() {
  const micId = useMediaSettingsStore((s) => s.micId);
  const camId = useMediaSettingsStore((s) => s.camId);
  const speakerId = useMediaSettingsStore((s) => s.speakerId);
  const ringtone = useMediaSettingsStore((s) => s.ringtone);
  const ringVolume = useMediaSettingsStore((s) => s.ringVolume);
  const contactRingtones = useMediaSettingsStore((s) => s.contactRingtones);
  const store = useMediaSettingsStore;

  const { toast } = useToast();
  const friends = useFriendsStore((s) => s.friends);

  /* ── Devices ──────────────────────────────────────────────────────────── */
  const [devices, setDevices] = useState<DeviceLists | null>(null);
  const refresh = useCallback(() => {
    void listDevices()
      .then(setDevices)
      .catch(() => setDevices(null));
  }, []);

  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);

  const grantPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* denied — the pickers just keep generic labels */
    }
    refresh();
  };

  /* ── Mic test (live level meter) ──────────────────────────────────────── */
  const [micLevel, setMicLevel] = useState<number | null>(null); // null = test off
  const micStopRef = useRef<(() => void) | null>(null);

  const stopMicTest = useCallback(() => {
    micStopRef.current?.();
    micStopRef.current = null;
    setMicLevel(null);
  }, []);

  const toggleMicTest = async () => {
    if (micStopRef.current) {
      stopMicTest();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micId ? { deviceId: { ideal: micId } } : true,
      });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let raf = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
        setMicLevel(peak);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      micStopRef.current = () => {
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
      };
      setMicLevel(0);
    } catch {
      toast({ title: "Micro inaccessible", description: "Vérifiez l'autorisation micro." });
    }
  };

  /* ── Global preview player (one at a time) ────────────────────────────── */
  const [playing, setPlaying] = useState<PlayKey | null>(null);
  const playerRef = useRef<{ key: PlayKey; stop: () => void } | null>(null);

  const stopPreview = useCallback(() => {
    playerRef.current?.stop();
    playerRef.current = null;
    setPlaying(null);
  }, []);

  // Everything audible dies with the page.
  useEffect(() => () => {
    playerRef.current?.stop();
    micStopRef.current?.();
  }, []);

  /** One loop of a synth tone. */
  const previewTone = (key: PlayKey, id: RingtoneId) => {
    stopPreview();
    const stopSynth = startRinging(id, ringVolume);
    const timer = setTimeout(() => {
      if (playerRef.current?.key === key) stopPreview();
    }, ringtoneLoopSeconds(id) * 1000);
    playerRef.current = {
      key,
      stop: () => {
        clearTimeout(timer);
        stopSynth();
      },
    };
    setPlaying(key);
  };

  /** The friend's imported file, once (no loop), with real error reporting. */
  const previewFile = async (key: PlayKey, userId: string) => {
    stopPreview();
    const f = await getRingtoneFile(userId).catch(() => null);
    if (!f) {
      toast({ title: "Fichier introuvable", description: "Réimportez une sonnerie." });
      return;
    }
    const url = URL.createObjectURL(f.blob);
    const audio = new Audio(url);
    audio.volume = Math.min(1, Math.max(0, ringVolume));
    const stop = () => {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
    const stopIfCurrent = () => {
      if (playerRef.current?.key === key) stopPreview();
    };
    audio.onended = stopIfCurrent;
    audio.onerror = () => {
      toast({ title: "Impossible de lire ce fichier" });
      stopIfCurrent();
    };
    playerRef.current = { key, stop };
    setPlaying(key);
    try {
      await audio.play();
    } catch {
      toast({ title: "Impossible de lire ce fichier" });
      stopIfCurrent();
    }
  };

  const toggleTonePreview = (id: RingtoneId) => {
    const key = `tone:${id}`;
    if (playing === key) stopPreview();
    else previewTone(key, id);
  };

  const toggleFriendPreview = (userId: string) => {
    const key = `friend:${userId}`;
    if (playing === key) {
      stopPreview();
      return;
    }
    const tone = contactRingtones[userId];
    if (tone === "custom") void previewFile(key, userId);
    else previewTone(key, tone ?? ringtone);
  };

  /* ── Per-friend ringtones ─────────────────────────────────────────────── */
  const [friendQuery, setFriendQuery] = useState("");
  const [files, setFiles] = useState<Record<string, { name: string; duration?: number }>>({});
  const filePickFor = useRef<string | null>(null);
  const toneFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void listRingtoneFiles()
      .then(async (metas) => {
        if (!alive) return;
        setFiles(Object.fromEntries(metas.map((m) => [m.userId, { name: m.name, duration: m.duration }])));
        // Records saved by older builds have no duration — measure once, persist.
        for (const m of metas.filter((m) => m.duration === undefined)) {
          const duration = await ensureRingtoneDuration(m.userId);
          if (!alive || duration === undefined) continue;
          setFiles((prev) => ({ ...prev, [m.userId]: { ...prev[m.userId], duration } }));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const friendName = (f: (typeof friends)[number]) => f.display_name?.trim() || f.username;
  const filteredFriends = friends.filter((f) => {
    const q = searchNormalize(friendQuery).trim();
    if (!q) return true;
    return (
      searchNormalize(f.username).includes(q) ||
      searchNormalize(f.display_name ?? "").includes(q)
    );
  });

  const onToneChange = (userId: string, value: string) => {
    // Switching away from "custom" KEEPS the imported file (the option stays
    // available); only the trash button deletes it.
    store.getState().setContactRingtone(userId, (value || null) as ContactTone | null);
    if (playing === `friend:${userId}`) stopPreview();
  };

  // A DIRECT button click only: on macOS the native <select> menu consumes the
  // user gesture, so WebKit ignores input.click() from a select's onChange.
  const importToneFile = (userId: string) => {
    filePickFor.current = userId;
    toneFileRef.current?.click();
  };

  const onToneFilePicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const userId = filePickFor.current;
    filePickFor.current = null;
    if (!file || !userId) return;
    try {
      const saved = await saveRingtoneFile(userId, file);
      store.getState().setContactRingtone(userId, "custom");
      setFiles((prev) => ({ ...prev, [userId]: { name: saved.name, duration: saved.duration } }));
      toast({
        title: "Sonnerie importée",
        description: `${saved.name} · ${fmtDuration(saved.duration)}`,
      });
    } catch (err) {
      toast({
        title: "Fichier refusé",
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const removeToneFile = async (userId: string) => {
    if (playing === `friend:${userId}`) stopPreview();
    await deleteRingtoneFile(userId).catch(() => {});
    setFiles((prev) => {
      const { [userId]: _dropped, ...rest } = prev;
      return rest;
    });
    if (contactRingtones[userId] === "custom") {
      store.getState().setContactRingtone(userId, null);
    }
  };

  /* ── Render ───────────────────────────────────────────────────────────── */
  const deviceSelect = (
    label: string,
    list: MediaDeviceInfo[],
    value: string | null,
    onChange: (id: string | null) => void,
  ) => (
    <label className="media-settings__field">
      <span className="media-settings__label">{label}</span>
      <select
        className="media-settings__select"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Par défaut du système</option>
        {list.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${label} ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>
    </label>
  );

  const groupHead = (icon: Parameters<typeof Icon>[0]["name"], title: string, sub: string) => (
    <header className="media-settings__group-head">
      <span className="media-settings__group-icon">
        <Icon name={icon} size={18} />
      </span>
      <div>
        <h3 className="media-settings__group-title">{title}</h3>
        <p className="media-settings__group-sub">{sub}</p>
      </div>
    </header>
  );

  return (
    <div className="media-settings">
      {/* ── Périphériques ── */}
      <section className="media-settings__group">
        {groupHead("microphone", "Périphériques", "Appliqués au prochain appel.")}
        {devices?.needsPermission && (
          <div className="media-settings__grant">
            <p className="home__hint">
              Autorisez l'accès au micro et à la caméra pour voir le nom de vos périphériques.
            </p>
            <Button size="sm" variant="outline" onClick={() => void grantPermission()}>
              Autoriser l'accès
            </Button>
          </div>
        )}
        <div className="media-settings__grid">
          {deviceSelect("Micro", devices?.mics ?? [], micId, (id) => store.getState().setMic(id))}
          {deviceSelect("Caméra", devices?.cams ?? [], camId, (id) => store.getState().setCam(id))}
          {deviceSelect("Sortie audio", devices?.speakers ?? [], speakerId, (id) =>
            store.getState().setSpeaker(id),
          )}
        </div>
        <div className="media-settings__mictest">
          <Button size="sm" variant={micLevel !== null ? "outline" : "ghost"} onClick={() => void toggleMicTest()}>
            {micLevel !== null ? "Arrêter le test" : "Tester le micro"}
          </Button>
          {micLevel !== null && (
            <div className="media-settings__vu" role="meter" aria-label="Niveau du micro">
              <div
                className="media-settings__vu-fill"
                style={{ width: `${Math.min(100, Math.round(micLevel * 140))}%` }}
              />
            </div>
          )}
        </div>
      </section>

      {/* ── Sonnerie d'appel ── */}
      <section className="media-settings__group">
        {groupHead("bell", "Sonnerie d'appel", "Cliquez une sonnerie pour la choisir et l'écouter.")}
        <div className="media-settings__tones" role="radiogroup" aria-label="Sonnerie d'appel">
          {RINGTONES.map((r) => {
            const active = ringtone === r.id;
            const isPlaying = playing === `tone:${r.id}`;
            return (
              <button
                key={r.id}
                type="button"
                className="media-settings__tone"
                data-active={active}
                data-playing={isPlaying}
                role="radio"
                aria-checked={active}
                onClick={() => {
                  store.getState().setRingtone(r.id);
                  toggleTonePreview(r.id);
                }}
              >
                <Icon name={isPlaying ? "speaker-high" : "bell"} size={14} />
                {r.label}
              </button>
            );
          })}
        </div>
        <label className="media-settings__field">
          <span className="media-settings__label">
            Volume de la sonnerie — {Math.round(ringVolume * 100)} %
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(ringVolume * 100)}
            onChange={(e) => store.getState().setRingVolume(Number(e.target.value) / 100)}
            aria-label="Volume de la sonnerie"
          />
        </label>
      </section>

      {/* ── Sonnerie par ami ── */}
      <section className="media-settings__group">
        {groupHead(
          "music-note",
          "Sonnerie par ami",
          "Une sonnerie différente par personne — ou votre propre fichier audio (.mp3, .ogg…).",
        )}
        <div className="media-settings__search">
          <Icon name="magnifying-glass" size={15} className="media-settings__search-icon" />
          <input
            className="media-settings__select media-settings__search-input"
            type="search"
            placeholder="Rechercher un pseudo…"
            value={friendQuery}
            onChange={(e) => setFriendQuery(e.target.value)}
            aria-label="Rechercher un ami"
          />
        </div>
        {filteredFriends.length === 0 && (
          <p className="home__hint">
            {friendQuery ? "Aucun ami ne correspond à cette recherche." : "Aucun ami pour le moment."}
          </p>
        )}
        <div className="media-settings__friends">
          {filteredFriends.map((f) => {
            const meta = files[f.user_id];
            const tone = contactRingtones[f.user_id];
            const isPlaying = playing === `friend:${f.user_id}`;
            return (
              <div key={f.user_id} className="media-settings__friend">
                <Avatar name={friendName(f)} size={32} src={f.avatar_url} />
                <div className="media-settings__friend-id">
                  <span className="media-settings__friend-name">{friendName(f)}</span>
                  {meta && (
                    <span
                      className="media-settings__friend-file"
                      data-active={tone === "custom"}
                      title={meta.name}
                    >
                      <Icon name="music-note" size={11} />
                      <span className="media-settings__friend-file-name">{meta.name}</span>
                      <span className="media-settings__friend-file-dur">{fmtDuration(meta.duration)}</span>
                    </span>
                  )}
                </div>
                <select
                  className="media-settings__select media-settings__friend-tone"
                  value={tone ?? ""}
                  onChange={(e) => onToneChange(f.user_id, e.target.value)}
                  aria-label={`Sonnerie pour ${friendName(f)}`}
                >
                  <option value="">Par défaut</option>
                  {RINGTONES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                  {meta && <option value="custom">Fichier importé</option>}
                </select>
                <IconButton
                  size="sm"
                  aria-label={`Importer un fichier audio pour ${friendName(f)}`}
                  title="Importer un fichier audio"
                  onClick={() => importToneFile(f.user_id)}
                >
                  <Icon name="paperclip" size={15} />
                </IconButton>
                <IconButton
                  size="sm"
                  aria-label={isPlaying ? "Arrêter l'écoute" : `Écouter la sonnerie de ${friendName(f)}`}
                  title={isPlaying ? "Arrêter" : "Écouter"}
                  onClick={() => toggleFriendPreview(f.user_id)}
                >
                  <Icon name={isPlaying ? "stop" : "play"} size={15} />
                </IconButton>
                <IconButton
                  size="sm"
                  aria-label={`Supprimer le fichier de ${friendName(f)}`}
                  title="Supprimer le fichier importé"
                  disabled={!meta}
                  onClick={() => void removeToneFile(f.user_id)}
                >
                  <Icon name="trash" size={15} />
                </IconButton>
              </div>
            );
          })}
        </div>
        <input
          ref={toneFileRef}
          type="file"
          accept="audio/*,.mp3,.ogg,.oga,.wav,.m4a,.aac,.flac,.opus"
          hidden
          onChange={(e) => void onToneFilePicked(e)}
        />
      </section>
    </div>
  );
}
