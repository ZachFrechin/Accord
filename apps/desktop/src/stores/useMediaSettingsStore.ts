/**
 * Audio/video preferences (persisted): capture devices for calls, speaker
 * output, ringtone + volume, and per-contact ringtone overrides. Device ids are
 * browser-issued and survive restarts on the same machine; a vanished device
 * simply falls back to the system default at call time.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ContactTone, RingtoneId } from "../lib/ringtones";

interface MediaSettingsState {
  micId: string | null;
  camId: string | null;
  speakerId: string | null;
  ringtone: RingtoneId;
  /** 0..1 */
  ringVolume: number;
  /** userId → ringtone override ("custom" = their audio file in IndexedDB). */
  contactRingtones: Record<string, ContactTone>;
  /** userId → voice volume in calls (0..1, absent = 1). Persisted like Discord. */
  voiceVolumes: Record<string, number>;
  setMic: (id: string | null) => void;
  setCam: (id: string | null) => void;
  setSpeaker: (id: string | null) => void;
  setRingtone: (id: RingtoneId) => void;
  setRingVolume: (v: number) => void;
  setContactRingtone: (userId: string, id: ContactTone | null) => void;
  setVoiceVolume: (userId: string, v: number) => void;
}

export const useMediaSettingsStore = create<MediaSettingsState>()(
  persist(
    (set) => ({
      micId: null,
      camId: null,
      speakerId: null,
      ringtone: "classique",
      ringVolume: 0.6,
      contactRingtones: {},
      voiceVolumes: {},
      setMic: (micId) => set({ micId }),
      setCam: (camId) => set({ camId }),
      setSpeaker: (speakerId) => set({ speakerId }),
      setRingtone: (ringtone) => set({ ringtone }),
      setRingVolume: (ringVolume) => set({ ringVolume: Math.min(1, Math.max(0, ringVolume)) }),
      setContactRingtone: (userId, id) =>
        set((s) => {
          if (id) return { contactRingtones: { ...s.contactRingtones, [userId]: id } };
          const { [userId]: _dropped, ...rest } = s.contactRingtones;
          return { contactRingtones: rest };
        }),
      setVoiceVolume: (userId, v) =>
        set((s) => ({
          voiceVolumes: { ...s.voiceVolumes, [userId]: Math.min(1, Math.max(0, v)) },
        })),
    }),
    { name: "accord.media.v1" },
  ),
);
