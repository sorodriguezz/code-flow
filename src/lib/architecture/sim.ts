/**
 * The capacity model: instant, analytic, explainable — what the Simulate lens shows as you drag.
 *
 * Ported from the user's `system-architect` simulator and corrected where it misled:
 *   - utilisation is load ÷ (capacity × replicas), counting replicas once;
 *   - a router (`network`) splits its traffic across its targets, a service calls each dependency,
 *     and `share` on a connection says what fraction passes it — the original copied the full rate
 *     to every child;
 *   - load a component cannot take is an error, not silently dropped;
 *   - async connections buffer: what a consumer cannot take accumulates in the queue feeding it,
 *     instead of propagating errors back to whoever produced the message;
 *   - latency is end to end along the numbered flow, not a percentile across unrelated nodes.
 *
 * Traffic is solved as a fixed point (load[v] = sources[v] + Σ load[u]·share(u→v)), so feedback
 * loops through queues (result back to the core) converge instead of being cut.
 */
import type { ArchDoc, Category, Connection, ResolvedComponents } from "./types";

const DEFAULTS: Record<Category, [number, number]> = {
  actor: [0, 0],
  network: [5000, 3],
  compute: [200, 20],
  data: [1000, 5],
  messaging: [5000, 3],
  identity: [3000, 40],
  security: [5000, 2],
  observability: [5000, 2],
  external: [500, 150],
};
export const PROTOCOL_MS: Record<string, number> = { https: 5, http: 2, "http:internal": 2, grpc: 1, tds: 1, sql: 1, tcp: 0.5, resp: 0.3, amqp: 3, kafka: 3, mqtt: 2 };

export interface NodeMetrics {
  load: number;
  /** Capacity × replicas; 0 when the component is switched off. */
  cap: number;
  util: number;
  /** Share of its own synchronous load it cannot serve. */
  err: number;
  /** Messages per second piling up in the queue that feeds it. */
  backlog: number;
  latency: number;
  down: boolean;
}

export interface Backlog { queue: string; consumer: string; rate: number }

export type Verdict = "ok" | "tight" | "queues" | "fails" | "idle";

export interface SimResult {
  metrics: Record<string, NodeMetrics>;
  /** Connection index → requests per second passing it. */
  edge: Record<number, number>;
  /** What a request that reaches this component sees fail, its dependencies included. */
  effectiveError: Record<string, number>;
  entry: number;
  syncMs: number;
  asyncMs: number;
  syncSteps: number[];
  asyncSteps: number[];
  /** The booking-style error: what fails along the synchronous part of the flow. */
  flowError: number;
  actorError: number;
  hottest: string | null;
  /** Traffic multiple at which the first component reaches 100 %. */
  breakAt: number;
  firstToBreak: string | null;
  backlogs: Backlog[];
  verdict: Verdict;
}

export const capacityOf = (c: { category?: Category; sim?: { capacity?: number; replicas?: number } }) =>
  (c.sim?.capacity ?? DEFAULTS[c.category ?? "compute"]?.[0] ?? 200) * (c.sim?.replicas ?? 1);
export const baseLatencyOf = (c: { category?: Category; sim?: { latency?: number } }) => c.sim?.latency ?? DEFAULTS[c.category ?? "compute"]?.[1] ?? 20;

