import { ended, type ThinkingActivity } from "./activity";
import { askBeat, askBlink, cueClock, hop, startle } from "./cue";
import { blink, INK, lookFor, sleepZ, soundIn, strokeEye, WHITE, type Gaze } from "./face";
import { listenLevel } from "./listen";
import { clamp01, easeOut, endColor, finishClock, makeBurst, rgba, TAU } from "./finish";
import { mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Cangrejo" — a crab in the shape of Ferris, Rust's mascot: CodeFlow's core is Rust, and this is
 * the nod to it (asked for 2026-10-08). A wide shell with a bumpy rim, two raised claws, little legs,
 * dot eyes and a smile — drawn in the assistant's hues like every other mark, so its green and red
 * endings still read.
 *
 * Crabs walk sideways, so this one does: reading, it scuttles slowly back and forth; working, it
 * scuttles fast and snaps its claws; writing, its claws tap like typing and it chatters; thinking,
 * it waves a claw now and then and looks around. Quiet, its claws come down and it dozes.
 * Listening (Codi), it stops walking and holds both claws up and open like cupped hands, leaning in
 * with its eyes wide on whoever speaks, its smile shut; each syllable it hears opens the claws a
 * little wider, and the sound comes in as arcs closing on them.
 *
 * Codi's cues: woken, it hops with its claws snapping up wide open, eyes on the viewer; asking, it
 * tilts its shell and taps one raised claw slowly, looking at the viewer and blinking twice now and
 * then.
 *
 * Finish: it hops, claps its claws twice, lands green and happy, and bubbles rise from it. Failed:
 * red, claws dropped, eyes X X, sinking a little.
 *
 * Below 20px the legs and the smile go; the shell, the claws and two eyes stay.
 */

export function createCrab(canvas: HTMLCanvasElement, px: number, gain = 1): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const cue = cueClock();
  const bubbles = makeBurst(7, 29);
  const detail = px >= 20;
  const u = (v: number) => v * px;
  let time = 0;
  let grow = 0;
  let lookX = 0;
  /** The pointer, when this mark follows it (`setGaze`). */
  let gaze: Gaze = null;
  let lookY = 0;
  let sleep = 0;
  let warn = 0;
  let alpha = 1;
  let mouth = 0;
  /** The sideways walk: where it is, and the step its legs are on. */
  let walkX = 0;
  let stride = 0;
  /** How high each claw is held (0 down by the shell, 1 raised) and how open (0 shut). */
  const raise = [0.7, 0.7];
  const open = [0.4, 0.4];
  /** Listening: how far into that look it is (0–1), and the microphone's level this frame. */
  let perk = 0;
  let hear = 0;

  const awake = (act: ThinkingActivity | undefined) => !ended(act) && !act?.quiet && !act?.stopping;
  const isFailed = (act: ThinkingActivity | undefined) => !!act?.failed;
  const phaseOf = (act: ThinkingActivity | undefined) => (awake(act) ? act?.phase : undefined);

  function claw(side: -1 | 1, lifted: number, gape: number, fill: string, lw: number) {
    if (!ctx) return;
    const base = { x: 0.5 + side * 0.25, y: 0.6 };
    const cx = 0.5 + side * (0.36 + 0.02 * lifted);
    const cy = 0.6 - 0.26 * lifted;
    // The arm.
    ctx.strokeStyle = fill;
    ctx.lineWidth = u(lw);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(u(base.x), u(base.y));
    ctx.quadraticCurveTo(u(cx + side * 0.04), u((base.y + cy) / 2 + 0.04), u(cx), u(cy + 0.03));
    ctx.stroke();
    // The pincer: a round palm and two fat jaws pointing up and out, parting by `gape`. Filled
    // shapes, not strokes — drawn as lines the jaws read as a fork.
    const dir = -Math.PI / 2 + side * 0.45;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(u(cx), u(cy), u(0.065), 0, TAU);
    ctx.fill();
    for (const jaw of [-1, 1]) {
      const a = dir + jaw * (0.2 + 0.5 * gape);
      ctx.beginPath();
      ctx.ellipse(u(cx + Math.cos(a) * 0.075), u(cy + Math.sin(a) * 0.075), u(0.068), u(0.033), a, 0, TAU);
      ctx.fill();
    }
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    const act = clock.act;
    const fin = clock.fin;
    const failed = clock.failed;
    ctx.clearRect(0, 0, px, px);

    let lift = 0;
    let sink = 0;
    if (fin >= 0 && !failed && fin < 0.55) lift = Math.sin((fin / 0.55) * Math.PI) * 0.12;
    if (failed && fin >= 0) sink = 0.05 * easeOut(fin / 0.5);
    const tint = fin >= 0 ? clamp01((fin - (failed ? 0 : 0.2)) / 0.4) : 0;
    const end = endColor(p, failed);
    const happy = !failed && !!act?.done && fin >= 0.3;
    const dazed = failed && fin >= 0.1;
    const tone = (h: Rgb) => rgba(mix(mix(h, end, tint), p.warning, warn * 0.3), alpha);
    const bob = Math.sin(time * 2.4) * 0.012 * (1 - sleep) * (1 - 0.8 * perk);
    // Listening, it leans in a little; woken, it hops. Asking, it tilts about the height of its
    // claws — about its middle, one claw would swing out of the square.
    const g = (0.4 + 0.6 * easeOut(grow)) * (1 + 0.02 * perk);
    const start = startle(cue.wake);
    const tilt = cue.ask * (0.07 + 0.04 * askBeat(time));
    lift += 0.05 * hop(cue.wake);

    ctx.save();
    ctx.translate(u(0.5 + walkX), u(0.62 - lift + sink + bob));
    ctx.scale(g, g);
    ctx.translate(-u(0.5), -u(0.62));
    if (tilt) {
      ctx.translate(u(0.5), u(0.38));
      ctx.rotate(tilt);
      ctx.translate(-u(0.5), -u(0.38));
    }

    // Legs, three a side, stepping with the walk.
    if (detail) {
      ctx.strokeStyle = tone(mix(p.b, INK, 0.15));
      ctx.lineWidth = Math.max(0.8, u(0.03));
      ctx.lineCap = "round";
      for (const side of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
          const step = Math.sin(stride + k * 2.1 + (side > 0 ? Math.PI : 0)) * 0.025;
          const x0 = 0.5 + side * (0.12 + k * 0.05);
          ctx.beginPath();
          ctx.moveTo(u(x0), u(0.74));
          ctx.quadraticCurveTo(u(x0 + side * 0.06), u(0.78 + step), u(x0 + side * 0.09), u(0.88 + step * 0.5));
          ctx.stroke();
        }
      }
    }

    // Claws behind the shell's shoulders.
    const clawFill = tone(mix(p.b, p.c, 0.35));
    claw(-1, raise[0], open[0], clawFill, 0.045);
    claw(1, raise[1], open[1], clawFill, 0.045);

    // The shell: a dome with Ferris's bumpy rim, over a flat underside.
    ctx.beginPath();
    const n = 42;
    for (let i = 0; i <= n; i++) {
      const th = Math.PI - (i / n) * Math.PI;
      const r = 1 + 0.07 * (0.5 + 0.5 * Math.cos(th * 14));
      const x = 0.5 + Math.cos(th) * 0.28 * r;
      const y = 0.64 - Math.sin(th) * 0.2 * r;
      if (i === 0) ctx.moveTo(u(x), u(y));
      else ctx.lineTo(u(x), u(y));
    }
    ctx.quadraticCurveTo(u(0.5), u(0.84), u(0.5 - 0.28 * 1.07), u(0.64));
    ctx.closePath();
    const grad = ctx.createLinearGradient(u(0.25), u(0.42), u(0.75), u(0.82));
    grad.addColorStop(0, tone(p.a));
    grad.addColorStop(1, tone(p.b));
    ctx.save();
    ctx.shadowColor = rgba(mix(p.a, end, tint), (p.dark ? 0.55 : 0.35) * alpha);
    // Brighter for each syllable it hears, and in the flash of a wake.
    ctx.shadowBlur = u(0.12 + 0.06 * Math.min(1, hear * gain) * perk + 0.1 * start);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // Eyes — wide while it listens, wider for a moment when woken — and Ferris's smile.
    const lid = act?.stopping ? 0.45 : cue.ask > 0.5 ? askBlink(time) : blink(time, 3.1);
    const wide = 1 + 0.18 * perk + 0.25 * start;
    for (const ex of [0.42, 0.58]) {
      const ey = 0.57;
      if (dazed) strokeEye(ctx, u(ex), u(ey), u(0.045), "x", rgba(INK, 0.9 * alpha), Math.max(1, u(0.03)));
      else if (happy) strokeEye(ctx, u(ex), u(ey), u(0.045), "happy", rgba(INK, 0.9 * alpha), Math.max(1, u(0.03)));
      else if (sleep > 0.5 || lid < 0.15) {
        strokeEye(ctx, u(ex), u(ey), u(0.042), "closed", rgba(INK, 0.8 * alpha), Math.max(0.8, u(0.026)));
      } else {
        ctx.fillStyle = rgba(INK, 0.95 * alpha);
        ctx.beginPath();
        ctx.ellipse(u(ex + lookX * 0.015), u(ey + lookY * 0.015), u(0.042 * wide), u(0.045 * lid * wide), 0, 0, TAU);
        ctx.fill();
        if (detail) {
          ctx.fillStyle = rgba(WHITE, 0.9 * alpha);
          ctx.beginPath();
          ctx.arc(u(ex + lookX * 0.015 - 0.013), u(ey + lookY * 0.015 - 0.015), u(0.013), 0, TAU);
          ctx.fill();
        }
      }
    }
    if (detail && !dazed) {
      ctx.strokeStyle = rgba(INK, 0.75 * alpha);
      ctx.fillStyle = rgba(INK, 0.75 * alpha);
      ctx.lineWidth = Math.max(0.8, u(0.022));
      ctx.lineCap = "round";
      ctx.beginPath();
      if (mouth > 0.05) {
        ctx.ellipse(u(0.5), u(0.665), u(0.035), u(0.03 * mouth + 0.006), 0, 0, TAU);
        ctx.fill();
      } else {
        ctx.moveTo(u(0.46), u(0.655));
        ctx.quadraticCurveTo(u(0.5), u(0.69), u(0.54), u(0.655));
        ctx.stroke();
      }
    }
    // Listening: what it hears, arcs closing in on each raised claw from straight above, landing in
    // its open pincer — from the sides they would leave the square, the claws reaching nearly to
    // its edges.
    const draw = Math.min(1.4, hear * gain) * perk;
    if (draw > 0.01) {
      const color = mix(mix(p.c, WHITE, p.dark ? 0.35 : 0), p.warning, warn * 0.3);
      for (const side of [-1, 1] as const) {
        const i = side < 0 ? 0 : 1;
        const x = u(0.5 + side * (0.36 + 0.02 * raise[i]));
        const y = u(0.6 - 0.26 * raise[i]);
        soundIn(ctx, x, y, u(0.17), u(0.08), -Math.PI / 2, 0.45, time + i * 0.4, draw * (1 - start) * alpha, color, Math.max(0.8, u(0.026)));
      }
    }
    ctx.restore();

    // Bubbles rising from the landing.
    if (!failed && fin > 0.4 && fin < 1.5) {
      const s = fin - 0.4;
      ctx.lineWidth = Math.max(0.6, u(0.018));
      for (const b of bubbles) {
        const x = u(0.5 + Math.cos(b.angle) * 0.22 + Math.sin(s * 6 + b.spin) * 0.02);
        const y = u(0.42 - s * 0.35 * b.speed);
        ctx.strokeStyle = rgba(mix(p.c, WHITE, 0.4), (1 - s / 1.1) * alpha);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.8, u(0.028 + 0.012 * b.kind)), 0, TAU);
        ctx.stroke();
      }
    }
    if (sleep > 0.5 && !ended(act)) sleepZ(ctx, px, time, mix(p.c, p.warning, 0.3), alpha);
  }

  function settle(act: ThinkingActivity | undefined, k: number) {
    const fin = clock.fin;
    const phase = phaseOf(act);
    // Listening, woken or asking, it looks at whoever it is with — the wake snapping its eyes there.
    const listening = phase === "listen";
    const facing = listening || cue.wake >= 0 || cue.ask > 0.5;
    const [tx, ty] = facing
      ? [0, 0]
      : gaze && !ended(act) && !act?.quiet && !act?.stopping
        ? gaze
        : phase
          ? lookFor(phase, time)
          : [0, 0];
    const snap = cue.wake >= 0 ? 40 : 10;
    lookX += (tx - lookX) * Math.min(1, k * snap);
    lookY += (ty - lookY) * Math.min(1, k * snap);
    perk += ((listening ? 1 : 0) - perk) * Math.min(1, k * 6);
    const hearing = Math.min(1, hear * gain);
    const resting = act?.quiet && !ended(act) ? 1 : 0;
    sleep += (resting - sleep) * Math.min(1, k * 3);
    warn += (resting - warn) * Math.min(1, k * 3);
    alpha += ((act?.stopping ? 0.35 : resting ? 0.6 : 1) - alpha) * Math.min(1, k * 3);
    const talking = phase === "write";
    const chatter = talking ? Math.max(0, Math.sin(time * 9)) * Math.abs(Math.sin(time * 2.6)) : 0;
    mouth += (chatter - mouth) * Math.min(1, k * 20);

    // Where the walk wants it: sideways, slow for reading, quick for work, home otherwise.
    const reading = phase === "read" || phase === "search";
    const working = phase === "edit" || phase === "run" || phase === "tool";
    const walkGoal = reading ? Math.sin(time * 1.2) * 0.07 : working ? Math.sin(time * 3.4) * 0.06 : 0;
    walkX += (walkGoal - walkX) * Math.min(1, k * 6);

    // The claws: what each is held at and how open, by state.
    for (const i of [0, 1]) {
      let r = 0.65;
      let o = 0.35;
      if (isFailed(act)) {
        r = 0;
        o = 0.1;
      } else if (act?.done) {
        r = 1;
        // Two claps after the hop.
        o = fin > 0.55 && fin < 1.15 ? 0.5 + 0.5 * Math.cos((fin - 0.55) * 21) : 0.6;
      } else if (resting || act?.stopping) {
        r = 0.05;
        o = 0.1;
      } else if (cue.wake >= 0) {
        // Woken: both claws snap up, open.
        r = 1;
        o = 0.75;
      } else if (cue.ask > 0.5 && i === 1) {
        // Asking: one claw raised high, tapping slowly on the beat — "well?".
        r = 0.95;
        o = 0.1 + 0.25 * askBeat(time);
      } else if (listening) {
        // Up and open like cupped hands, opening wider with what it hears.
        r = 0.9;
        o = 0.3 + 0.25 * hearing;
      } else if (working) {
        r = 0.75;
        o = 0.5 + 0.5 * Math.sin(time * 14 + i * Math.PI);
      } else if (talking) {
        // Tapping, like typing — one claw, then the other.
        r = 0.45 + 0.25 * Math.max(0, Math.sin(time * 10 + i * Math.PI));
        o = 0.2;
      } else {
        // A wave every few seconds, the claws taking turns.
        const w = (time + i * 1.6) % 3.2;
        r = w < 0.6 ? 0.65 + 0.35 * Math.sin((w / 0.6) * Math.PI) : 0.65;
        o = 0.35 + (w < 0.6 ? 0.3 * Math.sin((w / 0.6) * TAU * 2) : 0);
      }
      raise[i] += (r - raise[i]) * Math.min(1, k * 12);
      open[i] += (o - open[i]) * Math.min(1, k * 18);
    }
  }

  return {
    setGaze(next) {
      gaze = next;
    },
    setActivity(activity) {
      clock.set(activity);
      cue.set(activity);
    },
    tick(dt) {
      clock.step(dt);
      cue.step(dt);
      const act = clock.act;
      time += dt * (act?.quiet && !ended(act) ? 0.5 : 1);
      grow += (1 - grow) * Math.min(1, dt * 3);
      const phase = phaseOf(act);
      const walking = phase === "read" || phase === "search" || phase === "edit" || phase === "run" || phase === "tool";
      stride += dt * (walking ? 12 : 2);
      hear = phase === "listen" ? listenLevel() : 0;
      settle(act, dt);
      paint();
    },
    still() {
      const act = clock.act;
      if (time === 0) time = 1.1;
      grow = 1;
      // A still frame of listening is mid-word: claws up and open, arcs on their way in.
      hear = phaseOf(act) === "listen" ? 0.7 : 0;
      cue.settle();
      settle(act, 1);
      clock.settle();
      paint();
    },
  };
}
