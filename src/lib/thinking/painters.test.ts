import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThinkingActivity, ThinkingCue } from "./activity";
import type { Painter } from "./ticker";
import { ORB_PX } from "./ticker";
import { endListen, setListenLevel } from "./listen";
import { createSphere } from "./sphere";
import { createOrb } from "./orb";
import { createNetwork } from "./network";
import { createWave } from "./wave";
import { createLiquid } from "./liquid";
import { createCrystal } from "./crystal";
import { createCat } from "./cat";
import { createPixels } from "./pixels";
import { createGhost } from "./ghost";
import { createCrab } from "./crab";
import { createMoon } from "./moon";
import { createAtom } from "./atom";
import { createSpark } from "./spark";
import { createCloud } from "./cloud";
import { createBulb } from "./bulb";
import { createAlien } from "./alien";

/**
 * The canvas designs, stepped by hand. Nothing here runs a frame loop — the browser pane's hidden tab
 * runs no `requestAnimationFrame` either — so each painter is driven tick by tick with fake times on a
 * fake 2D context that keeps the transform, and what it draws is measured against its square: the
 * listening look, Codi's cues and the gain it passes must neither throw, nor paint NaN, nor leave the
 * square at the hero size.
 */

// The theme stood in for: the probe element and the one-pixel canvas `palette()` resolves tokens with
// do not exist here.
vi.mock("./palette", async (importOriginal) => {
  const real = await importOriginal<typeof import("./palette")>();
  const fixed: import("./palette").Palette = {
    text: [232, 233, 241],
    surface: [18, 19, 25],
    a: [139, 92, 246],
    b: [99, 102, 241],
    c: [6, 182, 212],
    success: [74, 222, 128],
    warning: [251, 191, 36],
    danger: [248, 113, 113],
    dark: true,
  };
  return { ...real, palette: () => fixed };
});
const motion = vi.hoisted(() => ({ off: false }));
vi.mock("../motion", () => ({ motionOff: () => motion.off }));

const DPR = 2;

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A 2D context that draws nothing and remembers how far out each frame's ink went, in device px. */
class FakeContext {
  fillStyle: unknown = "";
  strokeStyle: unknown = "";
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  shadowColor = "";
  shadowBlur = 0;
  imageSmoothingEnabled = true;
  /** Ink of the frame being drawn (since the last full clear), and whether anything was NaN. */
  box: Box = empty();
  nan = false;
  private m = [1, 0, 0, 1, 0, 0];
  /** What a `clip()` leaves drawable, as a box — ink outside it is never seen. */
  private clipBox: Box | null = null;
  private stack: { m: number[]; clip: Box | null }[] = [];
  private path: [number, number][] = [];
  private cur: [number, number] = [0, 0];
  constructor(private readonly canvas: { width: number; height: number }) {}

