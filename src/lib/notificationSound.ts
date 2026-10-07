/** Notification cues inspired by https://www.typeui.sh/ui-sounds/notifications.
 * Generated scores use Web Audio; recordings ship locally for offline playback.
 * See public/sounds/typeui/SOURCE.md for provenance and the publisher's licence.
 */
import type { TranslationKey } from "./i18n/translations";
import { NOTIFICATION_SOUND_ASSETS } from "./notificationSoundAssets";

export type NotificationSoundId =
  | "double-ping" | "ping" | "mellow-chime" | "soft-bell" | "activity-beacon"
  | "signal-arrival" | "short-beep" | "high-chime" | "popup" | "prism";

export const DEFAULT_NOTIFICATION_SOUND: NotificationSoundId = "double-ping";
export const DEFAULT_NOTIFICATION_VOLUME = 70;
const MIN_GAP_MS = 900;

export interface ScoreNote {
  at: number;
  hz: number;
  dur: number;
  peak: number;
  voice: "sine" | "triangle";
  attack?: number;
}

export interface NotificationSoundDef {
  id: NotificationSoundId;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  score: readonly ScoreNote[];
  file?: string;
  waveform?: readonly number[];
  level: number;
  length: number;
}

function recording(
  id: keyof typeof NOTIFICATION_SOUND_ASSETS,
  labelKey: TranslationKey,
  hintKey: TranslationKey,
): NotificationSoundDef {
  return {
    id, labelKey, hintKey, score: [],
    file: `${import.meta.env.BASE_URL}sounds/typeui/${id}.mp3`,
    ...NOTIFICATION_SOUND_ASSETS[id],
  };
}

// TypeUI cues match its live previews; Prisma is an original CodeFlow melody.
export const NOTIFICATION_SOUNDS: readonly NotificationSoundDef[] = [
  {
    id: "double-ping", labelKey: "notifications.soundDoublePing", hintKey: "notifications.soundDoublePingHint",
    score: [
      { at: 0, hz: 784, dur: 0.22, peak: 0.05, voice: "sine" },
      { at: 0.11, hz: 1046.5, dur: 0.28, peak: 0.045, voice: "sine" },
    ],
    level: 1, length: 0.42,
  },
  {
    id: "ping", labelKey: "notifications.soundPing", hintKey: "notifications.soundPingHint",
    score: [
      { at: 0, hz: 1320, dur: 0.35, attack: 0.002, peak: 0.045, voice: "sine" },
      { at: 0, hz: 2640, dur: 0.2, peak: 0.01, voice: "sine" },
    ],
    level: 1, length: 0.38,
  },
  recording("mellow-chime", "notifications.soundMellowChime", "notifications.soundMellowChimeHint"),
  {
    id: "soft-bell", labelKey: "notifications.soundSoftBell", hintKey: "notifications.soundSoftBellHint",
    score: [
      { at: 0, hz: 987.77, dur: 0.34, attack: 0.004, peak: 0.0325, voice: "sine" },
      { at: 0, hz: 1975.53, dur: 0.24, attack: 0.004, peak: 0.011, voice: "sine" },
      { at: 0.045, hz: 493.88, dur: 0.3, attack: 0.03, peak: 0.0175, voice: "triangle" },
    ],
    level: 1, length: 0.375,
  },
  recording("activity-beacon", "notifications.soundActivityBeacon", "notifications.soundActivityBeaconHint"),
  recording("signal-arrival", "notifications.soundSignalArrival", "notifications.soundSignalArrivalHint"),
  recording("short-beep", "notifications.soundShortBeep", "notifications.soundShortBeepHint"),
  recording("high-chime", "notifications.soundHighChime", "notifications.soundHighChimeHint"),
  recording("popup", "notifications.soundPopup", "notifications.soundPopupHint"),
  {
    // Original cue: E5 → A5 → D6, with a quiet fifth under the landing and a short echo.
    // Rounded attacks and a faint octave add a modern, glassy pluck without a sharp click.
    id: "prism", labelKey: "notifications.soundPrism", hintKey: "notifications.soundPrismHint",
    score: [
      ...[659.25, 880, 1174.66].flatMap((hz, index): ScoreNote[] => {
        const at = index * 0.1;
        const dur = index === 2 ? 0.46 : 0.28;
        return [
          { at, hz, dur, attack: 0.009, peak: 0.026 - index * 0.003, voice: "sine" },
          { at, hz: hz * 2, dur: dur * 0.55, attack: 0.008, peak: 0.0035, voice: "sine" },
          { at: at + 0.12, hz, dur: dur * 0.85, attack: 0.016, peak: 0.004, voice: "sine" },
        ];
      }),
      { at: 0.2, hz: 587.33, dur: 0.38, attack: 0.025, peak: 0.009, voice: "triangle" },
      { at: 0.2, hz: 440, dur: 0.32, attack: 0.03, peak: 0.006, voice: "sine" },
    ],
    level: 1, length: 0.741,
  },
];

