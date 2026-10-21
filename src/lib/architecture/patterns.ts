/**
 * Patterns the document already uses, recognised from its shape — what the Learn lens explains.
 *
 * Detection is by structure first (a queue between two services, a database with one writer) and by
 * name only where structure cannot tell (a BFF looks like any other service). Each hit names the
 * components it found it in, so "show me" can light them up; the catalogue text is translated
 * (`arch.pattern.<id>.*`).
 */
import type { ArchDoc, ResolvedComponents } from "./types";

export type QualityAttribute =
  | "availability"
  | "performance"
  | "scalability"
  | "security"
  | "maintainability"
  | "observability"
  | "consistency"
  | "resilience"
  | "cost"
  | "timeToMarket"
  | "portability"
  | "compliance"
  | "testability"
  | "interoperability";

export type Family = "architectural" | "design" | "resilience" | "concurrency" | "data" | "integration" | "observability" | "security" | "deployment";
export const FAMILIES: Family[] = ["architectural", "design", "resilience", "concurrency", "data", "integration", "observability", "security", "deployment"];

export interface PatternDef {
  id: string;
  family: Family;
  improves: QualityAttribute[];
  costs: QualityAttribute[];
}

/** The catalogue sample shipped with the lens; words in `arch.pattern.<id>.name|what`. */
export const PATTERNS: PatternDef[] = [
  { id: "gateway", family: "integration", improves: ["security", "maintainability"], costs: ["performance"] },
  { id: "bff", family: "architectural", improves: ["security", "timeToMarket"], costs: ["cost"] },
  { id: "outbox", family: "data", improves: ["consistency", "resilience"], costs: ["performance"] },
  { id: "cacheAside", family: "data", improves: ["performance", "scalability"], costs: ["consistency"] },
  { id: "loadLeveling", family: "resilience", improves: ["availability", "scalability"], costs: ["observability"] },
  { id: "asyncRequestReply", family: "integration", improves: ["resilience"], costs: ["maintainability"] },
  { id: "antiCorruption", family: "integration", improves: ["maintainability", "interoperability"], costs: ["cost"] },
  { id: "databasePerService", family: "data", improves: ["maintainability", "scalability"], costs: ["consistency"] },
  { id: "circuitBreaker", family: "resilience", improves: ["resilience", "availability"], costs: ["consistency"] },
  { id: "retryBackoff", family: "resilience", improves: ["resilience"], costs: ["performance"] },
  { id: "bulkhead", family: "resilience", improves: ["availability"], costs: ["cost"] },
  { id: "saga", family: "data", improves: ["availability", "scalability"], costs: ["consistency", "testability"] },
  { id: "cqrs", family: "data", improves: ["performance", "scalability"], costs: ["maintainability", "consistency"] },
  { id: "eventSourcing", family: "data", improves: ["compliance", "observability"], costs: ["maintainability"] },
  { id: "idempotency", family: "concurrency", improves: ["resilience", "consistency"], costs: ["performance"] },
  { id: "optimisticLocking", family: "concurrency", improves: ["performance"], costs: ["maintainability"] },
  { id: "rateLimiting", family: "security", improves: ["security", "availability"], costs: ["timeToMarket"] },
  { id: "tracing", family: "observability", improves: ["observability"], costs: ["cost"] },
  { id: "stranglerFig", family: "deployment", improves: ["availability", "timeToMarket"], costs: ["cost"] },
  { id: "blueGreen", family: "deployment", improves: ["availability"], costs: ["cost"] },
  { id: "modularMonolith", family: "architectural", improves: ["timeToMarket", "maintainability"], costs: ["scalability"] },
  { id: "hexagonal", family: "design", improves: ["testability", "maintainability"], costs: ["timeToMarket"] },
];
export const patternDef = (id: string) => PATTERNS.find((p) => p.id === id)!;

export interface PatternHit {
  id: string;
  affects: string[];
  /** Names for `arch.pattern.<id>.here`, already joined. */
  params: Record<string, string>;
}

/** "A, B and C" (or "A, B y C") — `and` is the translated conjunction. */
export function joinNames(names: string[], and: string): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
}

