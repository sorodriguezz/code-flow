import { ended, type ThinkingActivity } from "./activity";
import { askBeat, askBlink, cueClock, hop, startle } from "./cue";
import { aiCycle, clamp01, easeOut, easeOutBack, endColor, finishClock, makeBurst, rgba, TAU } from "./finish";
import { blink, fillHeart, INK, lookFor, sleepZ, soundIn, strokeEye, WHITE, type Gaze } from "./face";
import { listenLevel } from "./listen";
import { mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Gato" — a cat's head in the assistant's hues, glowing, with big bright eyes. It took the place of
 * "Estrella" on 2026-10-08 (the user: "uno de gato que sea muy llamativo"); a stored `star` setting
 * now reads as this one — see `storedThinkingDesign`.
 *
 * What it does is the phase: thinking, it looks around, blinks and twitches an ear; reading, its eyes
 * sweep along line after line; editing, it crouches with its pupils gone round, tracking a dot the
 * way a cat tracks a laser; writing, it meows; starting, it pops up with its eyes wide. A quiet run
 * sends it to sleep, a "z" drifting up out of the corner. Listening (Codi), its ears prick up and
 * forward and it leans in, its pupils gone round and wide on whoever speaks, its mouth shut; each
 * syllable it hears swivels its ears a little further toward the sound, which comes in as arcs
 * closing on them from either side.
 *
 * Codi's cues: woken, it hops with a start — ears straight up, eyes wide and on the viewer; asking,
 * it tilts its head with one ear turned back and looks at the viewer, blinking twice now and then.
 *
 * Finish: it crouches, jumps, lands green with happy ^ ^ eyes, and throws a burst of hearts.
 * Failed: no jump — it slumps, its ears droop, its eyes go X X, and it turns red.
 *
 * Kept simple on purpose (user, the same day: "que no tenga tanto detalle"): a head, two ears, two
 * bright eyes and a nose. The whiskers, tabby stripes, tail and resting mouth it was first drawn
 * with are gone; a mouth appears only to meow. Below 20px there is no room for pupils or the nose
 * either, and the eyes still blink and look.
 */

/** One ear's twitch, in radians outward: a flick every few seconds, the ears taking turns. */
function twitch(time: number, side: number): number {
  const k = (time + (side > 0 ? 1.45 : 0)) % 2.9;
  return k < 0.18 ? Math.sin((k / 0.18) * Math.PI) * 0.35 : 0;
}

export function createCat(canvas: HTMLCanvasElement, px: number, gain = 1): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const cue = cueClock();
  const hearts = makeBurst(12, 41);
  /** Pupils, nose and mouth — what a cat smaller than this cannot hold. */
  const detail = px >= 20;
  const u = (v: number) => v * px;
  let time = 0;
  let grow = 0;
  let lookX = 0;
  /** The pointer, when this mark follows it (`setGaze`). */
  let gaze: Gaze = null;
  let lookY = 0;
  let dilate = 0;
  let crouch = 0;
  let sleep = 0;
  let warn = 0;
  let alpha = 1;
  let mouth = 0;
  /** Listening: how far into that look it is (0–1), and the microphone's level this frame. */
  let perk = 0;
  let hear = 0;

  const awake = (act: ThinkingActivity | undefined) => !ended(act) && !act?.quiet && !act?.stopping;
  const hunting = (act: ThinkingActivity | undefined) => awake(act) && (act?.phase === "edit" || act?.phase === "run");
  const listening = (act: ThinkingActivity | undefined) => awake(act) && act?.phase === "listen";

  function lookTarget(act: ThinkingActivity | undefined): readonly [number, number] {
    if (ended(act) || act?.quiet || act?.stopping) return [0, 0];
    // Listening, woken or asking, it looks at whoever it is with.
    if (listening(act) || cue.wake >= 0 || cue.ask > 0.5) return [0, 0];
    // Following the pointer, that is what it watches — the way a cat does. Working, the point it
    // darts after is the dot it is about to pounce on.
    return gaze ?? lookFor(act?.phase, time);
  }

  /** One ear, as a soft triangle turned `angle` outward about its base. */
  function ear(side: -1 | 1, angle: number, outer: string, inner: string) {
    if (!ctx) return;
    const m = (x: number) => (side < 0 ? x : 1 - x);
    const pivotX = u(m(0.31));
    const pivotY = u(0.45);
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(side < 0 ? -angle : angle);
    ctx.translate(-pivotX, -pivotY);
    const tri = (shrink: number) => {
      const pts = [
        [m(0.15), 0.53],
        [m(0.2), 0.09],
        [m(0.47), 0.37],
      ];
      const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
      const cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        const X = u(cx + (x - cx) * shrink);
        const Y = u(cy + (y - cy) * shrink);
        if (i === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      });
      ctx.closePath();
    };
    ctx.lineJoin = "round";
    ctx.lineWidth = u(0.05);
    tri(1);
    ctx.fillStyle = outer;
    ctx.strokeStyle = outer;
    ctx.fill();
    ctx.stroke();
    tri(0.5);
    ctx.fillStyle = inner;
    ctx.fill();
    ctx.restore();
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    const act = clock.act;
    const fin = clock.fin;
    ctx.clearRect(0, 0, px, px);

    // The finish's body: crouch, jump, a damped landing.
    let sx = 1;
    let sy = 1;
    let lift = 0;
    let flat = 0;
    const failed = clock.failed;
    if (failed && fin >= 0) {
      // The slump: a little lower, ears falling outward, and it stays that way.
      const k = easeOut(fin / 0.4);
      sy = 1 - 0.06 * k;
      sx = 1 + 0.03 * k;
      flat = 0.5 * k;
    } else if (fin >= 0) {
      if (fin < 0.22) {
        const k = easeOut(fin / 0.22);
        sy = 1 - 0.12 * k;
        sx = 1 + 0.07 * k;
        flat = 0.3 * k;
      } else if (fin < 0.62) {
        const k = (fin - 0.22) / 0.4;
        const arc = Math.sin(k * Math.PI);
        // Low enough that the ears stay inside the square at the top of the jump.
        lift = arc * 0.07;
        sy = 1 + 0.08 * arc;
        sx = 1 - 0.05 * arc;
        flat = 0.3 * (1 - clamp01(k * 2));
      } else if (fin < 1.1) {
        const s = fin - 0.62;
        const q = Math.sin((s / 0.38) * TAU) * Math.exp(-s * 7) * 0.1;
        sy = 1 - q;
        sx = 1 + q * 0.7;
      }
    }
    const happy = !failed && !!act?.done && fin >= 0.25;
    const dazed = failed && fin >= 0.1;
    const green = fin >= 0 ? clamp01((fin - (failed ? 0 : 0.25)) / 0.4) : 0;
    const end = endColor(p, failed);
    sx *= 1 + crouch * 0.03;
    sy *= 1 - crouch * 0.04;
    // What it hears, as far as Codi's gain takes it; the wake's start; the ask's tilt.
    const draw = Math.min(1.4, hear * gain) * perk;
    const start = startle(cue.wake);
    const tilt = cue.ask * (0.09 + 0.05 * askBeat(time));
    // Listening, it leans in; the wake's hop is low, like the finish's jump, for the ears.
    sx *= 1 + 0.03 * perk;
    sy *= 1 + 0.03 * perk;
    lift += 0.035 * hop(cue.wake);

    const tone = (h: Rgb, g: Rgb) => rgba(mix(mix(h, g, green), p.warning, warn * 0.3), alpha);
    const fur = [tone(p.a, mix(end, WHITE, 0.3)), tone(p.b, end), tone(p.c, mix(end, INK, 0.25))];
    const innerEar = tone(mix(p.a, WHITE, 0.5), mix(end, WHITE, 0.55));
    const grow01 = 0.35 + 0.65 * easeOutBack(grow);
    // Listening, it holds still to hear.
    const bob = Math.sin(time * 2.2) * 0.012 * (1 - sleep) * (1 - 0.8 * perk) + sleep * 0.03 + crouch * 0.03;

    ctx.save();
    ctx.translate(u(0.5), u(0.88 - lift + bob));
    ctx.rotate(-tilt);
    ctx.scale(sx * grow01, sy * grow01);
    ctx.translate(-u(0.5), -u(0.88));

    // Ears: a twitch while it thinks, back while it sleeps, flattened for the jump, forward to hunt —
    // pricked up and in to listen, swivelling further in with each syllable; straight up when woken;
    // one turned back when it asks.
    const thinking = awake(act) && !hunting(act) && perk < 0.5;
    for (const side of [-1, 1] as const) {
      const prick = -0.08 * perk - 0.06 * Math.min(1, draw) - 0.1 * start;
      const quizzical = side > 0 ? 0.3 * cue.ask : 0;
      const angle = (thinking ? twitch(time, side) : 0) + sleep * 0.25 + flat - crouch * 0.12 + prick + quizzical;
      ear(side, angle, fur[side < 0 ? 0 : 1], innerEar);
    }

    // The head, glowing.
    const grad = ctx.createLinearGradient(u(0.15), u(0.3), u(0.85), u(0.9));
    grad.addColorStop(0, fur[0]);
    grad.addColorStop(0.55, fur[1]);
    grad.addColorStop(1, fur[2]);
    ctx.save();
    ctx.shadowColor = rgba(mix(mix(p.a, end, green), p.warning, warn * 0.3), (p.dark ? 0.55 : 0.35) * alpha);
    // Brighter for each syllable it hears, and in the flash of a wake.
    ctx.shadowBlur = u(0.14 + 0.06 * Math.min(1, draw) + 0.1 * start);
    ctx.beginPath();
    ctx.ellipse(u(0.5), u(0.61), u(0.345), u(0.265), 0, 0, TAU);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // The eyes: wide while it listens, wider for a moment when woken.
    const open = act?.stopping ? 0.45 : cue.ask > 0.5 ? askBlink(time) : blink(time);
    const wide = 1 + 0.1 * perk + 0.15 * start;
    const eyeLight = mix(mix(p.c, WHITE, 0.55), p.warning, warn * 0.3);
    for (const ex of [0.385, 0.615]) {
      const ey = 0.6;
      ctx.lineCap = "round";
      if (dazed) {
        strokeEye(ctx, u(ex), u(ey), u(0.067), "x", rgba(WHITE, 0.9 * alpha), Math.max(1, u(0.032)));
        continue;
      }
      if (happy) {
        strokeEye(ctx, u(ex), u(ey), u(0.07), "happy", rgba(mix(WHITE, p.success, 0.25), alpha), Math.max(1, u(0.035)));
        continue;
      }
      if (sleep > 0.5 || open < 0.15) {
        strokeEye(ctx, u(ex), u(ey), u(0.065), "closed", rgba(INK, 0.75 * alpha), Math.max(0.8, u(0.028)));
        continue;
      }
      ctx.save();
      ctx.translate(u(ex), u(ey));
      ctx.scale(1, open);
      ctx.shadowColor = rgba(p.c, 0.8 * alpha);
      ctx.shadowBlur = u(0.08);
      ctx.fillStyle = rgba(eyeLight, alpha);
      ctx.beginPath();
      ctx.ellipse(0, 0, u(0.085 * wide), u(0.1 * wide), 0, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (detail) {
        ctx.fillStyle = rgba(INK, alpha);
        ctx.beginPath();
        ctx.ellipse(lookX * u(0.03), lookY * u(0.035), u(0.02 + 0.04 * dilate), u(0.075 - 0.01 * dilate), 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    if (detail) {
      // The nose, and a mouth only mid-meow.
      ctx.fillStyle = tone(mix(p.a, WHITE, 0.55), mix(end, WHITE, 0.6));
      ctx.beginPath();
      ctx.moveTo(u(0.475), u(0.67));
      ctx.lineTo(u(0.525), u(0.67));
      ctx.lineTo(u(0.5), u(0.7));
      ctx.closePath();
      ctx.fill();
      if (mouth > 0.05) {
        ctx.fillStyle = rgba(INK, 0.85 * alpha);
        ctx.beginPath();
        ctx.ellipse(u(0.5), u(0.735), u(0.03), u(0.04 * mouth), 0, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();

    // Listening: what it hears, arcs closing in on each ear from its side, fading as they land.
    if (draw > 0.01) {
      const color = mix(mix(p.c, WHITE, p.dark ? 0.35 : 0), p.warning, warn * 0.3);
      for (const side of [-1, 1]) {
        const x = u(0.5 + side * 0.3);
        const y = u(0.36 - lift + bob);
        soundIn(ctx, x, y, u(0.16), u(0.05), side < 0 ? Math.PI : 0, 0.55, time + (side > 0 ? 0.3 : 0), draw * alpha, color, Math.max(0.8, u(0.028)));
      }
    }

    // Hearts, thrown up and out by the landing.
    if (!failed && fin > 0.35 && fin < 1.45) {
      const s = fin - 0.35;
      for (const bit of hearts) {
        const angle = -Math.PI / 2 + (bit.angle - Math.PI) * 0.5;
        const dist = easeOut(s / 0.8) * u(0.46) * bit.speed;
        const x = u(0.5) + Math.cos(angle) * dist;
        const y = u(0.45) + Math.sin(angle) * dist + s * s * u(0.25);
        const fade = (1 - s / 1.1) * alpha;
        const r = Math.max(0.7, u(0.05) * (1 - s * 0.4));
        if (bit.kind === 2 || !detail) {
          ctx.fillStyle = rgba(mix(p.c, WHITE, 0.5), fade);
          ctx.beginPath();
          ctx.arc(x, y, r * 0.6, 0, TAU);
          ctx.fill();
        } else {
          ctx.fillStyle = rgba(bit.kind === 0 ? p.success : aiCycle(p, bit.hue), fade);
          fillHeart(ctx, x, y, r);
        }
      }
    }

    // Asleep: a "z" drifting up out of the top-right corner.
    if (sleep > 0.5 && !ended(act)) sleepZ(ctx, px, time, mix(p.c, p.warning, 0.3), alpha);
  }

  function settleTowards(act: ThinkingActivity | undefined, k: number) {
    const [tx, ty] = lookTarget(act);
    // The wake snaps its eyes to the viewer.
    const snap = cue.wake >= 0 ? 40 : 10;
    lookX += (tx - lookX) * Math.min(1, k * snap);
    lookY += (ty - lookY) * Math.min(1, k * snap);
    perk += ((listening(act) ? 1 : 0) - perk) * Math.min(1, k * 6);
    // Round pupils to listen, rounder still when woken.
    const dilateGoal =
      hunting(act) || act?.done ? 1 : cue.wake >= 0 ? 0.9 : listening(act) ? 0.7 : act?.phase === "start" ? 0.6 : 0;
    dilate += (dilateGoal - dilate) * Math.min(1, k * 6);
    crouch += ((hunting(act) ? 1 : 0) - crouch) * Math.min(1, k * 5);
    const resting = act?.quiet && !ended(act) ? 1 : 0;
    sleep += (resting - sleep) * Math.min(1, k * 3);
    warn += (resting - warn) * Math.min(1, k * 3);
    const alphaGoal = act?.stopping ? 0.35 : resting ? 0.6 : 1;
    alpha += (alphaGoal - alpha) * Math.min(1, k * 3);
    const talking = awake(act) && act?.phase === "write";
    const mouthGoal = talking ? Math.max(0, Math.sin(time * 9)) * Math.abs(Math.sin(time * 2.3)) : 0;
    mouth += (mouthGoal - mouth) * Math.min(1, k * 20);
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
      grow += (1 - grow) * Math.min(1, dt * 4);
      hear = listening(act) ? listenLevel() : 0;
      settleTowards(act, dt);
      paint();
    },
    still() {
      const act = clock.act;
      if (time === 0) time = 1.3;
      grow = 1;
      // A still frame of listening is mid-word: ears pricked, arcs on their way in.
      hear = listening(act) ? 0.7 : 0;
      cue.settle();
      // Straight to where every value is heading: a still frame has no frames to ease across.
      settleTowards(act, 1);
      clock.settle();
      paint();
    },
  };
}
