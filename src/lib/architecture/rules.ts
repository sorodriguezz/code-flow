/**
 * The Review lens's rules: pure `(document) → findings`, no model, no network.
 *
 * Ported from the user's `system-architect` advisor (22 rules) and made to read a real document:
 * rules look at paths from the people who use the system rather than at "exists anywhere", stop a
 * synchronous chain at an async hop, treat a managed service as highly available, and read zones,
 * notes, decisions and risks the original had no notion of. Each finding names what it affects, so
 * the canvas can light it up; its words live in the translations (`arch.rule.<id>.*`), with
 * `params` filling the blanks.
 */
import { simulate } from "./sim";
import type { ArchDoc, Connection, ResolvedComponents } from "./types";

export type Severity = "critical" | "warning" | "suggestion" | "risk";
export type Area = "observability" | "security" | "resilience" | "performance" | "data" | "scalability" | "maintainability" | "decisions" | "risks";

export interface Finding {
  rule: string;
  severity: Severity;
  area: Area;
  affects: string[];
  params: Record<string, string | number>;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, suggestion: 2, risk: 3 };
const pct = (x: number) => Math.round(x * 100);

export function review(doc: ArchDoc, comps: ResolvedComponents): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, severity: Severity, area: Area, affects: string[], params: Record<string, string | number> = {}) =>
    out.push({ rule, severity, area, affects: [...new Set(affects)], params });
  const ids = Object.keys(comps);
  const conns = (doc.connections ?? []).filter((e) => comps[e.from] && comps[e.to]);
  const cat = (id: string) => comps[id]?.category;
  const text = (id: string) => `${id} ${comps[id].name ?? ""} ${comps[id].type ?? ""} ${comps[id].description ?? ""} ${comps[id].icon ?? ""}`;
  const name = (id: string) => comps[id]?.name ?? id;
  const actors = ids.filter((id) => cat(id) === "actor");
  const syncOut: Record<string, Connection[]> = {};
  for (const e of conns) if (e.kind !== "async" && cat(e.to) !== "actor") (syncOut[e.from] ??= []).push(e);
  const reach = new Set<string>();
  const stack = [...actors];
  while (stack.length) {
    const v = stack.pop()!;
    for (const e of syncOut[v] ?? []) if (!reach.has(e.to)) { reach.add(e.to); stack.push(e.to); }
  }

  // Observability
  if (!ids.some((id) => cat(id) === "observability" || /monitor|insights|observab|prometheus|grafana|datadog|opentelemetry|log.?analytics|cloudwatch|stackdriver/i.test(text(id)))) {
    const note = (doc.notes ?? []).find((n) => /insights|telemetr|observab|monitor/i.test(`${n.title ?? ""} ${n.text ?? ""}`));
    add(note ? "observabilityNoted" : "observability", "critical", "observability", [], note ? { note: note.id } : {});
  }

  // Security
  const entries = conns.filter((e) => cat(e.from) === "actor" && e.kind !== "async" && cat(e.to) !== "actor");
  const direct = entries.filter((e) => cat(e.to) !== "network" && cat(e.to) !== "security").map((e) => e.to);
  if (direct.length) add("directEntry", "critical", "security", direct);
  else if (entries.length && !ids.some((id) => (cat(id) === "network" || cat(id) === "security") && /waf|firewall|shield|armor|cloud armor/i.test(text(id))))
    add("noWaf", "critical", "security", entries.map((e) => e.to));
  const exposed = ids.filter((id) => cat(id) === "data" && conns.some((e) => e.to === id && (cat(e.from) === "actor" || cat(e.from) === "external")));
  if (exposed.length) add("dataExposed", "critical", "security", exposed);
  if (!ids.some((id) => cat(id) === "identity") && ids.some((id) => /admin|backoffice|back-office/i.test(text(id))))
    add("adminWithoutIdentity", "critical", "security", ids.filter((id) => /admin|backoffice|back-office/i.test(text(id))));
  const plain = conns.filter((e) => (cat(e.from) === "actor" || cat(e.from) === "external" || cat(e.to) === "external") && /^http$/i.test(e.protocol ?? ""));
  if (plain.length) add("plainHttp", "critical", "security", plain.flatMap((e) => [e.from, e.to]));

  // Resilience
  const spof = [...reach].filter((id) => cat(id) === "compute" && !comps[id].sim?.managed && (comps[id].sim?.replicas ?? 1) <= 1);
  if (spof.length) add("singlePoint", "warning", "resilience", spof, { names: spof.map(name).join(", ") });
  const extSync = conns.filter((e) => e.kind !== "async" && cat(e.to) === "external" && reach.has(e.from));
  if (extSync.length) add("externalSync", "warning", "resilience", extSync.flatMap((e) => [e.from, e.to]));

  // Performance: the longest synchronous chain from a person.
  let best: string[] = [];
  const walk = (v: string, path: string[]) => {
    if (path.length > best.length) best = [...path];
    for (const e of syncOut[v] ?? []) if (!path.includes(e.to) && path.length < 24) { path.push(e.to); walk(e.to, path); path.pop(); }
  };
  for (const a of actors) walk(a, [a]);
  if (best.length >= 6) add("longChain", "warning", "performance", best, { hops: best.length - 1, path: best.map(name).join(" → ") });
  const noCache = [...reach].filter((id) => cat(id) === "compute" && conns.some((e) => e.from === id && cat(e.to) === "data" && !/cache|redis|memcache/i.test(text(e.to))) && !conns.some((e) => e.from === id && /cache|redis|memcache/i.test(text(e.to))));
  if (noCache.length) add("noCache", "suggestion", "performance", noCache, { names: noCache.map(name).join(", ") });

  // Data
  for (const id of ids.filter((x) => cat(x) === "data" && !/cache|redis|memcache/i.test(text(x)))) {
    const writers = [...new Set(conns.filter((e) => e.to === id && cat(e.from) === "compute").map((e) => e.from))];
    if (writers.length >= 2) add("sharedDatabase", "warning", "data", [id, ...writers], { name: name(id), count: writers.length });
  }

  // Scalability, from the capacity model.
  const hasSim = ids.some((id) => comps[id].sim);
  if (hasSim) {
    const now = simulate(doc, comps, 1, new Set());
    const hot = ids.filter((id) => cat(id) !== "actor" && now.metrics[id] && now.metrics[id].util >= 0.85);
    if (hot.length) add("bottleneckNow", "critical", "scalability", hot, { names: hot.map(name).join(", ") });
    else {
      const twice = simulate(doc, comps, 2, new Set());
      const tight = ids.filter((id) => cat(id) !== "actor" && twice.metrics[id] && twice.metrics[id].util >= 0.85).sort((a, b) => twice.metrics[b].util - twice.metrics[a].util);
      if (tight.length) add("notTwice", "warning", "scalability", tight, { list: tight.map((id) => `${name(id)} ${pct(twice.metrics[id].util)} %`).join(", ") });
    }
  }

  // Messaging
  const isDlq = (id: string) => /dlq|dead.?letter|muertos/i.test(text(id));
  const noDlq = ids.filter((id) => cat(id) === "messaging" && !isDlq(id) && !conns.some((e) => e.from === id && isDlq(e.to)) && conns.some((e) => e.from === id));
  if (noDlq.length) add("noDeadLetter", "suggestion", "resilience", noDlq, { names: noDlq.map(name).join(", ") });

  // Maintainability
  const noProtocol = conns.filter((e) => !e.protocol && cat(e.to) !== "actor");
  if (noProtocol.length) add("noProtocol", "suggestion", "maintainability", noProtocol.flatMap((e) => [e.from, e.to]), { count: noProtocol.length });
  const alone = Object.keys(doc.components ?? {}).filter((id) => !conns.some((e) => e.from === id || e.to === id));
  if (alone.length) add("isolated", "suggestion", "maintainability", alone, { names: alone.map(name).join(", ") });

  // Decisions and risks
  for (const d of (doc.decisions ?? []).filter((x) => x.status === "proposed")) add("decisionOpen", "suggestion", "decisions", (d.affects ?? []).filter((id) => comps[id]), { id: d.id, title: d.title, count: (d.affects ?? []).length });
  for (const r of (doc.risks ?? []).filter((x) => (x.impact ?? 0) * (x.probability ?? 0) >= 12))
    add("riskHigh", "risk", "risks", (r.affects ?? []).filter((id) => comps[id]), { id: r.id, title: r.title, impact: r.impact ?? 0, probability: r.probability ?? 0, score: (r.impact ?? 0) * (r.probability ?? 0), mitigation: r.mitigation ?? "" });
  for (const n of (doc.notes ?? []).filter((x) => /^(risk|riesgo)\b/i.test(x.title ?? "")))
    add("riskNote", "risk", "risks", comps[n.on] ? [n.on] : [], { id: n.id, title: (n.title ?? "").replace(/^(risk|riesgo):?\s*/i, ""), text: n.text ?? "" });

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
