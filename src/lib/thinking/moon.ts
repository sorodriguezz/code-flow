import { ended, type ThinkingActivity } from "./activity";
import { askBreath, cueClock, softHalo, startle } from "./cue";
import { INK, WHITE, type Gaze } from "./face";
import { clamp01, easeOut, endColor, finishClock, makeBurst, rgba, TAU } from "./finish";
import { listenLevel } from "./listen";
import { mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";
import { easeToward, toward } from "./pointer";

/**
 * "Luna" — the moon, glowing in the assistant's hues, going through its phases. It took the Panda's
 * place on 2026-10-08 (a stored `panda` reads as this one — see `storedThinkingDesign`).
 *
 * The phase of the run is the phase of the moon: thinking, it waxes and wanes; working, it does so
 * fast; reading, it holds a half while its craters turn past; writing, its glow throbs. Starting, it
 * rises; quiet, it thins to a dim crescent. It never goes full while it runs — the full moon is the
 * finish's, so it can say "done" on its own.
 *
 * Finish: the shadow slides off, it shines full and green, and stars burst from it. Failed: an
 * eclipse — the shadow covers it and it turns a red blood moon.
 *
 * The shadow is a second disc slid across the first and clipped to it — the crescent every moon icon
 * draws — so one number (`lit`) is the whole phase. Below 20px the craters and stars go.
 *
 * Following the pointer (`ThinkingOrb follow`), it turns toward it: the disc drifts its way, the
 * craters roll round to face it, its light gathers on that side and the stars slip the other way,
 * behind it. The shadow never moves for it — how much of the moon is lit is the run's phase.
 *
 * Listening (Codi), it holds a steady gibbous, three quarters lit, and draws everything in with each
 * syllable it hears: rings of light close on its rim from outside and the stars are pulled toward
 * it. Codi's cues: woken, it flares bright, the stars all flashing, and pops for an instant; asking,
 * it glows softly in and out inside a halo, turning hardly at all.
 */

/** Craters: [x, y, r] on a moon of radius 1, drifting across it as it turns. */
const CRATERS: readonly [number, number, number][] = [
  [-0.35, -0.3, 0.2],
  [0.3, 0.15, 0.26],
  [-0.15, 0.45, 0.14],
  [0.48, -0.42, 0.12],
  [-0.6, 0.15, 0.11],
];

/** The `lit` at which the shadow sits square over the disc. */
const ECLIPSE = -0.06;

/** Small stars round the moon: [x, y] in the square, twinkling out of step. */
const STARS: readonly [number, number][] = [
  [0.12, 0.2],
  [0.88, 0.14],
  [0.9, 0.78],
  [0.1, 0.84],
];

export function createMoon(canvas: HTMLCanvasElement, px: number, gain = 1): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const cue = cueClock();
  /** The microphone's level this frame while it listens, as far as Codi's gain takes it. */
  let pull = 0;
  const burst = makeBurst(10, 61);
  const detail = px >= 20;
  const u = (v: number) => v * px;
  let time = 0;
  /** 0 a thin crescent, 0.5 a half, 1 full; at `ECLIPSE` the shadow covers it. */
  let lit = 0.6;
  let turn = 0;
  let rise = 0;
  let warn = 0;
  let alpha = 1;
  let twinkle = 0;
  let gaze: Gaze = null;
  const look = toward();

  const awake = (act: ThinkingActivity | undefined) => !ended(act) && !act?.quiet && !act?.stopping;

  function litGoal(act: ThinkingActivity | undefined): number {
    if (act?.quiet) return 0.08;
    if (act?.stopping) return 0.2;
    switch (act?.phase) {
      case "read":
      case "search":
        return 0.5;
      case "edit":
      case "run":
      case "tool":
        return 0.35 + 0.3 * Math.sin(time * 2.6);
      case "write":
        return 0.55;
      case "listen":
        return 0.72;
      default:
        return 0.35 + 0.3 * Math.sin(time * 0.9);
    }
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    const act = clock.act;
    const fin = clock.fin;
    const failed = clock.failed;
    ctx.clearRect(0, 0, px, px);

    // The finish decides the phase itself: the shadow slides off (or, failing, over).
    let phase = lit;
    if (fin >= 0) {
      const k = easeOut(fin / 0.4);
      phase = failed ? lit + (ECLIPSE - lit) * k : lit + (1.05 - lit) * k;
    }
    const tint = fin >= 0 ? clamp01((fin - (failed ? 0.15 : 0.25)) / 0.4) : 0;
    const end = endColor(p, failed);
    const warmed = (c: Rgb) => mix(c, p.warning, warn * 0.3);
    const writing = awake(act) && act?.phase === "write";
    const throb = writing ? 0.5 + 0.5 * Math.abs(Math.sin(time * 6)) : 0;
    const flare = !failed && fin > 0.3 && fin < 1 ? Math.sin(((fin - 0.3) / 0.7) * Math.PI) : 0;

    // Listening, drawn in by what it hears; woken, a flare and a pop; asking, a slow glow.
    const drawn = Math.min(1.4, pull);
    const start = startle(cue.wake);
    const breath = askBreath(time);
    // Bigger where there are no stars to leave room for.
    const R = u(detail ? 0.34 : 0.42) * (1 + 0.05 * start) * (1 + 0.03 * cue.ask * (breath - 0.5));
    // Turned toward the pointer: `tx`, `ty` -1..1, nothing at rest.
    const tx = look.x * look.on;
    const ty = look.y * look.on;
    const cx = u(0.5) + tx * R * 0.12;
    const cy = u(0.5 + (1 - easeOut(rise)) * 0.18) + ty * R * 0.12;
    const a = alpha * (0.3 + 0.7 * easeOut(rise));

    if (cue.ask > 0.01) softHalo(ctx, cx, cy, R, mix(p.a, p.c, 0.4), 0.25 * cue.ask * (0.55 + 0.45 * breath) * a);

    // Stars, twinkling round it — pulled toward it by what it hears, all flashing when it wakes.
    if (detail) {
      const toward = 0.3 * Math.min(1, drawn);
      STARS.forEach(([x, y], i) => {
        const tw = Math.max(0.5 + 0.5 * Math.sin(twinkle + i * 1.9), start);
        ctx.fillStyle = rgba(warmed(mix(mix(p.c, WHITE, 0.4), end, tint)), (0.25 + 0.6 * tw) * a);
        ctx.beginPath();
        const sx = x - tx * 0.035;
        const sy = y - ty * 0.035;
        ctx.arc(u(sx + (0.5 - sx) * toward), u(sy + (0.5 - sy) * toward), Math.max(0.6, u(0.016 + 0.014 * tw)), 0, TAU);
        ctx.fill();
      });
    }

    // The disc, lit, with its glow.
    const bright: Rgb = warmed(mix(mix(WHITE, p.c, 0.22), mix(end, WHITE, 0.45), tint));
    const rim: Rgb = warmed(mix(mix(p.a, WHITE, 0.2), end, tint));
    // Its light: from the top left, swung toward the pointer as it follows.
    const hx = -0.35 + (tx * 0.5 + 0.35) * look.on;
    const hy = -0.35 + (ty * 0.5 + 0.35) * look.on;
    const grad = ctx.createRadialGradient(cx + R * hx, cy + R * hy, R * 0.1, cx, cy, R);
    grad.addColorStop(0, rgba(bright, a));
    grad.addColorStop(1, rgba(rim, a));
    ctx.save();
    ctx.shadowColor = rgba(mix(p.a, end, tint), (p.dark ? 0.6 : 0.4) * a);
    ctx.shadowBlur = u(0.12 + 0.08 * throb + 0.12 * Math.max(flare, start) + 0.08 * cue.ask * breath);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.clip();

    // Craters, drifting across as it turns.
    if (detail) {
      ctx.fillStyle = rgba(warmed(mix(rim, INK, 0.12)), 0.35 * a);
      for (const [x, y, r] of CRATERS) {
        let ox = x + turn + tx * 0.35;
        ox = ((((ox + 1.3) % 2.6) + 2.6) % 2.6) - 1.3;
        ctx.beginPath();
        ctx.arc(cx + ox * R, cy + (y + ty * 0.3) * R, r * R, 0, TAU);
        ctx.fill();
      }
    }

    // The shadow: a disc slid in from the left, covering all but the lit part — a sliver at 0, half
    // at 0.5, none at 1, and all of it at `ECLIPSE`.
    const offset = -R * (0.12 + 2 * phase);
    if (offset > -2.1 * R) {
      // Dark, but not black: the night side stays faintly there, the way earthshine leaves it.
      const night: Rgb = mix(mix(p.b, INK, 0.84), mix(p.danger, INK, 0.3), failed ? tint : 0);
      ctx.fillStyle = rgba(night, 0.93 * a);
      ctx.beginPath();
      ctx.arc(cx + offset, cy, R * 1.04, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Listening: rings of light closing on its rim from outside, fading as they land.
    if (drawn > 0.01) {
      ctx.strokeStyle = rgba(warmed(mix(mix(p.c, WHITE, 0.4), p.a, 0.15)), 1);
      ctx.lineWidth = Math.max(0.8, u(0.02));
      const out = Math.min(R * 1.42, u(0.47) - Math.hypot(cx - u(0.5), cy - u(0.5)));
      for (const offset of [0, 0.5]) {
        const k = (time * 0.9 + offset) % 1;
        ctx.globalAlpha = Math.sin(k * Math.PI) * 0.6 * Math.min(1, drawn) * a;
        ctx.beginPath();
        ctx.arc(cx, cy, out - (out - R * 1.04) * k, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // A blood moon keeps a red rim of light round the eclipse.
    if (failed && tint > 0) {
      ctx.strokeStyle = rgba(end, 0.7 * tint * a);
      ctx.lineWidth = Math.max(0.8, u(0.025));
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
    }

    // Stars thrown out by the full moon.
    if (!failed && fin > 0.4 && fin < 1.45) {
      const s = fin - 0.4;
      for (const b of burst) {
        const dist = easeOut(s / 0.8) * u(0.48) * (0.75 + b.speed * 0.3);
        const x = cx + Math.cos(b.angle) * dist;
        const y = cy + Math.sin(b.angle) * dist;
        ctx.fillStyle = rgba(b.kind === 0 ? p.success : mix(p.c, WHITE, 0.5), (1 - s / 1.05) * alpha);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.6, u(0.028) * (1 - s * 0.5)), 0, TAU);
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
      pull = awake(act) && act?.phase === "listen" ? listenLevel() * gain : 0;
      easeToward(look, awake(act) ? gaze : null, dt, 4);
      time += dt * (act?.quiet && !ended(act) ? 0.4 : 1);
      rise = Math.min(1, rise + dt * 1.4);
      if (!ended(act)) lit += (litGoal(act) - lit) * Math.min(1, dt * 3);
      const reading = awake(act) && (act?.phase === "read" || act?.phase === "search");
      turn += dt * (reading ? 0.35 : 0.05) * (1 - 0.7 * cue.ask);
      const working = awake(act) && (act?.phase === "edit" || act?.phase === "run" || act?.phase === "tool");
      twinkle += dt * (working ? 9 : 2.5);
      const resting = act?.quiet && !ended(act) ? 1 : 0;
      warn += (resting - warn) * Math.min(1, dt * 3);
      alpha += ((act?.stopping ? 0.35 : resting ? 0.55 : 1) - alpha) * Math.min(1, dt * 3);
      paint();
    },
    still() {
      const act = clock.act;
      if (time === 0) time = 1.4;
      cue.settle();
      // A still frame of listening is mid-word: a ring on its way in, the stars drawn close.
      pull = awake(act) && act?.phase === "listen" ? 0.7 * gain : 0;
      rise = 1;
      if (!ended(act)) lit = litGoal(act);
      const resting = act?.quiet && !ended(act) ? 1 : 0;
      warn = resting;
      alpha = act?.stopping ? 0.35 : resting ? 0.55 : 1;
      clock.settle();
      paint();
    },
  };
}
