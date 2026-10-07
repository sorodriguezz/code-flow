import type { ThinkingActivity } from "./activity";
import { aiHue, mix, palette, rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Red neuronal" — a few nodes and the links between them, with signals travelling the links.
 *
 * A node lights up when a signal reaches it and passes it on along another link, so the activity
 * wanders through the graph rather than circling it. How many signals are out is the phase:
 * thinking keeps several in flight, writing sends them fast, a quiet run lets the graph go dim.
 */

const TAU = Math.PI * 2;

interface Node {
  x: number;
  y: number;
  /** Drift: each node breathes round its place on its own phase. */
  phase: number;
  glow: number;
}

interface Pulse {
  from: number;
  to: number;
  at: number;
  hue: number;
}

export function createNetwork(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const ringCount = px < 18 ? 5 : px < 30 ? 6 : 7;
  const nodes: Node[] = [{ x: 0, y: 0, phase: 0, glow: 0 }];
  for (let i = 0; i < ringCount; i++) {
    const angle = (i / ringCount) * TAU - Math.PI / 2 + (i % 2) * 0.25;
    const radius = i % 2 ? 0.78 : 0.62;
    nodes.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, phase: i * 1.7, glow: 0 });
  }
  // Spokes to the centre, and each outer node to its neighbour.
  const links: [number, number][] = [];
  for (let i = 1; i <= ringCount; i++) {
    links.push([0, i]);
    links.push([i, (i % ringCount) + 1]);
  }
  const neighbours = nodes.map((_, n) => links.flatMap(([a, b]) => (a === n ? [b] : b === n ? [a] : [])));
  const pulses: Pulse[] = [];
  let time = 0;
  let spawn = 0;
  let hueTurn = 0;
  let activity: ThinkingActivity | undefined;
  let dim = 0;

  function rate(): { count: number; speed: number } {
    if (activity?.done || activity?.stopping) return { count: 0, speed: 1.2 };
    if (activity?.quiet) return { count: 1, speed: 0.35 };
    switch (activity?.phase) {
      case "start":
        return { count: 1, speed: 1 };
      case "write":
        return { count: 3, speed: 2.6 };
      case "think":
      case "plan":
        return { count: 4, speed: 1.4 };
      default:
        return { count: 3, speed: 1.8 };
    }
  }

  function launch(from: number) {
    const options = neighbours[from];
    const to = options[Math.floor(Math.random() * options.length)];
    hueTurn = (hueTurn + 0.37) % 1;
    pulses.push({ from, to, at: 0, hue: hueTurn });
  }

  function position(n: Node) {
    const R = px * 0.4;
    return [px / 2 + (n.x + Math.sin(time * 0.9 + n.phase) * 0.05) * R, px / 2 + (n.y + Math.cos(time * 0.7 + n.phase) * 0.05) * R];
  }

  function paint() {
    if (!ctx) return;
    const p = palette();
    ctx.clearRect(0, 0, px, px);
    const fade = 1 - dim * 0.5;
    const points = nodes.map(position);
    ctx.lineWidth = Math.max(0.6, px / 40);
    ctx.strokeStyle = rgb(p.text);
    ctx.globalAlpha = 0.16 * fade;
    ctx.beginPath();
    for (const [a, b] of links) {
      ctx.moveTo(points[a][0], points[a][1]);
      ctx.lineTo(points[b][0], points[b][1]);
    }
    ctx.stroke();
    const dot = Math.max(0.9, px / 20);
    for (const pulse of pulses) {
      const [ax, ay] = points[pulse.from];
      const [bx, by] = points[pulse.to];
      const color = rgb(aiHue(p, pulse.hue));
      // A short tail behind the head: three steps back along the link.
      for (let k = 3; k >= 0; k--) {
        const t = Math.max(0, pulse.at - k * 0.08);
        ctx.globalAlpha = (1 - k * 0.28) * fade;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(ax + (bx - ax) * t, ay + (by - ay) * t, dot * (1 - k * 0.18), 0, TAU);
        ctx.fill();
      }
    }
    nodes.forEach((node, i) => {
      const [x, y] = points[i];
      const color = node.glow > 0.05 ? mix(p.text, aiHue(p, (i / nodes.length + hueTurn) % 1), node.glow) : p.text;
      ctx.globalAlpha = (0.45 + 0.55 * node.glow) * fade;
      ctx.fillStyle = rgb(activity?.quiet ? mix(color, p.warning, 0.4) : activity?.done ? mix(color, p.success, 0.7) : color);
      ctx.beginPath();
      ctx.arc(x, y, (i === 0 ? dot * 1.5 : dot * 1.15) * (1 + node.glow * 0.5), 0, TAU);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  return {
    setActivity(next) {
      activity = next;
    },
    tick(dt) {
      time += dt;
      const { count, speed } = rate();
      dim += ((activity?.quiet || activity?.stopping ? 1 : 0) - dim) * Math.min(1, dt * 3);
      for (const node of nodes) node.glow *= Math.exp(-dt / 0.35);
      for (let i = pulses.length - 1; i >= 0; i--) {
        const pulse = pulses[i];
        pulse.at += dt * speed;
        if (pulse.at >= 1) {
          nodes[pulse.to].glow = 1;
          pulses.splice(i, 1);
          // Passed on, while the phase still wants this many out.
          if (pulses.length < count) launch(pulse.to);
        }
      }
      spawn -= dt;
      if (pulses.length < count && spawn <= 0) {
        launch(Math.floor(Math.random() * nodes.length));
        spawn = 0.35;
      }
      paint();
    },
    still() {
      if (time === 0) {
        time = 1;
        nodes[0].glow = 1;
        nodes[2].glow = 0.6;
        pulses.length = 0;
        pulses.push({ from: 0, to: 3, at: 0.55, hue: 0.2 }, { from: 4, to: 5, at: 0.3, hue: 0.8 });
      }
      paint();
    },
  };
}
