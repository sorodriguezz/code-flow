import { ended } from "./activity";
import { aiCycle, clamp01, finishClock, rgba, TAU } from "./finish";
import { mix, palette } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Píxeles" — a small dot-matrix display (7×7, 5×5 at 14px) with a face.
 *
 * While the model thinks the face looks around and blinks, its mouth pulled to one side; reading,
 * a column sweeps across like an eye down a page; editing, ripples spread from the middle;
 * writing, a wave runs through it; starting, light spreads out from the centre. Quiet, the face
 * falls asleep and a "z" floats up out of the corner.
 *
 * Finish: a big ^‿^ smile, a wink, and the face itself turns green along a diagonal wipe. The face
 * stays: it used to be wiped away into a green tick, dropped at the user's ask (2026-10-08) for the
 * smiling face going green. Failed: X X eyes over a frown, and that face wipes to red.
 */

type Cell = readonly [col: number, row: number];

const LOOK = [0, 0, -1, -1, 0, 1, 1, 0, 0, 1, -1, 0];

export function createPixels(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const G = px < 18 ? 5 : 7;
  const mid = (G - 1) / 2;
  const level = new Float32Array(G * G);
  const want = new Float32Array(G * G);
  /** Per LED: 0 the AI hues, 1 green (the finish), 2 the sleepy warning tint, 3 red (a failure). */
  const tone = new Uint8Array(G * G);
  const clock = finishClock();
  const HAPPY: { left: Cell[]; right: Cell[]; wink: Cell[]; mouth: Cell[] } =
    G === 7
      ? {
          left: [[0, 3], [1, 2], [2, 3]],
          right: [[4, 3], [5, 2], [6, 3]],
          wink: [[0, 3], [1, 3], [2, 3]],
          mouth: [[1, 5], [2, 6], [3, 6], [4, 6], [5, 5]],
        }
      : {
          left: [[1, 1]],
          right: [[3, 1]],
          wink: [[0, 1], [1, 1]],
          mouth: [[0, 3], [1, 4], [2, 4], [3, 4], [4, 3]],
        };
  const SAD: Cell[] =
    G === 7
      ? [
          // X X — and a frown under them.
          [0, 1], [2, 1], [1, 2], [0, 3], [2, 3],
          [4, 1], [6, 1], [5, 2], [4, 3], [6, 3],
          [1, 6], [2, 5], [3, 5], [4, 5], [5, 6],
        ]
      : [[1, 1], [3, 1], [0, 4], [1, 3], [2, 3], [3, 3], [4, 4]];
  let time = 0;
  let alpha = 1;

  const set = (col: number, row: number, value = 1, kind = 0) => {
    if (col < 0 || col >= G || row < 0 || row >= G) return;
    const i = row * G + col;
    if (value >= want[i]) {
      want[i] = value;
      tone[i] = kind;
    }
  };

  function face(sleepy: boolean) {
    const look = sleepy ? 0 : LOOK[Math.floor(time / 0.7) % LOOK.length];
    const blink = !sleepy && time % 3.6 > 3.42;
    const eyeRow = G === 7 ? 2 : 1;
    const kind = sleepy ? 2 : 0;
    for (const eye of G === 7 ? [2, 4] : [1, 3]) {
      if (sleepy || blink) set(eye + look, eyeRow + 1, sleepy ? 0.7 : 1, kind);
      else {
        set(eye + look, eyeRow, 1, kind);
        set(eye + look, eyeRow + 1, 1, kind);
      }
    }
    // A mouth pulled to one side: thinking.
    const mouthRow = G - 2;
    for (const col of G === 7 ? [3, 4] : [2, 3]) set(col, mouthRow, 0.45, kind);
    if (sleepy) {
      // A "z" drifting up out of the top-right corner.
      const k = (time % 1.8) / 1.8;
      set(G - 1, Math.round((G - 3) * (1 - k)), 0.8 * (1 - k), 2);
    }
  }

  function happy(fin: number) {
    const winking = fin > 0.6 && fin < 0.85;
    for (const [c, r] of winking ? HAPPY.wink : HAPPY.left) set(c, r);
    for (const [c, r] of HAPPY.right) set(c, r);
    for (const [c, r] of HAPPY.mouth) set(c, r);
  }

  function scene() {
    want.fill(0);
    const act = clock.act;
    const fin = clock.fin;
    if (act?.stopping) return;
    if (ended(act)) {
      // A failure has no wink to wait for: its face is up at once and goes red sooner.
      const failed = clock.failed;
      const tint = failed ? 3 : 1;
      if (failed) for (const [c, r] of SAD) set(c, r);
      else happy(fin);
      const start = failed ? 0.45 : 1.0;
      if (fin < start) return;
      // The wipe: the face crosses over to green along a diagonal front, which runs past the far
      // corner so its bright edge leaves the matrix instead of stopping on it. The edge lights the
      // dark LEDs it passes, faintly, so the sweep reads as one even where there is no face.
      const front = clamp01((fin - start) / 0.4) * 2.45;
      for (let r = 0; r < G; r++) {
        for (let c = 0; c < G; c++) {
          const at = ((c + r) / (2 * (G - 1))) * 2;
          if (at >= front) continue;
          if (want[r * G + c] > 0) tone[r * G + c] = tint;
          else if (front - at < 0.35) set(c, r, 0.35, tint);
        }
      }
      return;
    }
    if (act?.quiet) {
      face(true);
      return;
    }
    switch (act?.phase) {
      case "start": {
        const reach = (time % 2.4) / 1.4;
        for (let r = 0; r < G; r++) {
          for (let c = 0; c < G; c++) {
            const d = Math.hypot(c - mid, r - mid) / (mid * 1.42);
            if (d <= reach) set(c, r, clamp01(1 - (reach - d) * 1.6));
          }
        }
        return;
      }
      case "read":
      case "search": {
        const x = ((time * G * 0.9) % (G + 3)) - 1.5;
        for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) set(c, r, clamp01(1 - Math.abs(c - x) / 1.4) * (r % 2 === 0 ? 1 : 0.55));
        return;
      }
      case "edit":
      case "run": {
        for (let r = 0; r < G; r++) {
          for (let c = 0; c < G; c++) {
            const d = Math.hypot(c - mid, r - mid);
            set(c, r, Math.pow(Math.max(0, Math.cos((d - time * 3.2) * 1.5)), 4));
          }
        }
        return;
      }
      case "write": {
        for (let c = 0; c < G; c++) {
          const y = mid + Math.sin(c * 0.95 - time * 5.5) * (mid - 0.6);
          for (let r = 0; r < G; r++) set(c, r, clamp01(1 - Math.abs(r - y) / 0.9));
        }
        return;
      }
      default:
        face(false);
    }
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    ctx.clearRect(0, 0, px, px);
    const pitch = px / G;
    const radius = pitch * 0.36;
    for (let row = 0; row < G; row++) {
      for (let col = 0; col < G; col++) {
        const i = row * G + col;
        const v = level[i];
        const x = (col + 0.5) * pitch;
        const y = (row + 0.5) * pitch;
        // The unlit LED, so the grid reads as a display even when it shows almost nothing.
        ctx.fillStyle = rgba(p.text, 0.09 * alpha);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, TAU);
        ctx.fill();
        if (v < 0.02) continue;
        let color = aiCycle(p, (col + row) / (2 * G) + time * 0.1);
        if (tone[i] === 1) color = p.success;
        if (tone[i] === 2) color = mix(color, p.warning, 0.4);
        if (tone[i] === 3) color = p.danger;
        ctx.fillStyle = rgba(color, v * alpha);
        ctx.beginPath();
        ctx.arc(x, y, radius * (0.85 + 0.25 * v), 0, TAU);
        ctx.fill();
      }
    }
  }

  return {
    setActivity(activity) {
      clock.set(activity);
    },
    tick(dt) {
      clock.step(dt);
      const act = clock.act;
      time += dt * (act?.quiet ? 0.5 : 1);
      scene();
      const k = Math.min(1, dt * 14);
      for (let i = 0; i < level.length; i++) level[i] += (want[i] - level[i]) * k;
      alpha += ((act?.stopping ? 0.3 : 1) - alpha) * Math.min(1, dt * 3);
      paint();
    },
    still() {
      if (time === 0) time = 1.1;
      alpha = clock.act?.stopping ? 0.3 : 1;
      clock.settle();
      scene();
      level.set(want);
      paint();
    },
  };
}