export function simulate(doc: ArchDoc, comps: ResolvedComponents, scale: number, down: ReadonlySet<string>): SimResult {
  const ids = Object.keys(comps);
  const actor = (id: string) => comps[id]?.category === "actor";
  const router = (id: string) => comps[id]?.category === "network";
  const conns = (doc.connections ?? [])
    .map((e, i) => ({ ...e, i }))
    .filter((e) => comps[e.from] && comps[e.to] && e.from !== e.to && !actor(e.to));
  const out: Record<string, Array<Connection & { i: number }>> = {};
  for (const e of conns) (out[e.from] ??= []).push(e);
  const share = (e: Connection) => (typeof e.share === "number" ? e.share : router(e.from) ? 1 / out[e.from].length : 1);
  const src: Record<string, number> = {};
  for (const id of ids) src[id] = (comps[id].sim?.rps ?? 0) * scale;

  let load: Record<string, number> = { ...src };
  let syncIn: Record<string, number> = {};
  let asyncIn: Record<string, number> = {};
  let edge: Record<number, number> = {};
  for (let it = 0; it < 80; it++) {
    const next: Record<string, number> = { ...src };
    syncIn = {}; asyncIn = {}; edge = {};
    for (const e of conns) {
      const pass = down.has(e.from) ? 0 : (load[e.from] ?? 0) * share(e);
      edge[e.i] = pass;
      next[e.to] = (next[e.to] ?? 0) + pass;
      if (e.kind === "async") asyncIn[e.to] = (asyncIn[e.to] ?? 0) + pass;
      else syncIn[e.to] = (syncIn[e.to] ?? 0) + pass;
    }
    load = next;
  }

  const metrics: Record<string, NodeMetrics> = {};
  for (const id of ids) {
    const c = comps[id];
    const off = down.has(id);
    const cap = off ? 0 : capacityOf(c);
    const L = load[id] ?? 0;
    const sync = (syncIn[id] ?? 0) + (actor(id) ? 0 : src[id] ?? 0);
    const asyn = asyncIn[id] ?? 0;
    const util = actor(id) ? 0 : cap > 0 ? L / cap : L > 0 ? Infinity : 0;
    let err = 0, backlog = 0;
    if (!actor(id)) {
      if (off) { err = 1; backlog = asyn; }
      else {
        if (sync > cap) err = (sync - cap) / sync;
        backlog = Math.max(0, Math.min(asyn, sync + asyn - cap));
      }
    }
    // Queueing: M/M/1-style growth, capped — past saturation the number stops meaning much.
    const latency = baseLatencyOf(c) * (util >= 1 ? 20 : Math.min(20, 1 / (1 - Math.min(util, 0.95))));
    metrics[id] = { load: L, cap, util, err, backlog, latency, down: off };
  }

  // A request fails if this component fails it, or if a synchronous dependency it calls does.
  const eff: Record<string, number> = {};
  for (const id of ids) eff[id] = metrics[id].err;
  for (let it = 0; it < 16; it++) {
    for (const id of ids) {
      const outs = (out[id] ?? []).filter((e) => e.kind !== "async");
      if (!outs.length) { eff[id] = metrics[id].err; continue; }
      if (router(id) || actor(id)) {
        const total = outs.reduce((a, e) => a + share(e), 0) || 1;
        const via = outs.reduce((a, e) => a + share(e) * eff[e.to], 0) / total;
        eff[id] = 1 - (1 - metrics[id].err) * (1 - Math.min(1, via));
      } else {
        let ok = 1 - metrics[id].err;
        for (const e of outs) ok *= 1 - eff[e.to] * Math.min(1, share(e));
        eff[id] = 1 - ok;
      }
    }
  }

  const steps = conns.filter((e) => e.step).sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
  const firstAsync = steps.findIndex((e) => e.kind === "async");
  const syncPart = firstAsync < 0 ? steps : steps.slice(0, firstAsync);
  const asyncPart = firstAsync < 0 ? [] : steps.slice(firstAsync);
  const hop = (e: Connection) => metrics[e.to].latency + (PROTOCOL_MS[(e.protocol ?? "").toLowerCase()] ?? 2);
  const syncMs = syncPart.reduce((a, e) => a + hop(e), 0);
  const asyncMs = asyncPart.reduce((a, e) => a + hop(e), 0);
  const services = syncPart.filter((e) => comps[e.from].category === "compute").map((e) => e.from);
  const flowError = services.length ? Math.max(...services.map((id) => eff[id])) : 0;
  const actors = ids.filter(actor).sort((a, b) => (src[b] ?? 0) - (src[a] ?? 0));
  const actorError = actors.length ? eff[actors[0]] : 0;
  const entry = actors.reduce((a, id) => a + (src[id] ?? 0), 0);

  const live = ids.filter((id) => !actor(id) && !metrics[id].down && metrics[id].cap > 0 && metrics[id].load > 0);
  let hottest: string | null = null;
  let breakAt = Infinity;
  for (const id of live) {
    if (!hottest || metrics[id].util > metrics[hottest].util) hottest = id;
    breakAt = Math.min(breakAt, scale * (metrics[id].cap / metrics[id].load));
  }
  const backlogs: Backlog[] = [];
  for (const id of ids) {
    if (metrics[id].backlog > 0.05) {
      const feeder = conns.find((e) => e.to === id && e.kind === "async")?.from ?? id;
      backlogs.push({ queue: feeder, consumer: id, rate: metrics[id].backlog });
    }
  }
  let verdict: Verdict = "ok";
  if (!entry && !live.length) verdict = "idle";
  else if (flowError > 0.01 || actorError > 0.01) verdict = "fails";
  else if (backlogs.length) verdict = "queues";
  else if (hottest && metrics[hottest].util >= 0.85) verdict = "tight";

  return {
    metrics,
    edge,
    effectiveError: eff,
    entry,
    syncMs,
    asyncMs,
    syncSteps: syncPart.map((e) => e.step!),
    asyncSteps: asyncPart.map((e) => e.step!),
    flowError,
    actorError,
    hottest,
    breakAt,
    firstToBreak: hottest,
    backlogs,
    verdict,
  };
}
