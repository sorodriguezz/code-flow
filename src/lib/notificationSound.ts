/**
 * The sounds a notification can make — ten of them, picked in Settings › Notifications › Sound.
 *
 * Synthesised rather than played from files. An `.mp3` would be simpler to read, and it would also
 * be a binary in the repository, a bundler rule, a decode step, and a thing nobody can adjust
 * without opening a DAW. Every sound here is a short score of notes played on a handful of
 * instruments made of oscillators; all ten weigh nothing in the bundle, and changing how one sounds
 * is changing a number here.
 *
 * **The score is also the picture.** Each sound is written down as notes — when, how high, how long
 * — and played from that list, and Settings draws the same list as a small piano roll beside the
 * sound's name (`NotificationSettings`). The drawing cannot drift from what plays: they are one
 * array.
 *
 * **The default, "Cadencia", is the sound this app always made**: two warm chords, the second
 * resolving the first, with three bright notes landing over the resolution. This plays when
 * background work *finishes*, and a single held chord — however pretty — only ever says "look
 * here". Saying "it's done" takes harmonic movement: an unresolved chord (A3, D4, E4 — a suspended
 * fourth, which the ear hears as leaning somewhere) followed by the one it was leaning towards (D3,
 * A3, D4, F#4). The two overlap rather than cutting from one to the next, and the second takes
 * 180ms of its own to arrive, so the resolution lands as a change of colour instead of a hit —
 * the difference between an app telling you something is ready and an app congratulating you.
 * Every note of those chords is two triangle oscillators six cents apart; the pair drifts in and
 * out of phase about twice a second, which is what makes the chords sound like they are breathing
 * rather than held.
 *
 * The other nine were written to the same brief — short, soft, and *finished* (each ends lower,
 * resolved, or decaying, never on a question) — and levelled against it: at the same volume, none
 * is meant to be noticeably louder than the default. Where they differ is character: melodic
 * (Marimba, Arpa, Timbre), struck (Campanilla, Cristal, Cuenco), minimal (Gota, Digital) and one
 * with no pitch at all (Soplo).
 */

import type { TranslationKey } from "./i18n/translations";

export type NotificationSoundId =
  | "cadence"
  | "chime"
  | "marimba"
  | "harp"
  | "glass"
  | "bowl"
  | "doorbell"
  | "drop"
  | "digital"
  | "air";

export const DEFAULT_NOTIFICATION_SOUND: NotificationSoundId = "cadence";

/**
 * The volume a fresh install plays at, on the 0–100 scale Settings shows — and the level every
 * sound was tuned at. Not 100: the top of the scale is headroom for the person who finds the tuned
 * level too quiet, which is a real complaint about a sound that is deliberately quiet.
 */
export const DEFAULT_NOTIFICATION_VOLUME = 70;

/** The instruments a note can be played on. Each is a function below, a few oscillators deep. */
type Voice = "warm" | "sine" | "bell" | "wood" | "pluck" | "glass" | "bowl" | "vibes" | "blip" | "drop" | "air";

/** One note of a score. */
export interface ScoreNote {
  /** Seconds from the start of the sound. */
  at: number;
  /** Pitch in hertz — for `air`, which has none, the centre of the band the noise is heard in. */
  hz: number;
  /** Where the pitch slides to by the end, for the sounds that glide (`drop`, `air`). */
  to?: number;
  /** Seconds until the note is silent, its tail included. */
  dur: number;
  /** Peak level of this one note, before the sound's `level` and the volume. */
  peak: number;
  voice: Voice;
  /** Attack in seconds, where the instrument does not fix its own. */
  attack?: number;
  /** For `warm`: a lowpass that opens as the note arrives — from, to, and over how long. */
  sweep?: readonly [from: number, to: number, over: number];
}

export interface NotificationSoundDef {
  id: NotificationSoundId;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  score: readonly ScoreNote[];
  /** The whole sound's gain, set by ear and meter so that they all arrive about equally loud. */
  level: number;
  /** Seconds until the last note is silent. */
  length: number;
}

