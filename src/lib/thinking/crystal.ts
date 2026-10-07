import type { RunPhase, ThinkingActivity } from "./activity";
import { aiCycle, clamp01, easeIn, easeOut, finishClock, makeBurst, rgba, TAU } from "./finish";
import { mix, palette } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Cristal" — an icosahedron in wireframe, tumbling slowly with a soft core of light inside and
 * energy running along its edges while the run works. Back edges fade, so it reads as a solid in
 * space, never as a ring.
 *
 * How fast it turns and how much energy runs through it is the phase. Finish: the spin races (the
 * wind-up), it bursts into sparks, pulls itself back together in green, and its corners catch the
 * light one after another.
 */

const GOAL: Partial<Record<RunPhase, [spin: number, energy: number]>> = {
  start: [0.6, 0.2],
  think: [0.8, 0.6],
  plan: [0.8, 0.6],
  read: [1, 0.5],
  search: [1, 0.5],
  edit: [1.5, 1],
  run: [1.5, 1],
  write: [1.2, 0.8],
};

const PHI = (1 + Math.sqrt(5)) / 2;
const RAW: readonly [number, number, number][] = [
  [-1, PHI, 0],
  [1, PHI, 0],
  [-1, -PHI, 0],
  [1, -PHI, 0],
  [0, -1, PHI],
  [0, 1, PHI],
  [0, -1, -PHI],
  [0, 1, -PHI],
  [PHI, 0, -1],
  [PHI, 0, 1],
  [-PHI, 0, -1],
  [-PHI, 0, 1],
];
const NORM = Math.hypot(1, PHI);
const VERTS = RAW.map(([x, y, z]) => [x / NORM, y / NORM, z / NORM] as const);
/** The 30 edges: every pair of vertices at the icosahedron's edge length (2 before normalising). */
const EDGES: [number, number][] = [];
for (let i = 0; i < 12; i++) {
  for (let j = i + 1; j < 12; j++) {
    const d = Math.hypot(RAW[i][0] - RAW[j][0], RAW[i][1] - RAW[j][1], RAW[i][2] - RAW[j][2]);
    if (Math.abs(d - 2) < 0.01) EDGES.push([i, j]);
  }
}

