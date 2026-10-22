/**
 * How loud the user is right now, as the microphone hears them — what the thinking mark moves by
 * while Codi listens (`RunPhase` `listen`), the way `voice.ts` is what it moves by while it speaks.
 *
 * Codi's window feeds it the microphone's level as the backend reports it, about 25 times a second;
 * the marks read it every frame. The reading is smoothed against the clock rather than per call, so
 * every mark on screen reads the same value however many of them read it — and unevenly: it rises
 * within a few hundredths of a second and falls over a fifth of one, so each syllable lands as a
 * pulse instead of flickering at the rate the events arrive.
 */

/** Seconds the level takes to rise most of the way to a louder reading, and to fall to a quieter one. */
const ATTACK_S = 0.03;
const RELEASE_S = 0.2;
/** A feed that stops without `endListen` reads as silence this long after its last level, rather
 *  than as the last level held for ever. */
const STALE_MS = 300;

interface Feed {
  /** The last level fed, 0–1, and when. */
  target: number;
  fedAt: number;
  /** The smoothed level, as of `at`. */
  value: number;
  at: number;
}

let feed: Feed | null = null;

/** One level from the microphone, 0–1 (out-of-range values are clamped). `now` is for tests. */
export function setListenLevel(level: number, now: number = performance.now()): void {
  const target = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  if (!feed) {
    feed = { target, fedAt: now, value: 0, at: now };
    return;
  }
  advance(feed, now);
  feed.target = target;
  feed.fedAt = now;
}

/** The microphone closed: back to the stand-in pattern for any mark still drawn listening. */
export function endListen(): void {
  feed = null;
}

/**
 * 0–1, smoothed (see above). With nothing feeding it — the moment before the microphone opens,
 * Settings' preview — a speech-like pattern instead: syllables over slower phrases, dipping lower
 * than the speaking stand-in (`voiceLevel`) so the pulses read as someone talking to the mark.
 */
export function listenLevel(now: number = performance.now()): number {
  if (!feed) {
    const t = now / 1000;
    return 0.12 + 0.88 * Math.abs(Math.sin(t * 8.1) * Math.sin(t * 1.9));
  }
  advance(feed, now);
  return feed.value;
}

export function listenActive(): boolean {
  return feed !== null;
}

/** Carries the smoothed level forward to `now`: toward the last level fed, and toward silence once
 *  the feed has gone stale. A `now` earlier than the last one changes nothing. */
function advance(f: Feed, now: number) {
  const staleAt = f.fedAt + STALE_MS;
  if (f.at < staleAt && now > staleAt) ease(f, staleAt, f.target);
  ease(f, now, now > staleAt ? 0 : f.target);
}

function ease(f: Feed, to: number, target: number) {
  const dt = (to - f.at) / 1000;
  if (dt <= 0) return;
  const tau = target > f.value ? ATTACK_S : RELEASE_S;
  f.value += (target - f.value) * (1 - Math.exp(-dt / tau));
  f.at = to;
}
