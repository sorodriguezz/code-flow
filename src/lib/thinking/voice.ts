/**
 * How loud the reading voice is right now — what the thinking mark moves by while it speaks.
 *
 * The backend sends the whole utterance's loudness envelope once, as it starts playing
 * (`speech:state`, phase `speaking`); the marks read it against the clock each frame. No event per
 * frame crosses the bridge, and every mark on screen moves with the same voice.
 */
let voice: { envelope: number[]; stepMs: number; startedAt: number } | null = null;

export function startVoice(envelope: number[], stepMs: number): void {
  voice = { envelope, stepMs: Math.max(1, stepMs), startedAt: performance.now() };
}

export function endVoice(): void {
  voice = null;
}

/**
 * 0–1. Smoothed a little across two steps, so the mark does not flicker on every syllable. With no
 * voice playing — the moment before it starts, Settings' preview — a speech-like pattern instead:
 * syllables over a slower phrase, the shape the marks drew writing with.
 */
export function voiceLevel(now: number = performance.now()): number {
  if (!voice) {
    const t = now / 1000;
    return 0.3 + 0.7 * Math.abs(Math.sin(t * 9) * Math.sin(t * 2.7));
  }
  const at = (now - voice.startedAt) / voice.stepMs;
  const index = Math.floor(at);
  if (index < 0 || index >= voice.envelope.length) return 0;
  const here = voice.envelope[index] ?? 0;
  const next = voice.envelope[index + 1] ?? here;
  return here + (next - here) * (at - index);
}

export function voiceActive(): boolean {
  return voice !== null;
}
