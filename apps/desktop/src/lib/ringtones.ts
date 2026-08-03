/**
 * Synthesized ringtones (WebAudio) — no bundled audio assets. Each tone is a
 * short scored loop of oscillator notes; startRinging schedules loop after
 * loop on the AudioContext clock until stopped.
 */

export type RingtoneId = "classique" | "carillon" | "pulsation" | "retro";

/** A contact's ringtone choice: a synth tone or their custom audio file. */
export type ContactTone = RingtoneId | "custom";

/** Loop an audio Blob (custom ringtone file) until stopped. */
export function startRingingBlob(blob: Blob, volume = 0.6): () => void {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.loop = true;
  audio.volume = Math.min(1, Math.max(0, volume));
  void audio.play().catch(() => {});
  return () => {
    audio.pause();
    audio.src = "";
    URL.revokeObjectURL(url);
  };
}

export const RINGTONES: { id: RingtoneId; label: string }[] = [
  { id: "classique", label: "Classique" },
  { id: "carillon", label: "Carillon" },
  { id: "pulsation", label: "Pulsation" },
  { id: "retro", label: "Rétro" },
];

interface Note {
  at: number; // seconds into the loop
  freq: number;
  dur: number;
  gain?: number; // 0..1 relative to master
  type?: OscillatorType;
}

interface Tone {
  loop: number; // seconds
  notes: Note[];
}

const TONES: Record<RingtoneId, Tone> = {
  // Dual-frequency European ring: 1.2s on, then silence.
  classique: {
    loop: 3.2,
    notes: [
      { at: 0, freq: 440, dur: 1.2, gain: 0.5 },
      { at: 0, freq: 480, dur: 1.2, gain: 0.5 },
    ],
  },
  // Soft ascending chime (E5 G5 B5 E6), long tails.
  carillon: {
    loop: 2.6,
    notes: [
      { at: 0.0, freq: 659.3, dur: 0.9, gain: 0.5 },
      { at: 0.22, freq: 784.0, dur: 0.9, gain: 0.45 },
      { at: 0.44, freq: 987.8, dur: 0.9, gain: 0.4 },
      { at: 0.66, freq: 1318.5, dur: 1.1, gain: 0.35 },
    ],
  },
  // Two short high beeps.
  pulsation: {
    loop: 2.0,
    notes: [
      { at: 0, freq: 880, dur: 0.12, gain: 0.6, type: "triangle" },
      { at: 0.24, freq: 880, dur: 0.12, gain: 0.6, type: "triangle" },
    ],
  },
  // Fast alternating old-phone trill.
  retro: {
    loop: 2.8,
    notes: Array.from({ length: 12 }, (_, i) => ({
      at: i * 0.09,
      freq: i % 2 === 0 ? 720 : 920,
      dur: 0.07,
      gain: 0.4,
      type: "square" as OscillatorType,
    })),
  },
};

function scheduleLoop(ctx: AudioContext, master: GainNode, tone: Tone, t0: number): void {
  for (const n of tone.notes) {
    const osc = ctx.createOscillator();
    osc.type = n.type ?? "sine";
    osc.frequency.value = n.freq;
    const env = ctx.createGain();
    const g = n.gain ?? 0.5;
    // Attack/decay envelope — avoids clicks and softens square/triangle tones.
    env.gain.setValueAtTime(0, t0 + n.at);
    env.gain.linearRampToValueAtTime(g, t0 + n.at + 0.02);
    env.gain.setValueAtTime(g, t0 + n.at + Math.max(0.02, n.dur - 0.08));
    env.gain.linearRampToValueAtTime(0, t0 + n.at + n.dur);
    osc.connect(env);
    env.connect(master);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.02);
  }
}

/** Loop a ringtone until the returned stop function is called. */
export function startRinging(id: RingtoneId, volume = 0.6): () => void {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return () => {};
  }
  const tone = TONES[id] ?? TONES.classique;
  const master = ctx.createGain();
  master.gain.value = Math.min(1, Math.max(0, volume));
  master.connect(ctx.destination);

  let next = ctx.currentTime + 0.05;
  scheduleLoop(ctx, master, tone, next);
  next += tone.loop;
  // Keep exactly one loop scheduled ahead of the clock.
  const timer = setInterval(() => {
    if (ctx.currentTime > next - tone.loop / 2) {
      scheduleLoop(ctx, master, tone, next);
      next += tone.loop;
    }
  }, 200);

  return () => {
    clearInterval(timer);
    try {
      master.gain.setTargetAtTime(0, ctx.currentTime, 0.03); // no hard click
      setTimeout(() => void ctx.close().catch(() => {}), 120);
    } catch {
      void ctx.close().catch(() => {});
    }
  };
}

/** One loop's length in seconds — lets callers schedule a single-pass preview. */
export function ringtoneLoopSeconds(id: RingtoneId): number {
  return (TONES[id] ?? TONES.classique).loop;
}

/** Play a single loop (settings preview). */
export function previewRingtone(id: RingtoneId, volume = 0.6): void {
  const stop = startRinging(id, volume);
  setTimeout(stop, ringtoneLoopSeconds(id) * 1000);
}

// ── Sons d'arrivée et de départ en vocal ─────────────────────────────────────

/** Deux notes brèves, jouées une seule fois.
 *
 * Montantes pour une arrivée, descendantes pour un départ : le sens se comprend
 * sans avoir à l'apprendre, et sans regarder l'écran — ce qui est tout l'intérêt
 * quand on est en train de faire autre chose. Volume bas et durée courte : ce
 * son se déclenche à chaque mouvement dans le salon, il doit informer sans
 * jamais couvrir la voix de quelqu'un. */
function blip(rising: boolean, volume: number): void {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return; // Pas de sortie audio : l'absence de son n'est pas une erreur.
  }
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  const [a, b] = rising ? [587.33, 880.0] : [880.0, 587.33];
  scheduleLoop(
    ctx,
    master,
    {
      loop: 0.4,
      notes: [
        { at: 0, freq: a, dur: 0.09, gain: 0.5, type: "sine" },
        { at: 0.1, freq: b, dur: 0.12, gain: 0.45, type: "sine" },
      ],
    },
    ctx.currentTime + 0.01,
  );
  // Le contexte se ferme seul une fois le son écoulé : en laisser un ouvert par
  // arrivée finirait par épuiser le quota de contextes audio du navigateur.
  window.setTimeout(() => void ctx.close().catch(() => {}), 600);
}

/** Quelqu'un vient de rejoindre le vocal. */
export function playJoinSound(volume = 0.35): void {
  blip(true, volume);
}

/** Quelqu'un vient de quitter le vocal. */
export function playLeaveSound(volume = 0.35): void {
  blip(false, volume);
}
