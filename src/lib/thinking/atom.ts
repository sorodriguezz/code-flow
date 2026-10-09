import { ended, type RunPhase, type ThinkingActivity } from "./activity";
import { WHITE } from "./face";
import { clamp01, easeIn, easeOut, endColor, finishClock, rgba, TAU } from "./finish";
import { aiHue, mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

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
};

const ORBITS = [0, Math.PI / 3, (2 * Math.PI) / 3];

export function createAtom(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const u = (v: number) => v * px;
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

  function motion(act: ThinkingActivity | undefined): [number, number] {
    if (act?.failed) return [0, 0];
    if (act?.done) return [1.6, 0.15];
    if (act?.stopping) return [0.4, 0.05];
    if (act?.quiet) return [0.6, 0.08];
    return MOTION[act?.phase ?? "think"] ?? [2.6, 0.25];
  }

  /** Point on orbit `i` at electron angle `a`, in the 0–1 square, scaled by `size`. */
  function onOrbit(i: number, a: number, size: number, wobble: number): [number, number] {
    const rx = 0.4 * size * (1 + wobble * Math.sin(time * 23 + i));
    const ry = 0.14 * size * (1 + wobble * Math.cos(time * 19 + i));
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    const r = ORBITS[i] + turn;
    return [0.5 + x * Math.cos(r) - y * Math.sin(r), 0.5 + x * Math.sin(r) + y * Math.cos(r)];
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

    // Orbits.
    ctx.lineWidth = Math.max(0.7, u(0.022));
    ORBITS.forEach((_, i) => {
      ctx.strokeStyle = rgba(hue(i), 0.4 * alpha * orbitFade);
      ctx.beginPath();
      for (let s = 0; s <= 48; s++) {
        const [x, y] = onOrbit(i, (s / 48) * TAU, size, wobble);
        if (s === 0) ctx.moveTo(u(x), u(y));
        else ctx.lineTo(u(x), u(y));
      }
      ctx.stroke();
    });

    // The nucleus: a few particles held together, glowing; it throbs while writing.
    const writing = !ended(act) && !act?.quiet && act?.phase === "write";
    const throb = writing ? 1 + 0.12 * Math.abs(Math.sin(time * 7)) : 1;
    const core = 0.085 * throb * (1 + flash * 0.6) * (failed ? 1 - 0.15 * clamp01(fin / 0.6) : 1);
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
      const x = u(0.5 + dx * core);
      const y = u(0.5 + dy * core);
      const grad = ctx.createRadialGradient(x - u(core * 0.3), y - u(core * 0.3), 0, x, y, u(core * 0.75));
      grad.addColorStop(0, rgba(mix(col, WHITE, 0.45), alpha));
      grad.addColorStop(1, rgba(col, alpha));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, u(core * 0.72), 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // The flash's ring, opening out from the nucleus.
    if (flash > 0) {
      const k = clamp01((fin - 0.35) / 0.5);
      ctx.strokeStyle = rgba(mix(end, WHITE, 0.3), (1 - k) * 0.8 * alpha);
      ctx.lineWidth = Math.max(0.8, u(0.03) * (1 - k));
      ctx.beginPath();
      ctx.arc(u(0.5), u(0.5), u(0.1 + 0.36 * k), 0, TAU);
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
        const [x, y] = onOrbit(i, a - t * 0.22 * Math.sign(spin || 1), size, wobble);
        ctx.fillStyle = rgba(mix(hue(i), WHITE, t === 0 ? 0.35 : 0), (t === 0 ? 1 : 0.5 - t * 0.12) * alpha);
        ctx.beginPath();
        ctx.arc(u(x), u(y), dot * (1 - t * 0.2), 0, TAU);
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
      if (clock.failed && !wasFailed) launchEscape();
    },
    tick(dt) {
      clock.step(dt);
      const act = clock.act;
      const [s, q] = motion(act);
      const fin = clock.fin;
      // The collapse whips the electrons round before the flash.
      const boost = fin >= 0 && !clock.failed && fin < 0.35 ? easeIn(fin / 0.35) * 14 : 0;
      spin += (s - spin) * Math.min(1, dt * 3);
      precess += (q - precess) * Math.min(1, dt * 3);
      time += dt;
      turn += dt * precess;
      for (let i = 0; i < electrons.length; i++) electrons[i] += dt * (spin + boost) * (1 + i * 0.15);
      open += (1 - open) * Math.min(1, dt * 2.5);
      warn += ((act?.quiet && !ended(act) ? 1 : 0) - warn) * Math.min(1, dt * 3);
      alpha += ((act?.stopping ? 0.35 : act?.quiet && !ended(act) ? 0.6 : 1) - alpha) * Math.min(1, dt * 3);
      paint();
    },
    still() {
      const act = clock.act;
      if (time === 0) time = 1;
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
