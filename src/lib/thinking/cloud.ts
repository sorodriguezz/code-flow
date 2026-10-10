import { ended, phaseGroup, type PhaseGroup, type ThinkingActivity } from "./activity";
import { blink, INK, lipSync, lookFor, sleepZ, strokeEye, WHITE } from "./face";
import { clamp01, easeOut, endColor, finishClock, makeBurst, rgba, TAU } from "./finish";
import { mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";
import { voiceLevel } from "./voice";

/**
 * "Nube" — a puffy little cloud with a face, pale and lit by the assistant's hues.
 *
 * It drifts and bobs while it thinks, blinking and looking around; reading, its eyes run along the
 * lines; working, it rains — a few drops falling from under it; writing, a little bolt of lightning
 * (cyan, the assistant's) flickers beneath it while it talks. Speaking (the reading aloud), it
 * puffs gently with the voice, its mouth moving with it, and sound arcs ripple out at its side —
 * more of them the louder it gets. Quiet, it dozes.
 *
 * Finish: it puffs up, wobbles like a jelly, beams with happy ^ ^ eyes, a few sparkles round it, and
 * turns green. Failed: it darkens into a red storm cloud and sags, its eyes X X — no puff, no
 * sparkles.
 *
 * Shape: five round puffs over a flat bottom, all one fill. Below 20px the mouth shows only while
 * it speaks, and the rain and the bolt are drawn as plain strokes.
 */

/** The puffs: [x, y, r] in the square, before the drift. */
const PUFFS: readonly (readonly [number, number, number])[] = [
  [0.5, 0.45, 0.205],
  [0.3, 0.55, 0.155],
  [0.7, 0.53, 0.165],
  [0.215, 0.645, 0.105],
  [0.785, 0.645, 0.105],
];
/** The flat underside the puffs sit on: left, top, right, bottom. */
const BASE = [0.215, 0.55, 0.785, 0.75] as const;

/** Where the drops fall from, and how far through its fall each starts. */
const DROPS: readonly (readonly [number, number])[] = [
  [0.33, 0],
  [0.46, 0.55],
  [0.59, 0.25],
  [0.71, 0.8],
];

/** The bolt, a zigzag hanging from the underside. */
const BOLT: readonly (readonly [number, number])[] = [
  [0.53, 0.72],
  [0.44, 0.85],
  [0.5, 0.85],
  [0.45, 0.98],
  [0.6, 0.82],
  [0.535, 0.82],
  [0.58, 0.72],
];

export function createCloud(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const sparkles = makeBurst(8, 71);
  /** Mouth and shaped drops — what a cloud smaller than this cannot hold. */
  const detail = px >= 20;
  const u = (v: number) => v * px;
  let time = 0;
  let grow = 0;
  let lookX = 0;
  let lookY = 0;
  let sleep = 0;
  let warn = 0;
  let alpha = 1;
  let mouth = 0;
  let rain = 0;
  let storm = 0;
  /** A still frame shows the bolt lit; running, it flickers. */
  let frozen = false;
  /** Speaking: how far into that look it is (0–1), the voice this frame, and the voice smoothed. */
  let talk = 0;
  let voice = 0;
  let swell = 0;

  const awake = (act: ThinkingActivity | undefined) => !ended(act) && !act?.quiet && !act?.stopping;
  // Speaking is its own look here, not writing's: `ThinkingOrb` hands this mark the phase as is.
  const groupOf = (act: ThinkingActivity | undefined): PhaseGroup | "speak" | undefined =>
    awake(act) ? (act?.phase === "speak" ? "speak" : phaseGroup(act?.phase)) : undefined;

  function paint() {
    if (!ctx) return;
    const p = palette();
    const act = clock.act;
    const fin = clock.fin;
    const failed = clock.failed;
    ctx.clearRect(0, 0, px, px);

    // The finish: a puff and a jelly wobble for a landing; a sag for a failure.
    let puff = 1;
    let jelly = 0;
    let sag = 0;
    if (fin >= 0 && !failed) {
      puff = fin < 0.3 ? 1 + 0.13 * easeOut(fin / 0.3) : 1.04 + 0.09 * Math.exp(-(fin - 0.3) * 4) * Math.cos((fin - 0.3) * 12);
      jelly = Math.exp(-fin * 3) * Math.min(1, fin * 8);
    }
    if (fin >= 0 && failed) sag = easeOut(fin / 0.5);
    const tint = fin >= 0 ? clamp01((fin - (failed ? 0 : 0.2)) / 0.4) : 0;
    const end = endColor(p, failed);
    const happy = !failed && !!act?.done && fin >= 0.25;
    const dazed = failed && fin >= 0.1;
    const warm = (c: Rgb) => mix(c, p.warning, warn * 0.3);
    const a = alpha;
    const g = 0.4 + 0.6 * easeOut(grow);

    const still = 1 - sleep * 0.6 - sag * 0.7;
    // Speaking, it makes room at its right for the sound arcs.
    const sway = Math.sin(time * 0.9) * 0.025 * still - 0.05 * talk;
    const bob = Math.sin(time * 1.7) * 0.015 * still + sleep * 0.02 + sag * 0.04;

    // The bolt's flicker: a double flash, then dark.
    const beat = time % 1.1;
    const flash = storm * (frozen || beat < 0.1 || (beat > 0.18 && beat < 0.3) ? 1 : 0);

    // Under the cloud: the rain, and the bolt.
    if (rain > 0.02) {
      ctx.lineCap = "round";
      for (const [x0, off] of DROPS) {
        const k = (time * 1.5 + off) % 1;
        const x = x0 + sway - k * 0.02;
        const y = 0.73 + bob + k * 0.22;
        const fade = (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85) * rain * a;
        const color = rgba(warm(mix(p.c, WHITE, 0.15)), fade);
        if (detail) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(u(x), u(y - 0.055));
          ctx.quadraticCurveTo(u(x + 0.034), u(y), u(x), u(y + 0.028));
          ctx.quadraticCurveTo(u(x - 0.034), u(y), u(x), u(y - 0.055));
          ctx.fill();
        } else {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(u(x), u(y - 0.04));
          ctx.lineTo(u(x - 0.01), u(y + 0.03));
          ctx.stroke();
        }
      }
    }
    if (flash > 0.02) {
      ctx.save();
      ctx.translate(u(sway), u(bob));
      ctx.shadowColor = rgba(p.a, (p.dark ? 0.9 : 0.6) * flash * a);
      ctx.shadowBlur = u(0.1);
      ctx.fillStyle = rgba(mix(p.c, WHITE, 0.3), flash * a);
      ctx.beginPath();
      BOLT.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(u(x), u(y)) : ctx.lineTo(u(x), u(y))));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(u(0.5 + sway), u(0.75 + bob));
    const voiced = 1 + 0.05 * swell;
    ctx.scale(g * puff * voiced * (1 + sag * 0.03), g * puff * voiced * (1 - sag * 0.07));
    ctx.translate(-u(0.5), -u(0.75));

    // The body: the puffs and the underside, one path, one glow.
    ctx.beginPath();
    PUFFS.forEach(([x, y, r], i) => {
      const breathe = 1 + Math.sin(time * 1.8 + i * 1.3) * 0.022 * still + Math.sin(fin * 18 + i * 2.1) * 0.07 * jelly;
      ctx.moveTo(u(x + r * breathe), u(y));
      ctx.arc(u(x), u(y), u(r * breathe), 0, TAU);
    });
    ctx.rect(u(BASE[0]), u(BASE[1]), u(BASE[2] - BASE[0]), u(BASE[3] - BASE[1]));
    const top: Rgb = mix(mix(WHITE, p.c, 0.3), failed ? mix(end, INK, 0.15) : mix(end, WHITE, 0.3), tint);
    const bottom: Rgb = mix(mix(p.a, WHITE, 0.3), failed ? mix(end, INK, 0.5) : end, tint);
    const lit = flash * 0.3;
    const grad = ctx.createLinearGradient(0, u(0.24), 0, u(0.76));
    grad.addColorStop(0, rgba(warm(mix(top, WHITE, lit)), a));
    grad.addColorStop(1, rgba(warm(mix(bottom, WHITE, lit)), a));
    ctx.save();
    ctx.shadowColor = rgba(warm(mix(p.a, end, tint)), (p.dark ? 0.6 : 0.4) * a);
    ctx.shadowBlur = u(0.13);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // The face.
    const ink = rgba(mix(INK, WHITE, failed ? tint * 0.9 : 0), 0.9 * a);
    const open = act?.stopping ? 0.45 : blink(time, 3.9);
    const ey = 0.585;
    const eyeR = detail ? 0.042 : 0.052;
    for (const ex of [0.415, 0.585]) {
      if (dazed) strokeEye(ctx, u(ex), u(ey), u(eyeR), "x", ink, Math.max(1, u(0.03)));
      else if (happy) strokeEye(ctx, u(ex), u(ey), u(eyeR * 1.1), "happy", ink, Math.max(1, u(0.032)));
      else if (sleep > 0.5 || open < 0.15) {
        strokeEye(ctx, u(ex), u(ey), u(eyeR), "closed", rgba(INK, 0.75 * a), Math.max(0.8, u(0.026)));
      } else {
        ctx.fillStyle = ink;
        ctx.beginPath();
        ctx.ellipse(u(ex + lookX * 0.02), u(ey + lookY * 0.018), u(eyeR * 0.9), u(eyeR * 1.35 * open), 0, 0, TAU);
        ctx.fill();
      }
    }
    const speaking = groupOf(act) === "speak";
    if (detail || speaking) {
      ctx.fillStyle = ink;
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(0.8, u(0.022));
      ctx.lineCap = "round";
      ctx.beginPath();
      if (speaking) {
        // Lip-sync: the mouth opens with the voice.
        const w = detail ? 0.032 : 0.048;
        ctx.ellipse(u(0.5), u(0.67), Math.max(0.6, u(w)), Math.max(0.5, u(w * (0.2 + 0.95 * mouth))), 0, 0, TAU);
        ctx.fill();
      } else if (mouth > 0.05 && !dazed) {
        ctx.ellipse(u(0.5), u(0.665), u(0.025), u(0.032 * mouth + 0.005), 0, 0, TAU);
        ctx.fill();
      } else if (dazed) {
        ctx.moveTo(u(0.47), u(0.68));
        ctx.quadraticCurveTo(u(0.5), u(0.655), u(0.53), u(0.68));
        ctx.stroke();
      } else {
        ctx.moveTo(u(0.47), u(0.655));
        ctx.quadraticCurveTo(u(0.5), u(0.685), u(0.53), u(0.655));
        ctx.stroke();
      }
    }
    ctx.restore();

    // Speaking: sound arcs rippling out of its right side, one more lit for each step up in volume.
    if (talk > 0.02) {
      ctx.strokeStyle = rgba(warm(mix(p.c, WHITE, p.dark ? 0.3 : 0)), 1);
      ctx.lineWidth = Math.max(1, u(0.036));
      ctx.lineCap = "round";
      const arcs = detail ? 3 : 2;
      // Beside its right edge, drifting with it.
      const ox = u(0.83 + sway + 0.05 * talk);
      const oy = u(0.6 + bob);
      for (let j = 0; j < arcs; j++) {
        const lit = clamp01((swell + 0.15 - j * 0.28) / 0.25);
        if (lit <= 0.01) continue;
        ctx.globalAlpha = talk * lit * a;
        ctx.beginPath();
        // At most 0.14 out from beside its edge: the outer arc stays inside the square.
        ctx.arc(ox, oy, u((0.055 + j * (detail ? 0.042 : 0.06)) * (0.85 + 0.15 * swell)), -0.65, 0.65);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // The landing's sparkles: little four-point stars round it, popping and fading.
    if (!failed && fin > 0.3 && fin < 1.4) {
      const s = fin - 0.3;
      for (const bit of sparkles) {
        const dist = u(0.36) + easeOut(s / 0.7) * u(0.1) * bit.speed;
        const x = u(0.5) + Math.cos(bit.angle) * dist;
        const y = u(0.52) + Math.sin(bit.angle) * dist * 0.85;
        const size = Math.max(1, u(0.05)) * Math.sin(Math.min(1, s / 1.1) * Math.PI);
        ctx.fillStyle = rgba(bit.kind === 0 ? p.success : mix(p.c, WHITE, 0.45), a);
        ctx.beginPath();
        ctx.moveTo(x, y - size);
        ctx.quadraticCurveTo(x, y, x + size, y);
        ctx.quadraticCurveTo(x, y, x, y + size);
        ctx.quadraticCurveTo(x, y, x - size, y);
        ctx.quadraticCurveTo(x, y, x, y - size);
        ctx.fill();
      }
    }
    if (sleep > 0.5 && !ended(act)) sleepZ(ctx, px, time, mix(p.c, p.warning, 0.3), a);
  }

  function settle(act: ThinkingActivity | undefined, k: number) {
    const group = groupOf(act);
    // Speaking, it looks at whoever it is talking to.
    const [tx, ty] = group ? lookFor(group === "work" ? "edit" : group === "speak" ? "start" : act?.phase, time) : [0, 0];
    lookX += (tx - lookX) * Math.min(1, k * 10);
    lookY += (ty - lookY) * Math.min(1, k * 10);
    const resting = act?.quiet && !ended(act) ? 1 : 0;
    sleep += (resting - sleep) * Math.min(1, k * 3);
    warn += (resting - warn) * Math.min(1, k * 3);
    alpha += ((act?.stopping ? 0.35 : resting ? 0.6 : 1) - alpha) * Math.min(1, k * 3);
    rain += ((group === "work" ? 1 : 0) - rain) * Math.min(1, k * 4);
    storm += ((group === "write" ? 1 : 0) - storm) * Math.min(1, k * 6);
    talk += ((group === "speak" ? 1 : 0) - talk) * Math.min(1, k * 6);
    swell += (lipSync(voice) - swell) * Math.min(1, k * 18);
    const say =
      group === "speak"
        ? Math.sqrt(lipSync(voice))
        : group === "write"
          ? Math.max(0, Math.sin(time * 8)) * Math.abs(Math.sin(time * 2.3))
          : 0;
    mouth += (say - mouth) * Math.min(1, k * 25);
  }

  return {
    setActivity(activity) {
      clock.set(activity);
    },
    tick(dt) {
      frozen = false;
      clock.step(dt);
      const act = clock.act;
      time += dt * (act?.quiet && !ended(act) ? 0.5 : 1);
      grow += (1 - grow) * Math.min(1, dt * 3.5);
      voice = groupOf(act) === "speak" ? voiceLevel() : 0;
      settle(act, dt);
      paint();
    },
    still() {
      const act = clock.act;
      if (time === 0) time = 1.25;
      grow = 1;
      frozen = true;
      // A still frame of speech is mid-syllable: mouth open, arcs out.
      voice = groupOf(act) === "speak" ? 0.85 : 0;
      settle(act, 1);
      clock.settle();
      paint();
    },
  };
}
