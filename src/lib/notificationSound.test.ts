import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

class FakeParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; return this; }
  linearRampToValueAtTime(value: number) { this.value = value; return this; }
  exponentialRampToValueAtTime(value: number) {
    if (value <= 0) throw new RangeError("Exponential ramps need positive targets");
    this.value = value;
    return this;
  }
  cancelScheduledValues() { return this; }
}

class FakeNode {
  readonly outputs: unknown[] = [];
  disconnected = false;
  connect<T>(target: T): T { this.outputs.push(target); return target; }
  disconnect() { this.disconnected = true; }
}

class FakeSource extends FakeNode {
  started: number | null = null;
  stopped: number | null = null;
  start(at = 0) { this.started = at; }
  stop(at = 0) { this.stopped = at; }
}

function fakeContext() {
  const sources: FakeSource[] = [];
  const gains: (FakeNode & { gain: FakeParam })[] = [];
  const ctx = {
    currentTime: 3,
    state: "running",
    destination: new FakeNode(),
    resume: vi.fn(async () => {}),
    decodeAudioData: vi.fn(async () => ({ duration: 1 }) as AudioBuffer),
    createOscillator: () => {
      const source = Object.assign(new FakeSource(), { type: "sine", frequency: new FakeParam() });
      sources.push(source);
      return source;
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
    createDynamicsCompressor: () => Object.assign(new FakeNode(), {
      threshold: new FakeParam(), knee: new FakeParam(), ratio: new FakeParam(),
      attack: new FakeParam(), release: new FakeParam(),
    }),
  };
  return { ctx: ctx as unknown as AudioContext, sources, gains, decode: ctx.decodeAudioData, resume: ctx.resume };
}

const audioResponse = () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => audioResponse())); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("the notification catalogue", () => {
  it("offers all nine TypeUI cues and the original Prisma melody", () => {
    expect(NOTIFICATION_SOUNDS.map((sound) => sound.id)).toEqual([
      "double-ping", "ping", "mellow-chime", "soft-bell", "activity-beacon",
      "signal-arrival", "short-beep", "high-chime", "popup", "prism",
    ]);
    expect(DEFAULT_NOTIFICATION_SOUND).toBe("double-ping");
    expect(NOTIFICATION_SOUNDS.filter((sound) => sound.file)).toHaveLength(6);
  });

  it("has a name and description in both languages", () => {
    for (const sound of NOTIFICATION_SOUNDS) {
      for (const key of [sound.labelKey, sound.hintKey]) {
        expect(translations.en[key], `${sound.id}: ${key} (en)`).toBeTruthy();
        expect(es[key], `${sound.id}: ${key} (es)`).toBeTruthy();
      }
    }
  });

  it("packages recordings locally and keeps previews tied to their duration", () => {
    for (const sound of NOTIFICATION_SOUNDS) {
      expect(sound.length).toBeGreaterThan(0.1);
      expect(sound.length).toBeLessThan(4);
      if (sound.file) {
        expect(sound.file).toMatch(/^\/sounds\/typeui\/.*\.mp3$/);
        expect(sound.waveform).toHaveLength(24);
        expect(sound.waveform!.every((value) => value >= 0 && value <= 1)).toBe(true);
      } else {
        expect(sound.score.length).toBeGreaterThan(0);
        for (const note of sound.score) expect(note.at + note.dur + 0.03).toBeLessThanOrEqual(sound.length + 1e-9);
      }
    }
  });

  it("stops every source it starts, after starting, without scheduling into the past", async () => {
    for (const sound of NOTIFICATION_SOUNDS) {
      const { ctx, sources } = fakeContext();
      await renderNotificationSound(ctx, sound.id, DEFAULT_NOTIFICATION_VOLUME);
      expect(sources.length, sound.id).toBeGreaterThan(0);
      for (const source of sources) {
        expect(source.started).not.toBeNull();
        expect(source.stopped).not.toBeNull();
        expect(source.started!).toBeGreaterThanOrEqual(ctx.currentTime);
        expect(source.stopped!).toBeGreaterThan(source.started!);
      }
    }
  });

  it("scales the final output with the existing volume curve", async () => {
    for (const id of ["ping", "mellow-chime"]) {
      for (const volume of [0, 35, 70, 100]) {
        const { ctx } = fakeContext();
        const master = await renderNotificationSound(ctx, id, volume);
        expect(master.gain.value).toBeCloseTo(volumeGain(volume), 10);
      }
    }
  });

  it("falls back for retired, absent or unknown saved selections", () => {
    for (const id of ["cadence", "chime", "marimba", "harp", "glass", "bowl", "doorbell", "drop", "digital", "air", "levelup", "victory", "theremin", null]) {
      expect(soundById(id).id).toBe(DEFAULT_NOTIFICATION_SOUND);
      expect(isNotificationSoundId(id)).toBe(false);
    }
    expect(isNotificationSoundId("soft-bell")).toBe(true);
  });
});

