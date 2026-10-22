import { ended, type ThinkingActivity } from "./activity";
import { askBeat, askBlink, cueClock, hop, startle } from "./cue";
import { blink, INK, lookFor, sleepZ, soundIn, strokeEye, WHITE, type Gaze } from "./face";
import { listenLevel } from "./listen";
import { clamp01, easeOut, endColor, finishClock, makeBurst, rgba, TAU } from "./finish";
import { mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Fantasma" — a little ghost, pale and lit from inside by the assistant's hues, floating.
 *
 * It bobs and sways while it thinks, its eyes wandering; reading, its eyes run along the lines;
 * working, it darts from side to side, its hem rippling fast; writing, it says "boo" — a round mouth
 * opening and closing. Quiet, it fades to see-through and dozes. Listening (Codi), it floats up and
 * holds still, drawn up tall with its hem barely stirring, its eyes wide on whoever speaks and no
 * "boo"; what it hears comes in as arcs closing on it from both sides, and it glows a little with
 * every syllable.
 *
 * Codi's cues: woken, it jumps — stretched tall for an instant, eyes wide on the viewer, a flash of
 * light; asking, it leans its head to one side, swaying slowly, looking at the viewer and blinking
 * twice now and then.
 *
 * Finish: a twirl, landing green with happy eyes in a ring of sparkles. Failed: it turns red, its
 * eyes go X X, and it sinks a little and fades — a ghost giving up.
 *
 * Shape: a dome over a body whose hem is three scallops that ripple. Below 20px the eyes are its
 * only detail.
 */

export function createGhost(canvas: HTMLCanvasElement, px: number, gain = 1): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const cue = cueClock();
  const sparks = makeBurst(10, 17);
  const detail = px >= 20;
  const u = (v: number) => v * px;
  let time = 0;
  let grow = 0;
  let lookX = 0;
  /** The pointer, when this mark follows it (`setGaze`). */
  let gaze: Gaze = null;
  let lookY = 0;
  let sleep = 0;
  let warn = 0;
  let alpha = 1;
  let mouth = 0;
  let hem = 0;
  let dart = 0;
  /** Listening: how far into that look it is (0–1), and the microphone's level this frame. */
  let perk = 0;
  let hear = 0;

  const awake = (act: ThinkingActivity | undefined) => !ended(act) && !act?.quiet && !act?.stopping;
  const listening = (act: ThinkingActivity | undefined) => awake(act) && act?.phase === "listen";
  const working = (act: ThinkingActivity | undefined) =>
    awake(act) && (act?.phase === "edit" || act?.phase === "run" || act?.phase === "tool");

  function paint() {
    if (!ctx) return;
    const p = palette();
    const act = clock.act;
    const fin = clock.fin;
    const failed = clock.failed;
    ctx.clearRect(0, 0, px, px);

    // The finish: a twirl (its width narrowing through a turn) for a landing, a sink for a failure.
    let twirl = 1;
    let sink = 0;
    let fade = 1;
    if (fin >= 0 && !failed && fin < 0.6) twirl = Math.cos((fin / 0.6) * TAU);
    if (failed && fin >= 0) {
      const k = easeOut(fin / 0.6);
      sink = 0.06 * k;
      fade = 1 - 0.3 * k;
    }
    const tint = fin >= 0 ? clamp01((fin - (failed ? 0 : 0.2)) / 0.4) : 0;
    const end = endColor(p, failed);
    const happy = !failed && !!act?.done && fin >= 0.35;
    const dazed = failed && fin >= 0.1;

    // What it hears, as far as Codi's gain takes it; the wake's start; the ask's lean.
    const draw = Math.min(1.4, hear * gain) * perk;
    const start = startle(cue.wake);
    const tilt = cue.ask * (0.08 + 0.05 * askBeat(time) + 0.03 * Math.sin(time * 1.4));
    // Listening, it floats up a little and holds still; woken, it jumps.
    const still = 1 - 0.75 * perk;
    const bob = Math.sin(time * 2.1) * 0.03 * (1 - sleep) * still + sleep * 0.04 - 0.02 * perk - 0.04 * hop(cue.wake);
    const sway = Math.sin(time * 1.3) * 0.035 * still + dart;
    const a = alpha * fade * (1 - sleep * 0.4);
    const g = 0.4 + 0.6 * easeOut(grow);
    // Drawn up tall to listen; stretched for an instant by the start.
    const tall = 1 + 0.03 * perk + 0.08 * start;

    ctx.save();
    ctx.translate(u(0.5 + sway), u(0.5 + bob + sink));
    ctx.rotate(tilt);
    ctx.scale(Math.max(0.08, Math.abs(twirl)) * g * (1 - 0.03 * start), g * tall);
    ctx.translate(-u(0.5), -u(0.5));

    // The body: a dome over a rippling three-scallop hem.
    const left = 0.21;
    const right = 0.79;
    const top = 0.44;
    const bottom = 0.84;
    ctx.beginPath();
    ctx.moveTo(u(left), u(bottom));
    ctx.lineTo(u(left), u(top));
    ctx.arc(u(0.5), u(top), u(0.29), Math.PI, 0);
    ctx.lineTo(u(right), u(bottom));
    const scallop = (right - left) / 3;
    for (let k = 0; k < 3; k++) {
      const x1 = right - scallop * k;
      const x2 = x1 - scallop;
      const ripple = Math.sin(hem + k * 1.9) * 0.035;
      ctx.quadraticCurveTo(u((x1 + x2) / 2), u(bottom - 0.09 + ripple), u(x2), u(bottom + (k === 2 ? 0 : 0.002)));
    }
    ctx.closePath();
    const body: Rgb = mix(mix(WHITE, p.c, 0.18), end, tint * 0.75);
    const rim: Rgb = mix(mix(p.a, WHITE, 0.3), end, tint);
    const grad = ctx.createRadialGradient(u(0.42), u(0.36), u(0.04), u(0.5), u(0.55), u(0.45));
    grad.addColorStop(0, rgba(mix(body, p.warning, warn * 0.3), 0.97 * a));
    grad.addColorStop(1, rgba(mix(rim, p.warning, warn * 0.3), 0.9 * a));
    ctx.save();
    ctx.shadowColor = rgba(mix(p.a, end, tint), (p.dark ? 0.6 : 0.4) * a);
    // Glowing a little with each syllable it hears, and in the flash of a wake.
    ctx.shadowBlur = u(0.16 + 0.07 * Math.min(1, draw) + 0.1 * start);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // The eyes — wide while it listens, wider for a moment when woken — and a "boo".
    const open = act?.stopping ? 0.45 : cue.ask > 0.5 ? askBlink(time) : blink(time, 3.8);
    const wide = 1 + 0.15 * perk + 0.2 * start;
    for (const ex of [0.41, 0.59]) {
      const ey = 0.47;
      if (dazed) {
        strokeEye(ctx, u(ex), u(ey), u(0.05), "x", rgba(INK, 0.85 * a), Math.max(1, u(0.03)));
      } else if (happy) {
        strokeEye(ctx, u(ex), u(ey), u(0.05), "happy", rgba(INK, 0.85 * a), Math.max(1, u(0.03)));
      } else if (sleep > 0.5 || open < 0.15) {
        strokeEye(ctx, u(ex), u(ey), u(0.045), "closed", rgba(INK, 0.7 * a), Math.max(0.8, u(0.026)));
      } else {
        ctx.fillStyle = rgba(INK, 0.9 * a);
        ctx.beginPath();
        ctx.ellipse(u(ex + lookX * 0.02), u(ey + lookY * 0.02), u(0.042 * wide), u(0.062 * open * wide), 0, 0, TAU);
        ctx.fill();
      }
    }
    if (detail && mouth > 0.05) {
      ctx.fillStyle = rgba(INK, 0.8 * a);
      ctx.beginPath();
      ctx.ellipse(u(0.5), u(0.6), u(0.03 + 0.01 * mouth), u(0.045 * mouth), 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Listening: what it hears, arcs closing in on it from both sides, fading as they land.
    if (draw > 0.01) {
      const color = mix(mix(p.c, WHITE, p.dark ? 0.35 : 0), p.warning, warn * 0.3);
      for (const side of [-1, 1]) {
        soundIn(ctx, u(0.5 + sway), u(0.55 + bob), u(0.45), u(0.33), side < 0 ? Math.PI : 0, 0.65, time + (side > 0 ? 0.5 : 0), draw * a, color, Math.max(0.8, u(0.028)));
      }
    }

    // The landing's sparkles: a ring of them, opening out.
    if (!failed && fin > 0.4 && fin < 1.4) {
      const s = fin - 0.4;
      for (const bit of sparks) {
        const dist = easeOut(s / 0.7) * u(0.42) * (0.8 + bit.speed * 0.25);
        const x = u(0.5) + Math.cos(bit.angle) * dist;
        const y = u(0.5) + Math.sin(bit.angle) * dist;
        ctx.fillStyle = rgba(bit.kind === 0 ? p.success : mix(p.c, WHITE, 0.5), (1 - s) * alpha);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.6, u(0.03) * (1 - s * 0.5)), 0, TAU);
        ctx.fill();
      }
    }
    if (sleep > 0.5 && !ended(act)) sleepZ(ctx, px, time, mix(p.c, p.warning, 0.3), alpha);
  }

  function settle(act: ThinkingActivity | undefined, k: number) {
    // Listening, woken or asking, it looks at whoever it is with — the wake snapping its eyes there.
    const facing = listening(act) || cue.wake >= 0 || cue.ask > 0.5;
    const [tx, ty] = ended(act) || act?.quiet || act?.stopping || facing ? [0, 0] : (gaze ?? lookFor(act?.phase, time));
    const snap = cue.wake >= 0 ? 40 : 10;
    lookX += (tx - lookX) * Math.min(1, k * snap);
    lookY += (ty - lookY) * Math.min(1, k * snap);
    perk += ((listening(act) ? 1 : 0) - perk) * Math.min(1, k * 6);
    const resting = act?.quiet && !ended(act) ? 1 : 0;
    sleep += (resting - sleep) * Math.min(1, k * 3);
    warn += (resting - warn) * Math.min(1, k * 3);
    alpha += ((act?.stopping ? 0.35 : 1) - alpha) * Math.min(1, k * 3);
    const talking = awake(act) && act?.phase === "write";
    const boo = talking ? Math.max(0, Math.sin(time * 8)) * Math.abs(Math.sin(time * 2.1)) : 0;
    mouth += (boo - mouth) * Math.min(1, k * 20);
    // Working, it darts: a quick side-to-side that would read as fidgeting.
    const darting = working(act) ? Math.sin(time * 7) * 0.06 : 0;
    dart += (darting - dart) * Math.min(1, k * 12);
  }

  return {
    setGaze(next) {
      gaze = next;
    },
    setActivity(activity) {
      clock.set(activity);
      cue.set(activity);
    },
    tick(dt) {
      clock.step(dt);
      cue.step(dt);
      const act = clock.act;
      time += dt * (act?.quiet && !ended(act) ? 0.5 : 1);
      grow += (1 - grow) * Math.min(1, dt * 3);
      // Listening, its hem barely stirs.
      hem += dt * (working(act) ? 9 : act?.phase === "write" && awake(act) ? 6 : act?.quiet ? 1.2 : listening(act) ? 1.4 : 3.5);
      hear = listening(act) ? listenLevel() : 0;
      settle(act, dt);
      paint();
    },
    still() {
      const act = clock.act;
      if (time === 0) time = 0.9;
      grow = 1;
      // A still frame of listening is mid-word: drawn up, arcs on their way in.
      hear = listening(act) ? 0.7 : 0;
      cue.settle();
      settle(act, 1);
      clock.settle();
      paint();
    },
  };
}
