/**
 * What the canvas's component library offers, and what a dropped icon becomes.
 *
 * A provider icon arrives with no more than its name and its pack's group, so its category is read
 * from those — the group where the provider's own taxonomy says it (Azure "databases", AWS
 * "application-integration"), the name where it doesn't (Google's pack has one group for every
 * product). The category is what the rules, the simulation and the card's tint go by, and it is
 * editable afterwards in the inspector.
 *
 * Simulation figures on a dropped component are the library's defaults for its kind, marked
 * `estimated` — the Simulate lens says so until a source or the person replaces them.
 */
import type { ArchComponent, Category, SimParams, ZoneStyle } from "./types";

/** The generic glyphs, each with the category it stands for. */
export const GENERIC: ReadonlyArray<{ icon: string; category: Category }> = [
  { icon: "person", category: "actor" },
  { icon: "people", category: "actor" },
  { icon: "web", category: "compute" },
  { icon: "mobile", category: "actor" },
  { icon: "container", category: "compute" },
  { icon: "server", category: "compute" },
  { icon: "function", category: "compute" },
  { icon: "api", category: "compute" },
  { icon: "scheduler", category: "compute" },
  { icon: "ai", category: "compute" },
  { icon: "gateway", category: "network" },
  { icon: "cdn", category: "network" },
  { icon: "balancer", category: "network" },
  { icon: "network", category: "network" },
  { icon: "globe", category: "network" },
  { icon: "link", category: "network" },
  { icon: "database", category: "data" },
  { icon: "pool", category: "data" },
  { icon: "cache", category: "data" },
  { icon: "storage", category: "data" },
  { icon: "queue", category: "messaging" },
  { icon: "bus", category: "messaging" },
  { icon: "stream", category: "messaging" },
  { icon: "identity", category: "identity" },
  { icon: "key", category: "security" },
  { icon: "lock", category: "security" },
  { icon: "firewall", category: "security" },
  { icon: "captcha", category: "security" },
  { icon: "monitor", category: "observability" },
  { icon: "log", category: "observability" },
  { icon: "external", category: "external" },
  { icon: "chat", category: "external" },
  { icon: "mail", category: "external" },
];

/** The zone kinds the library offers, with the glyph each starts with. */
export const ZONE_KINDS: ReadonlyArray<{ style: ZoneStyle; icon?: string }> = [
  { style: "cloud", icon: "cloud" },
  { style: "group", icon: "group" },
  { style: "cluster", icon: "namespace" },
  { style: "tier" },
  { style: "logical" },
  { style: "providers", icon: "globe" },
];

const BY_GROUP: Array<[RegExp, Category]> = [
  [/^(databases|storage)$/, "data"],
  [/^(networking|networking-content-delivery|web)$/, "network"],
  [/^identity$/, "identity"],
  [/^security$/, "security"],
  [/^(integration|application-integration)$/, "messaging"],
  [/^monitor$/, "observability"],
];

const BY_NAME: Array<[RegExp, Category]> = [
  [/\b(waf|firewall|shield|armor|key ?vault|kms|secret|sentinel|defender|guard ?duty|security|certificate|captcha)/i, "security"],
  [/\b(entra|active directory|identity|iam|cognito|single sign|sso|b2c|managed identit)/i, "identity"],
  [/\b(monitor|insights|cloudwatch|logging|log analytics|logs?\b|trace|x-ray|grafana|prometheus|observab)/i, "observability"],
  [/\b(queue|service bus|event ?(hub|grid|bridge)|pub ?\/? ?sub|sns|sqs|kafka|kinesis|eventarc|mq\b|messag|notification hub)/i, "messaging"],
  [/\b(sql|database|db\b|cosmos|dynamo|spanner|firestore|bigtable|aurora|rds|redshift|bigquery|storage|bucket|s3|blob|files?\b|redis|cache|memorystore|elasticache|data lake|warehouse)/i, "data"],
  [/\b(gateway|front ?door|cdn|cloudfront|load ?balanc|traffic manager|dns|route ?53|vpc|virtual network|vnet|network|private link|ingress|api management|apigee|expressroute|vpn)/i, "network"],
];

/** The category a provider icon stands for, from its pack group and its name. */
export function categoryFor(label: string, group = ""): Category {
  for (const [re, cat] of BY_NAME.slice(0, 2)) if (re.test(label)) return cat;
  for (const [re, cat] of BY_GROUP) if (re.test(group)) return cat;
  for (const [re, cat] of BY_NAME) if (re.test(label)) return cat;
  return "compute";
}

/** The library's starting figures for a kind of component — estimates, and marked as such. */
export function defaultSim(category: Category): SimParams | undefined {
  switch (category) {
    case "actor": return { rps: 20, estimated: true };
    case "compute": return { capacity: 150, replicas: 2, latency: 25, estimated: true };
    case "data": return { capacity: 1000, latency: 5, managed: true, estimated: true };
    case "messaging": return { capacity: 2000, latency: 3, managed: true, estimated: true };
    case "network": return { capacity: 5000, latency: 3, managed: true, estimated: true };
    case "security": return { capacity: 5000, latency: 2, managed: true, estimated: true };
    case "identity": return { capacity: 1000, latency: 40, managed: true, estimated: true };
    case "external": return { capacity: 100, latency: 150, estimated: true };
    default: return undefined;
  }
}

/** The component a library item becomes when it is dropped on the canvas. */
export function componentFor(icon: string, name: string, category: Category, type?: string): ArchComponent {
  const sim = defaultSim(category);
  return { name, ...(type ? { type } : {}), icon, category, ...(sim ? { sim } : {}) };
}