describe("recorded playback", () => {
  it("shares fetching and decoding for simultaneous plays on one context", async () => {
    const { ctx, decode, sources } = fakeContext();
    await Promise.all([renderNotificationSound(ctx, "mellow-chime", 70), renderNotificationSound(ctx, "mellow-chime", 70)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(2);
  });

  it("schedules against the current time after decoding finishes", async () => {
    const { ctx, decode, sources } = fakeContext();
    decode.mockImplementationOnce(async () => {
      Object.assign(ctx, { currentTime: 6 });
      return { duration: 1 } as AudioBuffer;
    });
    await renderNotificationSound(ctx, "mellow-chime", 70);
    expect(sources[0].started).toBeCloseTo(6.02);
    expect(sources[0].stopped).toBeCloseTo(7.02);
  });

  it("retries a failed load without poisoning the cache", async () => {
    const { ctx, decode } = fakeContext();
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    await expect(renderNotificationSound(ctx, "mellow-chime", 70)).rejects.toThrow("404");
    await renderNotificationSound(ctx, "mellow-chime", 70);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("discards a slow preview when a newer sound is selected", async () => {
    vi.resetModules();
    const { previewNotificationSound } = await import("./notificationSound");
    const { ctx, gains } = fakeContext();
    vi.stubGlobal("window", { AudioContext: class { constructor() { return ctx; } } });
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    previewNotificationSound("mellow-chime", 70);
    await flush();
    previewNotificationSound("ping", 70);
    await flush();
    finish(audioResponse() as Response);
    await flush();
    const outputs = gains.filter((gain) => gain.outputs.some((node) =>
      node instanceof FakeNode && node.outputs.includes(ctx.destination)));
    expect(outputs).toHaveLength(2);
    expect(outputs[0].disconnected).toBe(false);
    expect(outputs[1].disconnected).toBe(true);
  });

  it("resumes suspended contexts and throttles bursts of notifications", async () => {
    vi.resetModules();
    const { playNotificationSound } = await import("./notificationSound");
    const { ctx, sources, resume } = fakeContext();
    Object.assign(ctx, { state: "suspended" });
    vi.stubGlobal("window", { AudioContext: class { constructor() { return ctx; } } });
    playNotificationSound("ping", 70);
    playNotificationSound("ping", 70);
    await flush();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(2);
  });
});

describe("volumeGain", () => {
  it("is silent at 0, tuned at 70, and about 6 dB louder at 100", () => {
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(DEFAULT_NOTIFICATION_VOLUME)).toBe(1);
    expect(20 * Math.log10(volumeGain(100))).toBeCloseTo(6.2, 1);
  });
  it("increases monotonically", () => {
    for (let volume = 1; volume <= 100; volume++) expect(volumeGain(volume)).toBeGreaterThan(volumeGain(volume - 1));
  });
  it("clamps untrusted values", () => {
    expect(volumeGain(250)).toBe(volumeGain(100));
    expect(volumeGain(-5)).toBe(0);
    expect(volumeGain(Number.NaN)).toBe(1);
  });
});
