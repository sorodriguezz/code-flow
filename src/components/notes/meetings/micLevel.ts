/**
 * How the microphone sounds to the transcription, judged from its last two seconds of 40 ms blocks
 * (RMS and peak, fractions of full scale, after the gain).
 *
 * Judged by the loudest block, not the latest one: speech is full of short gaps, and a meter that
 * read "too low" between two words would be wrong half the time. Whisper copes with a wide range,
 * so "good" is wide; what really hurts it is clipping (the waveform flattened, words smeared) and
 * speech so low it sinks into the noise.
 */

export type MicVerdict = "silent" | "tooLow" | "good" | "limit" | "tooLoud";

/** A level in dBFS, floored at −90 for silence. */
export function dbfs(value: number): number {
  return value > 0 ? Math.max(-90, 20 * Math.log10(value)) : -90;
}

/** The meter's bottom, in dBFS: anything quieter draws as empty. */
export const METER_FLOOR = -60;
/** Below this the loudest block is nobody speaking (a room's noise, a muted microphone). */
const SILENT = -55;
/** Speech whose loudest block stays under this is too low to transcribe well. */
const TOO_LOW = -40;
/** Speech louder than this, or peaks past `LIMIT_PEAK`, is near clipping. */
const LIMIT = -12;
const LIMIT_PEAK = -3;
/** Peaks here are clipping (the gain's clamp lands exactly on full scale). */
const CLIP_PEAK = -0.5;

export function verdict(rms: readonly number[], peak: readonly number[]): MicVerdict {
  const loudest = dbfs(Math.max(0, ...rms));
  const highest = dbfs(Math.max(0, ...peak));
  if (highest >= CLIP_PEAK || loudest >= -6) return "tooLoud";
  if (highest >= LIMIT_PEAK || loudest >= LIMIT) return "limit";
  if (loudest < SILENT) return "silent";
  if (loudest < TOO_LOW) return "tooLow";
  return "good";
}

/** Where `db` sits on the meter, 0..1. */
export function meterPosition(db: number): number {
  return Math.min(1, Math.max(0, (db - METER_FLOOR) / -METER_FLOOR));
}

/** The meter's zones, as positions: low ends, limit starts, clipping starts. */
export const ZONES = { low: meterPosition(TOO_LOW), limit: meterPosition(LIMIT), loud: meterPosition(LIMIT_PEAK) };

/** The colour token of each verdict. */
export const VERDICT_COLOR: Record<MicVerdict, string> = {
  silent: "var(--cf-text-muted)",
  tooLow: "var(--cf-danger)",
  good: "var(--cf-success)",
  limit: "var(--cf-warning)",
  tooLoud: "var(--cf-danger)",
};

/** The gain slider's range, in percent (the backend clamps to 0.25..4). */
export const GAIN_MIN = 25;
export const GAIN_MAX = 400;