/**
 * Two notifications landing in the same breath are one event as far as the ear is concerned.
 *
 * A generation finishing usually pushes one entry, but a batch of them can push several within a
 * frame or two, and three copies of a 1.5-second cadence playing on top of each other is not three
 * notifications — it is a mess, and a resolution landing on top of the previous one is a dissonance
 * rather than a resolution. The first one wins and the rest are silent; the panel still shows all of
 * them, which is where counting belongs.
 *
 * 900ms rather than a sound's full length: by then the loudest part of every one of them is over,
 * so a second one starting over the tail reads as an echo rather than a collision. Waiting for true
 * silence would swallow notifications that are genuinely separate events — and the singing bowl
 * rings for three seconds.
 */
const MIN_GAP_MS = 900;

// ---------------------------------------------------------------------------------------------
// The scores
// ---------------------------------------------------------------------------------------------

/** Every tone of a chord, struck together. */
function chord(at: number, notes: readonly number[], rest: Omit<ScoreNote, "at" | "hz">): ScoreNote[] {
  return notes.map((hz) => ({ ...rest, at, hz }));
}

/** When Cadencia's resolution arrives, in seconds from the start. */
const RESOLVE_AT_S = 0.42;

const CADENCE: ScoreNote[] = [
  // The lean: A3, D4, E4. Still sounding when the resolution starts — its 750ms tail overlaps the
  // 180ms the tonic takes to arrive, which is what makes the change read as one gesture.
  ...chord(0, [220, 293.66, 329.63], { voice: "warm", attack: 0.2, peak: 0.06, dur: 0.75, sweep: [1100, 3400, 0.4] }),
  // Where it goes: D3, A3, D4, F#4. Louder and brighter than what it resolves, because it is the
  // half that carries the message.
  ...chord(RESOLVE_AT_S, [146.83, 220, 293.66, 369.99], {
    voice: "warm",
    attack: 0.18,
    peak: 0.07,
    dur: 1.05,
    sweep: [1300, 4400, 0.42],
  }),
  // D2, the floor the landing sits on. A 50ms attack rather than a snap: a sub that snaps in is a
  // thump, and a thump under a resolution turns "it's ready" into a drum hit.
  { at: RESOLVE_AT_S, hz: 73.42, voice: "sine", attack: 0.05, peak: 0.09, dur: 0.55 },
  // D6, G6, D7 over the resolution, so the brightest moment and the harmonic arrival coincide.
  ...[1174.66, 1567.98, 2349.32].map(
    (hz, index): ScoreNote => ({
      at: RESOLVE_AT_S + 0.08 + index * 0.09,
      hz,
      voice: "sine",
      attack: 0.008,
      peak: 0.055,
      dur: 0.4,
    }),
  ),
];

