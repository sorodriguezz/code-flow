import { ended, phaseGroup, type PhaseGroup, type ThinkingActivity } from "./activity";
import { blink, INK, lipSync, lookFor, sleepZ, strokeEye, WHITE } from "./face";
import { clamp01, easeOut, endColor, finishClock, makeBurst, rgba, TAU } from "./finish";
import { mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";
import { voiceLevel } from "./voice";

/**
 * "Marciano" — a little alien: a round head wider at the top, two big dark eyes, and two antennae
 * with glowing tips. Cyan and indigo while it runs — the assistant's hues — so its landing can turn
 * it the green every alien is drawn in.
 *
 * Its antennae are the phase: thinking, their tips pulse in turn while it blinks and looks around;
 * reading, its big eyes run along the lines; working, the antennae wiggle; writing, they beam little
 * signal arcs while it talks. Speaking (the reading aloud), its tips light up with the voice and
 * the arcs round them grow with it, its mouth moving with each syllable. Quiet, the antennae sag,
 * the tips go dim, and it dozes.
 *
 * Finish: it crouches and hops, its antennae spring up and their tips light up, happy ^ ^ eyes, and
 * it turns green. Failed: the antennae droop, the tips go dark, its eyes go X X and it turns red,
 * sinking a little — no hop, no lights.
 *
 * Below 20px the eyes lose their shine and the mouth shows only while it speaks; the head, the
 * antennae and the eyes stay.
 */

export function createAlien(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const pops = makeBurst(6, 83);
  /** Eye shine and mouth — what an alien smaller than this cannot hold. */
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
  let signal = 0;
  /** Speaking: how far into that look it is (0–1), the voice this frame, and the voice smoothed. */
  let talk = 0;
  let voice = 0;
  let swell = 0;
  /** Per antenna: how far it leans outward (radians), how far it has bent over (0 upright, 1
   *  drooping), and how bright its tip is (0 dark, 1 lit). */
  const lean = [0, 0];
  const sag = [0, 0];
  const light = [0.5, 0.5];

  const awake = (act: ThinkingActivity | undefined) => !ended(act) && !act?.quiet && !act?.stopping;
  // Speaking is its own look here, not writing's: `ThinkingOrb` hands this mark the phase as is.
  const groupOf = (act: ThinkingActivity | undefined): PhaseGroup | "speak" | undefined =>
    awake(act) ? (act?.phase === "speak" ? "speak" : phaseGroup(act?.phase)) : undefined;

  function head() {
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(u(0.5), u(0.355));
    ctx.bezierCurveTo(u(0.7), u(0.355), u(0.845), u(0.45), u(0.845), u(0.59));
    ctx.bezierCurveTo(u(0.845), u(0.77), u(0.66), u(0.9), u(0.5), u(0.9));
    ctx.bezierCurveTo(u(0.34), u(0.9), u(0.155), u(0.77), u(0.155), u(0.59));
    ctx.bezierCurveTo(u(0.155), u(0.45), u(0.3), u(0.355), u(0.5), u(0.355));
    ctx.closePath();
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    const act = clock.act;
    const fin = clock.fin;
    const failed = clock.failed;
    ctx.clearRect(0, 0, px, px);

    // The finish's body: crouch, hop, a damped landing — or, failing, a sink.
    let sx = 1;
    let sy = 1;
    let lift = 0;
    let sink = 0;
    if (fin >= 0 && failed) {
      sink = 0.035 * easeOut(fin / 0.5);
    } else if (fin >= 0) {
      if (fin < 0.18) {
        const k = easeOut(fin / 0.18);
        sy = 1 - 0.1 * k;
        sx = 1 + 0.06 * k;
      } else if (fin < 0.55) {
        const arc = Math.sin(((fin - 0.18) / 0.37) * Math.PI);
        // Low enough that the antennae stay inside the square at the top of the hop.
        lift = arc * 0.06;
        sy = 1 + 0.06 * arc;
        sx = 1 - 0.04 * arc;
      } else if (fin < 1) {
        const q = Math.sin(((fin - 0.55) / 0.35) * TAU) * Math.exp(-(fin - 0.55) * 7) * 0.08;
        sy = 1 - q;
        sx = 1 + q * 0.7;
      }
    }
    const tint = fin >= 0 ? clamp01((fin - (failed ? 0.05 : 0.2)) / 0.4) : 0;
    const end = endColor(p, failed);
    const happy = !failed && !!act?.done && fin >= 0.3;
    const dazed = failed && fin >= 0.1;
    // Lighter than the other marks' 0.3: amber over this cyan reads olive, too near the landing's green.
    const warm = (c: Rgb) => mix(c, p.warning, warn * 0.18);
    const tone = (c: Rgb, to: Rgb) => warm(mix(c, to, tint));
    const a = alpha;
    const g = 0.4 + 0.6 * easeOut(grow);
    const bob = Math.sin(time * 2.2) * 0.012 * (1 - sleep) + sleep * 0.025;

    ctx.save();
    ctx.translate(u(0.5), u(0.9 - lift + sink + bob));
    ctx.scale(sx * g, sy * g);
    ctx.translate(-u(0.5), -u(0.9));

    // The antennae, behind the head: a stalk curving up and out, a glowing ball on top.
    const stalk = tone(mix(p.c, p.b, 0.3), mix(end, INK, 0.1));
    const tips: [number, number][] = [];
    for (const i of [0, 1]) {
      const side = i === 0 ? -1 : 1;
      const bx = 0.5 + side * 0.1;
      const by = 0.4;
      ctx.save();
      ctx.translate(u(bx), u(by));
      ctx.rotate(side * lean[i]);
      ctx.strokeStyle = rgba(stalk, a);
      ctx.lineWidth = Math.max(1, u(0.035));
      ctx.lineCap = "round";
      // Upright, a stalk curving up and out; bent over, it rises and falls away to the side.
      const s = sag[i];
      const tipX = side * (0.11 + 0.09 * s);
      const tipY = -0.25 + 0.12 * s;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(u(side * (0.03 - 0.01 * s)), u(-0.15 - 0.08 * s), u(tipX), u(tipY));
      ctx.stroke();
      const on = clamp01(light[i]);
      const tip: Rgb = mix(
        tone(mix(p.a, INK, 0.35), mix(end, INK, failed ? 0.45 : 0.3)),
        // Lit: near-white on a dark page; on a light one that reads as faded, so cyan there.
        tone(mix(WHITE, p.c, p.dark ? 0.35 : 0.7), mix(end, WHITE, p.dark ? 0.35 : 0.1)),
        on,
      );
      ctx.save();
      ctx.shadowColor = rgba(tone(p.c, end), on * (p.dark ? 0.95 : 0.7) * a);
      ctx.shadowBlur = u(0.04 + 0.1 * on);
      ctx.fillStyle = rgba(tip, a);
      ctx.beginPath();
      ctx.arc(u(tipX), u(tipY), u(detail ? 0.05 : 0.065), 0, TAU);
      ctx.fill();
      ctx.restore();
      const m = ctx.getTransform();
      const dpr = canvas.width / px || 1;
      const at = m.transformPoint(new DOMPoint(u(tipX), u(tipY)));
      tips.push([at.x / dpr, at.y / dpr]);
      ctx.restore();
    }

    // The head, glowing.
    head();
    const grad = ctx.createLinearGradient(0, u(0.36), 0, u(0.9));
    grad.addColorStop(0, rgba(tone(mix(p.c, WHITE, 0.18), mix(end, WHITE, 0.3)), a));
    grad.addColorStop(0.6, rgba(tone(mix(p.c, p.b, 0.5), end), a));
    grad.addColorStop(1, rgba(tone(mix(p.b, p.a, 0.4), mix(end, INK, 0.15)), a));
    ctx.save();
    ctx.shadowColor = rgba(tone(mix(p.c, p.a, 0.4), end), (p.dark ? 0.55 : 0.35) * a);
    ctx.shadowBlur = u(0.13);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // The eyes: big, dark, tilted up at the outer corners, a shine that follows the gaze.
    const open = act?.stopping ? 0.45 : blink(time, 3.7);
    for (const side of [-1, 1]) {
      const ex = 0.5 + side * 0.125;
      const ey = 0.625;
      if (dazed) {
        strokeEye(ctx, u(ex), u(ey), u(0.07), "x", rgba(INK, 0.9 * a), Math.max(1, u(0.038)));
        continue;
      }
      if (happy) {
        strokeEye(ctx, u(ex), u(ey), u(0.075), "happy", rgba(INK, 0.9 * a), Math.max(1, u(0.038)));
        continue;
      }
      if (sleep > 0.5 || open < 0.15) {
        strokeEye(ctx, u(ex), u(ey), u(0.07), "closed", rgba(INK, 0.8 * a), Math.max(0.8, u(0.032)));
        continue;
      }
      ctx.save();
      ctx.translate(u(ex + lookX * 0.014), u(ey + lookY * 0.012));
      // Half shut, the tilt eases off — a slanted slit reads as a scowl.
      ctx.rotate(-side * 0.42 * open);
      ctx.scale(1, open);
      ctx.fillStyle = rgba(INK, 0.95 * a);
      ctx.beginPath();
      ctx.ellipse(0, 0, u(0.1), u(0.078), 0, 0, TAU);
      ctx.fill();
      ctx.restore();
      if (detail) {
        ctx.fillStyle = rgba(WHITE, 0.9 * a);
        ctx.beginPath();
        ctx.arc(
          u(ex + lookX * 0.04 - 0.012),
          u(ey + lookY * 0.03 - 0.022 * open),
          Math.max(0.7, u(0.025)) * Math.min(1, open * 1.5),
          0,
          TAU,
        );
        ctx.fill();
      }
    }
    if (groupOf(act) === "speak") {
      // Lip-sync: the mouth opens with the voice.
      const w = detail ? 0.034 : 0.05;
      ctx.fillStyle = rgba(INK, 0.85 * a);
      ctx.beginPath();
      ctx.ellipse(u(0.5), u(0.78), Math.max(0.6, u(w)), Math.max(0.5, u(w * (0.2 + 0.95 * mouth))), 0, 0, TAU);
      ctx.fill();
    } else if (detail && mouth > 0.05 && !dazed) {
      ctx.fillStyle = rgba(INK, 0.85 * a);
      ctx.beginPath();
      ctx.ellipse(u(0.5), u(0.775), u(0.026), u(0.032 * mouth + 0.005), 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Writing, the antennae beam: arcs leaving each tip, up and outward.
    if (signal > 0.02) {
      ctx.lineWidth = Math.max(0.8, u(0.024));
      ctx.lineCap = "round";
      tips.forEach(([x, y], i) => {
        const dir = -Math.PI / 2 + (i === 0 ? -1 : 1) * 0.95;
        for (let j = 0; j < 2; j++) {
          const k = (time * 1.3 + j * 0.5) % 1;
          ctx.strokeStyle = rgba(warm(mix(p.c, WHITE, 0.35)), (1 - k) * signal * a);
          ctx.beginPath();
          ctx.arc(x, y, u(0.07 + k * 0.08), dir - 0.65, dir + 0.65);
          ctx.stroke();
        }
      });
    }

    // Speaking, the arcs round each tip grow and light with the voice instead of travelling.
    if (talk > 0.02) {
      ctx.lineWidth = Math.max(0.8, u(0.024));
      ctx.lineCap = "round";
      ctx.strokeStyle = rgba(warm(mix(p.c, WHITE, p.dark ? 0.35 : 0)), 1);
      tips.forEach(([x, y], i) => {
        const dir = -Math.PI / 2 + (i === 0 ? -1 : 1) * 0.95;
        for (let j = 0; j < 2; j++) {
          const lit = clamp01((swell + 0.1 - j * 0.35) / 0.3);
          if (lit <= 0.01) continue;
          ctx.globalAlpha = talk * lit * a;
          ctx.beginPath();
          // At most 0.13 out: further and the outer arc leaves the square at the top.
          ctx.arc(x, y, u(0.06 + (0.03 + 0.04 * j) * swell), dir - 0.65, dir + 0.65);
          ctx.stroke();
        }
      });
      ctx.globalAlpha = 1;
    }

    // The landing: a few sparks popping off each lit tip.
    if (!failed && fin > 0.45 && fin < 1.45) {
      const s = fin - 0.45;
      tips.forEach(([x, y], i) => {
        for (const bit of pops) {
          const angle = -Math.PI / 2 + (i === 0 ? -1 : 1) * 0.6 + (bit.angle - Math.PI) * 0.45;
          const dist = easeOut(s / 0.7) * u(0.14) * bit.speed;
          ctx.fillStyle = rgba(bit.kind === 0 ? p.success : mix(p.c, WHITE, 0.45), (1 - s) * a);
          ctx.beginPath();
          ctx.arc(x + Math.cos(angle) * dist, y + Math.sin(angle) * dist, Math.max(0.6, u(0.022) * (1 - s * 0.5)), 0, TAU);
          ctx.fill();
        }
      });
    }
    if (sleep > 0.5 && !ended(act)) sleepZ(ctx, px, time, mix(p.c, p.warning, 0.3), a);
  }

  function settle(act: ThinkingActivity | undefined, k: number) {
    const fin = clock.fin;
    const group = groupOf(act);
    // Speaking, it looks at whoever it is talking to.
    const [tx, ty] = group ? lookFor(group === "work" ? "edit" : group === "speak" ? "start" : act?.phase, time) : [0, 0];
    lookX += (tx - lookX) * Math.min(1, k * 10);
    lookY += (ty - lookY) * Math.min(1, k * 10);
    const resting = act?.quiet && !ended(act) ? 1 : 0;
    sleep += (resting - sleep) * Math.min(1, k * 3);
    warn += (resting - warn) * Math.min(1, k * 3);
    alpha += ((act?.stopping ? 0.35 : resting ? 0.6 : 1) - alpha) * Math.min(1, k * 3);
    signal += ((group === "write" ? 1 : 0) - signal) * Math.min(1, k * 4);
    talk += ((group === "speak" ? 1 : 0) - talk) * Math.min(1, k * 6);
    swell += (lipSync(voice) - swell) * Math.min(1, k * 18);
    const say =
      group === "speak"
        ? Math.sqrt(lipSync(voice))
        : group === "write"
          ? Math.max(0, Math.sin(time * 8.5)) * Math.abs(Math.sin(time * 2.1))
          : 0;
    mouth += (say - mouth) * Math.min(1, k * 25);

    for (const i of [0, 1]) {
      let to = 0;
      let bend = 0;
      let on = 0.5;
      if (act?.failed) {
        // Bent over and drooping to the sides.
        const k = easeOut(Math.max(0, fin) / 0.5);
        to = 0.25 * k;
        bend = k;
        on = 0;
      } else if (act?.done) {
        // Sprung up and out by the hop, wobbling as it lands, then held lit.
        to = fin < 0.55 ? -0.15 : -0.15 * Math.exp(-(fin - 0.55) * 4) * Math.cos((fin - 0.55) * 16);
        on = fin < 0.18 ? 0.5 : 1;
      } else if (resting) {
        to = 0.15;
        bend = 0.6;
        on = 0.08;
      } else if (act?.stopping) {
        to = 0.1;
        bend = 0.35;
        on = 0.2;
      } else if (group === "work") {
        to = Math.sin(time * 10 + i * Math.PI) * 0.25;
        on = 0.75;
      } else if (group === "write") {
        to = -0.05;
        on = 1;
      } else if (group === "speak") {
        // The tips light with the voice, the antennae lifting a little on the loud syllables.
        to = -0.06 * lipSync(voice);
        on = 0.2 + 0.8 * lipSync(voice);
      } else if (group === "read") {
        on = 0.6;
      } else {
        // Thinking: the tips pulse in turn.
        to = Math.sin(time * 1.6 + i) * 0.05;
        on = 0.5 + 0.5 * Math.sin(time * 3.2 + i * Math.PI);
      }
      lean[i] += (to - lean[i]) * Math.min(1, k * 14);
      sag[i] += (bend - sag[i]) * Math.min(1, k * 8);
      light[i] += (on - light[i]) * Math.min(1, k * (group === "speak" ? 18 : 10));
    }
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
      paint();
    },
    still() {
      const act = clock.act;
      if (time === 0) time = 1.0;
      grow = 1;
      // A still frame of speech is mid-syllable: mouth open, tips lit, arcs out.
      voice = groupOf(act) === "speak" ? 0.85 : 0;
      clock.settle();
      settle(act, 1);
      paint();
    },
  };
}
