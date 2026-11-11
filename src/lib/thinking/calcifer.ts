import type { CharacterPose } from "./cinemaCharacters";
import { rgba, TAU } from "./finish";
import { mix, type Rgb } from "./palette";

type Point = readonly [number, number];
type Curve = readonly [number, number, number, number, number, number];
type Flame = readonly [Point, ...Curve[]];

const OUTER: Flame = [
  [-0.27, -0.012],
  [-0.41, -0.058, -0.44, -0.216, -0.367, -0.329],
  [-0.37, -0.261, -0.315, -0.264, -0.316, -0.387],
  [-0.315, -0.478, -0.252, -0.515, -0.261, -0.591],
  [-0.212, -0.564, -0.205, -0.521, -0.215, -0.472],
  [-0.14, -0.497, -0.17, -0.604, -0.078, -0.646],
  [-0.025, -0.676, -0.002, -0.709, -0.025, -0.755],
  [0.111, -0.703, 0.015, -0.576, 0.131, -0.544],
  [0.182, -0.53, 0.215, -0.577, 0.178, -0.622],
  [0.32, -0.565, 0.204, -0.414, 0.315, -0.371],
  [0.35, -0.353, 0.373, -0.389, 0.363, -0.425],
  [0.435, -0.342, 0.402, -0.236, 0.419, -0.187],
  [0.45, -0.063, 0.317, 0.017, 0.215, 0.021],
  [0.076, 0.041, -0.158, 0.029, -0.27, -0.012],
];

const INNER: Flame = [
  [-0.278, -0.031],
  [-0.371, -0.095, -0.354, -0.214, -0.296, -0.276],
  [-0.28, -0.308, -0.281, -0.345, -0.283, -0.381],
  [-0.252, -0.353, -0.233, -0.341, -0.211, -0.362],
  [-0.141, -0.403, -0.196, -0.482, -0.077, -0.545],
  [-0.099, -0.445, 0.005, -0.417, 0.07, -0.441],
  [0.119, -0.458, 0.125, -0.495, 0.114, -0.523],
  [0.207, -0.467, 0.151, -0.374, 0.263, -0.323],
  [0.306, -0.302, 0.326, -0.29, 0.345, -0.312],
  [0.347, -0.237, 0.4, -0.188, 0.366, -0.102],
  [0.319, 0.038, -0.155, 0.038, -0.278, -0.031],
];

const COLORS = {
  edge: [208, 56, 22], outer: [248, 87, 29], inner: [255, 152, 41],
  gold: [255, 194, 66], white: [255, 248, 218], pupil: [43, 27, 23],
  mouth: [100, 31, 22], tongue: [243, 91, 59],
  bark: [80, 43, 37], wood: [132, 66, 43], end: [188, 103, 56],
  ember: [246, 106, 38],
} satisfies Record<string, Rgb>;

function flamePath(ctx: CanvasRenderingContext2D, [start, ...curves]: Flame, time: number, flutter: number) {
  function move(x: number, y: number): Point {
    // The face stays anchored while the individual tongues of fire change shape.
    const weight = Math.max(0, -y - 0.19);
    return [
      x + Math.sin(time * 8.4 + x * 14 + y * 5) * flutter * weight,
      y + Math.sin(time * 11.6 - x * 13 + y * 8) * flutter * weight,
    ];
  }

  ctx.beginPath();
  ctx.moveTo(...move(...start));
  for (const [x1, y1, x2, y2, x, y] of curves) {
    ctx.bezierCurveTo(...move(x1, y1), ...move(x2, y2), ...move(x, y));
  }
  ctx.closePath();
}

