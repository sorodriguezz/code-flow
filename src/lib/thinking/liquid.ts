import type { RunPhase, ThinkingActivity } from "./activity";
import { aiCycle, clamp01, drawCheck, easeOut, finishClock, makeBurst, rgba, TAU } from "./finish";
import { mix, palette } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Líquido" — four drops of mercury in the assistant's hues, merging and pulling apart (metaballs).
 *
 * How far apart they roam and how fast is the phase: close and slow while starting, wide while
 * thinking, wider and quicker while editing, quickest while the answer is written; a quiet run lets
 * them sink into one. Finish: they flow into a single drop, it lands with a squash and a splash of
 * droplets, turns green, and a tick draws itself inside it.
 *
 * The field is evaluated per pixel at the canvas's own resolution (an upscaled field reads as a
 * blur, not a drop) — at the 44px it is used at most, 88² pixels for four drops.
 */

const GOAL: Partial<Record<RunPhase, [spread: number, speed: number]>> = {
  start: [0.45, 0.8],
  think: [1.15, 1],
  plan: [1.15, 1],
  read: [0.95, 1.4],
  search: [0.95, 1.4],
  edit: [1.3, 1.7],
  run: [1.3, 1.7],
  write: [1.2, 2.3],
};

const BALLS = [
  { ax: 0.34, ay: 0.26, fx: 0.9, fy: 1.3, ph: 0, r: 0.3 },
  { ax: 0.3, ay: 0.34, fx: 1.4, fy: 0.8, ph: 2.1, r: 0.25 },
  { ax: 0.36, ay: 0.24, fx: 0.7, fy: 1.1, ph: 4.2, r: 0.22 },
  { ax: 0.22, ay: 0.3, fx: 1.7, fy: 1.5, ph: 1.1, r: 0.18 },
];

export function createLiquid(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const res = Math.max(28, Math.min(160, canvas.width));
  const off = document.createElement("canvas");
  off.width = off.height = res;
  const octx = off.getContext("2d");
  const img = octx?.createImageData(res, res) ?? null;
  const clock = finishClock();
  const drops = makeBurst(7, 11);
  let time = 0;
  let spread = 0.6;
  let speed = 1;
  let warn = 0;
  let alpha = 1;

  function goal(activity: ThinkingActivity | undefined): [number, number] {
    if (activity?.stopping) return [0.15, 0.3];
    if (activity?.quiet) return [0.22, 0.3];
    return GOAL[activity?.phase ?? "think"] ?? [1.15, 1];
  }

  function paint() {
    if (!ctx || !octx || !img) return;
    const p = palette();
    const data = img.data;
    const fin = clock.fin;
    const merge = fin >= 0 ? easeOut(fin / 0.35) : 0;
    const green = fin >= 0 ? clamp01((fin - 0.15) / 0.4) : 0;
    const sp = spread * (1 - merge);
    const pos = BALLS.map((b) => [
      Math.sin(time * b.fx + b.ph) * b.ax * sp,
      Math.cos(time * b.fy + b.ph) * b.ay * sp,
      b.r * (1 - 0.15 * (1 - Math.min(1, spread))) * (1 - merge * 0.12),
    ]);
    const white: readonly [number, number, number] = [255, 255, 255];
    for (let j = 0; j < res; j++) {
      const y = ((j + 0.5) / res) * 2 - 1;
      for (let i = 0; i < res; i++) {
        const x = ((i + 0.5) / res) * 2 - 1;
        let f = 0;
        for (const [bx, by, r] of pos) {
          const dx = x - bx;
          const dy = y - by;
          f += (r * r) / (dx * dx + dy * dy + 1e-4);
        }
        const k = (j * res + i) * 4;
        const edge = clamp01((f - 0.9) / 0.22);
        if (edge <= 0) {
          data[k + 3] = 0;
          continue;
        }
        let col = aiCycle(p, 0.5 + x * 0.32 + y * 0.42 + Math.sin(time * 0.5) * 0.15);
        col = mix(col, p.success, green);
        // Lit from the top left, a rim of shade at the bottom right: a drop, not a sticker.
        const light = clamp01(0.5 - (x + y) * 0.45);
        col = mix(col, white, light * light * 0.55 * clamp01((f - 1) * 1.5));
        col = mix(col, p.warning, warn * 0.3);
        data[k] = col[0];
        data[k + 1] = col[1];
        data[k + 2] = col[2];
        data[k + 3] = edge * 255 * alpha;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, px, px);
    const c = px / 2;
    // The landing: a damped squash and stretch, anchored at the drop's foot.
    let sx = 1;
    let sy = 1;
    if (fin > 0.3 && fin < 1.1) {
      const s = fin - 0.3;
      const q = Math.sin((s / 0.55) * TAU) * Math.exp(-s * 5) * 0.28;
      sy = 1 - q;
      sx = 1 + q * 0.8;
    }
    ctx.save();
    ctx.translate(c, px * 0.82);
    ctx.scale(sx, sy);
    ctx.translate(-c, -px * 0.82);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, px, px);
    ctx.restore();
    if (fin > 0.3 && fin < 1.25) {
      const s = fin - 0.3;
      for (const d of drops) {
        const angle = -Math.PI / 2 + Math.cos(d.angle) * 1.1;
        const dist = s * px * 0.55 * d.speed;
        const x = c + Math.cos(angle) * dist;
        const y = c + px * 0.1 + Math.sin(angle) * dist + s * s * px * 1.4;
        ctx.fillStyle = rgba(mix(aiCycle(p, d.hue), p.success, green), (1 - s / 0.95) * alpha);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.8, px * 0.055 * (1 - s * 0.7)), 0, TAU);
        ctx.fill();
      }
    }
    if (fin > 0.7) drawCheck(ctx, c, c, px * 0.36, (fin - 0.7) / 0.35, "rgba(255,255,255,0.95)", Math.max(1.2, px * 0.075));
  }

  return {
    setActivity(activity) {
      clock.set(activity);
    },
    tick(dt) {
      clock.step(dt);
      const act = clock.act;
      const [s, v] = goal(act);
      const k = Math.min(1, dt * 2.5);
      spread += (s - spread) * k;
      speed += (v - speed) * k;
      warn += ((act?.quiet ? 1 : 0) - warn) * Math.min(1, dt * 3);
      alpha += ((act?.stopping ? 0.35 : act?.quiet ? 0.6 : 1) - alpha) * Math.min(1, dt * 3);
      time += dt * speed;
      paint();
    },
    still() {
      const act = clock.act;
      spread = goal(act)[0];
      warn = act?.quiet ? 1 : 0;
      alpha = act?.stopping ? 0.35 : act?.quiet ? 0.6 : 1;
      clock.settle();
      if (time === 0) time = 1.7;
      paint();
    },
  };
}