export function detectPatterns(doc: ArchDoc, comps: ResolvedComponents, and: string): PatternHit[] {
  const ids = Object.keys(comps);
  const conns = (doc.connections ?? []).filter((e) => comps[e.from] && comps[e.to]);
  const cat = (id: string) => comps[id].category;
  const text = (id: string) => `${id} ${comps[id].name ?? ""} ${comps[id].type ?? ""} ${comps[id].description ?? ""} ${comps[id].icon ?? ""}`;
  const N = (list: string[]) => joinNames(list.map((id) => comps[id].name ?? id), and);
  const isCache = (id: string) => /cache|redis|memcache/i.test(text(id));
  const hits: PatternHit[] = [];
  const push = (id: string, affects: string[], params: Record<string, string>) => { if (affects.length) hits.push({ id, affects: [...new Set(affects)], params }); };

  const gw = ids.filter((id) => cat(id) === "network" && /gateway|front ?door|ingress|cdn|load.?balanc|cloudfront|api.?management|apigee/i.test(text(id)));
  push("gateway", gw, { names: N(gw) });
  const bff = ids.filter((id) => cat(id) === "compute" && /\bbff\b|_bff|bff_|backend.for.frontend/i.test(text(id)));
  push("bff", bff, { names: N(bff) });
  for (const db of ids.filter((id) => cat(id) === "data" && /outbox/i.test(text(id)))) {
    const writers = conns.filter((e) => e.to === db && cat(e.from) === "compute").map((e) => e.from);
    const queues = conns.filter((e) => writers.includes(e.from) && e.kind === "async" && cat(e.to) === "messaging").map((e) => e.to);
    if (queues.length) push("outbox", [db, ...writers, ...queues], { store: N([db]), queues: N([...new Set(queues)]) });
  }
  const caches = ids.filter((id) => cat(id) === "data" && isCache(id));
  push("cacheAside", caches, { names: N(caches) });
  const queues = ids.filter((id) => cat(id) === "messaging" && conns.some((e) => e.to === id && e.kind === "async") && conns.some((e) => e.from === id && e.kind === "async"));
  const consumers = [...new Set(conns.filter((e) => queues.includes(e.from) && cat(e.to) !== "messaging").map((e) => e.to))];
  push("loadLeveling", [...queues, ...consumers], { queues: N(queues), consumers: N(consumers) });
  const producers = (q: string) => conns.filter((e) => e.to === q).map((e) => e.from);
  const consumersOf = (q: string) => conns.filter((e) => e.from === q).map((e) => e.to);
  for (let i = 0; i < queues.length; i++)
    for (let j = i + 1; j < queues.length; j++) {
      const a = queues[i], b = queues[j];
      if (consumersOf(a).some((x) => producers(b).includes(x)) && consumersOf(b).some((x) => producers(a).includes(x)))
        push("asyncRequestReply", [a, b], { request: N([a]), reply: N([b]) });
    }
  const acl = ids.filter((id) => cat(id) === "compute" && /integra|adapter|adaptador|anti.?corruption|connector/i.test(text(id)) && conns.some((e) => e.from === id && cat(e.to) === "external"));
  const outside = [...new Set(conns.filter((e) => acl.includes(e.from) && cat(e.to) === "external").map((e) => e.to))];
  push("antiCorruption", [...acl, ...outside], { names: N(acl), systems: N(outside) });
  const stores = ids.filter((id) => cat(id) === "data" && !isCache(id));
  const owned = stores.filter((id) => new Set(conns.filter((e) => e.to === id && cat(e.from) === "compute").map((e) => e.from)).size === 1);
  if (owned.length >= 2) push("databasePerService", owned, { names: N(owned) });
  const breakers = ids.filter((id) => /circuit.?breaker|resilience4j|polly|hystrix/i.test(text(id)));
  push("circuitBreaker", breakers, { names: N(breakers) });
  const limits = ids.filter((id) => /rate.?limit|throttl|waf/i.test(text(id)));
  push("rateLimiting", limits, { names: N(limits) });
  return hits;
}