export const NOTIFICATION_SOUNDS: readonly NotificationSoundDef[] = (
  [
    {
      id: "cadence",
      labelKey: "notifications.soundCadence",
      hintKey: "notifications.soundCadenceHint",
      score: CADENCE,
      level: 0.9,
    },
    {
      // A5 then E6: a fifth up, struck on a small bell. The second strike is the softer one, so it
      // lands as the answer to the first rather than as a second alarm.
      id: "chime",
      labelKey: "notifications.soundChime",
      hintKey: "notifications.soundChimeHint",
      score: [
        { at: 0, hz: 880, voice: "bell", peak: 0.16, dur: 1.3 },
        { at: 0.13, hz: 1318.51, voice: "bell", peak: 0.12, dur: 1.5 },
      ],
      level: 0.6,
    },
    {
      // D5, F#5, A5 — the major triad, walked up on wood. The last note rings longest.
      id: "marimba",
      labelKey: "notifications.soundMarimba",
      hintKey: "notifications.soundMarimbaHint",
      score: [
        { at: 0, hz: 587.33, voice: "wood", peak: 0.2, dur: 0.5 },
        { at: 0.09, hz: 739.99, voice: "wood", peak: 0.19, dur: 0.5 },
        { at: 0.18, hz: 880, voice: "wood", peak: 0.21, dur: 0.85 },
      ],
      level: 0.58,
    },
    {
      // A4 up to D6 in five plucks 50ms apart, each left ringing under the next: a strum that opens
      // rather than a scale that is played.
      id: "harp",
      labelKey: "notifications.soundHarp",
      hintKey: "notifications.soundHarpHint",
      score: [440, 587.33, 739.99, 880, 1174.66].map(
        (hz, index): ScoreNote => ({ at: index * 0.05, hz, voice: "pluck", peak: 0.12 - index * 0.008, dur: index === 4 ? 1.3 : 0.95 }),
      ),
      level: 0.8,
    },
    {
      // Two glasses meeting: G6, then A6 a beat later and quieter. Each rings with a slow shimmer —
      // two sines a couple of hertz apart, the way a real glass beats against itself.
      id: "glass",
      labelKey: "notifications.soundGlass",
      hintKey: "notifications.soundGlassHint",
      score: [
        { at: 0, hz: 1567.98, voice: "glass", peak: 0.1, dur: 1.2 },
        { at: 0.11, hz: 1760, voice: "glass", peak: 0.075, dur: 1.3 },
      ],
      level: 0.85,
    },
    {
      // One strike on a bowl tuned near E♭4, left to ring. The longest sound here and the quietest
      // at its peak: it is the one to pick if every other one is too much.
      id: "bowl",
      labelKey: "notifications.soundBowl",
      hintKey: "notifications.soundBowlHint",
      score: [{ at: 0, hz: 311.13, voice: "bowl", peak: 0.13, dur: 3.2 }],
      level: 0.7,
    },
    {
      // Ding-dong: E5 falling a major third to C5, on a vibraphone with its motor on.
      id: "doorbell",
      labelKey: "notifications.soundDoorbell",
      hintKey: "notifications.soundDoorbellHint",
      score: [
        { at: 0, hz: 659.25, voice: "vibes", peak: 0.14, dur: 1.1 },
        { at: 0.36, hz: 523.25, voice: "vibes", peak: 0.14, dur: 1.6 },
      ],
      level: 0.9,
    },
    {
      // Two drops. A falling drop is a sine whose pitch *rises* — the bubble it traps shrinks — and
      // the second, smaller one lands a little higher.
      id: "drop",
      labelKey: "notifications.soundDrop",
      hintKey: "notifications.soundDropHint",
      score: [
        { at: 0, hz: 520, to: 1250, voice: "drop", peak: 0.2, dur: 0.14 },
        { at: 0.16, hz: 780, to: 1900, voice: "drop", peak: 0.12, dur: 0.11 },
      ],
      level: 1.75,
    },
    {
      // B5 then E6, two short beeps a fourth apart — square waves with the edges filtered off.
      id: "digital",
      labelKey: "notifications.soundDigital",
      hintKey: "notifications.soundDigitalHint",
      score: [
        { at: 0, hz: 987.77, voice: "blip", peak: 0.06, dur: 0.075 },
        { at: 0.1, hz: 1318.51, voice: "blip", peak: 0.06, dur: 0.09 },
      ],
      level: 1.3,
    },
    {
      // Noise through a band that sweeps up: a breath, the one sound here with no note in it.
      id: "air",
      labelKey: "notifications.soundAir",
      hintKey: "notifications.soundAirHint",
      score: [{ at: 0, hz: 450, to: 3200, voice: "air", peak: 0.22, dur: 0.42 }],
      level: 4,
    },
  ] satisfies Omit<NotificationSoundDef, "length">[]
).map((sound) => ({
  ...sound,
  length: Math.max(...sound.score.map((note) => note.at + note.dur)),
}));

/** The sound for an id, falling back to the default for an unknown one (a setting from a newer
 *  release, or one hand-edited). */
export function soundById(id: string | null | undefined): NotificationSoundDef {
  return NOTIFICATION_SOUNDS.find((sound) => sound.id === id) ?? NOTIFICATION_SOUNDS[0];
}

export function isNotificationSoundId(value: unknown): value is NotificationSoundId {
  return NOTIFICATION_SOUNDS.some((sound) => sound.id === value);
}

/**
 * The 0–100 volume as a gain on top of the tuned level.
 *
 * Squared, because loudness is heard on a log scale and a linear slider spends its whole top half
 * on differences nobody can hear: this way each step of the slider is roughly the same step of
 * loudness. 70 — the default — is the tuned level exactly; 100 is about 6 dB over it; 0 is silence.
 */
export function volumeGain(volume: number): number {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(volume) ? volume : DEFAULT_NOTIFICATION_VOLUME));
  return (clamped / DEFAULT_NOTIFICATION_VOLUME) ** 2;
}

