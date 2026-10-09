import { ended, type RunPhase, type ThinkingActivity } from "./activity";
import { WHITE } from "./face";
import { clamp01, endColor, finishClock, rgba, TAU } from "./finish";
import { aiHue, mix, palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Red neuronal" — a small layered network, drawn the way networks are drawn: columns of neurons,
 * every neuron wired to the next column, signals running through it a layer at a time.
 *
 * Rebuilt on 2026-10-08 (the user: "mejora el de red neuronal") — it was a hub and a ring with dots
 * wandering between them, which read as a molecule more than a network. Now a pass is a wavefront
 * crossing the layers: the neurons it reaches light up (a different few each pass, the way
 * activations do), and the links between firing neurons carry the signal across.
 *
 * The phase is the passes: thinking runs forward and then back (inference, then the error running
 * back); reading lights the inputs one by one before each pass; working runs passes back to back,
 * fast; writing makes the outputs pulse. Quiet, a slow dim pass now and then.
 *
 * Finish: one last pass that leaves every neuron it reaches green. Failed: the pass dies part-way —
 * what it reached goes red, and the links past it go dark.
 */

/** [passes' speed in layers/s, gap between passes in s] per phase. */
const PACE: Partial<Record<RunPhase, [number, number]>> = {
  start: [2, 0.6],
  think: [2.2, 0.15],
  plan: [2.2, 0.15],
  read: [1.6, 0.45],
  search: [1.6, 0.45],
  edit: [4.2, 0],
  run: [4.2, 0],
  tool: [3.6, 0.05],
  write: [3, 0.1],
};

interface Neuron {
  x: number;
  y: number;
  layer: number;
  glow: number;
}

/** Seeded, so a network looks the same every time it is drawn. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a * 9301 + 49297) % 233280;
    return a / 233280;
  };
}

export function createNetwork(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const u = (v: number) => v * px;
  const shape = px >= 20 ? [3, 4, 4, 2] : [2, 3, 2];
  const last = shape.length - 1;
  const neurons: Neuron[] = [];
  const layers: number[][] = shape.map((count, layer) => {
    const x = 0.14 + (layer / last) * 0.72;
    const gap = count > 1 ? Math.min(0.22, 0.7 / (count - 1)) : 0;
    return Array.from({ length: count }, (_, k) => {
      neurons.push({ x, y: 0.5 + (k - (count - 1) / 2) * gap, layer, glow: 0 });
      return neurons.length - 1;
    });
  });
  const rnd = seeded(13);
  const links: { a: number; b: number; weight: number }[] = [];
  for (let l = 0; l < last; l++) {
    for (const a of layers[l]) for (const b of layers[l + 1]) links.push({ a, b, weight: 0.25 + rnd() * 0.75 });
  }
  /** Which neurons this pass fires — a different few each time. */
  let firing = new Set<number>();
  let passSeed = 1;
  let running = false;
  let front = 0;
  let backward = false;
  let nextBack = false;
  let wait = 0;
  let time = 0;
  let grow = 0;
  let warn = 0;
  let alpha = 1;
  /** On a finish, how far its last pass has got, in layers; -1 while the run runs. */
  let endFront = -1;

  function pace(act: ThinkingActivity | undefined): [number, number] {
    if (act?.stopping) return [0, 1];
    if (act?.quiet) return [0.8, 1.6];
    return PACE[act?.phase ?? "think"] ?? [2.2, 0.15];
  }

  function newPass(reverse: boolean) {
    passSeed += 1;
    const r = seeded(passSeed * 7 + 3);
    firing = new Set(
      neurons.map((_, i) => i).filter((i) => neurons[i].layer === 0 || neurons[i].layer === last || r() < 0.6),
    );
    backward = reverse;
    front = reverse ? last + 0.4 : -0.4;
    running = true;
  }

  /** Lights the firing neurons of a layer a front has just reached. */
  function reach(layer: number, strength: number) {
    for (const i of layers[layer] ?? []) if (firing.has(i)) neurons[i].glow = Math.max(neurons[i].glow, strength);
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    const act = clock.act;
    const failed = clock.failed;
    ctx.clearRect(0, 0, px, px);
    const end = endColor(p, failed);
    const shown = (layer: number) => clamp01(grow * (last + 1) - layer);
    const ink = (layer: number, lit: number): Rgb => {
      let c = mix(p.text, aiHue(p, layer / last), 0.35 + 0.65 * lit);
      if (endFront >= 0 && layer <= endFront) c = mix(c, end, clamp01((endFront - layer) * 2.5));
      return mix(c, p.warning, warn * 0.3);
    };

    // Links: faint by weight, brighter between lit neurons; past a failure's front, dark.
    for (const link of links) {
      const A = neurons[link.a];
      const B = neurons[link.b];
      const vis = Math.min(shown(A.layer), shown(B.layer));
      if (vis <= 0) continue;
      const broken = failed && endFront >= 0 && B.layer > endFront ? 0.25 : 1;
      const lit = Math.min(A.glow, B.glow);
      ctx.strokeStyle = rgba(ink(A.layer, lit), (0.1 + 0.18 * link.weight + 0.35 * lit) * vis * broken * alpha);
      ctx.lineWidth = Math.max(0.5, u(0.012 + 0.012 * link.weight));
      ctx.beginPath();
      ctx.moveTo(u(A.x), u(A.y));
      ctx.lineTo(u(B.x), u(B.y));
      ctx.stroke();
    }

    // The signal crossing between two layers: one dot per link whose ends both fire.
    if (running && !ended(act)) {
      const from = backward ? Math.ceil(front) : Math.floor(front);
      const to = backward ? from - 1 : from + 1;
      const t = backward ? from - front : front - from;
      if (from >= 0 && from <= last && to >= 0 && to <= last) {
        for (const link of links) {
          const fwd = neurons[link.a].layer === from && neurons[link.b].layer === to;
          const back = neurons[link.b].layer === from && neurons[link.a].layer === to;
          if (!(backward ? back : fwd) || !firing.has(link.a) || !firing.has(link.b)) continue;
          const src = neurons[backward ? link.b : link.a];
          const dst = neurons[backward ? link.a : link.b];
          const x = src.x + (dst.x - src.x) * t;
          const y = src.y + (dst.y - src.y) * t;
          const col = mix(aiHue(p, (from + (to - from) * t) / last), WHITE, backward ? 0 : 0.3);
          ctx.fillStyle = rgba(mix(col, p.warning, warn * 0.3), (0.5 + 0.5 * link.weight) * alpha * (backward ? 0.6 : 1));
          ctx.beginPath();
          ctx.arc(u(x), u(y), Math.max(0.6, u(0.022)), 0, TAU);
          ctx.fill();
        }
      }
    }

    // Neurons: a ring around a core that lights up.
    const r = Math.max(1.1, u(shape.length > 3 ? 0.05 : 0.07));
    for (const n of neurons) {
      const vis = shown(n.layer);
      if (vis <= 0) continue;
      const col = ink(n.layer, n.glow);
      const radius = r * (0.85 + 0.25 * n.glow) * vis;
      ctx.save();
      if (n.glow > 0.3) {
        ctx.shadowColor = rgba(col, 0.8 * alpha);
        ctx.shadowBlur = u(0.08) * n.glow;
      }
      ctx.fillStyle = rgba(mix(p.surface, col, 0.25 + 0.75 * n.glow), vis * alpha);
      ctx.beginPath();
      ctx.arc(u(n.x), u(n.y), radius, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = rgba(col, (0.55 + 0.45 * n.glow) * vis * alpha);
      ctx.lineWidth = Math.max(0.6, u(0.016));
      ctx.beginPath();
      ctx.arc(u(n.x), u(n.y), radius, 0, TAU);
      ctx.stroke();
    }
  }

  return {
    setActivity(activity) {
      const was = ended(clock.act);
      clock.set(activity);
      if (ended(activity) && !was) {
        // The last pass: forward from the inputs, every neuron firing.
        firing = new Set(neurons.map((_, i) => i));
        endFront = -0.4;
        running = false;
      }
      if (!ended(activity)) endFront = -1;
    },
    tick(dt) {
      clock.step(dt);
      const act = clock.act;
      time += dt;
      grow = Math.min(1, grow + dt * 1.6);
      warn += ((act?.quiet && !ended(act) ? 1 : 0) - warn) * Math.min(1, dt * 3);
      alpha += ((act?.stopping ? 0.35 : act?.quiet && !ended(act) ? 0.55 : 1) - alpha) * Math.min(1, dt * 3);
      for (const n of neurons) n.glow *= Math.exp(-dt / (ended(act) ? 3 : 0.45));

      if (ended(act)) {
        // The final pass — cut short after the second layer when the run failed.
        const stop = clock.failed ? 1.35 : last + 0.4;
        if (endFront < stop) {
          const before = endFront;
          endFront = Math.min(stop, endFront + dt * 3.2);
          for (let l = Math.max(0, Math.ceil(before)); l <= Math.min(last, Math.floor(endFront)); l++) reach(l, 1);
        }
        paint();
        return;
      }

      const [speed, gap] = pace(act);
      const phase = act?.quiet || act?.stopping ? undefined : act?.phase;
      const thinking = phase === undefined || phase === "think" || phase === "plan";
      if (!running) {
        if (wait > 0) {
          wait -= dt;
          // Reading: the inputs light one after another while the next pass waits.
          if (phase === "read" || phase === "search") {
            const k = Math.floor((1 - clamp01(wait / Math.max(0.01, gap))) * shape[0]);
            const input = layers[0][Math.min(shape[0] - 1, k)];
            neurons[input].glow = Math.max(neurons[input].glow, 0.9);
          }
        } else if (speed > 0) {
          // Thinking alternates: forward, then the error running back.
          newPass(thinking && nextBack);
          nextBack = thinking ? !nextBack : false;
        }
      }
      if (running) {
        const before = front;
        front += (backward ? -1 : 1) * dt * speed;
        const lo = Math.min(before, front);
        const hi = Math.max(before, front);
        for (let l = Math.max(0, Math.ceil(lo)); l <= Math.min(last, Math.floor(hi)); l++) reach(l, 1);
        if ((!backward && front > last + 0.4) || (backward && front < -0.4)) {
          running = false;
          wait = gap;
        }
      }
      // Writing: the outputs pulse with the words.
      if (phase === "write") {
        for (const i of layers[last]) neurons[i].glow = Math.max(neurons[i].glow, 0.5 + 0.5 * Math.abs(Math.sin(time * 8)));
      }
      paint();
    },
    still() {
      const act = clock.act;
      grow = 1;
      warn = act?.quiet && !ended(act) ? 1 : 0;
      alpha = act?.stopping ? 0.35 : act?.quiet && !ended(act) ? 0.55 : 1;
      clock.settle();
      if (ended(act)) {
        // The end pose only where the finish will not play (`settle` jumps the clock there under
        // reduced motion); otherwise this is the mount's first frame and the last pass is to come.
        if (clock.fin >= 9) {
          firing = new Set(neurons.map((_, i) => i));
          endFront = clock.failed ? 1.35 : last + 0.4;
          for (let l = 0; l <= Math.min(last, Math.floor(endFront)); l++) reach(l, 1);
        }
      } else if (time === 0) {
        // A pass caught half-way, for a frame that has to say "signals moving through".
        time = 1;
        newPass(false);
        front = 1.5;
        reach(0, 0.6);
        reach(1, 1);
      }
      paint();
    },
  };
}