/** Retired selections and unrecognised settings use the new default. */
export function soundById(id: string | null | undefined): NotificationSoundDef {
  return NOTIFICATION_SOUNDS.find((sound) => sound.id === id) ?? NOTIFICATION_SOUNDS[0];
}

export function isNotificationSoundId(value: unknown): value is NotificationSoundId {
  return NOTIFICATION_SOUNDS.some((sound) => sound.id === value);
}

/** 70 is the tuned level, 100 adds approximately 6 dB, and 0 is silence. */
export function volumeGain(volume: number): number {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(volume) ? volume : DEFAULT_NOTIFICATION_VOLUME));
  return (clamped / DEFAULT_NOTIFICATION_VOLUME) ** 2;
}

// Cache decoding per context, including concurrent requests. Failed loads can be retried.
const buffers = new WeakMap<BaseAudioContext, Map<string, Promise<AudioBuffer>>>();

async function loadRecording(ctx: BaseAudioContext, file: string): Promise<AudioBuffer> {
  let cache = buffers.get(ctx);
  if (!cache) {
    cache = new Map();
    buffers.set(ctx, cache);
  }
  const cached = cache.get(file);
  if (cached) return cached;
  const pending = fetch(file).then(async (response) => {
    if (!response.ok) throw new Error(`Unable to load notification sound: ${response.status}`);
    return ctx.decodeAudioData(await response.arrayBuffer());
  });
  cache.set(file, pending);
  try {
    return await pending;
  } catch (error) {
    cache.delete(file);
    throw error;
  }
}

/** TypeUI's compressor and makeup gain, with a final limiter after the user's volume.
 * The slider can boost above the tuned level, so the limiter must cover that boost too.
 */
function output(ctx: BaseAudioContext, volume: number, dest: AudioNode): { input: AudioNode; master: GainNode } {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -34;
  compressor.knee.value = 20;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.18;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.6;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  const master = ctx.createGain();
  master.gain.value = volumeGain(volume);
  compressor.connect(makeup).connect(master).connect(limiter).connect(dest);
  return { input: compressor, master };
}

/** Decodes first, then schedules ahead of currentTime so the attack is never clipped.
 * The returned volume gain controls the entire sound and can be faded or disconnected.
 */
export async function renderNotificationSound(
  ctx: BaseAudioContext,
  id: string,
  volume: number,
  dest: AudioNode = ctx.destination,
): Promise<GainNode> {
  const sound = soundById(id);
  const buffer = sound.file ? await loadRecording(ctx, sound.file) : null;
  const at = ctx.currentTime + 0.02;
  const { input, master } = output(ctx, volume, dest);
  if (buffer) {
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    gain.gain.value = sound.level;
    source.connect(gain).connect(input);
    source.start(at);
    source.stop(at + buffer.duration);
  } else {
    for (const note of sound.score) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = at + note.at;
      oscillator.type = note.voice;
      oscillator.frequency.setValueAtTime(note.hz, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(note.peak, start + (note.attack ?? 0.005));
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.dur);
      oscillator.connect(gain).connect(input);
      oscillator.start(start);
      oscillator.stop(start + note.dur + 0.03);
    }
  }
  return master;
}

let context: AudioContext | null = null;
let lastPlayedAt = -Infinity;
let previewing: GainNode | null = null;
let previewRequest = 0;
type AudioContextCtor = new () => AudioContext;

/** Created on a click to unlock audio in WebKit, reused for the life of the window. */
function audioContext(): AudioContext | null {
  if (context) return context;
  const ctor = window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!ctor) return null;
  context = new ctor();
  return context;
}

function whenAudible(play: (ctx: AudioContext) => Promise<void>): void {
  try {
    const ctx = audioContext();
    if (!ctx) return;
    const ready = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
    void ready.then(() => play(ctx)).catch(() => {});
  } catch {
    // Missing audio devices, refused resumes and failed decoding stay silent.
  }
}

/** Collapse a burst of arrivals while still displaying every notification. */
export function playNotificationSound(id: string, volume: number): void {
  const now = Date.now();
  if (now - lastPlayedAt < MIN_GAP_MS || volumeGain(volume) === 0) return;
  lastPlayedAt = now;
  whenAudible(async (ctx) => { await renderNotificationSound(ctx, id, volume); });
}

/** Preview clicks bypass the arrival throttle; only the latest click may remain audible. */
export function previewNotificationSound(id: string, volume: number): void {
  const request = ++previewRequest;
  whenAudible(async (ctx) => {
    if (request !== previewRequest) return;
    const previous = previewing;
    previewing = null;
    if (previous) {
      const now = ctx.currentTime;
      previous.gain.cancelScheduledValues(now);
      previous.gain.setValueAtTime(previous.gain.value, now);
      previous.gain.linearRampToValueAtTime(0, now + 0.04);
      setTimeout(() => previous.disconnect(), 80);
    }
    if (volumeGain(volume) === 0) return;
    const next = await renderNotificationSound(ctx, id, volume);
    if (request !== previewRequest) next.disconnect();
    else previewing = next;
  });
}