// ---------------------------------------------------------------------------------------------
// The instruments
// ---------------------------------------------------------------------------------------------

/** Above this a partial is dropped rather than played: it would be piercing, and near Nyquist. */
const MAX_PARTIAL_HZ = 12000;

/**
 * One oscillator with an envelope, connected to `dest`.
 *
 * The envelope ramps exponentially and never touches zero — `exponentialRampToValueAtTime` throws
 * on a zero target, and 0.0001 is forty decibels below anything audible, so it is silence for every
 * purpose except the maths.
 */
function voice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  type: OscillatorType,
  freq: number,
  at: number,
  attack: number,
  peak: number,
  duration: number,
  detune = 0,
): void {
  if (freq > MAX_PARTIAL_HZ || peak <= 0) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  osc.detune.setValueAtTime(detune, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(at);
  // Stopped explicitly rather than left to be collected: an oscillator that is never stopped stays
  // on the context's graph for the life of the page, and this runs every time work finishes.
  osc.stop(at + duration + 0.02);
}

/**
 * Struck things — bells, bars, glasses, bowls — are a stack of partials, each decaying faster the
 * higher it is. `[ratio to the fundamental, share of the peak, share of the duration]`.
 */
type Partials = readonly (readonly [ratio: number, gain: number, decay: number])[];

/** A small bell's bar modes (1 : 2.76 : 5.40 : 8.93), the inharmonic ladder that makes it a bell. */
const BELL: Partials = [
  [1, 1, 1],
  [2.76, 0.42, 0.45],
  [5.4, 0.18, 0.25],
  [8.93, 0.07, 0.12],
];

/** A marimba bar: the fundamental, the tuned fourth-harmonic mode, and the mallet's click. */
const WOOD: Partials = [
  [1, 1, 1],
  [3.93, 0.25, 0.22],
  [9.2, 0.07, 0.06],
];

function struck(ctx: BaseAudioContext, dest: AudioNode, at: number, note: ScoreNote, partials: Partials, attack: number): void {
  for (const [ratio, gain, decay] of partials) {
    voice(ctx, dest, "sine", note.hz * ratio, at, attack, note.peak * gain, Math.max(0.05, note.dur * decay));
  }
}

/** A second of white noise per context, made once — `air` is the only voice that needs it. */
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function noise(ctx: BaseAudioContext): AudioBuffer {
  let buffer = noiseBuffers.get(ctx);
  if (!buffer) {
    buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, buffer);
  }
  return buffer;
}

