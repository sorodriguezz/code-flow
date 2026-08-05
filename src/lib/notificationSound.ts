/**
 * The sound a notification makes: two warm chords, the second resolving the first, with three bright
 * notes landing over the resolution.
 *
 * Synthesised rather than played from a file. An `.mp3` would be simpler to read, and it would also
 * be a binary in the repository, a bundler rule, a decode step, and a thing nobody can adjust
 * without opening a DAW. This is sixty lines of oscillators, it weighs nothing in the bundle, and
 * changing how it sounds is changing a number here.
 *
 * **Why two chords.** This plays when background work *finishes*, and a single held chord — however
 * pretty — only ever says "look here". Saying "it's done" takes harmonic movement: an unresolved
 * chord (A3, D4, E4 — a suspended fourth, which the ear hears as leaning somewhere) followed by the
 * one it was leaning towards (D3, A3, D4, F#4). That fall onto the tonic is the whole message. A
 * sound that ends on the note it started on is a sound that never finished.
 *
 * **Why it is slow.** The two chords overlap rather than cutting from one to the next, and the
 * second takes 180ms of its own to arrive. The resolution lands as a change of colour instead of a
 * hit — which is the difference between an app telling you something is ready and an app
 * congratulating you. The sub underneath has a slow attack for the same reason: it is there to give
 * the landing a floor, not to thump.
 *
 * Every note is two triangle oscillators six cents apart. The pair drifts in and out of phase about
 * twice a second, which is what makes the chords sound like they are breathing rather than held.
 */

/**
 * Two notifications landing in the same breath are one event as far as the ear is concerned.
 *
 * A generation finishing usually pushes one entry, but a batch of them can push several within a
 * frame or two, and three copies of a 1.5-second cadence playing on top of each other is not three
 * notifications — it is a mess, and a resolution landing on top of the previous one is a dissonance
 * rather than a resolution. The first one wins and the rest are silent; the panel still shows all of
 * them, which is where counting belongs.
 *
 * 900ms rather than the sound's full 1.5s: by then the resolving chord is about 26dB down, quiet
 * enough that a second cadence starting over its tail reads as an echo rather than a collision.
 * Waiting for true silence would swallow notifications that are genuinely separate events.
 */
const MIN_GAP_MS = 900;

/**
 * Peak level for the whole sound.
 *
 * Low on purpose. This plays while the user is doing something else — that is the entire point of
 * it — so it has to be audible without being an interruption. Loud enough to notice, quiet enough
 * that the tenth one today is not a reason to turn the feature off.
 */
const MASTER_GAIN = 0.9;

/** The chord that leans: A3, D4, E4. Suspended, so it wants somewhere to go. */
const TENSION_HZ = [220, 293.66, 329.63];

/** Where it goes: D3, A3, D4, F#4. */
const TONIC_HZ = [146.83, 220, 293.66, 369.99];

/** The bright notes over the resolution: D6, G6, D7. */
const SHIMMER_HZ = [1174.66, 1567.98, 2349.32];

/** D2, an octave under the tonic's root — the floor the landing sits on. */
const SUB_HZ = 73.42;

/** When the resolution arrives, in seconds from the start. */
const RESOLVE_AT_S = 0.42;

/**
 * One `AudioContext` for the life of the app.
 *
 * Browsers cap how many a page may hold — a handful, then `new AudioContext()` starts throwing —
 * so one per notification would work beautifully for the first few and then stop working forever.
 */
let context: AudioContext | null = null;
let lastPlayedAt = 0;

type AudioContextCtor = new () => AudioContext;

/**
 * The context, created on first use and never before.
 *
 * Deliberately lazy. A context built at module load, with no user gesture behind it, is born
 * `suspended` under every autoplay policy — and the WebView this runs in is Safari's engine on
 * macOS, which is the strictest of them. Building it on the click that turns the sound *on* means
 * the gesture that unlocks audio is the same gesture that asks for it, which is why enabling the
 * setting plays the sound: the preview is the point, and the unlock is a bonus.
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

/**
 * One oscillator with an envelope, connected to `dest`.
 *
 * The envelope ramps exponentially and never touches zero — `exponentialRampToValueAtTime` throws
 * on a zero target, and 0.0001 is forty decibels below anything audible, so it is silence for every
 * purpose except the maths.
 */
