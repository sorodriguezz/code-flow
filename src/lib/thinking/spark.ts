import { ended, phaseGroup, type PhaseGroup, type ThinkingActivity } from "./activity";
import { blink, INK, lipSync, lookFor, sleepZ, strokeEye, WHITE } from "./face";
import { clamp01, easeOut, endColor, finishClock, makeBurst, rgba, TAU } from "./finish";
import { mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";
import { voiceLevel } from "./voice";

/**
 * "Chispa" — a little flame spirit with a face, burning in the assistant's hues: cyan-white at the
 * heart, indigo, violet at the tips. Never orange — it is the assistant's fire, not a candle's.
 *
 * Its flame is the phase: thinking, it flickers gently, blinking and looking around; reading, its
 * eyes run along the lines; working, it leans and dances, flickering fast; writing, it burns taller
 * and embers rise off its shoulders. Speaking (the reading aloud), it swells taller and brighter
 * with each syllable of the voice, its mouth moving with it — no embers, those are writing's. Quiet,
 * it burns low with its eyes shut and dozes.
 *
 * Finish: it flares up big, happy ^ ^ eyes, throws a few sparks and settles burning green. Failed:
 * it sputters and shrinks to a red ember with X X eyes, a wisp of smoke curling up from it — no
 * sparks, no flare.
 *
 * Shape: a teardrop (a round base drawn up into a tip that sways) with two smaller tongues at its
 * shoulders, all one fill, and a lighter core the face sits on. Below 20px the embers go, and the
 * mouth shows only while it speaks; the flame and two eyes stay.
 */

/** One teardrop flame added to the current path: a round base of radius `r` at (cx, cy), drawn up
 *  into a tip `h` above it that leans `dx` to the side. Several in one path unite in one fill. */
function flame(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, h: number, dx: number) {
  const tx = cx + dx;
  const ty = cy - h;
  ctx.moveTo(tx, ty);
  ctx.bezierCurveTo(tx + r * 0.15 - dx * 0.6, ty + h * 0.4, cx + r * 1.02, cy - r * 0.9, cx + r, cy);
  ctx.arc(cx, cy, r, 0, Math.PI);
  ctx.bezierCurveTo(cx - r * 1.02, cy - r * 0.9, tx - r * 0.15 - dx * 0.6, ty + h * 0.4, tx, ty);
  ctx.closePath();
}

export function createSpark(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const sparks = makeBurst(9, 53);
  /** Mouth and embers — what a flame smaller than this cannot hold. */
  const detail = px >= 20;
  const u = (v: number) => v * px;
  let time = 0;
  /** The flicker's own clock: it runs faster while the flame works. */
  let flick = 0;
  let pace = 1;
  let grow = 0;
  let lookX = 0;
  let lookY = 0;
  let sleep = 0;
  let warn = 0;
  let alpha = 1;
  let mouth = 0;
  /** How tall it burns: 1 at rest, low asleep, taller writing. */
  let height = 1;
  let lean = 0;
  let embers = 0;
  /** The voice this frame while it speaks (0–1), and the same smoothed into the flame's swell. */
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

    // The finish: a flare that springs back for a landing; a sputter down to an ember for a failure.
    let flare = 0;
    let die = 0;
    let sputter = 0;
    if (fin >= 0 && !failed) {
      // At most 0.38 taller: more and the tip leaves the square.
      flare = fin < 0.3 ? easeOut(fin / 0.3) * 0.38 : 0.38 * Math.exp(-(fin - 0.3) * 4.5) * Math.cos((fin - 0.3) * 9);
    }
    if (fin >= 0 && failed) {
      die = easeOut(fin / 0.8);
      if (fin < 0.8) sputter = Math.sin(fin * 38) * 0.2 * (1 - fin / 0.8);
    }
    const tint = fin >= 0 ? clamp01((fin - (failed ? 0 : 0.15)) / 0.4) : 0;
    const end = endColor(p, failed);
    const happy = !failed && !!act?.done && fin >= 0.25;
    const dazed = failed && fin >= 0.1;
    // A dying flame barely flickers.
    const calm = 1 - die * 0.75;

    const wobble = (Math.sin(flick * 3.1) * 0.6 + Math.sin(flick * 7.7) * 0.4) * calm;
    const r = 0.235;
    const cx = 0.5;
    const cy = 0.655;
    const h = Math.max(0.12, 0.43 * height * (1 + flare + 0.2 * swell) * (1 - 0.45 * die + sputter) + wobble * 0.03);
    const dx = (Math.sin(flick * 2.3) * 0.035 + Math.sin(flick * 5.9) * 0.018) * calm + lean;
    const a = alpha;
    // Failing, the whole flame shrinks as it goes out.
    const g = (0.4 + 0.6 * easeOut(grow)) * (1 - 0.14 * die);
    const warm = (c: Rgb) => mix(c, p.warning, warn * 0.3);

    ctx.save();
    ctx.translate(u(cx), u(cy + r));
    ctx.scale(g, g);
    ctx.translate(-u(cx), -u(cy + r));

    // The flame: body and two shoulder tongues in one path, so it glows as one.
    const tongue = (side: -1 | 1) => {
      const k = Math.sin(flick * 4.4 + (side > 0 ? 1.7 : 0)) * calm;
      const th = r * (1.05 + 0.25 * k) * Math.min(1.15, height) * (1 + flare * 0.6) * (1 - 0.7 * die);
      flame(ctx, u(cx + side * r * 0.62), u(cy - r * 0.05), u(r * 0.42), u(th), u(side * (0.06 + 0.015 * k) + lean * 0.6));
    };
    ctx.beginPath();
    flame(ctx, u(cx), u(cy), u(r), u(h), u(dx));
    if (die < 0.9) {
      tongue(-1);
      tongue(1);
    }
    const grad = ctx.createLinearGradient(0, u(cy + r), 0, u(cy - h));
    grad.addColorStop(0, rgba(warm(mix(mix(p.c, WHITE, 0.15), mix(end, WHITE, 0.3), tint)), a));
    grad.addColorStop(0.45, rgba(warm(mix(p.b, end, tint)), a));
    grad.addColorStop(1, rgba(warm(mix(p.a, mix(end, INK, 0.15), tint)), a));
    ctx.save();
    ctx.shadowColor = rgba(warm(mix(mix(p.a, p.c, 0.35), end, tint)), (p.dark ? 0.7 : 0.45) * a * (1 - die * 0.5));
    ctx.shadowBlur = u(0.14 + 0.12 * Math.max(0, flare) + 0.1 * swell);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // The core: a smaller, paler flame inside, where the face is.
    ctx.beginPath();
    flame(ctx, u(cx), u(cy + r * 0.2), u(r * 0.66), u(h * 0.52), u(dx * 0.5));
    const core = ctx.createLinearGradient(0, u(cy + r), 0, u(cy - h * 0.52));
    core.addColorStop(0, rgba(warm(mix(mix(WHITE, p.c, 0.18 * (1 - swell)), mix(end, WHITE, failed ? 0.35 : 0.6), tint)), 0.95 * a));
    core.addColorStop(1, rgba(warm(mix(mix(p.c, WHITE, 0.35 + 0.35 * swell), mix(end, WHITE, 0.3), tint)), (0.6 + 0.3 * swell) * a));
    ctx.fillStyle = core;
    ctx.fill();

    // The face.
    const open = act?.stopping ? 0.45 : blink(time, 3.6);
    const ey = cy + 0.015;
    const eyeR = detail ? 0.045 : 0.055;
    for (const side of [-1, 1]) {
      const ex = cx + side * 0.075 + dx * 0.15;
      if (dazed) strokeEye(ctx, u(ex), u(ey), u(eyeR), "x", rgba(INK, 0.9 * a), Math.max(1, u(0.03)));
      else if (happy) strokeEye(ctx, u(ex), u(ey), u(eyeR), "happy", rgba(INK, 0.9 * a), Math.max(1, u(0.03)));
      else if (sleep > 0.5 || open < 0.15) {
        strokeEye(ctx, u(ex), u(ey), u(eyeR * 0.9), "closed", rgba(INK, 0.8 * a), Math.max(0.8, u(0.026)));
      } else {
        ctx.fillStyle = rgba(INK, 0.92 * a);
        ctx.beginPath();
        ctx.ellipse(u(ex + lookX * 0.018), u(ey + lookY * 0.018), u(eyeR * 0.9), u(eyeR * 1.3 * open), 0, 0, TAU);
        ctx.fill();
      }
    }
    const speaking = groupOf(act) === "speak";
    if ((detail || speaking) && !dazed) {
      ctx.fillStyle = rgba(INK, 0.8 * a);
      ctx.strokeStyle = rgba(INK, 0.8 * a);
      ctx.lineWidth = Math.max(0.8, u(0.022));
      ctx.lineCap = "round";
      ctx.beginPath();
      if (speaking) {
        // Lip-sync: the mouth opens with the voice, a little wider than writing's chatter.
        const w = detail ? 0.03 : 0.045;
        ctx.ellipse(u(cx + dx * 0.15), u(cy + 0.088), Math.max(0.6, u(w)), Math.max(0.5, u(w * (0.2 + 0.95 * mouth))), 0, 0, TAU);
        ctx.fill();
      } else if (mouth > 0.05) {
        ctx.ellipse(u(cx + dx * 0.15), u(cy + 0.085), u(0.022), u(0.03 * mouth + 0.005), 0, 0, TAU);
        ctx.fill();
      } else {
        ctx.moveTo(u(cx - 0.028), u(cy + 0.08));
        ctx.quadraticCurveTo(u(cx), u(cy + 0.105), u(cx + 0.028), u(cy + 0.08));
        ctx.stroke();
      }
    }
    ctx.restore();

    // Embers rising off its shoulders while it writes.
    if (detail && embers > 0.02) {
      for (let i = 0; i < 5; i++) {
        const k = (time * 0.75 + i * 0.21) % 1;
        const side = i % 2 ? 1 : -1;
        const x = cx + side * (0.17 + 0.1 * k) + Math.sin(time * 3 + i) * 0.02;
        const y = cy - 0.06 - k * 0.46;
        ctx.fillStyle = rgba(warm(mix(i % 2 ? p.c : p.a, WHITE, 0.4)), (1 - k) * embers * a);
        ctx.beginPath();
        ctx.arc(u(x), u(y), Math.max(0.6, u(0.024) * (1 - k * 0.5)), 0, TAU);
        ctx.fill();
      }
    }

    // The landing's sparks, thrown up and out of the flare.
    if (!failed && fin > 0.15 && fin < 1.3) {
      const s = fin - 0.15;
      for (const bit of sparks) {
        const angle = -Math.PI / 2 + (bit.angle - Math.PI) * 0.6;
        const dist = easeOut(s / 0.8) * u(0.4) * bit.speed;
        const x = u(cx) + Math.cos(angle) * dist;
        const y = u(cy - 0.12) + Math.sin(angle) * dist + s * s * u(0.2);
        ctx.fillStyle = rgba(bit.kind === 0 ? p.success : mix(bit.kind === 1 ? p.c : end, WHITE, 0.4), (1 - s / 1.15) * a);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.6, u(0.03) * (1 - s * 0.5)), 0, TAU);
        ctx.fill();
      }
    }

    // A failure's smoke: puffs rising out of the ember, growing and fading as they go.
    if (failed && fin > 0.3) {
      const w = easeOut((fin - 0.3) / 0.6);
      const tipX = cx + dx;
      const tipY = cy + r - (r + h) * g;
      const smoke = mix(mix(p.text, p.surface, 0.25), p.danger, 0.12);
      for (let i = 0; i < 3; i++) {
        const k = (time * 0.45 + i / 3) % 1;
        const x = tipX + 0.05 * k + Math.sin(k * 6 + i * 2) * 0.03;
        const y = tipY - 0.02 - k * 0.3;
        ctx.fillStyle = rgba(smoke, (k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88) * 0.6 * w * a);
        ctx.beginPath();
        ctx.arc(u(x), u(y), Math.max(0.8, u(0.04 + 0.07 * k)), 0, TAU);
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
    swell += (lipSync(voice) - swell) * Math.min(1, k * 18);
    const heightGoal = resting ? 0.55 : act?.stopping ? 0.7 : group === "write" ? 1.18 : group === "work" ? 1.06 : 1;
    height += (heightGoal - height) * Math.min(1, k * 4);
    // Working, it leans one way and the other — a dance.
    const leanGoal = group === "work" ? Math.sin(time * 4.2) * 0.075 : 0;
    lean += (leanGoal - lean) * Math.min(1, k * 8);
    const paceGoal = group === "work" ? 2.4 : group === "write" ? 1.6 : group === "speak" ? 1.3 : resting ? 0.45 : 1;
    pace += (paceGoal - pace) * Math.min(1, k * 4);
    embers += ((group === "write" ? 1 : 0) - embers) * Math.min(1, k * 4);
    const say =
      group === "speak"
        ? Math.sqrt(lipSync(voice))
        : group === "write"
          ? Math.max(0, Math.sin(time * 8.5)) * Math.abs(Math.sin(time * 2.2))
          : 0;
    mouth += (say - mouth) * Math.min(1, k * 25);
  }

  return {
    setActivity(activity) {
      clock.set(activity);
    },
    tick(dt) {
      clock.step(dt);
      const act = clock.act;
      time += dt * (act?.quiet && !ended(act) ? 0.5 : 1);
      flick += dt * pace;
      grow += (1 - grow) * Math.min(1, dt * 3.5);
      voice = groupOf(act) === "speak" ? voiceLevel() : 0;
      settle(act, dt);
      paint();
    },
    still() {
      const act = clock.act;
      if (time === 0) {
        time = 1.2;
        flick = 1.2;
      }
      grow = 1;
      // A still frame of speech is mid-syllable: mouth open, flame up.
      voice = groupOf(act) === "speak" ? 0.85 : 0;
      settle(act, 1);
      clock.settle();
      paint();
    },
  };
}