const VOICES: Record<Voice, (ctx: BaseAudioContext, dest: AudioNode, at: number, note: ScoreNote) => void> = {
  /**
   * Cadencia's chord tone: two triangles six cents apart under a lowpass that opens as it arrives,
   * so the chord brightens into being rather than simply appearing. The sweep is linear rather
   * than exponential — an exponential ramp spends most of its travel in the first hundred
   * milliseconds, and these are the slow part. Each note gets its own filter; every note of a
   * chord carries the same sweep, and a filter is linear, so that is the chord's filter exactly.
   */
  warm: (ctx, dest, at, note) => {
    const [from, to, over] = note.sweep ?? [1200, 4000, 0.4];
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.setValueAtTime(from, at);
    lowpass.frequency.linearRampToValueAtTime(to, at + over);
    lowpass.connect(dest);
    voice(ctx, lowpass, "triangle", note.hz, at, note.attack ?? 0.18, note.peak, note.dur, -6);
    voice(ctx, lowpass, "triangle", note.hz, at, note.attack ?? 0.18, note.peak, note.dur, 6);
  },

  sine: (ctx, dest, at, note) => {
    voice(ctx, dest, "sine", note.hz, at, note.attack ?? 0.008, note.peak, note.dur);
  },

  bell: (ctx, dest, at, note) => struck(ctx, dest, at, note, BELL, 0.002),

  wood: (ctx, dest, at, note) => struck(ctx, dest, at, note, WOOD, 0.002),

  /** A plucked string: a triangle whose brightness falls away faster than its level does. */
  pluck: (ctx, dest, at, note) => {
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.Q.value = 0.8;
    lowpass.frequency.setValueAtTime(Math.min(note.hz * 9, 9000), at);
    lowpass.frequency.exponentialRampToValueAtTime(note.hz * 1.6, at + 0.3);
    lowpass.connect(dest);
    voice(ctx, lowpass, "triangle", note.hz, at, 0.003, note.peak, note.dur);
    voice(ctx, dest, "sine", note.hz * 2, at, 0.003, note.peak * 0.22, note.dur * 0.4);
  },

  /**
   * A glass: the fundamental as two sines 2.2 Hz apart — the slow beating a real glass makes
   * against itself — one higher mode that dies early, and the tick of the contact.
   */
  glass: (ctx, dest, at, note) => {
    voice(ctx, dest, "sine", note.hz - 1.1, at, 0.0015, note.peak * 0.5, note.dur);
    voice(ctx, dest, "sine", note.hz + 1.1, at, 0.0015, note.peak * 0.5, note.dur);
    voice(ctx, dest, "sine", note.hz * 2.71, at, 0.0015, note.peak * 0.28, note.dur * 0.35);
    voice(ctx, dest, "sine", note.hz * 5.2, at, 0.001, note.peak * 0.12, 0.05);
  },

  /**
   * A singing bowl: three modes, each a pair of sines a little apart, beating at 0.7, 1.6 and 2.9 Hz.
   * The beating is the sound of a bowl — without it this is an organ note.
   */
  bowl: (ctx, dest, at, note) => {
    const modes: readonly (readonly [ratio: number, gain: number, decay: number, beat: number])[] = [
      [1, 1, 1, 0.7],
      [2.71, 0.45, 0.6, 1.6],
      [5.04, 0.2, 0.32, 2.9],
    ];
    for (const [ratio, gain, decay, beat] of modes) {
      const hz = note.hz * ratio;
      const peak = note.peak * gain * 0.5;
      voice(ctx, dest, "sine", hz - beat / 2, at, 0.01, peak, note.dur * decay);
      voice(ctx, dest, "sine", hz + beat / 2, at, 0.01, peak, note.dur * decay);
    }
  },

  /**
   * A vibraphone: a sine with its fourth-harmonic mode, through a tremolo — the vibraphone's motor,
   * 5.2 turns a second, a quarter deep.
   */
  vibes: (ctx, dest, at, note) => {
    const depth = 0.25;
    const tremolo = ctx.createGain();
    tremolo.gain.value = 1 - depth / 2;
    const lfo = ctx.createOscillator();
    const lfoDepth = ctx.createGain();
    lfo.frequency.value = 5.2;
    lfoDepth.gain.value = depth / 2;
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremolo.gain);
    lfo.start(at);
    lfo.stop(at + note.dur + 0.02);
    tremolo.connect(dest);
    voice(ctx, tremolo, "sine", note.hz, at, 0.003, note.peak, note.dur);
    voice(ctx, dest, "sine", note.hz * 4, at, 0.002, note.peak * 0.2, note.dur * 0.3);
  },

  /** A beep: held, not struck, so it has a plateau; a square with its corners filtered off. */
  blip: (ctx, dest, at, note) => {
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 2600;
    lowpass.Q.value = 0.7;
    lowpass.connect(dest);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(note.hz, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(note.peak, at + 0.004);
    gain.gain.setValueAtTime(note.peak, at + note.dur * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + note.dur);
    osc.connect(gain);
    gain.connect(lowpass);
    osc.start(at);
    osc.stop(at + note.dur + 0.02);
  },

  /** A drop: a sine that rises fast and dies faster. */
  drop: (ctx, dest, at, note) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(note.hz, at);
    osc.frequency.exponentialRampToValueAtTime(note.to ?? note.hz * 2, at + note.dur * 0.4);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(note.peak, at + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + note.dur);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(at);
    osc.stop(at + note.dur + 0.02);
  },

  /** Breath: noise through a band-pass whose centre slides from `hz` to `to`. */
  air: (ctx, dest, at, note) => {
    const source = ctx.createBufferSource();
    source.buffer = noise(ctx);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.2;
    band.frequency.setValueAtTime(note.hz, at);
    band.frequency.exponentialRampToValueAtTime(note.to ?? note.hz * 4, at + note.dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(note.peak, at + note.dur * 0.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + note.dur);
    source.connect(band);
    band.connect(gain);
    gain.connect(dest);
    source.start(at);
    source.stop(at + note.dur + 0.02);
  },
};

