/**
 * The sound a notification makes: a warm chord that swells and fades, with three bright notes over
 * the top of it.
 *
 * Synthesised rather than played from a file. An `.mp3` would be simpler to read, and it would also
 * be a binary in the repository, a bundler rule, a decode step, and a thing nobody can adjust
 * without opening a DAW. This is forty lines of oscillators, it weighs nothing in the bundle, and
 * changing how it sounds is changing a number here.
 *
 * The design brief was "gamer/IA": a triangle-wave chord in D (D3, A3, D4 — an open fifth with the
 * octave, which reads as neither major nor minor and so never sounds cheerful or ominous), each
 * note doubled and detuned a few cents so it beats slowly instead of sitting still, under a rising
 * lowpass that opens as the chord arrives. On top, three sines climbing D6–G6–D7 for the part your
 * ear actually notices from across the room.
 */

/**
 * Two notifications landing in the same breath are one event as far as the ear is concerned.
 *
 * A generation finishing usually pushes one entry, but a batch of them can push several within a
 * frame or two, and three copies of a 1.4-second chord playing on top of each other is not three
 * notifications — it is a mess. The first one wins and the rest are silent; the panel still shows
 * all of them, which is where counting belongs.
 */
const MIN_GAP_MS = 600;

/**
 * Peak level for the whole sound.
 *
 * Low on purpose. This plays while the user is doing something else — that is the entire point of
 * it — so it has to be audible without being an interruption. Loud enough to notice, quiet enough
 * that the tenth one today is not a reason to turn the feature off.
 */
const MASTER_GAIN = 0.9;

/** The swelling chord: D3, A3, D4. */
const CHORD_HZ = [293.66, 440, 587.33];

/** The bright notes over the top: D6, G6, D7. */
const SHIMMER_HZ = [1174.66, 1567.98, 2349.32];

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

function render(ctx: AudioContext): void {
  // A beat of lead-in. Scheduling at `currentTime` exactly means asking for a sound in the past by
  // the time the graph is built, and the first milliseconds get clipped.
  const at = ctx.currentTime + 0.02;

  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(ctx.destination);

  // The filter opens as the chord arrives, so the sound brightens rather than simply appearing.
  // Linear rather than exponential: this is the slow half of the sound, and an exponential sweep
  // spends most of its travel in the first hundred milliseconds, which is the opposite of the
  // swell we want.
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.setValueAtTime(1100, at);
  lowpass.frequency.linearRampToValueAtTime(4200, at + 0.45);
  lowpass.connect(master);

  for (const freq of CHORD_HZ) {
    // Two per note, six cents apart. The pair drifts in and out of phase about twice a second,
    // which is what makes the chord sound like it is breathing instead of held.
    voice(ctx, lowpass, "triangle", freq, at, 0.24, 0.085, 1.2, -6);
    voice(ctx, lowpass, "triangle", freq, at, 0.24, 0.085, 1.2, 6);
  }

  // Past the filter, not through it: these are the part that has to carry across a room, and the
  // sweep that flatters the chord would swallow them.
  SHIMMER_HZ.forEach((freq, index) => {
    voice(ctx, master, "sine", freq, at + 0.2 + index * 0.09, 0.008, 0.06, 0.38);
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