  private apply(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.m;
    if (!Number.isFinite(x) || !Number.isFinite(y)) this.nan = true;
    return [a * x + c * y + e, b * x + d * y + f];
  }
  private push(x: number, y: number) {
    this.cur = this.apply(x, y);
    this.path.push(this.cur);
  }
  private commit(points: [number, number][], pad: number) {
    const c = this.clipBox;
    for (const [x, y] of points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) this.nan = true;
      const lo = (v: number, edge: number | undefined) => (edge === undefined ? v : Math.max(v, edge));
      const hi = (v: number, edge: number | undefined) => (edge === undefined ? v : Math.min(v, edge));
      this.box.minX = Math.min(this.box.minX, lo(x - pad, c?.minX));
      this.box.minY = Math.min(this.box.minY, lo(y - pad, c?.minY));
      this.box.maxX = Math.max(this.box.maxX, hi(x + pad, c?.maxX));
      this.box.maxY = Math.max(this.box.maxY, hi(y + pad, c?.maxY));
    }
  }
  private scaleOf() {
    const [a, b, c, d] = this.m;
    return Math.sqrt(Math.abs(a * d - b * c));
  }

  save() {
    this.stack.push({ m: [...this.m], clip: this.clipBox });
  }
  restore() {
    const top = this.stack.pop();
    this.m = top?.m ?? [1, 0, 0, 1, 0, 0];
    this.clipBox = top?.clip ?? null;
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.m = [a, b, c, d, e, f];
  }
  private multiply(n: number[]) {
    const [a, b, c, d, e, f] = this.m;
    this.m = [
      a * n[0] + c * n[1],
      b * n[0] + d * n[1],
      a * n[2] + c * n[3],
      b * n[2] + d * n[3],
      a * n[4] + c * n[5] + e,
      b * n[4] + d * n[5] + f,
    ];
  }
  translate(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) this.nan = true;
    this.multiply([1, 0, 0, 1, x, y]);
  }
  scale(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) this.nan = true;
    this.multiply([x, 0, 0, y, 0, 0]);
  }
  rotate(t: number) {
    if (!Number.isFinite(t)) this.nan = true;
    this.multiply([Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0]);
  }
  getTransform() {
    const [a, b, c, d, e, f] = this.m;
    return { a, b, c, d, e, f, transformPoint: (p: { x: number; y: number }) => ({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }) };
  }

  beginPath() {
    this.path = [];
  }
  closePath() {}
  moveTo(x: number, y: number) {
    this.push(x, y);
  }
  lineTo(x: number, y: number) {
    this.push(x, y);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    const [x0, y0] = this.cur;
    const c = this.apply(cx, cy);
    const e = this.apply(x, y);
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      const k = 1 - t;
      this.path.push([k * k * x0 + 2 * k * t * c[0] + t * t * e[0], k * k * y0 + 2 * k * t * c[1] + t * t * e[1]]);
    }
    this.cur = e;
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
    const [x0, y0] = this.cur;
    const c1 = this.apply(c1x, c1y);
    const c2 = this.apply(c2x, c2y);
    const e = this.apply(x, y);
    for (let i = 1; i <= 16; i++) {
      const t = i / 16;
      const k = 1 - t;
      const w = [k * k * k, 3 * k * k * t, 3 * k * t * t, t * t * t];
      this.path.push([w[0] * x0 + w[1] * c1[0] + w[2] * c2[0] + w[3] * e[0], w[0] * y0 + w[1] * c1[1] + w[2] * c2[1] + w[3] * e[1]]);
    }
    this.cur = e;
  }
  arcTo(x1: number, y1: number, x2: number, y2: number) {
    this.push(x1, y1);
    this.push(x2, y2);
  }
  arc(x: number, y: number, r: number, from: number, to: number, ccw = false) {
    this.ellipse(x, y, r, r, 0, from, to, ccw);
  }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, from: number, to: number, ccw = false) {
    if (![x, y, rx, ry, rot, from, to].every(Number.isFinite) || rx < 0 || ry < 0) this.nan = true;
    let span = ccw ? from - to : to - from;
    if (span < 0) span = span + Math.PI * 2 * Math.ceil(-span / (Math.PI * 2));
    span = Math.min(span, Math.PI * 2);
    for (let i = 0; i <= 32; i++) {
      const t = from + (ccw ? -1 : 1) * span * (i / 32);
      const ex = Math.cos(t) * rx;
      const ey = Math.sin(t) * ry;
      this.push(x + ex * Math.cos(rot) - ey * Math.sin(rot), y + ex * Math.sin(rot) + ey * Math.cos(rot));
    }
  }
  rect(x: number, y: number, w: number, h: number) {
    this.push(x, y);
    this.push(x + w, y);
    this.push(x + w, y + h);
    this.push(x, y + h);
  }
  fill() {
    this.commit(this.path, 0);
  }
  stroke() {
    this.commit(this.path, (this.lineWidth / 2) * this.scaleOf());
  }
  clip() {
    const box = empty();
    for (const [x, y] of this.path) {
      box.minX = Math.min(box.minX, x);
      box.minY = Math.min(box.minY, y);
      box.maxX = Math.max(box.maxX, x);
      box.maxY = Math.max(box.maxY, y);
    }
    this.clipBox = box;
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.commit([this.apply(x, y), this.apply(x + w, y + h)], 0);
  }
  clearRect(x: number, y: number, w: number, h: number) {
    // A full clear starts a new frame.
    const [x0, y0] = this.apply(x, y);
    const [x1, y1] = this.apply(x + w, y + h);
    if (x0 <= 0 && y0 <= 0 && x1 >= this.canvas.width && y1 >= this.canvas.height) this.box = empty();
  }
  drawImage(_image: unknown, x: number, y: number, w: number, h: number) {
    this.commit([this.apply(x, y), this.apply(x + w, y + h)], 0);
  }
  createLinearGradient() {
    return { addColorStop() {} };
  }
  createRadialGradient(...args: number[]) {
    if (!args.every(Number.isFinite) || args[2] < 0 || args[5] < 0) this.nan = true;
    return { addColorStop() {} };
  }
  createConicGradient() {
    return { addColorStop() {} };
  }
  createImageData(w: number, h: number) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData() {}
  getImageData() {
    return { data: new Uint8ClampedArray(4) };
  }
}

function empty(): Box {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    ctx: null as FakeContext | null,
    getContext(kind: string) {
      if (kind !== "2d") return null;
      canvas.ctx ??= new FakeContext(canvas);
      return canvas.ctx;
    },
  };
  return canvas;
}

type Make = (canvas: HTMLCanvasElement, px: number, gain: number) => Painter;

const PAINTERS: Record<string, Make> = {
  sphere: createSphere,
  orb: createOrb,
  network: createNetwork,
  wave: createWave,
  liquid: createLiquid,
  crystal: createCrystal,
  cat: createCat,
  pixels: createPixels,
  ghost: createGhost,
  crab: createCrab,
  moon: createMoon,
  atom: createAtom,
  spark: createSpark,
  cloud: createCloud,
  bulb: createBulb,
  alien: createAlien,
};