function voice(
  ctx: AudioContext,
  dest: AudioNode,
  type: OscillatorType,
  freq: number,
  at: number,
  attack: number,
  peak: number,
  duration: number,
  detune = 0,
): void {
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
 * One chord, under a lowpass that opens as it arrives — so it brightens into being rather than
 * simply appearing.
 *
 * The sweep is linear rather than exponential. An exponential ramp spends most of its travel in the
 * first hundred milliseconds, which is exactly wrong here: these chords are the slow part, and the
 * filter has to still be moving when the ear is halfway through hearing them.
 *
 * Each chord gets its own filter rather than sharing one. They overlap by design, and a single
 * sweep would be somewhere in the middle of the first chord's brightening when the second one
 * arrived — so the resolution would come in duller than the thing it resolves.
 */
function chord(
  ctx: AudioContext,
  dest: AudioNode,
  notes: readonly number[],
  at: number,
  attack: number,
  peak: number,
  duration: number,
  from: number,
  to: number,
  sweep: number,
): void {
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.setValueAtTime(from, at);
  lowpass.frequency.linearRampToValueAtTime(to, at + sweep);
  lowpass.connect(dest);
  for (const freq of notes) {
    voice(ctx, lowpass, "triangle", freq, at, attack, peak, duration, -6);
    voice(ctx, lowpass, "triangle", freq, at, attack, peak, duration, 6);
  }
}

function render(ctx: AudioContext): void {
  // A beat of lead-in. Scheduling at `currentTime` exactly means asking for a sound in the past by
  // the time the graph is built, and the first milliseconds get clipped.
  const at = ctx.currentTime + 0.02;

  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(ctx.destination);

  // The lean. Still sounding when the resolution starts — its 750ms tail overlaps the 180ms the
  // tonic takes to arrive, which is what makes the change read as one gesture instead of two
  // chords played in a row.
  chord(ctx, master, TENSION_HZ, at, 0.2, 0.06, 0.75, 1100, 3400, 0.4);

  // The landing. Louder and brighter than what it resolves, because it is the half that carries the
  // message; the first chord's only job is to make this one feel like an answer.
  const resolveAt = at + RESOLVE_AT_S;
  chord(ctx, master, TONIC_HZ, resolveAt, 0.18, 0.07, 1.05, 1300, 4400, 0.42);

  // Slow attack on purpose — 50ms rather than the 8ms every other transient here gets. A sub that
  // snaps in is a thump, and a thump under a resolution turns "it's ready" into a drum hit.
  voice(ctx, master, "sine", SUB_HZ, resolveAt, 0.05, 0.09, 0.55);

  // Straight to the master, past both filters: these are the part that has to carry across a room,
  // and the sweeps that flatter the chords would swallow them. Placed over the resolution rather
  // than the opening, so the brightest moment and the harmonic arrival are the same moment.
  SHIMMER_HZ.forEach((freq, index) => {
    voice(ctx, master, "sine", freq, resolveAt + 0.08 + index * 0.09, 0.008, 0.055, 0.4);
  });
}

/**
 * Plays the sound, unless one just played.
 *
 * Silent — never throws, never toasts. A machine with no audio device, a context that refused to
 * resume, a user who has muted the app at the OS level: none of those are errors the person who
 * started a code generation needs to hear about.
 */
export function playNotificationSound(): void {
  const now = Date.now();
  if (now - lastPlayedAt < MIN_GAP_MS) return;
  lastPlayedAt = now;
  previewNotificationSound();
}

/**
 * Plays the sound now, whatever else just played.
 *
 * For the toggle: pressing it is a request to hear the thing, and swallowing that because a
 * notification happened to arrive half a second ago would read as a broken button.
 */
export function previewNotificationSound(): void {
  const ctx = audioContext();
  if (!ctx) return;
  // A context can be suspended by the autoplay policy at birth, and again whenever the OS decides
  // to — the app being backgrounded is enough on macOS. `resume` is a promise nobody can await
  // here, so the sound is scheduled behind it rather than before.
  if (ctx.state === "suspended") {
    void ctx.resume().then(
      () => render(ctx),
      () => undefined,
    );
    return;
  }
  render(ctx);
}
