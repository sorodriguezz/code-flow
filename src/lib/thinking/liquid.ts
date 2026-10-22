import { ended, type RunPhase, type ThinkingActivity } from "./activity";
import { askBreath, cueClock, softHalo, startle } from "./cue";
import type { Gaze } from "./face";
import { listenLevel } from "./listen";
import { easeToward, leanOf, toward } from "./pointer";
import { aiCycle, clamp01, easeOut, endColor, finishClock, makeBurst, rgba, TAU } from "./finish";
import { aiHue, mix, palette } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Líquido" — four drops of mercury in the assistant's hues, merging and pulling apart (metaballs).
 *
 * How far apart they roam and how fast is the phase: close and slow while starting, wide while
 * thinking, wider and quicker while editing, quickest while the answer is written; a quiet run lets
 * them sink into one. Finish: they flow into a single drop, it lands with a squash and a splash of
 * droplets, and turns green. Green and nothing else: the white tick that used to draw itself
 * inside it was taken out at the user's ask (2026-10-08) — the colour already says "done". Failed,
 * the drop turns red and sags into a puddle, one drip falling from it.
 *
 * Listening (Codi), the drops gather in and slow, and every syllable it hears pulls them together
 * into the middle — writing flings them wide. Codi's cues: woken, they jump apart for an instant and
 * catch the light; asking, they breathe slowly as one, in a soft halo.
 *
 * The field is evaluated per pixel at the canvas's own resolution (an upscaled field reads as a
 * blur, not a drop) — 88² pixels for four drops at 44px, the largest gutter size. Codi's window is
 * capped at 256², a little upscaled: its soft edge hides that, and 360² would cost a frame's budget.
 *
 * Following the pointer (`ThinkingOrb follow`), the drops are drawn to it like mercury to a magnet:
 * each pulled its way, the smallest furthest, so the body stretches out toward it in a tongue — and
 * the light on them comes from its side instead of the top left.
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
  listen: [0.75, 0.7],
};

const BALLS = [
  { ax: 0.34, ay: 0.26, fx: 0.9, fy: 1.3, ph: 0, r: 0.3 },
  { ax: 0.3, ay: 0.34, fx: 1.4, fy: 0.8, ph: 2.1, r: 0.25 },
  { ax: 0.36, ay: 0.24, fx: 0.7, fy: 1.1, ph: 4.2, r: 0.22 },
  { ax: 0.22, ay: 0.3, fx: 1.7, fy: 1.5, ph: 1.1, r: 0.18 },
];
/** How far each drop is pulled toward the pointer, in the -1..1 square: the small ones lead. */
const PULL = [0.12, 0.2, 0.3, 0.42];

