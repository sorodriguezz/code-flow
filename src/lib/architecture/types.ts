/**
 * The Arquitectura document: one JSON file that is at once the diagram, the capacity model, the
 * decision log and the risk register of a system.
 *
 * `layout` is a tree — a zone says what it contains and in what order, the way a page says rows and
 * columns — and the automatic drawing is derived from it. That is what lets a model write a document
 * without computing positions. Where the person dragged something on the canvas, `positions` holds
 * it (relative to its zone); «Ordenar» drops them and the tree's own arrangement comes back.
 *
 * What a document was generated from — a repository, documents, a brief, a cloud account — is in
 * `sources`, and every component, connection, decision and risk read from one carries `evidence`:
 * the lenses say where a fact came from, and which simulation numbers are only estimates.
 *
 * Keys are English (the user's call, 2026-10-21); the UI around them is translated as usual.
 */

export const ARCH_FORMAT = "codeflow.architecture/1";

export type ZoneStyle = "cloud" | "group" | "cluster" | "tier" | "logical" | "providers";
export type Category =
  | "actor"
  | "compute"
  | "data"
  | "messaging"
  | "network"
  | "identity"
  | "security"
  | "observability"
  | "external";
export type ConnectionKind = "sync" | "async";
export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected";
export type ComponentStatus = "proposed" | "building" | "production" | "deprecated";

/** A string is a component id; `{ row }` / `{ column }` group without drawing a box; a zone draws one. */
export type LayoutNode = string | LayoutGroup | Zone;

export interface LayoutGroup {
  row?: LayoutNode[];
  column?: LayoutNode[];
  gap?: number;
  /** Pushes the group down (in a row) or right (in a column) by this many px. */
  offset?: number;
  align?: "start" | "center";
}

export interface Zone {
  id: string;
  title?: string;
  subtitle?: string;
  icon?: string;
  style?: ZoneStyle;
  direction?: "row" | "column";
  align?: "start" | "center";
  gap?: number;
  offset?: number;
  children: LayoutNode[];
}

export interface SimParams {
  /** Requests per second this component can serve, per replica. */
  capacity?: number;
  replicas?: number;
  /** Base latency, ms, before any queueing. */
  latency?: number;
  /** Requests per second this component originates (people, schedulers). */
  rps?: number;
  /** A managed service: high availability is the provider's, so one "replica" is not a single point of failure. */
  managed?: boolean;
  /** The figures are guesses (a default, or the model's estimate) rather than read from a source. */
  estimated?: boolean;
}

/**
 * Where a fact came from, as one line: `repo:<path>[:<line>] — what`, `doc:<name> — what`,
 * `brief — what`, `azure:<resource id>`, `aws:<arn>`, `gcp:<resource name>`.
 */
export type Evidence = string;

export interface ArchComponent {
  name?: string;
  type?: string;
  icon?: string;
  /** A small second icon in the tile's corner (the stack: `logos:nestjs`). */
  badge?: string;
  category?: Category;
  /** The resource name. `{env}` is replaced by the chosen environment's key; an object names one per environment. */
  resource?: string | Record<string, string>;
  description?: string;
  status?: ComponentStatus;
  owner?: string;
  tech?: string;
  sim?: SimParams;
  evidence?: Evidence[];
}

export interface Connection {
  from: string;
  to: string;
  protocol?: string;
  kind?: ConnectionKind;
  /** The number of this hop in `flow`. */
  step?: number;
  /** Share of the source's traffic that goes this way: a router splits (default 1/n), a service calls each dependency (default 1). */
  share?: number;
  label?: string;
  evidence?: Evidence[];
}

export interface Note {
  id: string;
  /** A component or zone id. */
  on: string;
  title?: string;
  text?: string;
}

export interface Criterion {
  id: string;
  name: string;
  weight: number;
}

export interface DecisionOption {
  name: string;
  recommended?: boolean;
  /** Criterion id → 1..5. */
  scores?: Record<string, number>;
  pros?: string[];
  cons?: string[];
}

export interface Decision {
  id: string;
  title: string;
  status?: DecisionStatus;
  date?: string;
  /** 0..100. */
  confidence?: number;
  affects?: string[];
  context?: string;
  criteria?: Criterion[];
  options?: DecisionOption[];
  consequences?: string;
  revisitIf?: string;
  evidence?: Evidence[];
}

export interface Risk {
  id: string;
  title: string;
  /** 1..5 each. */
  impact?: number;
  probability?: number;
  mitigation?: string;
  affects?: string[];
  evidence?: Evidence[];
}

/** Where a component or zone was put by hand: its top-left, relative to the zone it sits in. */
export interface Position {
  x: number;
  y: number;
  /** A zone's size, once resized by hand. */
  w?: number;
  h?: number;
}