export function createCrystal(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const sparks = makeBurst(14, 5);
  const pulses: { edge: number; at: number; hue: number }[] = [];
  let time = 0;
  let tiltX = 0.4;
  let turnY = 0;
  let spin = 1;
  let energy = 0.5;
  let warn = 0;
  let alpha = 1;

  function goal(activity: ThinkingActivity | undefined): [number, number] {
    if (activity?.done) return [0.35, 0];
    if (activity?.stopping) return [0.2, 0];
    if (activity?.quiet) return [0.15, 0.1];
    return GOAL[activity?.phase ?? "think"] ?? [0.8, 0.6];
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    const fin = clock.fin;
    ctx.clearRect(0, 0, px, px);
    const c = px / 2;
    const burst = fin >= 0.35 && fin < 1.05 ? Math.sin(((fin - 0.35) / 0.7) * Math.PI) : 0;
    const green = fin >= 0 ? clamp01((fin - 0.3) / 0.45) : 0;
    const R = px * 0.4 * (1 + burst * 0.5) * (fin >= 0 ? 0.92 : 1);
    const cx = Math.cos(tiltX);
    const sx = Math.sin(tiltX);
    const cy = Math.cos(turnY);
    const sy = Math.sin(turnY);
    const pts = VERTS.map(([x, y, z]) => {
      const x1 = x * cy + z * sy;
      const z1 = -x * sy + z * cy;
      const y2 = y * cx - z1 * sx;
      const z2 = y * sx + z1 * cx;
      const persp = 3 / (3 - z2);
      return [c + x1 * R * persp, c - y2 * R * persp, (z2 + 1) / 2] as const;
    });
    // The core: light inside the glass.
    const core = ctx.createRadialGradient(c, c, 0, c, c, px * 0.36);
    const coreHue = mix(aiCycle(p, 0.35 + Math.sin(time * 0.7) * 0.2), p.success, green);
    core.addColorStop(0, rgba(coreHue, (0.35 + energy * 0.25 + burst * 0.5) * alpha));
    core.addColorStop(1, rgba(coreHue, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(c, c, px * 0.36, 0, TAU);
    ctx.fill();
    ctx.lineCap = "round";
    const lw = Math.max(0.7, px / 36);
    const edgeAlpha = 1 - burst * 0.85;
    const sorted = EDGES.map(([i, j], n) => [i, j, n, (pts[i][2] + pts[j][2]) / 2] as const).sort((a, b) => a[3] - b[3]);
    for (const [i, j, n, depth] of sorted) {
      let col = mix(p.text, aiCycle(p, n / EDGES.length + time * 0.05), 0.55);
      col = mix(col, p.success, green);
      col = mix(col, p.warning, warn * 0.3);
      ctx.strokeStyle = rgba(col, (0.12 + 0.6 * depth) * alpha * edgeAlpha);
      ctx.lineWidth = lw * (0.6 + 0.6 * depth);
      ctx.beginPath();
      ctx.moveTo(pts[i][0], pts[i][1]);
      ctx.lineTo(pts[j][0], pts[j][1]);
      ctx.stroke();
    }
    for (const pulse of pulses) {
      const [i, j] = EDGES[pulse.edge];
      const k = pulse.at;
      const x = pts[i][0] + (pts[j][0] - pts[i][0]) * k;
      const y = pts[i][1] + (pts[j][1] - pts[i][1]) * k;
      const depth = pts[i][2] + (pts[j][2] - pts[i][2]) * k;
      ctx.fillStyle = rgba(aiCycle(p, pulse.hue), (0.4 + 0.6 * depth) * alpha);
      ctx.beginPath();
      ctx.arc(x, y, lw * 1.6, 0, TAU);
      ctx.fill();
    }
    // The glint once it is whole again: its corners catch the light one after another.
    const white: readonly [number, number, number] = [255, 255, 255];
    pts.forEach(([x, y, depth], i) => {
      const glow = 0.5 + 0.5 * Math.sin(time * 3 + i * 1.7);
      let col = mix(p.text, aiCycle(p, i / 12 + time * 0.08), 0.5 + 0.5 * glow * energy);
      col = mix(col, p.success, green);
      col = mix(col, p.warning, warn * 0.3);
      const shine = fin > 1.0 && fin < 1.7 ? Math.max(0, Math.sin(((fin - 1.0) / 0.7) * Math.PI * 1.5 - i * 0.35)) : 0;
      col = mix(col, white, shine);
      ctx.fillStyle = rgba(col, (0.25 + 0.75 * depth) * alpha);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.7, px / 30) * (0.6 + 0.7 * depth) * (1 + shine * 0.8), 0, TAU);
      ctx.fill();
    });
    if (fin > 0.35 && fin < 1.4) {
      const s = fin - 0.35;
      for (const spark of sparks) {
        const dist = easeOut(s / 0.8) * px * 0.48 * spark.speed;
        const x = c + Math.cos(spark.angle) * dist;
        const y = c + Math.sin(spark.angle) * dist + s * s * px * 0.25;
        ctx.fillStyle = rgba(spark.kind === 0 ? p.success : aiCycle(p, spark.hue), (1 - s / 1.05) * alpha);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.6, px * 0.03), 0, TAU);
        ctx.fill();
      }
    }
  }

  return {
    setActivity(activity) {
      clock.set(activity);
    },
    tick(dt) {
      clock.step(dt);
      const act = clock.act;
      const fin = clock.fin;
      const [s, e] = goal(act);
      const k = Math.min(1, dt * 2.5);
      spin += (s - spin) * k;
      energy += (e - energy) * k;
      warn += ((act?.quiet ? 1 : 0) - warn) * Math.min(1, dt * 3);
      alpha += ((act?.stopping ? 0.35 : act?.quiet ? 0.6 : 1) - alpha) * Math.min(1, dt * 3);
      // The wind-up before the burst: the spin races, then lets go.
      const boost = fin >= 0 ? (fin < 0.35 ? easeIn(fin / 0.35) * 9 : Math.max(0, 9 * (1 - (fin - 0.35) / 0.6))) : 0;
      time += dt;
      turnY += dt * (0.7 * spin + boost);
      tiltX = 0.4 + Math.sin(time * 0.35) * 0.35;
      for (let i = pulses.length - 1; i >= 0; i--) {
        pulses[i].at += dt * 1.8 * spin;
        if (pulses[i].at >= 1) pulses.splice(i, 1);
      }
      if (pulses.length < Math.round(energy * 4) && Math.random() < dt * 6) {
        pulses.push({ edge: Math.floor(Math.random() * EDGES.length), at: 0, hue: Math.random() });
      }
      paint();
    },
    still() {
      const act = clock.act;
      energy = goal(act)[1];
      warn = act?.quiet ? 1 : 0;
      alpha = act?.stopping ? 0.35 : act?.quiet ? 0.6 : 1;
      clock.settle();
      if (time === 0) {
        time = 1;
        turnY = 0.6;
      }
      paint();
    },
  };
}