export function createLiquid(canvas: HTMLCanvasElement, px: number, gain = 1): Painter {
  const ctx = prepareCanvas(canvas, px);
  const res = Math.max(28, Math.min(256, canvas.width));
  const off = document.createElement("canvas");
  off.width = off.height = res;
  const octx = off.getContext("2d");
  const img = octx?.createImageData(res, res) ?? null;
  const clock = finishClock();
  const cue = cueClock();
  const drops = makeBurst(7, 11);
  /** What it hears this frame while it listens, as far as Codi's gain takes it — eased, so the drops
   *  flow together rather than jump. */
  let pull = 0;
  let time = 0;
  let spread = 0.6;
  let speed = 1;
  let warn = 0;
  let alpha = 1;
  let gaze: Gaze = null;
  const look = toward();

  const listening = (act: ThinkingActivity | undefined) =>
    !ended(act) && !act?.quiet && !act?.stopping && act?.phase === "listen";

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
    const failed = clock.failed;
    const merge = fin >= 0 ? easeOut(fin / 0.35) : 0;
    const green = fin >= 0 ? clamp01((fin - (failed ? 0 : 0.15)) / 0.4) : 0;
    const end = endColor(p, failed);
    // Listening, pulled together by what it hears; woken, jumping apart; asking, one slow breath.
    const start = startle(cue.wake);
    const breath = askBreath(time);
    const sp = spread * (1 - merge) * (1 - 0.5 * Math.min(1, pull)) * (1 + 0.3 * start);
    const swell = 1 + 0.06 * cue.ask * (breath - 0.5);
    const pullX = look.x * look.on;
    const pullY = look.y * look.on;
    const pos = BALLS.map((b, n) => [
      Math.sin(time * b.fx + b.ph) * b.ax * sp + pullX * PULL[n],
      Math.cos(time * b.fy + b.ph) * b.ay * sp + pullY * PULL[n],
      b.r * (1 - 0.15 * (1 - Math.min(1, spread))) * (1 - merge * 0.12) * swell,
    ]);
    // Where the light comes from: the top left, swung round to the pointer's side as it follows —
    // as far as it leans, so a pointer right on top (no side to come from) leaves it where it was.
    const reach = Math.hypot(pullX, pullY);
    const swing = Math.min(1, leanOf(look) * 3);
    const lightX = -0.45 + (reach > 1e-3 ? (pullX / reach) * 0.64 + 0.45 : 0) * swing;
    const lightY = -0.45 + (reach > 1e-3 ? (pullY / reach) * 0.64 + 0.45 : 0) * swing;
    // Nothing in the per-pixel loop allocates — at Codi's size it runs 65 thousand times a frame.
    // The colour mixes are `aiHue()` and `mix()` written out a channel at a time, the same arithmetic
    // in the same order, amounts clamped as `mix()` clamps them.
    const drift = Math.sin(time * 0.5) * 0.15;
    const toEnd = clamp01(green);
    const toWarm = clamp01(warn * 0.3);
    for (let j = 0; j < res; j++) {
      const y = ((j + 0.5) / res) * 2 - 1;
      for (let i = 0; i < res; i++) {
        const x = ((i + 0.5) / res) * 2 - 1;
        let f = 0;
        for (let n = 0; n < pos.length; n++) {
          const ball = pos[n];
          const dx = x - ball[0];
          const dy = y - ball[1];
          f += (ball[2] * ball[2]) / (dx * dx + dy * dy + 1e-4);
        }
        const k = (j * res + i) * 4;
        const edge = clamp01((f - 0.9) / 0.22);
        if (edge <= 0) {
          data[k + 3] = 0;
          continue;
        }
        // Along the ramp, never round it: wrapped, the far top left turned from cyan back to violet
        // in one hard edge — rarely reached until the drops could be pulled up there.
        const at = clamp01(0.5 + x * 0.32 + y * 0.42 + drift);
        const lo = at < 0.5 ? p.a : p.b;
        const hi = at < 0.5 ? p.b : p.c;
        const along = clamp01(at < 0.5 ? at * 2 : (at - 0.5) * 2);
        // Lit from the top left, a rim of shade at the bottom right: a drop, not a sticker.
        const light = clamp01(0.5 + x * lightX + y * lightY);
        const toWhite = clamp01(Math.min(1, light * light * 0.55 * clamp01((f - 1) * 1.5) + 0.3 * start));
        for (let c = 0; c < 3; c++) {
          let v = lo[c] + (hi[c] - lo[c]) * along;
          v = v + (end[c] - v) * toEnd;
          v = v + (255 - v) * toWhite;
          data[k + c] = v + (p.warning[c] - v) * toWarm;
        }
        data[k + 3] = edge * 255 * alpha;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, px, px);
    if (cue.ask > 0.01) softHalo(ctx, px / 2, px / 2, px * 0.36, aiHue(p, 0.5), 0.22 * cue.ask * (0.6 + 0.4 * breath) * alpha);
    const c = px / 2;
    // The landing: a damped squash and stretch, anchored at the drop's foot.
    let sx = 1;
    let sy = 1;
    if (failed && fin > 0.25) {
      // The sag: lower and wider, and it stays that way.
      const k = easeOut((fin - 0.25) / 0.6);
      sy = 1 - 0.28 * k;
      sx = 1 + 0.16 * k;
    } else if (!failed && fin > 0.3 && fin < 1.1) {
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
    if (failed && fin > 0.35 && fin < 1.2) {
      const s = fin - 0.35;
      ctx.fillStyle = rgba(end, (1 - s / 0.85) * alpha);
      ctx.beginPath();
      ctx.arc(c, px * 0.8 + s * s * px * 1.2, Math.max(0.8, px * 0.05), 0, TAU);
      ctx.fill();
    }
    if (!failed && fin > 0.3 && fin < 1.25) {
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
  }

  return {
    setActivity(activity) {
      clock.set(activity);
      cue.set(activity);
    },
    setGaze(next) {
      gaze = next;
    },
    tick(dt) {
      clock.step(dt);
      cue.step(dt);
      const act = clock.act;
      const heard = listening(act) ? listenLevel() * gain : 0;
      pull += (heard - pull) * Math.min(1, dt * 12);
      easeToward(look, ended(act) || act?.quiet || act?.stopping ? null : gaze, dt, 4);
      const [s, v] = goal(act);
      const k = Math.min(1, dt * 2.5);
      spread += (s - spread) * k;
      speed += (v - speed) * k;
      warn += ((act?.quiet ? 1 : 0) - warn) * Math.min(1, dt * 3);
      alpha += ((act?.stopping ? 0.35 : act?.quiet ? 0.6 : 1) - alpha) * Math.min(1, dt * 3);
      // Asking, they slow to a breath.
      time += dt * speed * (1 - 0.6 * cue.ask);
      paint();
    },
    still() {
      const act = clock.act;
      spread = goal(act)[0];
      cue.settle();
      // A still frame of listening is mid-word, the drops drawn together.
      pull = listening(act) ? 0.7 * gain : 0;
      warn = act?.quiet ? 1 : 0;
      alpha = act?.stopping ? 0.35 : act?.quiet ? 0.6 : 1;
      clock.settle();
      if (time === 0) time = 1.7;
      paint();
    },
  };
}