export type SourceKind = "repo" | "document" | "brief" | "cloud";

/** Something the document was generated from, kept so the lenses can say so and read it again. */
export interface SourceRef {
  kind: SourceKind;
  /** What to call it: the repository's name, the file's, "Brief", "Azure · <subscription>". */
  name: string;
  /** How to find it again: a folder or file path, or `<provider>:<context>[/<scope>]`. */
  ref?: string;
  /** ISO date of the read. */
  readAt?: string;
}

/** The questions ArchFlow's intake asks, answered — a source of its own. */
export interface Brief {
  problem?: string;
  goals?: string;
  outOfScope?: string;
  current?: string;
  constraints?: string;
  scale?: string;
  team?: string;
  compliance?: string;
  budget?: string;
  /** Quality attributes that matter, 1..5 — what Decisions weighs options by. */
  drivers?: Array<{ attribute: string; weight: number }>;
}

export interface ArchMeta {
  title?: string;
  description?: string;
  version?: string;
  date?: string;
  owner?: string;
  author?: string;
  /** Environment key → its display name, e.g. `{ "dev": "Development", "prd": "Production" }`. */
  environments?: Record<string, string>;
}

export interface ArchDoc {
  format?: string;
  meta?: ArchMeta;
  /** Titles of other architecture documents in the workspace whose components this one reuses. */
  includes?: string[];
  layout?: LayoutNode[];
  components?: Record<string, ArchComponent>;
  connections?: Connection[];
  flow?: string[];
  notes?: Note[];
  decisions?: Decision[];
  risks?: Risk[];
  /** Hand placements by component or zone id; absent ids are where the automatic layout puts them. */
  positions?: Record<string, Position>;
  sources?: SourceRef[];
  brief?: Brief;
}

/** A component as the document sees it once `includes` are resolved. */
export interface ResolvedComponent extends ArchComponent {
  id: string;
  /** Title of the document it came from, when it is shared rather than this document's own. */
  sharedFrom?: string;
}

export type ResolvedComponents = Record<string, ResolvedComponent>;

export const isZone = (n: LayoutNode): n is Zone => typeof n === "object" && n !== null && Array.isArray((n as Zone).children);
export const isGroup = (n: LayoutNode): n is LayoutGroup =>
  typeof n === "object" && n !== null && (Array.isArray((n as LayoutGroup).row) || Array.isArray((n as LayoutGroup).column));

/** The document's components with every included document's folded in under them (own ids win). */
export function resolveComponents(doc: ArchDoc, included: ReadonlyArray<{ title: string; doc: ArchDoc }> = []): ResolvedComponents {
  const out: ResolvedComponents = {};
  for (const name of doc.includes ?? []) {
    const other = included.find((d) => d.title === name);
    if (!other) continue;
    for (const [id, c] of Object.entries(other.doc.components ?? {})) out[id] = { ...c, id, sharedFrom: name };
  }
  for (const [id, c] of Object.entries(doc.components ?? {})) out[id] = { ...c, id };
  return out;
}

/** `resource` for one environment: `{env}` filled in, or that environment's own entry. */
export function resourceFor(value: ArchComponent["resource"], env: string): string {
  if (value == null) return "";
  if (typeof value === "object") return String(value[env] ?? Object.values(value)[0] ?? "");
  return String(value).replace(/\{env\}/g, env);
}

/**
 * Whether choosing an environment changes anything on this document: the environment only fills in
 * resource names — a component's `resource` with `{env}` in it or one name per environment, a
 * zone's title with `{env}` — so a document with none has nothing for the switch to switch.
 */
export function variesByEnvironment(doc: ArchDoc): boolean {
  const named = (value: unknown) =>
    typeof value === "string" ? value.includes("{env}") : typeof value === "object" && value !== null && new Set(Object.values(value)).size > 1;
  if (Object.values(doc.components ?? {}).some((c) => named(c.resource))) return true;
  const zoneNamed = (nodes: LayoutNode[] | undefined): boolean =>
    (nodes ?? []).some((n) => (isZone(n) ? named(n.title) || zoneNamed(n.children) : isGroup(n) ? zoneNamed(n.row ?? n.column) : false));
  return zoneNamed(doc.layout);
}

/** The environment a document should open in: the one asked for if it has it, else its last (production, by convention). */
export function pickEnvironment(doc: ArchDoc, wanted: string | null | undefined): string {
  const keys = Object.keys(doc.meta?.environments ?? {});
  if (!keys.length) return wanted || "prd";
  return wanted && keys.includes(wanted) ? wanted : keys[keys.length - 1];
}
