import { ended, type RunPhase, type ThinkingActivity } from "./activity";
import { askBreath, cueClock, softHalo, startle } from "./cue";
import { aiHue, mix, palette, rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";
import type { Gaze } from "./face";
import { listenLevel } from "./listen";
import { easeToward, toward } from "./pointer";

/**
 * "Esfera" — a globe of dots that lights up by what the run is doing.
 *
 * Ported from the MorphOrb on 21st.dev (@anark17r, "ai thinking orb and input"): rings of dots on a
 * sphere, turning on a tilted axis, drawn back to front with perspective. What is kept is its idea
 * that the *light* says the phase, not the shape: two roaming spotlights while the model thinks, a
 * band scanning down while it reads or searches, a trail running round the rings while it edits or
 * runs a command, a faster one while it writes. Finished, a green sweep runs top to bottom; failed,
 * the sweep is red and the globe stops turning.
 *
 * Listening (Codi), it turns slowly and rings of light close in from its rim toward its middle, the
 * whole globe drawing in a little with every syllable it hears — speaking pushes the mark out, this
 * pulls it in. Codi's cues: woken, every dot flashes and the globe pops for an instant; asking, it
 * breathes slowly, turning hardly at all, in a soft halo.
 *
 * Scaled down for a gutter: fewer, fatter dots as it shrinks — three hundred hairline dots in 32px
 * read as fog, not as a globe. Big (Codi's window), more and finer ones, so it does not read coarse.
 *
 * Following the pointer (`ThinkingOrb follow`), the globe turns its face to it: it tips toward it,
 * and the dots facing it light up — a light that the pointer carries. It does not drift: the globe
 * already fills its square, and moved, its lit edge was cut off by the canvas.
 */

const TAU = Math.PI * 2;
/** Phase → light: 0 trail, 1 spotlights, 2 scan band, 3 fast trail, 4 rings closing in, -1 none. */
const LIGHT: Record<RunPhase, number> = {
  start: -1,
  think: 1,
  plan: 1,
  work: 1,
  read: 2,
  search: 2,
  tool: 2,
  edit: 0,
  run: 0,
  delegate: 0,
  write: 3,
  speak: 3,
  listen: 4,
};

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

interface Dot {
  x: number;
  y: number;
  z: number;
  /** 0 at the top pole, 1 at the bottom — what the assembly and the finishing sweep run along. */
  u: number;
  seed: number;
}

export function createSphere(canvas: HTMLCanvasElement, px: number, gain = 1): Painter {
  const ctx = prepareCanvas(canvas, px);
  // The caps only bind past the gutter sizes (51px and 48px): up to 44px the globe is what it was.
  const rings = Math.round(Math.max(6, Math.min(24, px / 3.2)));
  const perRing = Math.round(Math.max(8, Math.min(46, px / 1.6)));
  const random = mulberry32(7);
  const dots: Dot[] = [];
  for (let r = 0; r < rings; r++) {
    const y = 1 - ((r + 0.5) / rings) * 2;
    const radius = Math.sqrt(1 - y * y);
    const n = Math.max(4, Math.round(perRing * radius));
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU + r * 0.35;
      dots.push({ x: Math.cos(th) * radius, y, z: Math.sin(th) * radius, u: (1 - y) / 2, seed: random() * TAU });
    }
  }
  const count = dots.length;
  const glow = new Float32Array(count);
  const R = px * 0.43;
  const dot = Math.max(0.6, ((2 * R) / rings) * 0.27);
  const weights = [0, 0, 0, 0, 0];
  let light = 1;
  const cue = cueClock();
  /** The microphone's level this frame while it listens, as far as Codi's gain takes it. */
  let pull = 0;
  /** The run ended in an error: the closing sweep is red, and the globe stops turning. */
  let failed = false;
  let time = 0;
  let turn = 0;
  // Eased toward `goal` every tick; `sweep` runs at its own steady pace.
  const now = { k: 0, spin: 0.9, gain: 1, sweep: 0, alpha: 1, warn: 0 };
  const goal = { ...now, k: 1 };
  let gaze: Gaze = null;
  /** Following the pointer only while it runs: a finish, a stop or a quiet spell is its own look. */
  let awake = true;
  const look = toward();

  function setActivity(activity: ThinkingActivity | undefined) {
    cue.set(activity);
    const done = ended(activity);
    failed = !!activity?.failed;
    const stopping = !!activity?.stopping;
    const quiet = !!activity?.quiet && !done && !stopping;
    awake = !done && !stopping && !quiet;
    light = done || stopping || quiet ? -1 : LIGHT[activity?.phase ?? "work"];
    goal.k = stopping ? 0 : 1;
    goal.spin = quiet ? 0.18 : failed ? 0.04 : done ? 0.3 : light === 4 ? 0.45 : 0.9;
    goal.gain = quiet ? 0.2 : done ? 0 : 1;
    goal.sweep = done ? 1 : 0;
    goal.alpha = stopping ? 0.3 : 1;
    goal.warn = quiet ? 1 : 0;
  }

  function draw(dt: number) {
    if (!ctx) return;
    const p = palette();
    ctx.clearRect(0, 0, px, px);
    if (now.alpha < 0.01) return;
    time += dt;
    // Asking, it hardly turns.
    turn += now.spin * dt * (1 - 0.7 * cue.ask);
    for (let j = 0; j < weights.length; j++) {
      const d = (j === light ? 1 : 0) - weights[j];
      const step = dt > 0 ? dt / 0.35 : 1;
      weights[j] += Math.abs(d) <= step ? d : d > 0 ? step : -step;
    }
    const decay = dt > 0 ? Math.exp(-dt / 0.5) : 0;
    const trailA = (time * count * 0.8) % count;
    const trailB = (time * count * 1.35) % count;
    const widthA = Math.max(5, count * 0.06);
    const widthB = Math.max(6, count * 0.08);
    const y1 = time * 0.8;
    const p1 = Math.sin(time * 0.5) * 0.9;
    const s1 = [Math.cos(p1) * Math.cos(y1), Math.sin(p1), Math.cos(p1) * Math.sin(y1)];
    const y2 = time * 0.55 + 2.1;
    const p2 = Math.cos(time * 0.42) * 0.9;
    const s2 = [Math.cos(p2) * Math.cos(y2), Math.sin(p2), Math.cos(p2) * Math.sin(y2)];
    const band = Math.sin(time * 2.2);
    // Listening: drawn in by what it hears; the rings closing from the rim, two at a time.
    const drawn = Math.min(1.4, pull) * weights[4];
    const closing = [1 - ((time * 0.8) % 1), 1 - ((time * 0.8 + 0.5) % 1)];
    // The wake's flash and pop; the ask's breath, and its halo behind the dots.
    const start = startle(cue.wake);
    const breath = askBreath(time);
    const Rnow = R * (1 - 0.07 * drawn) * (1 + 0.04 * start) * (1 + 0.03 * cue.ask * (breath - 0.5));
    if (cue.ask > 0.01) softHalo(ctx, px / 2, px / 2, px * 0.36, aiHue(p, 0.5), 0.22 * cue.ask * (0.6 + 0.4 * breath) * now.alpha);
    const cr = Math.cos(turn);
    const sr = Math.sin(turn);
    // Tipped toward the pointer: up when it is above, over toward it when it is below.
    const tilt = 0.35 - look.y * look.on * 0.5;
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    const c = px / 2;
    // The pointer's light: from its side, and from the front — the screen's y runs down, the
    // globe's up.
    const toLen = Math.hypot(look.x, look.y, 0.85);
    const lx = look.x / toLen;
    const ly = -look.y / toLen;
    const lz = 0.85 / toLen;
    const ring = (i: number, at: number, width: number) => {
      let d = Math.abs(i - at);
      if (d > count - d) d = count - d;
      const v = Math.max(0, 1 - d / width);
      return v * v;
    };
    const fills: [number, number, number, number, number, string][] = [];
    for (let i = 0; i < count; i++) {
      const q = dots[i];
      let lit = 0;
      if (weights[0] > 0.001) lit = Math.max(lit, ring(i, trailA, widthA) * weights[0]);
      if (weights[1] > 0.001) {
        const a = Math.max(0, (q.x * s1[0] + q.y * s1[1] + q.z * s1[2] - 0.72) / 0.28);
        const b = Math.max(0, (q.x * s2[0] + q.y * s2[1] + q.z * s2[2] - 0.72) / 0.28);
        const m = Math.max(a, b);
        lit = Math.max(lit, m * m * weights[1]);
      }
      if (weights[2] > 0.001) {
        const dy = q.y - band;
        const v = Math.max(0, 1 - (dy * dy) / 0.02);
        lit = Math.max(lit, v * v * weights[2]);
      }
      if (weights[3] > 0.001) lit = Math.max(lit, ring(i, trailB, widthB) * weights[3]);
      const mx = q.x * cr + q.z * sr;
      const mz = -q.x * sr + q.z * cr;
      const my = q.y * ct - mz * st;
      const depth = q.y * st + mz * ct;
      if (start > 0.01) lit = Math.max(lit, 0.85 * start);
      if (look.on > 0.01) {
        const f = Math.max(0, (mx * lx + my * ly + depth * lz - 0.62) / 0.38);
        lit = Math.max(lit, f * f * look.on * 0.9);
      }
      let g = Math.max(glow[i] * decay, lit * now.gain);
      glow[i] = g;
      // The listening rings light the dots they pass without leaving the glow's trail behind: with
      // it, two rings a second lit the whole globe and nothing read as closing in.
      if (weights[4] > 0.001) {
        const rr = Math.hypot(mx, my);
        let v = 0;
        for (const at of closing) v = Math.max(v, Math.max(0, 1 - Math.abs(rr - at) / 0.14));
        g = Math.max(g, v * v * (0.35 + 0.65 * Math.min(1, drawn)) * weights[4] * now.gain);
      }
      const shown = clamp01(now.k * 1.6 - 0.6 * q.u);
      if (shown <= 0.001) continue;
      const e = 1 - Math.pow(1 - shown, 3);
      const persp = 2.8 / (2.8 - depth);
      const ma = (depth + 1) / 2;
      const sw = clamp01((now.sweep * 1.4 - q.u) / 0.4);
      let alpha =
        0.2 +
        0.05 * Math.sin(q.seed + time * 1.6) * (1 - sw) +
        0.5 * ma * ma +
        0.8 * g * (1 - sw) +
        sw * (0.55 + 0.4 * ma) +
        1.6 * sw * (1 - sw);
      alpha = Math.min(1, alpha) * e * now.alpha * (1 - 0.35 * now.warn);
      if (alpha < 0.02) continue;
      let color = p.text;
      if (sw > 0.02) color = mix(p.text, failed ? p.danger : p.success, sw * 1.2);
      else if (g > 0.04) color = mix(p.text, aiHue(p, q.u), g * 2.2);
      if (now.warn > 0.02) color = mix(color, p.warning, now.warn * 0.45);
      const size = (dot * (0.55 + 0.6 * ma) * persp + dot * g + dot * 0.25 * sw) * (0.45 + 0.55 * e);
      fills.push([depth, c + mx * Rnow * e * persp, c - my * Rnow * e * persp, size, alpha, rgb(color)]);
    }
    fills.sort((a, b) => a[0] - b[0]);
    for (const [, x, y, size, alpha, color] of fills) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  return {
    setActivity,
    setGaze(next) {
      gaze = next;
    },
    tick(dt) {
      cue.step(dt);
      pull = light === 4 ? listenLevel() * gain : 0;
      easeToward(look, awake ? gaze : null, dt);
      const ease = (key: "k" | "spin" | "gain" | "alpha" | "warn", rate: number) => {
        now[key] += (goal[key] - now[key]) * Math.min(1, dt * rate);
      };
      ease("k", 3.2);
      ease("spin", 2.5);
      ease("gain", 3);
      ease("alpha", 3.5);
      ease("warn", 3);
      now.sweep = goal.sweep > now.sweep ? Math.min(goal.sweep, now.sweep + dt * 1.5) : goal.sweep;
      draw(dt);
    },
    still() {
      Object.assign(now, goal);
      if (time === 0) time = 1.3;
      cue.settle();
      // A still frame of listening is mid-word, drawn in, its rings on their way.
      pull = light === 4 ? 0.7 * gain : 0;
      draw(0);
    },
  };
}
