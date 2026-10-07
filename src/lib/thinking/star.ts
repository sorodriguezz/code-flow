import type { ThinkingActivity } from "./activity";
import { clamp01, easeOut, easeOutBack, finishClock, makeBurst, rgba, aiCycle, TAU } from "./finish";
import { mix, palette } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Estrella" — the four-pointed sparkle the AI products have made familiar, alive: its points draw
 * in and out (a superellipse whose exponent breathes), a gradient turns through it, and two small
 * sparks twinkle beside it. Reading it drifts round; editing turns it a deliberate quarter at a
 * time — a click, not a spin.
 *
 * Finish: it crouches, jumps with a full turn throwing confetti, lands green, and winks a glint.
 */

export function createStar(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const confetti = makeBurst(16, 23);
  let time = 0;
  let shape = 0.55;
  let beat = 0;
  let turn = 0;
  let warn = 0;
  let alpha = 1;
  let grow = 0;

  /** The superellipse exponent: ~0.5 is a sharp four-point star, 2 a circle. */
  function goal(activity: ThinkingActivity | undefined): number {
    if (activity?.done) return 0.5;
    if (activity?.quiet) return 0.6;
    if (activity?.stopping) return 0.9;
    switch (activity?.phase) {
      case "think":
      case "plan":
        return 0.5 + 0.4 * (0.5 + 0.5 * Math.sin(time * 1.8));
      case "write":
        return 0.5 + 0.15 * Math.abs(Math.sin(time * 7));
      case "read":
      case "search":
        return 0.55 + 0.1 * Math.sin(time * 3);
      case "edit":
      case "run":
        return 0.5;
      default:
        return 0.6 + 0.2 * Math.sin(time * 2);
    }
  }

  function sparkle(cx: number, cy: number, R: number, n: number, rot: number) {
    if (!ctx) return;
    const e = 2 / n;
    ctx.beginPath();
    for (let s = 0; s <= 72; s++) {
      const a = (s / 72) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const x = Math.sign(ca) * Math.pow(Math.abs(ca), e);
      const y = Math.sign(sa) * Math.pow(Math.abs(sa), e);
      const xr = x * Math.cos(rot) - y * Math.sin(rot);
      const yr = x * Math.sin(rot) + y * Math.cos(rot);
      if (s === 0) ctx.moveTo(cx + xr * R, cy + yr * R);
      else ctx.lineTo(cx + xr * R, cy + yr * R);
    }
    ctx.closePath();
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    const fin = clock.fin;
    ctx.clearRect(0, 0, px, px);
    const c = px / 2;
    // The finish, in three beats: crouch, jump with a full turn, land.
    let scale = 1;
    let extraTurn = 0;
    let lift = 0;
    if (fin >= 0) {
      if (fin < 0.25) {
        scale = 1 - 0.18 * easeOut(fin / 0.25);
        extraTurn = -0.25 * easeOut(fin / 0.25);
      } else if (fin < 0.7) {
        const k = (fin - 0.25) / 0.45;
        scale = 0.82 + 0.48 * easeOutBack(k);
        extraTurn = -0.25 + (TAU / 2 + 0.25) * easeOut(k);
        lift = Math.sin(k * Math.PI) * px * 0.08;
      } else {
        scale = 1.3 - 0.3 * easeOut((fin - 0.7) / 0.35);
        extraTurn = TAU / 2;
      }
    }
    const green = fin >= 0 ? clamp01((fin - 0.3) / 0.35) : 0;
    const R = px * 0.42 * (0.35 + 0.65 * grow) * (1 + beat * 0.06) * scale * (fin >= 0 ? 0.82 : 1);
    const ga = time * 0.8;
    const grad = ctx.createLinearGradient(c + Math.cos(ga) * R, c + Math.sin(ga) * R, c - Math.cos(ga) * R, c - Math.sin(ga) * R);
    const stops = [p.a, p.b, p.c].map((h) => mix(mix(h, p.success, green), p.warning, warn * 0.3));
    grad.addColorStop(0, rgba(stops[0], alpha));
    grad.addColorStop(0.5, rgba(stops[1], alpha));
    grad.addColorStop(1, rgba(stops[2], alpha));
    if (fin > 0.4 && fin < 1.6) {
      const s = fin - 0.4;
      const size = Math.max(0.8, px * 0.045);
      for (const bit of confetti) {
        const dist = easeOut(s / 0.7) * px * 0.5 * bit.speed;
        const x = c + Math.cos(bit.angle) * dist;
        const y = c + Math.sin(bit.angle) * dist + s * s * px * 0.5;
        ctx.fillStyle = rgba(bit.kind === 0 ? p.success : aiCycle(p, bit.hue), (1 - s / 1.15) * alpha);
        if (bit.kind === 2) {
          // A ribbon, tumbling.
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(bit.spin * s);
          ctx.fillRect(-size, -size * 0.45, size * 2, size * 0.9);
          ctx.restore();
        } else {
          sparkle(x, y, size * 1.4, 0.5, bit.spin * s);
          ctx.fill();
        }
      }
    }
    ctx.save();
    ctx.shadowColor = rgba(stops[1], 0.55 * alpha);
    ctx.shadowBlur = px * 0.16;
    sparkle(c, c - lift, R, shape, turn + extraTurn);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
    if (px >= 20 && fin < 0) {
      const tw1 = Math.max(0, Math.sin(time * 2.3));
      const tw2 = Math.max(0, Math.sin(time * 2.3 + 2.4));
      ctx.fillStyle = rgba(mix(p.c, p.warning, warn * 0.3), 0.9 * alpha);
      sparkle(c + R * 0.92, c - R * 0.9, px * 0.09 * tw1, 0.5, 0);
      ctx.fill();
      ctx.fillStyle = rgba(mix(p.a, p.warning, warn * 0.3), 0.9 * alpha);
      sparkle(c - R * 0.95, c + R * 0.8, px * 0.07 * tw2, 0.5, 0);
      ctx.fill();
    }
    // The wink: one white glint on its upper point once it has landed.
    if (fin > 1.0 && fin < 1.7) {
      const k = Math.sin(((fin - 1.0) / 0.7) * Math.PI);
      ctx.fillStyle = `rgba(255,255,255,${0.95 * k * alpha})`;
      sparkle(c + R * 0.3, c - R * 0.45, px * 0.11 * k, 0.5, 0);
      ctx.fill();
    }
  }

  return {
    setActivity(activity) {
      clock.set(activity);
    },
    tick(dt) {
      clock.step(dt);
      const act = clock.act;
      time += dt * (act?.quiet ? 0.35 : 1);
      shape += (goal(act) - shape) * Math.min(1, dt * 4);
      grow += (1 - grow) * Math.min(1, dt * 3);
      beat = act?.phase === "write" && !act?.done ? Math.abs(Math.sin(time * 7)) : act?.done ? 0 : 0.3 * Math.sin(time * 1.8);
      const editing = (act?.phase === "edit" || act?.phase === "run") && !act?.done && !act?.quiet && !act?.stopping;
      const target = editing ? Math.floor(time / 1.1) * (Math.PI / 4) : turn;
      const drifting = (act?.phase === "read" || act?.phase === "search") && !act?.done;
      turn += (target - turn) * Math.min(1, dt * 6) + (drifting ? dt * 0.4 : 0);
      warn += ((act?.quiet ? 1 : 0) - warn) * Math.min(1, dt * 3);
      alpha += ((act?.stopping ? 0.35 : act?.quiet ? 0.6 : 1) - alpha) * Math.min(1, dt * 3);
      paint();
    },
    still() {
      const act = clock.act;
      if (time === 0) time = 0.9;
      grow = 1;
      shape = goal(act);
      warn = act?.quiet ? 1 : 0;
      alpha = act?.stopping ? 0.35 : act?.quiet ? 0.6 : 1;
      clock.settle();
      paint();
    },
  };
}