/**
 * Schedules one sound on a context, into a fresh gain on its way to the speakers, and hands that
 * gain back — so a preview can be faded out when the next one starts.
 *
 * Takes a `BaseAudioContext` rather than the live one so the same graph can be rendered offline:
 * that is how the ten were levelled against each other.
 */
export function renderNotificationSound(
  ctx: BaseAudioContext,
  id: string,
  volume: number,
  dest: AudioNode = ctx.destination,
): GainNode {
  const sound = soundById(id);
  // A beat of lead-in. Scheduling at `currentTime` exactly means asking for a sound in the past by
  // the time the graph is built, and the first milliseconds get clipped.
  const at = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.value = sound.level * volumeGain(volume);
  master.connect(dest);
  for (const note of sound.score) VOICES[note.voice](ctx, master, at + note.at, note);
  return master;
}

// ---------------------------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------------------------

/**
 * One `AudioContext` for the life of the app.
 *
 * Browsers cap how many a page may hold — a handful, then `new AudioContext()` starts throwing —
 * so one per notification would work beautifully for the first few and then stop working forever.
 */
let context: AudioContext | null = null;
let lastPlayedAt = 0;
/** The preview still sounding, if any — faded out when the next one starts. */
let previewing: GainNode | null = null;

type AudioContextCtor = new () => AudioContext;

/**
 * The context, created on first use and never before.
 *
 * Deliberately lazy. A context built at module load, with no user gesture behind it, is born
 * `suspended` under every autoplay policy — and the WebView this runs in is Safari's engine on
 * macOS, which is the strictest of them. Building it on the click that turns the sound *on* (or
 * picks one) means the gesture that unlocks audio is the same gesture that asks for it.
 */
function audioContext(): AudioContext | null {
  if (context) return context;
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!ctor) return null;
  try {
    context = new ctor();
  } catch {
    // No audio on this machine, or the context limit was hit. Not worth a toast: the user asked
    // for a sound, not for a report about one.
    return null;
  }
  return context;
}

/** Runs `play` once the context can make a sound. */
function whenAudible(play: (ctx: AudioContext) => void): void {
  const ctx = audioContext();
  if (!ctx) return;
  // A context can be suspended by the autoplay policy at birth, and again whenever the OS decides
  // to — the app being backgrounded is enough on macOS. `resume` is a promise nobody can await
  // here, so the sound is scheduled behind it rather than before.
  if (ctx.state === "suspended") {
    void ctx.resume().then(
      () => play(ctx),
      () => undefined,
    );
    return;
  }
  play(ctx);
}

/**
 * Plays the chosen sound, unless one just played.
 *
 * Silent — never throws, never toasts. A machine with no audio device, a context that refused to
 * resume, a user who has muted the app at the OS level: none of those are errors the person who
 * started a code generation needs to hear about.
 */
export function playNotificationSound(id: string, volume: number): void {
  const now = Date.now();
  if (now - lastPlayedAt < MIN_GAP_MS) return;
  lastPlayedAt = now;
  whenAudible((ctx) => {
    renderNotificationSound(ctx, id, volume);
  });
}

/**
 * Plays a sound now, whatever else just played — for Settings and the bell's switch: pressing one
 * is a request to hear the thing, and swallowing that because a notification happened to arrive
 * half a second ago would read as a broken button.
 *
 * One preview at a time. Walking down the list clicking each sound would otherwise stack ten of
 * them, the bowl still ringing under the fourth; the one before fades out over 40ms (a hard cut
 * clicks) as the next begins.
 */
export function previewNotificationSound(id: string, volume: number): void {
  whenAudible((ctx) => {
    const previous = previewing;
    if (previous) {
      const now = ctx.currentTime;
      previous.gain.cancelScheduledValues(now);
      previous.gain.setValueAtTime(previous.gain.value, now);
      previous.gain.linearRampToValueAtTime(0, now + 0.04);
      setTimeout(() => previous.disconnect(), 80);
    }
    previewing = renderNotificationSound(ctx, id, volume);
  });
}
