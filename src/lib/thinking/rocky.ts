import { ended, phaseGroup, type ThinkingActivity } from "./activity";
import { askBeat, cueClock, hop, startle } from "./cue";
import { WHITE, type Gaze } from "./face";
import { clamp01, easeOut, endColor, finishClock, makeBurst, rgba, TAU } from "./finish";
import { listenLevel } from "./listen";
import { mix, palette, rgb } from "./palette";
import { easeToward, toward } from "./pointer";
import { prepareCanvas, type Painter } from "./ticker";

type Point = readonly [x: number, y: number, z: number];
type Projected = { x: number; y: number; view: Point };
type Facet = { points: Projected[]; depth: number; light: number; tone: number; moss: boolean };

const RING = [1, 0.93, 1.04, 0.94, 1, 0.91, 1.04].map((radius, i, ring) => {
  const angle = (i / ring.length) * TAU;
  return [Math.sin(angle) * radius, Math.cos(angle) * radius] as const;
});
const LEGS = Array.from({ length: 5 }, (_, i) => {
  const angle = i * TAU / 5;
  return { x: Math.sin(angle), z: Math.cos(angle) };
});
const LIMB_PROFILE = [[0, 0.63], [0.2, 1], [0.7, 0.94], [1, 0.66]] as const;
const SHELL_PROFILE = [[0.225, 0.11], [0.32, 0.225], [0.43, 0.28], [0.515, 0.24], [0.56, 0.145]] as const;
const FOOTFALLS = [0, 0.53, 0.18, 0.73, 0.36];
const STANCE = 0.64;

