import { ended, type RunPhase, type ThinkingActivity } from "./activity";
import { askBreath, cueClock, softHalo, startle } from "./cue";
import { WHITE, type Gaze } from "./face";
import { clamp01, easeIn, easeOut, endColor, finishClock, rgba, TAU } from "./finish";
import { listenLevel } from "./listen";
import { aiHue, mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";
import { easeToward, lean, toward } from "./pointer";

/**
 * "Átomo" — a glowing nucleus with three electrons on orbits crossed at 60°.
 *
 * The phase is in the electrons and the orbits: thinking, a steady spin; reading, slower, the
 * orbits precessing as if turning the thing over to look at it; working, fast; writing, fast with
 * the nucleus throbbing. Starting, the orbits open out from the nucleus; quiet, everything slows
 * and dims.
 *
 * Finish: the orbits collapse into the nucleus, it flashes, and they open out again green — fusion.
 * Failed: the orbits wobble and the electrons fly off and fade, leaving a red nucleus — decay.
 *
 * Following the pointer (`ThinkingOrb follow`), the whole atom tips toward it like a gyroscope: the
 * orbits' near side swings out and grows, the far side recedes, and the nucleus drifts its way.
 *
 * Listening (Codi), the electrons slow and every syllable it hears pulls the orbits in tight round a
 * nucleus that glows up with it, while rings close on it from outside — the finish's flash ring,
 * the other way. Codi's cues: woken, the nucleus flashes and the orbits pop for an instant; asking,
 * it breathes slowly in a soft halo, turning hardly at all.
 *
 * Big (Codi's window), smoother orbits on finer lines.
 */

/** [electron speed in rad/s, orbit precession in rad/s] per phase. */
const MOTION: Partial<Record<RunPhase, [number, number]>> = {
  start: [2, 0.2],
  think: [2.6, 0.25],
  plan: [2.6, 0.25],
  read: [1.4, 0.7],
  search: [1.4, 0.7],
  edit: [5.2, 0.35],
  run: [5.2, 0.35],
  tool: [4.4, 0.3],
  write: [4.2, 0.3],
  listen: [1.5, 0.12],
};

const ORBITS = [0, Math.PI / 3, (2 * Math.PI) / 3];

export function createAtom(canvas: HTMLCanvasElement, px: number, gain = 1): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const cue = cueClock();
  const u = (v: number) => v * px;
  /** Points per orbit: 48 is round at the gutter sizes; big, it shows its corners. */
  const steps = px > 64 ? 120 : 48;
  /** The microphone's level this frame while it listens, as far as Codi's gain takes it. */
  let pull = 0;
  const electrons = ORBITS.map((_, i) => (i * TAU) / 3);
  /** Where each electron left its orbit, for a failure's escape. */
  const escape: { x: number; y: number; vx: number; vy: number }[] = [];
  let time = 0;
  let spin = 2.6;
  let precess = 0.25;
  let turn = 0;
  let open = 0;
  let warn = 0;
  let alpha = 1;
  let gaze: Gaze = null;
  const look = toward();

  function motion(act: ThinkingActivity | undefined): [number, number] {
    if (act?.failed) return [0, 0];
    if (act?.done) return [1.6, 0.15];
    if (act?.stopping) return [0.4, 0.05];
    if (act?.quiet) return [0.6, 0.08];
    return MOTION[act?.phase ?? "think"] ?? [2.6, 0.25];
  }

  /** Point on orbit `i` at electron angle `a`, in the 0–1 square, scaled by `size` — and how much
   *  nearer the lean toward the pointer brought it. */
  function onOrbit(i: number, a: number, size: number, wobble: number): [number, number, number] {
    const rx = 0.4 * size * (1 + wobble * Math.sin(time * 23 + i));
    const ry = 0.14 * size * (1 + wobble * Math.cos(time * 19 + i));
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    const r = ORBITS[i] + turn;
    const [lx, ly, nearer] = lean(look, x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r), 0.4);
    return [0.5 + lx, 0.5 + ly, nearer];
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    const act = clock.act;
    const fin = clock.fin;
    const failed = clock.failed;
    ctx.clearRect(0, 0, px, px);

    // The finish's beats: collapse (0–0.35), flash (0.35–0.55), open out green (0.5–1.0).
    let size = easeOut(open);
    let flash = 0;
    let wobble = 0;
    let orbitFade = 1;
    if (fin >= 0 && !failed) {
      if (fin < 0.35) size *= 1 - easeIn(fin / 0.35) * 0.92;
      else if (fin < 0.5) size *= 0.08;
      else size *= 0.08 + 0.92 * easeOut((fin - 0.5) / 0.5);
      flash = fin > 0.3 && fin < 0.75 ? Math.sin(((fin - 0.3) / 0.45) * Math.PI) : 0;
    }
    if (failed && fin >= 0) {
      wobble = 0.12 * (1 - clamp01(fin / 0.6));
      orbitFade = 1 - 0.65 * clamp01(fin / 0.8);
    }
    const tint = fin >= 0 ? clamp01((fin - (failed ? 0 : 0.4)) / 0.4) : 0;
    const end = endColor(p, failed);
    const hue = (i: number): Rgb => mix(mix(aiHue(p, i / 2), end, tint), p.warning, warn * 0.3);
    // Listening, the orbits pulled in by what it hears; woken, a pop and a flash; asking, a breath.
    const drawn = Math.min(1.4, pull);
    const start = startle(cue.wake);
    const breath = askBreath(time);
    size *= (1 - 0.16 * Math.min(1, drawn)) * (1 + 0.05 * start) * (1 + 0.05 * cue.ask * (breath - 0.5));
    flash = Math.max(flash, 0.8 * start);
    if (cue.ask > 0.01) softHalo(ctx, u(0.5), u(0.5), u(0.36), aiHue(p, 0.5), 0.2 * cue.ask * (0.6 + 0.4 * breath) * alpha);

    // Orbits.
    ctx.lineWidth = Math.max(0.7, Math.min(u(0.022), 1 + px / 90));
    ORBITS.forEach((_, i) => {
      ctx.strokeStyle = rgba(hue(i), 0.4 * alpha * orbitFade);
      ctx.beginPath();
      for (let s = 0; s <= steps; s++) {
        const [x, y] = onOrbit(i, (s / steps) * TAU, size, wobble);
        if (s === 0) ctx.moveTo(u(x), u(y));
        else ctx.lineTo(u(x), u(y));
      }
      ctx.stroke();
    });

    // The nucleus: a few particles held together, glowing; it throbs while writing.
    const writing = !ended(act) && !act?.quiet && act?.phase === "write";
    const throb = writing ? 1 + 0.12 * Math.abs(Math.sin(time * 7)) : 1;
    const core = 0.085 * throb * (1 + flash * 0.6 + 0.25 * Math.min(1, drawn)) * (failed ? 1 - 0.15 * clamp01(fin / 0.6) : 1);
    const [nx, ny] = lean(look, 0, 0, 0.4);
    ctx.save();
    ctx.shadowColor = rgba(mix(mix(p.a, end, tint), WHITE, flash * 0.6), (0.7 + flash * 0.3) * alpha);
    ctx.shadowBlur = u(0.12 + flash * 0.2);
    const parts: [number, number, Rgb][] = [
      [-0.35, -0.3, p.a],
      [0.4, -0.2, p.c],
      [0, 0.38, p.b],
      [-0.1, 0, p.c],
    ];
    for (const [dx, dy, c] of parts) {
      const col = mix(mix(mix(c, end, tint), WHITE, flash * 0.7), p.warning, warn * 0.3);
      const x = u(0.5 + nx + dx * core);
      const y = u(0.5 + ny + dy * core);
      const grad = ctx.createRadialGradient(x - u(core * 0.3), y - u(core * 0.3), 0, x, y, u(core * 0.75));
      grad.addColorStop(0, rgba(mix(col, WHITE, 0.45), alpha));
      grad.addColorStop(1, rgba(col, alpha));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, u(core * 0.72), 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Listening: rings closing on the nucleus from outside, fading as they land.
    if (drawn > 0.01) {
      ctx.strokeStyle = rgba(mix(p.c, WHITE, 0.35), 1);
      ctx.lineWidth = Math.max(0.8, Math.min(u(0.022), 1 + px / 90));
      for (const offset of [0, 0.5]) {
        const k = (time * 0.9 + offset) % 1;
        ctx.globalAlpha = Math.sin(k * Math.PI) * 0.65 * Math.min(1, drawn) * alpha;
        ctx.beginPath();
        ctx.arc(u(0.5 + nx), u(0.5 + ny), u(0.46 - 0.32 * k), 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // The flash's ring, opening out from the nucleus.
    if (flash > 0 && fin >= 0) {
      const k = clamp01((fin - 0.35) / 0.5);
      ctx.strokeStyle = rgba(mix(end, WHITE, 0.3), (1 - k) * 0.8 * alpha);
      ctx.lineWidth = Math.max(0.8, u(0.03) * (1 - k));
      ctx.beginPath();
      ctx.arc(u(0.5 + nx), u(0.5 + ny), u(0.1 + 0.36 * k), 0, TAU);
      ctx.stroke();
    }

    // Electrons with short trails — or, on a failure, flying off.
    const dot = Math.max(0.9, u(0.04));
    if (failed && fin >= 0) {
      const k = clamp01(fin / 0.9);
      escape.forEach((e, i) => {
        ctx.fillStyle = rgba(mix(hue(i), end, 0.6), (1 - k) * alpha);
        ctx.beginPath();
        ctx.arc(u(e.x + e.vx * fin), u(e.y + e.vy * fin), dot, 0, TAU);
        ctx.fill();
      });
      return;
    }
    electrons.forEach((a, i) => {
      for (let t = 3; t >= 0; t--) {
        const [x, y, nearer] = onOrbit(i, a - t * 0.22 * Math.sign(spin || 1), size, wobble);
        ctx.fillStyle = rgba(mix(hue(i), WHITE, t === 0 ? 0.35 : 0), (t === 0 ? 1 : 0.5 - t * 0.12) * alpha);
        ctx.beginPath();
        ctx.arc(u(x), u(y), dot * (1 - t * 0.2) * nearer, 0, TAU);
        ctx.fill();
      }
    });
  }

  /** Records each electron's position and tangent as it leaves, so the escape starts from it. */
  function launchEscape() {
    escape.length = 0;
    electrons.forEach((a, i) => {
      const [x, y] = onOrbit(i, a, easeOut(open), 0);
      const [x2, y2] = onOrbit(i, a + 0.05, easeOut(open), 0);
      const len = Math.hypot(x2 - x, y2 - y) || 1;
      escape.push({ x, y, vx: ((x2 - x) / len) * 0.55, vy: ((y2 - y) / len) * 0.55 });
    });
  }

  return {
    setActivity(activity) {
      const wasFailed = clock.failed;
      clock.set(activity);
      cue.set(activity);
      if (clock.failed && !wasFailed) launchEscape();
    },
    setGaze(next) {
      gaze = next;
    },
    tick(dt) {
      clock.step(dt);
      cue.step(dt);
      const act = clock.act;
      pull = !ended(act) && !act?.quiet && !act?.stopping && act?.phase === "listen" ? listenLevel() * gain : 0;
      easeToward(look, ended(act) || act?.quiet || act?.stopping ? null : gaze, dt);
      const [s, q] = motion(act);
      const fin = clock.fin;
      // The collapse whips the electrons round before the flash.
      const boost = fin >= 0 && !clock.failed && fin < 0.35 ? easeIn(fin / 0.35) * 14 : 0;
      spin += (s - spin) * Math.min(1, dt * 3);
      precess += (q - precess) * Math.min(1, dt * 3);
      time += dt;
      // Asking, it turns hardly at all.
      turn += dt * precess * (1 - 0.7 * cue.ask);
      for (let i = 0; i < electrons.length; i++) electrons[i] += dt * (spin + boost) * (1 + i * 0.15);
      open += (1 - open) * Math.min(1, dt * 2.5);
      warn += ((act?.quiet && !ended(act) ? 1 : 0) - warn) * Math.min(1, dt * 3);
      alpha += ((act?.stopping ? 0.35 : act?.quiet && !ended(act) ? 0.6 : 1) - alpha) * Math.min(1, dt * 3);
      paint();
    },
    still() {
      const act = clock.act;
      if (time === 0) time = 1;
      cue.settle();
      // A still frame of listening is mid-word: drawn in, a ring on its way.
      pull = !ended(act) && !act?.quiet && !act?.stopping && act?.phase === "listen" ? 0.7 * gain : 0;
      open = 1;
      [spin, precess] = motion(act);
      warn = act?.quiet && !ended(act) ? 1 : 0;
      alpha = act?.stopping ? 0.35 : act?.quiet && !ended(act) ? 0.6 : 1;
      clock.settle();
      if (clock.failed && escape.length === 0) launchEscape();
      paint();
    },
  };
}
