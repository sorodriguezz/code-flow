import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_SOUND,
  DEFAULT_NOTIFICATION_VOLUME,
  isNotificationSoundId,
  NOTIFICATION_SOUNDS,
  renderNotificationSound,
  soundById,
  volumeGain,
} from "./notificationSound";
import { translations } from "./i18n/translations";
import { es } from "./i18n/translations.es";

/**
 * The notification sounds, checked without a speaker: every one is a graph of oscillators scheduled
 * on a context, so what can go wrong is visible in the graph — a source started and never stopped
 * (it stays on the context for the life of the app, and this runs every time work finishes), a
 * note scheduled in the past (its first milliseconds are clipped), an exponential ramp to zero (the
 * real API throws), and the default quietly becoming a different sound.
 *
 * How they *sound*, and that they are level with each other, was measured by rendering each through
 * an `OfflineAudioContext` — which needs a browser, so it is not repeated here.
 */

class FakeParam {
  value = 0;
  setValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number) {
    // What the real AudioParam does, and the reason every envelope here stops at 0.0001.
    if (value <= 0) throw new RangeError("exponentialRampToValueAtTime needs a positive target");
    this.value = value;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class FakeNode {
  readonly outputs: unknown[] = [];
  connect(target: unknown) {
    this.outputs.push(target);
    return target;
  }
  disconnect() {}
}

class FakeSource extends FakeNode {
  started: number | null = null;
  stopped: number | null = null;
  start(at = 0) {
    this.started = at;
  }
  stop(at = 0) {
    this.stopped = at;
  }
}

class FakeOscillator extends FakeSource {
  type = "sine";
  frequency = new FakeParam();
  detune = new FakeParam();
}

function fakeContext() {
  const sources: FakeSource[] = [];
  const gains: { gain: FakeParam }[] = [];
  const ctx = {
    currentTime: 3,
    sampleRate: 48000,
    destination: new FakeNode(),
    createOscillator: () => {
      const osc = new FakeOscillator();
      sources.push(osc);
      return osc;
    },
    createBufferSource: () => {
      const source = Object.assign(new FakeSource(), { buffer: null as unknown });
      sources.push(source);
      return source;
    },
    createGain: () => {
      const node = Object.assign(new FakeNode(), { gain: new FakeParam() });
      gains.push(node);
      return node;
    },
    createBiquadFilter: () => Object.assign(new FakeNode(), { type: "lowpass", frequency: new FakeParam(), Q: new FakeParam() }),
    createBuffer: (_channels: number, length: number) => {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    },
  };
  return { ctx: ctx as unknown as BaseAudioContext, sources, gains };
}

describe("the notification sounds", () => {
  it("are ten, each with its own id", () => {
    const ids = NOTIFICATION_SOUNDS.map((sound) => sound.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(DEFAULT_NOTIFICATION_SOUND);
  });

  it("have a name and a line in both languages", () => {
    for (const sound of NOTIFICATION_SOUNDS) {
      for (const key of [sound.labelKey, sound.hintKey]) {
        expect(translations.en[key], `${sound.id}: ${key} (en)`).toBeTruthy();
        expect(es[key], `${sound.id}: ${key} (es)`).toBeTruthy();
      }
    }
  });

  it("keep the default the sound the app always made", () => {
    // Cadencia is not a new sound with an old name: someone who never opens the new pane must hear
    // exactly what they heard before it existed.
    const cadence = soundById("cadence");
    expect(cadence.level).toBe(0.9);
    const at = (seconds: number) =>
      cadence.score.filter((note) => Math.abs(note.at - seconds) < 1e-9).map((note) => note.hz);
    expect(at(0)).toEqual([220, 293.66, 329.63]);
    expect(at(0.42)).toEqual([146.83, 220, 293.66, 369.99, 73.42]);
    expect(cadence.score.filter((note) => note.peak === 0.055).map((note) => note.hz)).toEqual([1174.66, 1567.98, 2349.32]);
    expect(volumeGain(DEFAULT_NOTIFICATION_VOLUME)).toBe(1);
  });

  it("are short — the longest is the bowl, and it is under four seconds", () => {
    for (const sound of NOTIFICATION_SOUNDS) {
      expect(sound.length, sound.id).toBeGreaterThan(0.1);
      expect(sound.length, sound.id).toBeLessThan(4);
    }
  });

  it("stop every source they start, after starting it, and never schedule into the past", () => {
    for (const sound of NOTIFICATION_SOUNDS) {
      const { ctx, sources } = fakeContext();
      renderNotificationSound(ctx, sound.id, DEFAULT_NOTIFICATION_VOLUME);
      expect(sources.length, sound.id).toBeGreaterThan(0);
      for (const source of sources) {
        expect(source.started, sound.id).not.toBeNull();
        expect(source.stopped, sound.id).not.toBeNull();
        expect(source.started!, sound.id).toBeGreaterThanOrEqual(ctx.currentTime);
        expect(source.stopped!, sound.id).toBeGreaterThan(source.started!);
        // Nothing outlives the sound by more than the 20ms each stop is padded with, plus the lead-in.
        expect(source.stopped!, sound.id).toBeLessThanOrEqual(ctx.currentTime + sound.length + 0.05);
      }
    }
  });

  it("scale the whole sound by its level and the volume, on one gain", () => {
    for (const volume of [0, 35, 70, 100]) {
      const { ctx, gains } = fakeContext();
      const master = renderNotificationSound(ctx, "marimba", volume);
      expect(gains[0]).toBe(master);
      expect(master.gain.value).toBeCloseTo(soundById("marimba").level * volumeGain(volume), 10);
    }
  });

  it("fall back to the default for an id this release does not know", () => {
    expect(soundById("theremin").id).toBe(DEFAULT_NOTIFICATION_SOUND);
    expect(soundById(null).id).toBe(DEFAULT_NOTIFICATION_SOUND);
    expect(isNotificationSoundId("bowl")).toBe(true);
    expect(isNotificationSoundId("theremin")).toBe(false);
  });
});

describe("volumeGain", () => {
  it("is silence at 0, the tuned level at the default, and about 6 dB over it at 100", () => {
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(DEFAULT_NOTIFICATION_VOLUME)).toBe(1);
    expect(20 * Math.log10(volumeGain(100))).toBeCloseTo(6.2, 1);
  });

  it("only ever gets louder as the slider goes up", () => {
    for (let volume = 1; volume <= 100; volume++) {
      expect(volumeGain(volume)).toBeGreaterThan(volumeGain(volume - 1));
    }
  });

  it("clamps what it cannot trust", () => {
    expect(volumeGain(250)).toBe(volumeGain(100));
    expect(volumeGain(-5)).toBe(0);
    expect(volumeGain(Number.NaN)).toBe(1);
  });
});
