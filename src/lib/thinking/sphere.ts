import { ended, type RunPhase, type ThinkingActivity } from "./activity";
import { aiHue, mix, palette, rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

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
 * Scaled down for a gutter: fewer, fatter dots as it shrinks — three hundred hairline dots in 32px
 * read as fog, not as a globe.
 */

const TAU = Math.PI * 2;
/** Phase → light: 0 trail, 1 spotlights, 2 scan band, 3 fast trail, -1 none. */
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

export function createSphere(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const rings = Math.round(Math.max(6, Math.min(16, px / 3.2)));
  const perRing = Math.round(Math.max(8, Math.min(30, px / 1.6)));
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
  const weights = [0, 0, 0, 0];
  let light = 1;
  /** The run ended in an error: the closing sweep is red, and the globe stops turning. */
  let failed = false;
  let time = 0;
  let turn = 0;
  // Eased toward `goal` every tick; `sweep` runs at its own steady pace.
  const now = { k: 0, spin: 0.9, gain: 1, sweep: 0, alpha: 1, warn: 0 };
  const goal = { ...now, k: 1 };

  function setActivity(activity: ThinkingActivity | undefined) {
    const done = ended(activity);
    failed = !!activity?.failed;
    const stopping = !!activity?.stopping;
    const quiet = !!activity?.quiet && !done && !stopping;
    light = done || stopping || quiet ? -1 : LIGHT[activity?.phase ?? "work"];
    goal.k = stopping ? 0 : 1;
    goal.spin = quiet ? 0.18 : failed ? 0.04 : done ? 0.3 : 0.9;
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
    turn += now.spin * dt;
    for (let j = 0; j < 4; j++) {
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
    const cr = Math.cos(turn);
    const sr = Math.sin(turn);
    const ct = Math.cos(0.35);
    const st = Math.sin(0.35);
    const c = px / 2;
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
      const g = Math.max(glow[i] * decay, lit * now.gain);
      glow[i] = g;
      const shown = clamp01(now.k * 1.6 - 0.6 * q.u);
      if (shown <= 0.001) continue;
      const e = 1 - Math.pow(1 - shown, 3);
      const mx = q.x * cr + q.z * sr;
      const mz = -q.x * sr + q.z * cr;
      const my = q.y * ct - mz * st;
      const depth = q.y * st + mz * ct;
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
      fills.push([depth, c + mx * R * e * persp, c - my * R * e * persp, size, alpha, rgb(color)]);
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
    tick(dt) {
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
      draw(0);
    },
  };
}
