import { ended, phaseGroup, type PhaseGroup } from "./activity";
import { askBlink, cueClock, hop, startle } from "./cue";
import { blink, INK, lipSync, lookFor, strokeEye, WHITE, type Gaze } from "./face";
import { clamp01, easeOut, endColor, finishClock, rgba, TAU } from "./finish";
import { listenLevel } from "./listen";
import { mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";
import { voiceLevel } from "./voice";
import { contactShadow, faceAt, material } from "./volume";

const SWIM_SPEED: Record<PhaseGroup, number> = { think: 2.6, read: 1.8, work: 7, write: 4.2, listen: 1.25 };

/** A swimming axolotl. The tail leads the paddle, the gills lag behind the head, and the
 * eyes follow the curve of the face as it turns to look at the pointer. */
export function createAxolotl(canvas: HTMLCanvasElement, px: number, gain = 1): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const cue = cueClock();
  const detail = px >= 22;
  const u = (value: number) => value * px;
  let time = 0;
  let stroke = 0;
  let gaze: Gaze = null;
  let lookX = 0;
  let lookY = 0;
  let energy = 0;
  let speech = 0;

  function paint() {
    if (!ctx) return;
    ctx.clearRect(0, 0, px, px);

    const p = palette();
    const act = clock.act;
    const fin = clock.fin;
    const resting = !!(act?.quiet || act?.stopping);
    const failed = clock.failed;
    const tint = fin >= 0 ? easeOut(fin / 0.64) : 0;
    const end = endColor(p, failed);
    const skin = mix(mix(p.b, p.c, 0.38), end, tint * 0.85);
    const light = mix(mix(p.c, WHITE, 0.68), mix(end, WHITE, 0.45), tint);
    const shade = mix(mix(p.a, INK, 0.32), mix(end, INK, 0.38), tint);
    const gill = mix(mix(p.a, p.b, 0.23), end, tint * 0.88);
    const alpha = act?.stopping ? 0.42 : act?.quiet ? 0.74 : 1;
    const alert = startle(cue.wake);
    const lift = fin < 0 ? 0.038 * hop(cue.wake) : failed ? -0.05 * tint : 0.06 * Math.sin(Math.PI * clamp01(fin / 0.64));
    const swim = resting || fin >= 0 ? 0.2 : 1;
    const turn = lookX * 0.32 + Math.sin(stroke) * 0.042 * swim;
    const pitch = lookY * 0.032;
    const tailBeat = Math.sin(stroke - 0.8) * (0.088 * swim + 0.026 * energy);
    const bob = Math.sin(stroke * 0.8) * 0.019 * swim;

    if (detail) contactShadow(ctx, u(0.5), u(0.887), u(0.29), shade, (p.dark ? 0.35 : 0.2) * alpha);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(u(0.5 + lookX * 0.015), u(0.46 + bob - lift));
    ctx.rotate(0.043 * lookX + 0.07 * cue.ask + 0.022 * Math.sin(stroke) * swim);
    ctx.translate(-u(0.5), -u(0.46));

    const rounded = (x: number, y: number, width: number, height: number, color: Rgb, angle = 0) => {
      ctx.save();
      ctx.translate(u(x), u(y));
      ctx.rotate(angle);
      ctx.scale(1, height / width);
      ctx.fillStyle = material(ctx, 0, 0, u(width), [mix(light, color, 0.12), color, mix(color, shade, 0.75)], 1, turn);
      ctx.beginPath();
      ctx.arc(0, 0, u(width), 0, TAU);
      ctx.fill();
      ctx.restore();
    };

    // From the front the tail trails behind the belly. Its narrow fin swings below the feet.
    const tailTipX = 0.5 + tailBeat * 1.85;
    const tail = ctx.createLinearGradient(u(0.46), u(0.66), u(tailTipX), u(0.87));
    tail.addColorStop(0, rgba(shade, 1));
    tail.addColorStop(0.55, rgba(skin, 1));
    tail.addColorStop(1, rgba(mix(light, gill, 0.45), 1));
    ctx.fillStyle = tail;
    ctx.beginPath();
    ctx.moveTo(u(0.447), u(0.65));
    ctx.bezierCurveTo(u(0.44 + tailBeat * 0.3), u(0.77), u(tailTipX - 0.04), u(0.835), u(tailTipX), u(0.878));
    ctx.bezierCurveTo(u(tailTipX + 0.03), u(0.815), u(0.568 + tailBeat), u(0.76), u(0.55), u(0.65));
    ctx.closePath();
    ctx.fill();

    for (const side of [-1, 1]) {
      rounded(0.5 + side * 0.103, 0.741 + side * tailBeat * 0.12, 0.063, 0.032, mix(skin, shade, 0.34), side * 0.68);
    }
    rounded(0.5, 0.607, 0.143, 0.161, mix(skin, shade, 0.16));
    for (const side of [-1, 1]) {
      rounded(0.5 + side * 0.134, 0.662 - side * tailBeat * 0.14, 0.076, 0.042, skin, side * (0.78 + tailBeat));
    }

    // Three gills per side. The far fan shortens and darkens as the face turns.
    ctx.lineCap = "round";
    for (const side of [-1, 1]) {
      const near = side * turn;
      const rootX = 0.5 + side * (0.185 + 0.038 * near);
      const stem = mix(gill, shade, Math.max(0, -near) * 0.64);
      for (let index = 0; index < 3; index++) {
        const flutter = Math.sin(stroke * 1.18 - side * 0.58 - index * 0.61);
        const length = 1 + near * 0.22;
        const baseY = 0.385 + index * 0.041;
        const reach = (0.064 + index * 0.034) * length;
        const tipX = rootX + side * (reach + flutter * 0.016 * swim);
        const tipY = baseY - (0.181 - index * 0.052) * length + flutter * (0.015 + 0.012 * energy) * swim;
        const middleX = tipX - side * 0.031;
        const middleY = (baseY + tipY) / 2 - 0.025;
        if (detail) {
          ctx.strokeStyle = rgba(mix(stem, light, 0.17 + energy * 0.19), 0.9);
          ctx.lineWidth = u(0.016);
          for (const step of [0.48, 0.68, 0.87]) {
            const x = rootX + (tipX - rootX) * step;
            const y = baseY + (tipY - baseY) * step - 0.014;
            ctx.beginPath();
            ctx.moveTo(u(x), u(y));
            ctx.quadraticCurveTo(u(x + side * 0.013), u(y - 0.027), u(x + side * 0.032), u(y - 0.024));
            ctx.stroke();
          }
        }
        const plume = ctx.createLinearGradient(u(rootX), u(baseY), u(tipX), u(tipY));
        plume.addColorStop(0, rgba(mix(stem, shade, 0.33), 1));
        plume.addColorStop(1, rgba(mix(stem, mix(p.c, light, 0.2), 0.64 + energy * 0.16), 1));
        ctx.strokeStyle = plume;
        ctx.lineWidth = u(detail ? 0.036 : 0.044);
        ctx.beginPath();
        ctx.moveTo(u(rootX), u(baseY));
        ctx.quadraticCurveTo(u(middleX), u(middleY), u(tipX), u(tipY));
        ctx.stroke();
      }
    }

    rounded(0.5, 0.455, 0.242, 0.178 + alert * 0.014, skin);

    const eyesOpen = act?.quiet ? 0 : cue.ask > 0.5 ? askBlink(time) : blink(time, 3.3);
    for (const side of [-1, 1]) {
      const { x, y, width } = faceAt(0.5 + side * 0.091, 0.455, 0.185, turn, pitch);
      if (eyesOpen < 0.2 || fin >= 0.29) {
        strokeEye(ctx, u(x), u(y), u(0.028 * width), fin >= 0.29 ? (failed ? "x" : "happy") : "closed", rgba(INK, 0.88), u(0.024));
      } else {
        const radius = 0.035 * width;
        ctx.fillStyle = rgba(INK, 1);
        ctx.beginPath();
        ctx.ellipse(u(x), u(y), u(radius), u(0.038 * eyesOpen), 0, 0, TAU);
        ctx.fill();
        if (detail && eyesOpen > 0.65) {
          ctx.fillStyle = rgba(WHITE, 0.94);
          ctx.beginPath();
          ctx.arc(u(x - 0.009 + lookX * 0.011), u(y - 0.012 + lookY * 0.009), u(0.009), 0, TAU);
          ctx.fill();
        }
      }
    }

    const mouth = faceAt(0.5, 0.52, 0.17, turn, pitch);
    const mouthX = mouth.x;
    const mouthWidth = 0.046 * mouth.width;
    ctx.strokeStyle = rgba(mix(INK, shade, 0.22), 0.94);
    ctx.lineWidth = u(0.018);
    ctx.beginPath();
    if (speech > 0.12) {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.ellipse(u(mouthX), u(mouth.y + 0.007), u(mouthWidth * 0.75), u(0.01 + speech * 0.022), 0, 0, TAU);
      ctx.fill();
    } else {
      ctx.moveTo(u(mouthX - mouthWidth), u(mouth.y));
      ctx.quadraticCurveTo(u(mouthX), u(mouth.y + (failed ? -0.026 : 0.034)), u(mouthX + mouthWidth), u(mouth.y));
      ctx.stroke();
    }
    ctx.restore();
  }

  function update(dt: number, still = false) {
    const act = clock.act;
    const awake = !ended(act) && !act?.quiet && !act?.stopping;
    const group = phaseGroup(act?.phase);
    const target = !awake || cue.ask > 0.5 ? [0, 0] : gaze ?? lookFor(act?.phase, time);
    const follow = Math.min(1, dt * 7);
    lookX += (target[0] - lookX) * follow;
    lookY += (target[1] - lookY) * follow;
    const level = awake && group === "listen" ? (still ? 0.5 : listenLevel()) : 0;
    energy += (clamp01(level * gain) - energy) * follow;
    const voice = !awake || group !== "write" ? 0 : act?.phase === "speak" ? lipSync(voiceLevel()) : (1 + Math.sin(time * 11)) * 0.37;
    speech += (clamp01(voice * gain) - speech) * follow;
    if (!still) stroke += dt * (awake ? SWIM_SPEED[group] + energy * 3 : 0.75);
  }

  return {
    setGaze(next) { gaze = next; },
    setActivity(activity) {
      clock.set(activity);
      cue.set(activity);
    },
    tick(dt) {
      time += dt;
      clock.step(dt);
      cue.step(dt);
      update(dt);
      paint();
    },
    still() {
      clock.settle();
      cue.settle();
      update(1, true);
      paint();
    },
  };
}