export function paintCalcifer(ctx: CanvasRenderingContext2D, px: number, pose: CharacterPose, tint: Rgb, amount: number, alpha: number) {
  const color = (value: Rgb) => rgba(mix(value, tint, amount), alpha);
  const voice = pose.speak * pose.signal;
  const heat = Math.max(pose.work, pose.write, voice, pose.done);
  const flicker = Math.floor(pose.time * 18) / 18;
  const height = 1 - pose.quiet * 0.27 - pose.failed * 0.12 + voice * 0.075 + pose.done * 0.065;
  const lean = pose.gazeX * 0.036 + Math.sin(pose.time * 3.2) * pose.read * 0.032;

  ctx.save();
  ctx.scale(px, px);
  ctx.translate(0.5, 0.817);
  ctx.scale(0.93, 0.93);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.save();
  ctx.rotate(-0.095);
  ctx.fillStyle = color(COLORS.bark);
  ctx.beginPath();
  ctx.moveTo(-0.353, -0.032);
  ctx.lineTo(0.356, -0.047);
  ctx.lineTo(0.384, 0.018);
  ctx.lineTo(0.342, 0.076);
  ctx.lineTo(-0.351, 0.085);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = color(COLORS.wood);
  ctx.beginPath();
  ctx.moveTo(-0.349, -0.025);
  ctx.lineTo(0.354, -0.04);
  ctx.lineTo(0.371, -0.009);
  ctx.lineTo(0.237, 0.007);
  ctx.lineTo(0.183, 0.036);
  ctx.lineTo(0.078, 0.022);
  ctx.lineTo(-0.044, 0.056);
  ctx.lineTo(-0.347, 0.051);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = color(COLORS.end);
  ctx.beginPath();
  ctx.ellipse(-0.348, 0.025, 0.032, 0.056, -0.12, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = color(COLORS.ember);
  ctx.lineWidth = 0.009;
  ctx.beginPath();
  ctx.moveTo(-0.271, 0.026);
  ctx.lineTo(-0.164, 0.015);
  ctx.lineTo(-0.11, 0.024);
  ctx.lineTo(-0.035, 0.009);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.rotate(lean);
  ctx.scale(1, height);
  const flutter = (0.042 + heat * 0.045) * (1 - pose.quiet * 0.82);
  ctx.fillStyle = color(COLORS.outer);
  ctx.strokeStyle = color(COLORS.edge);
  ctx.lineWidth = 0.009;
  flamePath(ctx, OUTER, flicker, flutter);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color(COLORS.inner);
  flamePath(ctx, INNER, flicker, flutter);
  ctx.fill();

  const blink = pose.time % 4.4;
  const eyeOpening = pose.quiet ? 0.1 : blink < 0.16 ? 0.12 + Math.abs(blink - 0.08) * 11 : 1;
  for (const side of [-1, 1]) {
    const x = side * 0.103;
    const y = side === -1 ? -0.228 : -0.247;
    ctx.fillStyle = color(COLORS.white);
    ctx.beginPath();
    ctx.ellipse(x, y, 0.092 + pose.listen * 0.005, 0.089 * eyeOpening + pose.listen * 0.006, side * 0.12, 0, TAU);
    ctx.fill();
    ctx.fillStyle = color(COLORS.pupil);
    ctx.beginPath();
    ctx.ellipse(x + 0.012 + pose.gazeX * 0.027, y + pose.gazeY * 0.019 * eyeOpening, 0.042, 0.053 * eyeOpening, 0, 0, TAU);
    ctx.fill();
  }

  const mouthY = -0.106;
  const opening = 0.012 + voice * 0.054 + pose.done * 0.025;
  const smile = 0.026 + pose.done * 0.02 - pose.failed * 0.044;
  ctx.fillStyle = color(COLORS.mouth);
  ctx.beginPath();
  ctx.moveTo(-0.062, mouthY);
  ctx.quadraticCurveTo(0.003, mouthY + smile - opening, 0.079, mouthY - 0.012);
  ctx.quadraticCurveTo(0.02, mouthY + smile + opening, -0.062, mouthY);
  ctx.fill();
  if (opening > 0.03) {
    ctx.fillStyle = color(COLORS.tongue);
    ctx.beginPath();
    ctx.ellipse(0.012, mouthY + smile * 0.67 + opening * 0.48, 0.028, opening * 0.18, 0, 0, TAU);
    ctx.fill();
  }

  ctx.fillStyle = color(COLORS.gold);
  for (const side of [-1, 1]) {
    const reach = Math.sin(pose.time * 6 + side) * heat * 0.017;
    ctx.beginPath();
    ctx.moveTo(side * 0.24, -0.07);
    ctx.quadraticCurveTo(side * 0.317, -0.045, side * 0.295, 0.023 + reach);
    ctx.quadraticCurveTo(side * 0.269, 0.054 + reach, side * 0.245, 0.012 + reach);
    ctx.quadraticCurveTo(side * 0.237, -0.026, side * 0.207, -0.046);
    ctx.fill();
  }
  ctx.restore();

  if (heat > 0.05 && px >= 32) {
    ctx.fillStyle = color(COLORS.gold);
    for (let i = 0; i < 3; i++) {
      const rise = (pose.time * 0.63 + i / 3) % 1;
      const x = (i - 1) * 0.29 + Math.sin(rise * 4 + i) * 0.047;
      ctx.beginPath();
      ctx.arc(x, -0.37 - rise * 0.37, (1 - rise) * 0.014 * heat, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}