/** Rocky's stone plates and five jointed legs are projected onto the shared 2D canvas. */
export function createRocky(canvas: HTMLCanvasElement, px: number, gain = 1): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const cue = cueClock();
  const look = toward();
  const sparks = makeBurst(8, 31);
  const detail = px >= 28;
  let gaze: Gaze = null;
  let time = 0.8;
  let gait = 0;
  let walking = 0;
  let rest = 0;
  let resonance = 0;

  function active(act: ThinkingActivity | undefined) {
    return !ended(act) && !act?.quiet && !act?.stopping;
  }

  function settle(dt: number) {
    const act = clock.act;
    const running = active(act);
    const phase = phaseGroup(act?.phase);
    const reach = gaze ? Math.min(1, Math.hypot(gaze[0], gaze[1])) : 0;
    const pace = phase === "work" ? 1 : phase === "write" ? 0.63 : phase === "listen" ? 0.12 : 0.3;
    const steps = running ? Math.max(pace, reach * 0.92) : 0;
    const resting = act?.quiet || act?.stopping ? 1 : 0;
    const pulse = !running ? 0 : phase === "listen" ? clamp01(listenLevel() * gain)
      : phase === "write" ? (0.5 + Math.sin(time * 11) * 0.5) * 0.66 : 0;
    const k = Math.min(1, dt * 8);
    walking += (steps - walking) * k;
    rest += (resting - rest) * k;
    resonance += (pulse - resonance) * k;
    easeToward(look, running ? gaze : null, dt, 7);
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    const { act, failed, fin } = clock;
    const finish = fin < 0 ? 0 : easeOut(fin / 0.55);
    const success = !failed && fin >= 0;
    const jump = success && fin < 0.62 ? Math.sin(Math.PI * fin / 0.62) * 0.068 : 0;
    const woken = startle(cue.wake);
    const lift = jump + hop(cue.wake) * 0.048;
    const phase = phaseGroup(act?.phase);
    const scan = active(act) && phase === "read" ? Math.sin(time * 3.6) * 0.18 : 0;
    const yaw = 0.28 + Math.sin(time * 1.5) * 0.17 + scan + look.x * 0.8 + cue.ask * 0.19;
    const pitch = 0.33 - look.y * 0.16 + cue.ask * (0.04 + askBeat(time) * 0.08);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const bodyX = Math.sin(gait * TAU) * walking * 0.012;
    const bodyY = Math.sin(gait * TAU * 2) * walking * 0.014 - rest * 0.058 - (failed ? 0.10 * finish : 0);
    const leanX = look.x * 0.026;
    const leanY = look.y * 0.015;
    const size = px * 0.94;
    const alpha = 1 - rest * 0.21 - (failed ? finish * 0.12 : 0);

    ctx.clearRect(0, 0, px, px);
    ctx.save();
    ctx.translate(px * (0.5 + leanX), px * (0.75 + leanY));
    ctx.scale(1, 0.31);
    const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, px * 0.45);
    shadow.addColorStop(0, rgba(mix(p.surface, [20, 14, 24], 0.9), (p.dark ? 0.53 : 0.24) * (1 - lift * 5)));
    shadow.addColorStop(1, rgba(p.surface, 0));
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.arc(0, 0, px * 0.45, 0, TAU);
    ctx.fill();
    ctx.restore();

    function project([x, y, z]: Point): Projected {
      const height = y + lift - 0.24;
      const forward = z * cy - x * sy;
      const across = x * cy + z * sy;
      const up = height * cp - forward * sp;
      const depth = height * sp + forward * cp;
      const scale = size * (1 + depth * 0.17);
      return { x: px * (0.5 + leanX) + across * scale, y: px * (0.51 + leanY) - up * scale, view: [across, up, depth] };
    }

    const facets: Facet[] = [];
    function facet(points: Projected[], tone: number, moss: boolean) {
      const a = points[0].view, b = points[1].view, c = points[2].view;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nz = ux * vy - uy * vx;
      if (nz <= 0.000001) return;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz;
      const light = (-nx * 0.44 + ny * 0.72 + nz * 0.54) / Math.hypot(nx, ny, nz);
      const depth = points.reduce((sum, point) => sum + point.view[2], 0) / points.length;
      facets.push({ points, depth, light, tone, moss });
    }

    function stone(rings: Projected[][], tone: number, moss: number, shell = false) {
      facet([...rings[0]].reverse(), tone - 0.06, false);
      for (let row = 1; row < rings.length; row++) {
        const bottom = rings[row - 1];
        const top = rings[row];
        for (let i = 0; i < RING.length; i++) {
          const next = (i + 1) % RING.length;
          const material = shell && row === 2 ? -0.13 : 0;
          const variation = ((i * 5 + row * 3) % 7 - 3) * 0.025;
          facet([bottom[i], bottom[next], top[next], top[i]], tone + variation + material, i === moss && row !== 2);
        }
      }
      facet(rings[rings.length - 1], tone + 0.05, shell);
    }

    stone(SHELL_PROFILE.map(([height, r]) => RING.map(([x, z]) => project([x * r + bodyX, height + bodyY, z * r * 0.9]))), 0.07, 0, true);

    LEGS.forEach(({ x, z }, i) => {
      // Each foot spends most of its cycle on the ground. During the swing it lifts and reaches
      // forward while the other legs carry the body. The staggered footfalls keep it from hopping.
      const phase = (gait + FOOTFALLS[i]) % 1;
      const swing = Math.max(0, (phase - STANCE) / (1 - STANCE));
      const reach = phase < STANCE ? 1 - 2 * phase / STANCE : -Math.cos(swing * Math.PI);
      const stride = reach * walking * 0.046;
      const rise = Math.sin(swing * Math.PI) * walking * 0.085;
      const foot = 0.432 + rest * 0.018;
      const knee = 0.373 + rise * 0.16;
      const jointY = 0.253 + bodyY * 0.6 + rise * 0.42;
      const footAt: Point = [x * foot + stride * look.x * 0.35, 0.028 + rise, z * foot + stride];
      const kneeAt: Point = [x * knee + bodyX * 0.55, jointY, z * knee + stride * 0.28];
      const shoulder: Point = [x * 0.225 + bodyX, 0.421 + bodyY, z * 0.225];
      // Each lower segment pivots around its knee while the upper segment connects to the shell.
      function limb(from: Point, to: Point, thickness: number) {
        const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
        const horizontal = Math.hypot(dx, dz);
        const length = Math.hypot(horizontal, dy);
        const sideX = horizontal > 0.001 ? -dz / horizontal : z;
        const sideZ = horizontal > 0.001 ? dx / horizontal : -x;
        const rimX = -sideZ * dy / length;
        const rimY = (sideZ * dx - sideX * dz) / length;
        const rimZ = sideX * dy / length;
        return LIMB_PROFILE.map(([along, taper]) => RING.map(([side, rim]) => {
          const r = thickness * taper;
          return project([
            from[0] + dx * along + (side * sideX + rim * rimX) * r,
            from[1] + dy * along + rim * rimY * r,
            from[2] + dz * along + (side * sideZ + rim * rimZ) * r,
          ]);
        }));
      }
      stone(limb(footAt, [kneeAt[0], jointY - 0.008, kneeAt[2]], 0.077), 0.005, (i + 2) % RING.length);
      stone(limb([kneeAt[0], jointY + 0.004, kneeAt[2]], shoulder, 0.069), -0.04, (i + 4) % RING.length);
    });

    const end = endColor(p, failed);
    const shade = mix(mix([65, 43, 35], p.a, 0.11), end, finish * 0.41);
    const stoneColor = mix([169, 125, 86], end, finish * (failed ? 0.65 : 0.37));
    const sun = mix([249, 215, 171], end, finish * 0.55);
    const green = mix(mix([45, 133, 84], p.c, 0.26 + resonance * 0.42), end, finish * 0.84);
    facets.sort((a, b) => a.depth - b.depth);
    ctx.globalAlpha = alpha;
    ctx.lineJoin = "round";
    ctx.lineWidth = 0.45;
    for (const { points, light, tone, moss } of facets) {
      const brightness = clamp01(0.39 + light * 0.55 + tone + woken * 0.09);
      ctx.fillStyle = rgb(brightness < 0.55 ? mix(shade, stoneColor, brightness / 0.55) : mix(stoneColor, sun, (brightness - 0.55) / 0.45));
      ctx.strokeStyle = ctx.fillStyle;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (!moss) continue;
      const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      const radius = px * (points.length > 4 ? 0.031 : 0.019) * (0.86 + resonance * 0.28);
      ctx.fillStyle = rgba(mix(green, WHITE, clamp01(light) * 0.36 + resonance * 0.21), 0.93);
      ctx.beginPath();
      ctx.ellipse(x, y, radius, radius * 0.73, -0.28, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (detail && success && fin > 0.2 && fin < 1.2) {
      const elapsed = fin - 0.2;
      for (const spark of sparks) {
        const r = px * easeOut(elapsed) * 0.47 * spark.speed;
        ctx.fillStyle = rgba(mix(end, WHITE, 0.42), 1 - elapsed);
        ctx.beginPath();
        ctx.arc(px * 0.5 + Math.cos(spark.angle) * r, px * 0.48 + Math.sin(spark.angle) * r * 0.7, px * 0.017, 0, TAU);
        ctx.fill();
      }
    }
  }

  return {
    setGaze(next) { gaze = next; },
    setActivity(activity) {
      clock.set(activity);
      cue.set(activity);
    },
    tick(dt) {
      clock.step(dt);
      cue.step(dt);
      time += dt;
      gait = (gait + dt * (0.55 + walking * 1.38)) % 1;
      settle(dt);
      paint();
    },
    still() {
      cue.settle();
      clock.settle();
      settle(1);
      paint();
    },
  };
}
