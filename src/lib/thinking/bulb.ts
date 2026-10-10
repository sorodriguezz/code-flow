import { ended, phaseGroup, type PhaseGroup, type ThinkingActivity } from "./activity";
import { blink, INK, lipSync, lookFor, sleepZ, strokeEye, WHITE } from "./face";
import { clamp01, easeOut, easeOutBack, endColor, finishClock, rgba, TAU } from "./finish";
import { mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";
import { voiceLevel } from "./voice";

/**
 * "Bombilla" — a light bulb with a face on its glass: the idea mascot, glowing in the assistant's
 * hues.
 *
 * How bright it burns is the phase: thinking, it glows low and its filament stutters now and then,
 * an idea about to happen; reading, a steady glow while its eyes run along the lines; working, it
 * pulses brighter; writing, it shines with soft rays round it. Speaking (the reading aloud), its
 * light speaks: glass and filament brighten and dim with the voice, its mouth moving with it, and
 * the rays flash out only on the loudest syllables. Quiet, it dims right down, its eyes shut, and
 * dozes.
 *
 * Finish: a flicker, then it lights up fully — the idea — rays bursting out, happy ^ ^ eyes, and it
 * settles glowing green. Failed: it flickers, goes dark, its glass cracks, and it turns red with
 * X X eyes — no rays, no glow.
 *
 * Shape: round glass over a neck and a screw base. Dark, its eyes light up instead, so the face
 * still reads. Below 20px the filament and the base's threads go, and the mouth shows only while
 * it speaks.
 */

/** The glass: its centre, its radius, and how far round from the bottom its sides leave for the neck. */
const CX = 0.5;
const CY = 0.4;
const R = 0.275;
const SIDE = 0.6;
const NECK = 0.1;
const NECK_Y = 0.715;

/** The rays' directions, fanned across the top half and a little below it. */
const RAYS = [-3, -2, -1, 0, 1, 2, 3].map((k) => -Math.PI / 2 + (k * Math.PI) / 4.5);

/** The crack a failure leaves: a jagged line across the glass's upper left. */
const CRACK: readonly (readonly [number, number])[] = [
  [0.3, 0.24],
  [0.37, 0.28],
  [0.34, 0.32],
  [0.41, 0.35],
];

export function createBulb(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  /** Filament, mouth and threads — what a bulb smaller than this cannot hold. */
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
  /** How bright it burns: 0 dark, 1 fully lit. */
  let glow = 0.5;
  let shine = 0;
  /** The voice this frame while it speaks, 0–1. */
  let voice = 0;

  const awake = (act: ThinkingActivity | undefined) => !ended(act) && !act?.quiet && !act?.stopping;
  // Speaking is its own look here, not writing's: `ThinkingOrb` hands this mark the phase as is.
  const groupOf = (act: ThinkingActivity | undefined): PhaseGroup | "speak" | undefined =>
    awake(act) ? (act?.phase === "speak" ? "speak" : phaseGroup(act?.phase)) : undefined;

  function glowGoal(act: ThinkingActivity | undefined): number {
    if (act?.quiet) return 0.12;
    if (act?.stopping) return 0.25;
    switch (groupOf(act)) {
      case "read":
        return 0.65;
      case "work":
        return 0.62 + 0.33 * (0.5 + 0.5 * Math.sin(time * 6));
      case "write":
        return 0.95;
      case "speak":
        return 0.45 + 0.55 * lipSync(voice);
      default:
        return 0.55;
    }
  }

  /** The glass's outline: round, drawn down into the neck. */
  function glass() {
    if (!ctx) return;
    const lx = CX - R * Math.sin(SIDE);
    const ly = CY + R * Math.cos(SIDE);
    ctx.beginPath();
    ctx.arc(u(CX), u(CY), u(R), Math.PI / 2 + SIDE, Math.PI / 2 - SIDE);
    ctx.quadraticCurveTo(u(CX + NECK), u(ly + 0.035), u(CX + NECK), u(NECK_Y));
    ctx.lineTo(u(CX - NECK), u(NECK_Y));
    ctx.quadraticCurveTo(u(CX - NECK), u(ly + 0.035), u(lx), u(ly));
    ctx.closePath();
  }

  function roundRect(x: number, y: number, w: number, h: number, r: number) {
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(u(x + r), u(y));
    ctx.arcTo(u(x + w), u(y), u(x + w), u(y + h), u(r));
    ctx.arcTo(u(x + w), u(y + h), u(x), u(y + h), u(r));
    ctx.arcTo(u(x), u(y + h), u(x), u(y), u(r));
    ctx.arcTo(u(x), u(y), u(x + w), u(y), u(r));
    ctx.closePath();
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    const act = clock.act;
    const fin = clock.fin;
    const failed = clock.failed;
    ctx.clearRect(0, 0, px, px);

    // The finish: a flicker, then full light for a landing; a strobe and dark for a failure.
    let g = glow;
    let rays = shine;
    let crack = 0;
    if (fin >= 0 && !failed) {
      if (fin < 0.15) g = Math.sin(fin * 70) > 0 ? 1 : 0.35;
      else g = 1 + 0.35 * Math.exp(-(fin - 0.15) * 5);
      const burst = fin < 0.15 ? 0 : easeOutBack((fin - 0.15) / 0.3);
      rays = Math.max(rays * clamp01(1 - fin / 0.15), burst * (1 - clamp01((fin - 1) / 0.5)));
    }
    if (fin >= 0 && failed) {
      g = fin < 0.6 ? (Math.sin(fin * 50) > 0.2 ? 0.85 : 0.1) * (1 - fin / 0.6) + 0.05 : 0.05;
      rays = 0;
      crack = clamp01((fin - 0.55) / 0.12);
    }
    const tint = fin >= 0 ? clamp01((fin - (failed ? 0.1 : 0.15)) / 0.4) : 0;
    const end = endColor(p, failed);
    const happy = !failed && !!act?.done && fin >= 0.2;
    const dazed = failed && fin >= 0.1;
    const warm = (c: Rgb) => mix(c, p.warning, warn * 0.3);
    const a = alpha;
    const lit = clamp01(g);
    const over = Math.max(0, g - 1);
    const s = 0.4 + 0.6 * easeOut(grow);

    ctx.save();
    ctx.translate(u(0.5), u(0.9));
    ctx.scale(s, s);
    ctx.translate(-u(0.5), -u(0.9));

    // Rays, behind the glass.
    if (rays > 0.02) {
      const pulse = act?.done || groupOf(act) === "speak" ? 1 : 0.8 + 0.2 * Math.sin(time * 4);
      ctx.strokeStyle = rgba(warm(mix(mix(p.c, WHITE, 0.35), mix(end, WHITE, 0.2), tint)), Math.min(1, rays) * a);
      ctx.lineWidth = Math.max(1, u(0.035));
      ctx.lineCap = "round";
      ctx.beginPath();
      for (const angle of RAYS) {
        const from = R + 0.04;
        const to = from + 0.075 * rays * pulse;
        ctx.moveTo(u(CX + Math.cos(angle) * from), u(CY + Math.sin(angle) * from));
        ctx.lineTo(u(CX + Math.cos(angle) * to), u(CY + Math.sin(angle) * to));
      }
      ctx.stroke();
    }

    // The screw base: threads, and the contact at the bottom.
    const metal = warm(mix(mix(p.a, p.b, 0.5), INK, p.dark ? 0.2 : 0.35));
    ctx.fillStyle = rgba(metal, a);
    if (detail) {
      roundRect(CX - 0.105, NECK_Y - 0.005, 0.21, 0.05, 0.022);
      ctx.fill();
      roundRect(CX - 0.1, NECK_Y + 0.057, 0.2, 0.05, 0.022);
      ctx.fill();
    } else {
      roundRect(CX - 0.105, NECK_Y - 0.005, 0.21, 0.11, 0.035);
      ctx.fill();
    }
    ctx.fillStyle = rgba(mix(metal, INK, 0.35), a);
    ctx.beginPath();
    ctx.arc(u(CX), u(NECK_Y + 0.115), u(0.06), 0, Math.PI);
    ctx.fill();

    // The glass, lit from the filament.
    const centre: Rgb = mix(
      mix(mix(p.b, INK, 0.5), failed ? mix(end, INK, 0.35) : mix(end, INK, 0.3), tint),
      mix(mix(WHITE, p.c, 0.3), mix(end, WHITE, 0.5), tint),
      lit,
    );
    const edge: Rgb = mix(
      mix(mix(p.b, INK, 0.62), failed ? mix(end, INK, 0.55) : mix(end, INK, 0.45), tint),
      mix(mix(p.a, p.b, 0.4), end, tint),
      lit,
    );
    glass();
    const grad = ctx.createRadialGradient(u(CX), u(CY - 0.06), u(0.02), u(CX), u(CY), u(R * 1.05));
    grad.addColorStop(0, rgba(warm(mix(centre, WHITE, over)), a));
    grad.addColorStop(1, rgba(warm(edge), a));
    ctx.save();
    ctx.shadowColor = rgba(warm(mix(mix(p.c, p.a, 0.4), end, tint)), (p.dark ? 0.8 : 0.5) * Math.min(1, lit + 0.15) * a);
    ctx.shadowBlur = u(0.06 + 0.16 * Math.min(1.3, g));
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
    // Its rim, which is what shows the glass when it is dark.
    ctx.strokeStyle = rgba(warm(mix(mix(p.a, WHITE, 0.25), end, tint)), (0.75 - 0.5 * lit) * a);
    ctx.lineWidth = Math.max(0.8, u(0.022));
    ctx.stroke();

    // The filament: a little coil of wire that glows with the bulb.
    if (detail) {
      const hot = Math.min(1, g + 0.15);
      ctx.save();
      ctx.strokeStyle = rgba(warm(mix(mix(p.a, INK, 0.2), mix(mix(WHITE, p.c, 0.2), mix(end, WHITE, 0.4), tint), hot)), a);
      ctx.shadowColor = rgba(mix(p.c, end, tint), hot * 0.9 * a);
      ctx.shadowBlur = u(0.06 * hot);
      ctx.lineWidth = Math.max(0.8, u(0.024));
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      // A prolate cycloid: three loops, the way a coiled filament looks side on.
      const turns = 3;
      const step = 0.12 / (turns * TAU);
      for (let i = 0; i <= 48; i++) {
        const t = (i / 48) * turns * TAU;
        const x = 0.44 + step * t - 0.018 * Math.sin(t);
        const y = 0.305 + 0.022 * Math.cos(t);
        if (i === 0) ctx.moveTo(u(x), u(y));
        else ctx.lineTo(u(x), u(y));
      }
      ctx.stroke();
      ctx.restore();
    }

    // The crack.
    if (crack > 0) {
      ctx.strokeStyle = rgba(mix(end, WHITE, 0.15), crack * a);
      ctx.lineWidth = Math.max(0.8, u(0.024));
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      CRACK.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(u(x), u(y)) : ctx.lineTo(u(x), u(y))));
      ctx.stroke();
    }

    // The face: dark ink on a lit glass, its eyes lighting up on a dark one.
    const ink = rgba(mix(mix(WHITE, p.c, 0.25), INK, clamp01((g - 0.22) * 3.3)), 0.92 * a);
    const open = act?.stopping ? 0.45 : blink(time, 3.5);
    const ey = 0.435;
    const eyeR = detail ? 0.042 : 0.052;
    for (const ex of [0.42, 0.58]) {
      if (dazed) strokeEye(ctx, u(ex), u(ey), u(eyeR), "x", ink, Math.max(1, u(0.03)));
      else if (happy) strokeEye(ctx, u(ex), u(ey), u(eyeR * 1.1), "happy", ink, Math.max(1, u(0.032)));
      else if (sleep > 0.5 || open < 0.15) strokeEye(ctx, u(ex), u(ey), u(eyeR), "closed", ink, Math.max(0.8, u(0.026)));
      else {
        ctx.fillStyle = ink;
        ctx.beginPath();
        ctx.ellipse(u(ex + lookX * 0.02), u(ey + lookY * 0.018), u(eyeR * 0.9), u(eyeR * 1.35 * open), 0, 0, TAU);
        ctx.fill();
      }
    }
    const speaking = groupOf(act) === "speak";
    if ((detail || speaking) && !dazed) {
      ctx.fillStyle = ink;
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(0.8, u(0.022));
      ctx.lineCap = "round";
      ctx.beginPath();
      if (speaking) {
        // Lip-sync: the mouth opens with the voice.
        const w = detail ? 0.03 : 0.046;
        ctx.ellipse(u(0.5), u(0.522), Math.max(0.6, u(w)), Math.max(0.5, u(w * (0.2 + 0.95 * mouth))), 0, 0, TAU);
        ctx.fill();
      } else if (mouth > 0.05) {
        ctx.ellipse(u(0.5), u(0.515), u(0.024), u(0.03 * mouth + 0.005), 0, 0, TAU);
        ctx.fill();
      } else {
        ctx.moveTo(u(0.475), u(0.507));
        ctx.quadraticCurveTo(u(0.5), u(0.532), u(0.525), u(0.507));
        ctx.stroke();
      }
    }
    ctx.restore();

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
    alpha += ((act?.stopping ? 0.35 : resting ? 0.7 : 1) - alpha) * Math.min(1, k * 3);
    // Speaking, the light follows the voice syllable by syllable, so it eases fast.
    const speaking = group === "speak";
    if (!ended(act)) glow += (glowGoal(act) - glow) * Math.min(1, k * (speaking ? 16 : 6));
    // Rays: steady while writing; speaking, only on the loudest syllables.
    const shineGoal = group === "write" ? 1 : speaking ? clamp01((lipSync(voice) - 0.7) / 0.2) : 0;
    shine += (shineGoal - shine) * Math.min(1, k * (speaking ? 14 : 4));
    const say = speaking
      ? Math.sqrt(lipSync(voice))
      : group === "write"
        ? Math.max(0, Math.sin(time * 8)) * Math.abs(Math.sin(time * 2.4))
        : 0;
    mouth += (say - mouth) * Math.min(1, k * 25);
  }

  /** Thinking, the filament stutters now and then — an idea about to happen. */
  function stutter(act: ThinkingActivity | undefined): number {
    if (groupOf(act) !== "think") return 0;
    const beat = time % 2.4;
    return beat > 1.75 && beat < 2.2 && Math.sin(beat * 55) > 0 ? 0.4 : 0;
  }

  return {
    setActivity(activity) {
      clock.set(activity);
    },
    tick(dt) {
      clock.step(dt);
      const act = clock.act;
      time += dt * (act?.quiet && !ended(act) ? 0.5 : 1);
      grow += (1 - grow) * Math.min(1, dt * 3.5);
      voice = groupOf(act) === "speak" ? voiceLevel() : 0;
      settle(act, dt);
      const base = glow;
      glow = Math.min(1, glow + stutter(act));
      paint();
      glow = base;
    },
    still() {
      const act = clock.act;
      if (time === 0) time = 1.2;
      grow = 1;
      // A still frame of speech is mid-syllable: mouth open and the glass bright, but not loud
      // enough for rays — a still with rays is writing's.
      voice = groupOf(act) === "speak" ? 0.7 : 0;
      settle(act, 1);
      clock.settle();
      paint();
    },
  };
}
