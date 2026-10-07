import type { ThinkingActivity } from "./activity";
import { palette, rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Onda" — three voice waves in the assistant's hues, the way a voice assistant draws itself
 * listening and speaking.
 *
 * The waves are pinned at both ends and swell in the middle, each at its own frequency and speed,
 * so they cross and part instead of moving as one. Their height is the phase: a steady swell while
 * the model thinks, a speech-like flutter while the answer streams, almost flat when the run has
 * gone quiet.
 */

const CURVES = [
  { freq: 1.6, speed: 3.1, phase: 0, weight: 1 },
  { freq: 2.3, speed: -2.4, phase: 1.7, weight: 0.75 },
  { freq: 1.1, speed: 1.8, phase: 3.4, weight: 0.6 },
];

export function createWave(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  let time = 0;
  let energy = 0.4;
  let activity: ThinkingActivity | undefined;

  function target(): number {
    if (activity?.done) return 0.12;
    if (activity?.stopping) return 0;
    if (activity?.quiet) return 0.08;
    switch (activity?.phase) {
      case "start":
        return 0.25;
      case "write":
        return 0.35 + 0.65 * Math.abs(Math.sin(time * 7.3) * Math.sin(time * 2.9));
      case "think":
      case "plan":
        return 0.6 + 0.2 * Math.sin(time * 1.4);
      default:
        return 0.45 + 0.15 * Math.sin(time * 2.2);
    }
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    ctx.clearRect(0, 0, px, px);
    const mid = px / 2;
    const left = px * 0.06;
    const width = px - left * 2;
    const height = px * 0.38 * energy;
    const steps = Math.max(16, Math.round(px * 1.5));
    const colors = [p.a, p.c, p.b];
    // On a dark ground the waves add up to light where they cross; on a light one that would wash
    // out to white, so they simply overlap.
    ctx.globalCompositeOperation = p.dark ? "lighter" : "source-over";
    ctx.lineCap = "round";
    CURVES.forEach((curve, i) => {
      ctx.beginPath();
      for (let s = 0; s <= steps; s++) {
        const nx = (s / steps) * 2 - 1;
        const envelope = Math.pow(1 - nx * nx, 2);
        const y =
          mid +
          Math.sin(nx * curve.freq * Math.PI + time * curve.speed + curve.phase) *
            envelope *
            height *
            curve.weight *
            (0.75 + 0.25 * Math.sin(time * 1.1 + i));
        const x = left + (s / steps) * width;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineWidth = Math.max(1, px / (i === 0 ? 16 : 22));
      ctx.strokeStyle = rgb(activity?.quiet ? p.warning : colors[i]);
      ctx.globalAlpha = activity?.stopping ? 0.3 : i === 0 ? 0.95 : 0.7;
      ctx.stroke();
    });
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  return {
    setActivity(next) {
      activity = next;
    },
    tick(dt) {
      time += dt;
      energy += (target() - energy) * Math.min(1, dt * 5);
      paint();
    },
    still() {
      if (time === 0) time = 0.8;
      energy = Math.max(0.35, target());
      paint();
    },
  };
}