/** The fake clock the painters' `performance.now()` reads (the voice, the microphone, the cues). */
let now = 1_000_000;

interface Run {
  /** Furthest any frame's ink went past the square, as a fraction of it (0 = inside). */
  overflow: number;
  nan: boolean;
}

/**
 * Builds a painter at `px` with `gain`, paints its mount's still frame, then plays each step: the
 * activity it is handed and how many 60 fps frames to run it for — feeding the microphone with
 * `feed` each frame when given. The overflow is the furthest any of those frames went.
 */
function play(
  make: Make,
  px: number,
  gain: number,
  steps: { act: ThinkingActivity | undefined; frames: number; feed?: (frame: number) => number }[],
): Run {
  const canvas = fakeCanvas();
  const painter = make(canvas as unknown as HTMLCanvasElement, px, gain);
  const ctx = canvas.ctx!;
  painter.setActivity(steps[0]?.act);
  painter.still();
  let overflow = 0;
  for (const step of steps) {
    painter.setActivity(step.act);
    for (let f = 0; f < step.frames; f++) {
      now += 1000 / 60;
      if (step.feed) setListenLevel(step.feed(f), now);
      painter.tick(1 / 60);
      const box = ctx.box;
      if (box.minX === Infinity) continue;
      const size = px * DPR;
      const out = Math.max(-box.minX, -box.minY, box.maxX - size, box.maxY - size, 0) / size;
      overflow = Math.max(overflow, out);
    }
  }
  return { overflow, nan: ctx.nan };
}

const wake = (): ThinkingCue => ({ kind: "wake", at: now });
const ask: ThinkingCue = { kind: "ask", at: 0 };
/** A voice talking to the mark: syllables, loud ones among them, and gaps. */
const talking = (frame: number) => Math.max(0, Math.sin(frame * 0.5)) * (frame % 40 < 30 ? 1 : 0.1);

beforeAll(() => {
  vi.stubGlobal("window", { devicePixelRatio: DPR });
  vi.stubGlobal("document", { createElement: () => fakeCanvas() });
  vi.stubGlobal(
    "DOMPoint",
    class {
      constructor(
        readonly x = 0,
        readonly y = 0,
      ) {}
    },
  );
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

beforeEach(() => {
  motion.off = false;
});

afterEach(() => {
  endListen();
});

describe("every canvas design", () => {
  for (const [id, make] of Object.entries(PAINTERS)) {
    describe(id, () => {
      it("listens, startles, waits and still finishes, at every size and at Codi's gain", () => {
        for (const size of ["sm", "lg", "hero"] as const) {
          for (const gain of [1, 2.2]) {
            const run = play(make, ORB_PX[size], gain, [
              { act: { phase: "think" }, frames: 30 },
              { act: { phase: "listen" }, frames: 60 },
              { act: { phase: "listen" }, frames: 90, feed: talking },
              { act: { phase: "listen", cue: wake() }, frames: 40, feed: talking },
              { act: { phase: "listen", cue: ask }, frames: 200 },
              { act: { phase: "speak" }, frames: 90 },
              { act: { phase: "listen", cue: ask, done: true }, frames: 120 },
              { act: { phase: "listen", failed: true }, frames: 120 },
            ]);
            expect(run.nan, `${id} at ${size}, gain ${gain}, painted NaN`).toBe(false);
          }
        }
        // Thousands of frames a design, the liquid's per-pixel field among them: seconds alone, and
        // more than vitest's default five when the whole suite shares the machine.
      }, 30_000);

      it("keeps listening, speaking and the cues inside the square at the hero size, gain 2.2", () => {
        const run = play(make, ORB_PX.hero, 2.2, [
          { act: { phase: "listen" }, frames: 120 },
          { act: { phase: "listen" }, frames: 120, feed: () => 1 },
          { act: { phase: "listen", cue: wake() }, frames: 40, feed: () => 1 },
          { act: { phase: "listen", cue: wake() }, frames: 40, feed: talking },
          { act: { phase: "listen", cue: ask }, frames: 240, feed: talking },
          { act: { phase: "speak" }, frames: 240 },
          { act: { phase: "speak", cue: wake() }, frames: 40 },
        ]);
        expect(run.overflow, `${id} leaves the square by ${(run.overflow * 100).toFixed(1)}%`).toBeLessThanOrEqual(0.01);
      }, 30_000);

      it("paints a still frame of listening and of each cue under reduced motion", () => {
        motion.off = true;
        for (const act of [
          { phase: "listen" },
          { phase: "listen", cue: wake() },
          { phase: "listen", cue: ask },
          { phase: "think", cue: ask },
        ] as ThinkingActivity[]) {
          const canvas = fakeCanvas();
          const painter = make(canvas as unknown as HTMLCanvasElement, ORB_PX.hero, 2.2);
          painter.setActivity(act);
          painter.still();
          expect(canvas.ctx!.box.minX, `${id} drew nothing`).toBeLessThan(Infinity);
          expect(canvas.ctx!.nan).toBe(false);
        }
      });
    });
  }
});
