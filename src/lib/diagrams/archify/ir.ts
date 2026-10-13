/**
 * The IR of [archify](https://github.com/tt-a1i/archify) — the JSON it renders — for all five of
 * its diagram types, read, cleaned and typed.
 *
 * **Why archify's format and not one of ours.** A map the agent spends minutes reading a repository
 * for should outlive this app: stored as archify's own document, the same file is what
 * `archify finalize <type> <file> <out.html> --repo-root <repo>` turns into archify's validated
 * page, and a file someone already has opens here. The five types are archify's:
 *
 * | type           | what it is for                                             | its parts                               |
 * |----------------|-------------------------------------------------------------|------------------------------------------|
 * | `architecture` | components, boundaries, who talks to whom                   | components, boundaries, connections      |
 * | `workflow`     | a process: steps, owners, branches, retries                 | lanes, phases, groups, nodes, edges      |
 * | `sequence`     | one request through its participants, in order              | participants, messages, activations      |
 * | `dataflow`     | where data is born, changes and ends up                     | stages, nodes, flows                     |
 * | `lifecycle`    | the states something goes through and what moves it         | lanes, states, transitions               |
 *
 * **Everything here is lenient on the way in and exact on the way out.** Archify's schemas set
 * `additionalProperties: false` at every level, so one key a model invented fails a whole file;
 * [`parseArchify`] therefore rebuilds every object from the fields archify knows, repairs what it
 * can (an id with a space, a type out of the seven, a connection to nothing) and drops what it
 * cannot. Positions are not part of what an engine is asked for — [`./layout`] places everything —
 * so the IR here keeps the *semantic* placement archify itself has (`lane`/`col`, `stage`/`row`)
 * when a document supplied it, and leaves it absent when it did not.
 */

/** Archify's component types — `common.schema.json#/$defs/componentType`. */
export const ARCHIFY_TYPES = [
  "frontend",
  "backend",
  "database",
  "cloud",
  "security",
  "messagebus",
  "external",
] as const;
export type ArchifyType = (typeof ARCHIFY_TYPES)[number];

/** A lifecycle state's type — `lifecycle.schema.json`, where the vocabulary is the mode's own. */
export const LIFECYCLE_TYPES = [
  "start",
  "active",
  "waiting",
  "decision",
  "success",
  "failure",
  "neutral",
  "external",
] as const;
export type LifecycleType = (typeof LIFECYCLE_TYPES)[number];

export const ARCHIFY_MODES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const;
export type ArchifyMode = (typeof ARCHIFY_MODES)[number];

const VARIANTS = ["default", "emphasis", "security", "dashed"] as const;
export type ArchifyVariant = (typeof VARIANTS)[number];

const SIDES = ["left", "right", "top", "bottom"] as const;
export type ArchifySide = (typeof SIDES)[number];

const ROLES = ["main", "branch", "async", "return", "error"] as const;
export type ArchifyRole = (typeof ROLES)[number];

const CARD_DOTS = ["cyan", "emerald", "violet", "amber", "rose", "orange", "slate"] as const;
export type ArchifyCardDot = (typeof CARD_DOTS)[number];

export type ArchifyPoint = [number, number];

export interface ArchifySource {
  path: string;
  line?: number;
  end_line?: number;
  label?: string;
}

export interface ArchifyRepository {
  url: string;
  revision: string;
  provider?: "github" | "gitee";
  link_mode?: "web" | "local-only";
}

export interface ArchifyCard {
  dot: ArchifyCardDot;
  title: string;
  items: string[];
}

export interface ArchifyMeta {
  title: string;
  subtitle?: string;
  output?: string;
  repository?: ArchifyRepository;
}

interface Named {
  id: string;
  label: string;
  sublabel?: string;
  tag?: string;
  sources?: ArchifySource[];
}

// --- architecture ----------------------------------------------------------------------------

export interface ArchifyComponent extends Named {
  type: ArchifyType;
  pos?: ArchifyPoint;
  size?: ArchifyPoint;
  row?: number;
  col?: number;
}

export interface ArchifyBoundary {
  kind: "region" | "security-group";
  label: string;
  wraps: string[];
  pad?: number;
}

export interface ArchifyConnection {
  id?: string;
  from: string;
  to: string;
  label?: string;
  variant?: ArchifyVariant;
  fromSide?: ArchifySide;
  toSide?: ArchifySide;
}

export interface ArchifyGrid {
  mode: "grid";
  origin?: ArchifyPoint;
  cols?: number;
  gapX?: number;
  gapY?: number;
  cellW?: number;
  cellH?: number;
}

export interface ArchifyArchitecture {
  schema_version: 1;
  diagram_type: "architecture";
  meta: ArchifyMeta;
  layout?: ArchifyGrid;
  components: ArchifyComponent[];
  boundaries: ArchifyBoundary[];
  connections: ArchifyConnection[];
  cards: ArchifyCard[];
}

// --- workflow --------------------------------------------------------------------------------

export interface WorkflowLane {
  id: string;
  label: string;
  variant?: "normal" | "exception";
}

export interface WorkflowNode extends Named {
  type: ArchifyType;
  lane: string;
  col?: number;
}

export interface WorkflowEdge {
  id?: string;
  from: string;
  to: string;
  label?: string;
  variant?: ArchifyVariant;
  role?: ArchifyRole;
}

export interface WorkflowPhase {
  id: string;
  label: string;
  fromCol: number;
  toCol: number;
  variant?: ArchifyVariant;
}

export interface WorkflowGroup {
  id: string;
  label: string;
  lane: string;
  fromCol: number;
  toCol: number;
  variant?: ArchifyVariant;
}

export interface ArchifyWorkflow {
  schema_version: 2;
  diagram_type: "workflow";
  meta: ArchifyMeta;
  lanes: WorkflowLane[];
  phases: WorkflowPhase[];
  groups: WorkflowGroup[];
  mainPath: string[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  cards: ArchifyCard[];
}

// --- sequence --------------------------------------------------------------------------------

export interface SequenceParticipant extends Named {
  type: ArchifyType;
}

export interface SequenceMessage {
  id?: string;
  from: string;
  to: string;
  label: string;
  variant?: ArchifyVariant | "return";
  note?: string;
}

/** A band over a run of messages — archify's `segments`, which it spells in `y`; here in indices. */
export interface SequencePhase {
  label: string;
  from: number;
  to: number;
}

export interface SequenceActivation {
  participant: string;
  from: number;
  to: number;
  type?: ArchifyType;
}

export interface ArchifySequence {
  schema_version: 1;
  diagram_type: "sequence";
  meta: ArchifyMeta;
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
  phases: SequencePhase[];
  /** Absent unless the document wrote them; [`activationsOf`] derives them from the messages. */
  activations?: SequenceActivation[];
  cards: ArchifyCard[];
}

// --- dataflow --------------------------------------------------------------------------------

export interface DataflowNode extends Named {
  type: ArchifyType;
  stage?: number;
  row?: number;
}

export interface DataflowFlow {
  id?: string;
  from: string;
  to: string;
  label: string;
  classification?: string;
  variant?: ArchifyVariant;
}

export interface ArchifyDataflow {
  schema_version: 1;
  diagram_type: "dataflow";
  meta: ArchifyMeta;
  stages: { label: string }[];
  nodes: DataflowNode[];
  flows: DataflowFlow[];
  cards: ArchifyCard[];
}

// --- lifecycle -------------------------------------------------------------------------------

export interface LifecycleState extends Named {
  type: LifecycleType;
  step?: string;
  lane: string;
  col?: number;
}

export interface LifecycleTransition {
  id?: string;
  from: string;
  to: string;
  label?: string;
  note?: string;
  variant?: ArchifyVariant;
}

export interface ArchifyLifecycle {
  schema_version: 2;
  diagram_type: "lifecycle";
  meta: ArchifyMeta;
  lanes: { id: string; label: string }[];
  states: LifecycleState[];
  transitions: LifecycleTransition[];
  cards: ArchifyCard[];
}

export type ArchifyDocument =
  | ArchifyArchitecture
  | ArchifyWorkflow
  | ArchifySequence
  | ArchifyDataflow
  | ArchifyLifecycle;

export type ArchifyParseError = "empty" | "json" | "mode" | "entities";

// ---------------------------------------------------------------------------------------------
// Telling the two kinds of document apart
// ---------------------------------------------------------------------------------------------

/** archify stamps every page it renders: `<meta name="generator" content="archify 3.0.1">`. */
export function isArchifyHtml(text: string): boolean {
  return /<meta\s+name=["']generator["']\s+content=["']archify\b/i.test(text.slice(0, 8192));
}

/** A whole HTML document, by its first tag. */
function looksLikeHtml(text: string): boolean {
  return /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html)\b/i.test(text);
}

/**
 * Which of the two things an archify diagram holds — or why it is neither.
 *
 * Any HTML document counts as a rendered page, not only one archify stamped: the viewer shows a
 * page as it is, sandboxed, and the importer is what insists on archify's stamp (see
 * `exportFile.openDiagramFile`).
 */
export function archifyDocKind(
  doc: string,
  fallbackTitle = "",
):
  | { kind: "html" }
  | { kind: "document"; ir: ArchifyDocument }
  | { kind: "invalid"; error: ArchifyParseError; mode?: string } {
  if (looksLikeHtml(doc)) return { kind: "html" };
  const parsed = parseArchify(doc, fallbackTitle);
  return "error" in parsed
    ? { kind: "invalid", error: parsed.error, mode: parsed.mode }
    : { kind: "document", ir: parsed.ir };
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const FULL_SHA = /^[a-fA-F0-9]{40}$/;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function integer(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : undefined;
}

function point(value: unknown, positive: boolean): ArchifyPoint | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [x, y] = value;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  if (positive && (x <= 0 || y <= 0)) return undefined;
  return [x, y];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * The word an engine used for a component, as one of archify's seven.
 *
 * Models given an enum still answer with the noun they had in mind — `service`, `queue`, `user` —
 * and dropping those components would cost the map its point. Unknown words become `backend`: in a
 * repository map, a box nobody could name is most often code that runs on a server.
 */
export function archifyType(raw: unknown): ArchifyType {
  const word = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
  const exact = oneOf(word, ARCHIFY_TYPES);
  if (exact) return exact;
  if (/^(message-?bus|queue|bus|broker|event|events|stream|topic|pub-?sub|kafka|sqs|nats|mq)/.test(word)) {
    return "messagebus";
  }
  if (/^(db|data|store|storage|cache|redis|sql|postgres|mysql|sqlite|mongo|table|index|search|blob|bucket|file-?system)/.test(word)) {
    return "database";
  }
  if (/^(auth|security|identity|iam|oauth|secret|vault|keychain|key|firewall|waf|sso|crypto)/.test(word)) {
    return "security";
  }
  if (/^(ui|web|webapp|spa|client|browser|mobile|app|desktop|view|page|screen|cli|frontend)/.test(word)) {
    return "frontend";
  }
  if (/^(cloud|cdn|hosting|infra|load-?balancer|lb|dns|kubernetes|k8s|container|cluster|serverless|edge)/.test(word)) {
    return "cloud";
  }
  if (/^(external|third-?party|user|actor|person|human|saas|vendor|partner|provider|upstream)/.test(word)) {
    return "external";
  }
  return "backend";
}

/** A lifecycle state's type from an engine's word for it. */
export function lifecycleType(raw: unknown): LifecycleType {
  const word = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
  const exact = oneOf(word, LIFECYCLE_TYPES);
  if (exact) return exact;
  if (/^(init|initial|begin|created|new|open|draft|entry|inicio)/.test(word)) return "start";
  if (/^(done|final|end|complete|completed|closed|ok|approved|paid|delivered|resolved|success|terminal)/.test(word)) return "success";
  if (/^(error|fail|failed|rejected|denied|cancel|cancelled|canceled|aborted|expired|timeout|dead)/.test(word)) return "failure";
  if (/^(wait|pending|blocked|hold|paused|queued|retry|idle|suspended)/.test(word)) return "waiting";
  if (/^(choice|gate|branch|check|condition|if|switch|review)/.test(word)) return "decision";
  if (/^(ext|external|third|vendor|outside)/.test(word)) return "external";
  if (/^(run|running|process|processing|work|working|progress|in-progress|executing)/.test(word)) return "active";
  return "neutral";
}

function variant(raw: unknown): ArchifyVariant | undefined {
  const word = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!word) return undefined;
  const exact = oneOf(word, VARIANTS);
  if (exact) return exact === "default" ? undefined : exact;
  if (/^(main|primary|critical|hot|request|sync)/.test(word)) return "emphasis";
  if (/^(async|event|optional|background|dashed|queue|deferred)/.test(word)) return "dashed";
  if (/^(auth|secure|security|secret|trust)/.test(word)) return "security";
  return undefined;
}

/**
 * A repository-relative POSIX path, or nothing.
 *
 * archify resolves `sources` against `--repo-root` and refuses anything that could leave it; so does
 * the backend, before the answer gets here (`ai::ground_archify_answer`). This is the same rule for
 * an imported file, which never went through the backend.
 */
function sourcePath(value: unknown): string {
  const path = typeof value === "string" ? value.trim().replace(/^\.\//, "") : "";
  if (!path || path.length > 240) return "";
  if (path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path)) return "";
  if (path.split("/").some((part) => part === ".." || part === "." || part === "")) return "";
  return path;
}

function sources(value: unknown): ArchifySource[] {
  if (!Array.isArray(value)) return [];
  const out: ArchifySource[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (out.length === 3) break;
    const raw = typeof entry === "string" ? { path: entry } : (entry as Record<string, unknown> | null);
    if (!raw || typeof raw !== "object") continue;
    const path = sourcePath(raw.path);
    if (!path) continue;
    const line = integer(raw.line, 1);
    const end = line !== undefined ? integer(raw.end_line, line) : undefined;
    const key = `${path}:${line ?? ""}:${end ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = text(raw.label, 48);
    out.push({
      path,
      ...(line !== undefined ? { line } : {}),
      ...(end !== undefined && end !== line ? { end_line: end } : {}),
      ...(label ? { label } : {}),
    });
  }
  return out;
}

/** An id archify accepts, made from whatever the engine wrote, and unique in `taken`. */
function cleanId(raw: unknown, fallback: string, taken: Set<string>): string {
  const base =
    (typeof raw === "string" ? raw.trim() : "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^[^a-zA-Z]+/, "")
      .replace(/-+$/, "")
      .slice(0, 48) || fallback;
  const root = ID.test(base) ? base : fallback;
  let id = root;
  for (let n = 2; taken.has(id); n++) id = `${root}-${n}`;
  taken.add(id);
  return id;
}

function repository(value: unknown): ArchifyRepository | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const revision = typeof raw.revision === "string" ? raw.revision.trim() : "";
  if (!url || !FULL_SHA.test(revision)) return undefined;
  const provider = oneOf(raw.provider, ["github", "gitee"] as const);
  const linkMode = oneOf(raw.link_mode, ["web", "local-only"] as const);
  return { url, revision, ...(provider ? { provider } : {}), ...(linkMode ? { link_mode: linkMode } : {}) };
}

function grid(value: unknown): ArchifyGrid | undefined {
  if (!value || typeof value !== "object" || (value as { mode?: unknown }).mode !== "grid") return undefined;
  const raw = value as Record<string, unknown>;
  const out: ArchifyGrid = { mode: "grid" };
  const origin = point(raw.origin, false);
  if (origin) out.origin = origin;
  const cols = integer(raw.cols, 1);
  if (cols !== undefined && cols <= 12) out.cols = cols;
  for (const key of ["gapX", "gapY", "cellW", "cellH"] as const) {
    const n = raw[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

/**
 * `meta.output` as archify's `portableOutputPath` accepts it: a relative POSIX path to an `.html`,
 * no dot segments, no characters Windows refuses, nothing ending in a dot or a space.
 */
export function portableOutput(path: string): boolean {
  if (!/^[^/]+(?:\/[^/]+)*$/.test(path) || !/\.html$/i.test(path)) return false;
  if (/[\\<>:"|?*\u0000-\u001f\u007f-\u009f]/.test(path)) return false;
  return path.split("/").every((part) => part !== "." && part !== ".." && !/[. ]$/.test(part) && part.length < 256);
}

function cards(value: unknown): ArchifyCard[] {
  const out: ArchifyCard[] = [];
  for (const [index, entry] of (Array.isArray(value) ? value : []).entries()) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const title = text(raw.title, 60);
    const items = Array.isArray(raw.items)
      ? raw.items.map((item) => text(item, 160)).filter(Boolean).slice(0, 8)
      : [];
    if (!title || items.length === 0) continue;
    out.push({ dot: oneOf(raw.dot, CARD_DOTS) ?? CARD_DOTS[index % CARD_DOTS.length], title, items });
  }
  return out.slice(0, 6);
}

function meta(doc: Record<string, unknown>, fallbackTitle: string): ArchifyMeta {
  const raw = (doc.meta && typeof doc.meta === "object" ? doc.meta : {}) as Record<string, unknown>;
  const out: ArchifyMeta = { title: text(raw.title, 120) || fallbackTitle.trim() || "Archify" };
  const subtitle = text(raw.subtitle ?? doc.summary, 400);
  if (subtitle) out.subtitle = subtitle;
  const output = typeof raw.output === "string" && portableOutput(raw.output) ? raw.output : "";
  if (output) out.output = output;
  const repo = repository(raw.repository);
  if (repo) out.repository = repo;
  return out;
}

/** The part of a node every mode shares, and the id it ended up with. */
function named(
  entry: unknown,
  index: number,
  taken: Set<string>,
  rename: Map<string, string>,
): (Named & { raw: Record<string, unknown> }) | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, unknown>;
  const label = text(raw.label, 80) || text(raw.name, 80) || text(raw.id, 80);
  if (!label) return null;
  const original = typeof raw.id === "string" ? raw.id : label;
  if (rename.has(original)) return null;
  const id = cleanId(original, `item-${index + 1}`, taken);
  rename.set(original, id);
  const out: Named & { raw: Record<string, unknown> } = { id, label, raw };
  const sublabel = text(raw.sublabel ?? raw.description, 120);
  if (sublabel) out.sublabel = sublabel;
  const tag = text(raw.tag, 60);
  if (tag) out.tag = tag;
  const found = sources(raw.sources);
  if (found.length) out.sources = found;
  return out;
}

function strip<T extends Named & { raw?: unknown }>(item: T): Omit<T, "raw"> {
  const { raw: _raw, ...rest } = item;
  return rest;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Links between entities, once the ids are final: drops self-loops, dangling ends and repeats. */
function links<T extends { id?: string; from: string; to: string; label?: string }>(
  value: unknown,
  rename: Map<string, string>,
  build: (raw: Record<string, unknown>) => Omit<T, "id" | "from" | "to">,
  allowSelf = false,
): T[] {
  const out: T[] = [];
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const entry of list(value)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const from = rename.get(String(raw.from));
    const to = rename.get(String(raw.to));
    if (!from || !to || (from === to && !allowSelf)) continue;
    const built = build(raw) as Partial<T>;
    const key = `${from}\u0000${to}\u0000${built.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const link = { ...built, from, to } as T;
    if (typeof raw.id === "string" && ID.test(raw.id) && !ids.has(raw.id)) {
      ids.add(raw.id);
      link.id = raw.id;
    }
    out.push(link);
  }
  return out;
}

function withDefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key];
  return value;
}

function parseArchitecture(doc: Record<string, unknown>, fallbackTitle: string): ArchifyArchitecture | null {
  const taken = new Set<string>();
  const rename = new Map<string, string>();
  const components: ArchifyComponent[] = [];
  for (const [index, entry] of list(doc.components).entries()) {
    const base = named(entry, index, taken, rename);
    if (!base) continue;
    const component: ArchifyComponent = { ...strip(base), type: archifyType(base.raw.type ?? base.raw.kind) };
    const pos = point(base.raw.pos, false);
    if (pos) component.pos = pos;
    const size = point(base.raw.size, true);
    if (size) component.size = size;
    const row = integer(base.raw.row, 0);
    const col = integer(base.raw.col, 0);
    if (row !== undefined && col !== undefined) {
      component.row = row;
      component.col = col;
    }
    components.push(component);
  }
  if (components.length === 0) return null;

  const boundaries: ArchifyBoundary[] = [];
  for (const entry of list(doc.boundaries)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const label = text(raw.label, 80);
    const wraps = Array.isArray(raw.wraps)
      ? [...new Set(raw.wraps.map((id) => rename.get(String(id))).filter((id): id is string => !!id))]
      : [];
    if (!label || wraps.length === 0) continue;
    const kindWord = typeof raw.kind === "string" ? raw.kind.toLowerCase() : "";
    const kind = /security|^sg$|trust|sandbox|private/.test(kindWord) ? "security-group" : "region";
    const pad = typeof raw.pad === "number" && Number.isFinite(raw.pad) && raw.pad >= 0 ? raw.pad : undefined;
    boundaries.push({ kind, label, wraps, ...(pad !== undefined ? { pad } : {}) });
  }

  const connections = links<ArchifyConnection>(doc.connections, rename, (raw) =>
    withDefined({
      label: text(raw.label, 60) || undefined,
      variant: variant(raw.variant ?? raw.kind),
      fromSide: oneOf(raw.fromSide, SIDES),
      toSide: oneOf(raw.toSide, SIDES),
    }),
  );

  const ir: ArchifyArchitecture = {
    schema_version: 1,
    diagram_type: "architecture",
    meta: meta(doc, fallbackTitle),
    components,
    boundaries,
    connections,
    cards: cards(doc.cards),
  };
  const layout = grid(doc.layout);
  if (layout) ir.layout = layout;
  return ir;
}

function parseWorkflow(doc: Record<string, unknown>, fallbackTitle: string): ArchifyWorkflow | null {
  const laneIds = new Set<string>();
  const laneRename = new Map<string, string>();
  const lanes: WorkflowLane[] = [];
  for (const [index, entry] of list(doc.lanes).entries()) {
    const raw = typeof entry === "string" ? { label: entry } : (entry as Record<string, unknown> | null);
    if (!raw || typeof raw !== "object") continue;
    const label = text(raw.label, 60) || text(raw.name, 60) || text(raw.id, 60);
    if (!label) continue;
    const original = typeof raw.id === "string" ? raw.id : label;
    if (laneRename.has(original)) continue;
    const id = cleanId(original, `lane-${index + 1}`, laneIds);
    laneRename.set(original, id);
    laneRename.set(label, id);
    lanes.push({ id, label, ...(raw.variant === "exception" ? { variant: "exception" as const } : {}) });
  }
  if (lanes.length === 0) {
    lanes.push({ id: "main", label: "Flujo" });
    laneRename.set("main", "main");
  }

  const taken = new Set<string>();
  const rename = new Map<string, string>();
  const nodes: WorkflowNode[] = [];
  for (const [index, entry] of list(doc.nodes).entries()) {
    const base = named(entry, index, taken, rename);
    if (!base) continue;
    const lane = laneRename.get(String(base.raw.lane)) ?? lanes[0].id;
    const node: WorkflowNode = {
      ...strip(base),
      type: archifyType(base.raw.type ?? base.raw.kind),
      lane,
    };
    const col = integer(base.raw.col, 0);
    if (col !== undefined) node.col = col;
    nodes.push(node);
  }
  if (nodes.length === 0) return null;

  const edges = links<WorkflowEdge>(doc.edges, rename, (raw) =>
    withDefined({
      label: text(raw.label, 60) || undefined,
      variant: variant(raw.variant),
      role: oneOf(raw.role, ROLES),
    }),
  );

  const columns = (raw: Record<string, unknown>) => {
    const from = integer(raw.fromCol, 0) ?? 0;
    const to = integer(raw.toCol, from) ?? from;
    return { fromCol: Math.min(from, to), toCol: Math.max(from, to) };
  };
  const phases: WorkflowPhase[] = [];
  const phaseIds = new Set<string>();
  for (const [index, entry] of list(doc.phases).entries()) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const label = text(raw.label, 48);
    if (!label) continue;
    phases.push({ id: cleanId(raw.id ?? label, `phase-${index + 1}`, phaseIds), label, ...columns(raw), ...withDefined({ variant: variant(raw.variant) }) });
  }
  const groups: WorkflowGroup[] = [];
  const groupIds = new Set<string>();
  for (const [index, entry] of list(doc.groups).entries()) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const label = text(raw.label, 48);
    const lane = laneRename.get(String(raw.lane));
    if (!label || !lane) continue;
    groups.push({ id: cleanId(raw.id ?? label, `group-${index + 1}`, groupIds), label, lane, ...columns(raw), ...withDefined({ variant: variant(raw.variant) }) });
  }

  return {
    schema_version: 2,
    diagram_type: "workflow",
    meta: meta(doc, fallbackTitle),
    lanes,
    phases,
    groups,
    mainPath: list(doc.mainPath).map((id) => rename.get(String(id))).filter((id): id is string => !!id),
    nodes,
    edges,
    cards: cards(doc.cards),
  };
}

function parseSequence(doc: Record<string, unknown>, fallbackTitle: string): ArchifySequence | null {
  const taken = new Set<string>();
  const rename = new Map<string, string>();
  const participants: SequenceParticipant[] = [];
  for (const [index, entry] of list(doc.participants).entries()) {
    const base = named(entry, index, taken, rename);
    if (!base) continue;
    participants.push({ ...strip(base), type: archifyType(base.raw.type ?? base.raw.kind) });
  }
  if (participants.length === 0) return null;

  // Messages keep their authored order — or, when every one carries archify's `y`, that order.
  const rawMessages = list(doc.messages).filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
  const ys = rawMessages.map((m) => (typeof m.y === "number" && Number.isFinite(m.y) ? m.y : null));
  const ordered = rawMessages.map((raw, at) => ({ raw, at, y: ys[at] }));
  if (ys.every((y) => y !== null)) ordered.sort((a, b) => a.y! - b.y! || a.at - b.at);
  // Not through `links`: a sequence message is not unique by (from, to, label) — the same call
  // happens twice in a retry — and a self-message is a legitimate loop.
  const everyMessage: SequenceMessage[] = [];
  /** The `y` of each message that survived, in the same order — what a band written in `y` is read against. */
  const orderedYs: (number | null)[] = [];
  for (const { raw, y } of ordered) {
    const from = rename.get(String(raw.from));
    const to = rename.get(String(raw.to));
    if (!from || !to) continue;
    const explicit = oneOf(raw.variant, [...VARIANTS, "return"] as const);
    const style = explicit === "default" ? undefined : (explicit ?? variant(raw.variant));
    const message: SequenceMessage = { from, to, label: text(raw.label, 64) || text(raw.name, 64) || "\u2026" };
    if (typeof raw.id === "string" && ID.test(raw.id) && !everyMessage.some((m) => m.id === raw.id)) {
      message.id = raw.id;
    }
    if (style) message.variant = style;
    const note = text(raw.note, 160);
    if (note) message.note = note;
    everyMessage.push(message);
    orderedYs.push(y);
  }
  if (everyMessage.length === 0) return null;

  // Archify writes a band as a `y` range; an engine writes it as message ids or indices. Both land
  // as message indices.
  const indexOfId = new Map(everyMessage.flatMap((m, at) => (m.id ? [[m.id, at] as const] : [])));
  const phases: SequencePhase[] = [];
  for (const entry of [...list(doc.phases), ...list(doc.segments)]) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const label = text(raw.label, 48);
    if (!label) continue;
    const resolve = (value: unknown, fallback: number): number => {
      if (typeof value === "string" && indexOfId.has(value)) return indexOfId.get(value)!;
      if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < everyMessage.length && orderedYs.every((y) => y === null)) return value;
      return fallback;
    };
    let from = resolve(raw.from, -1);
    let to = resolve(raw.to, -1);
    if ((from < 0 || to < 0) && typeof raw.from === "number" && typeof raw.to === "number" && orderedYs.every((y) => y !== null)) {
      const first = orderedYs.findIndex((y) => y! >= (raw.from as number));
      const last = orderedYs.map((y) => y! <= (raw.to as number)).lastIndexOf(true);
      from = first;
      to = last;
    }
    if (from < 0 || to < from) continue;
    phases.push({ label, from, to });
  }

  const ir: ArchifySequence = {
    schema_version: 1,
    diagram_type: "sequence",
    meta: meta(doc, fallbackTitle),
    participants,
    messages: everyMessage,
    phases,
    cards: cards(doc.cards),
  };
  const activations: SequenceActivation[] = [];
  for (const entry of list(doc.activations)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const participant = rename.get(String(raw.participant));
    if (!participant || typeof raw.from !== "number" || typeof raw.to !== "number") continue;
    const withY = orderedYs.every((y) => y !== null);
    const from = withY ? orderedYs.findIndex((y) => y! >= (raw.from as number) - 8) : Math.round(raw.from);
    const to = withY ? orderedYs.map((y) => y! <= (raw.to as number) + 8).lastIndexOf(true) : Math.round(raw.to);
    if (from >= 0 && to >= from && to < everyMessage.length) activations.push({ participant, from, to });
  }
  if (activations.length) ir.activations = activations;
  return ir;
}

function parseDataflow(doc: Record<string, unknown>, fallbackTitle: string): ArchifyDataflow | null {
  const taken = new Set<string>();
  const rename = new Map<string, string>();
  const nodes: DataflowNode[] = [];
  for (const [index, entry] of list(doc.nodes).entries()) {
    const base = named(entry, index, taken, rename);
    if (!base) continue;
    const node: DataflowNode = { ...strip(base), type: archifyType(base.raw.type ?? base.raw.kind) };
    const stage = integer(base.raw.stage, 0);
    if (stage !== undefined) node.stage = stage;
    const row = integer(base.raw.row, 0);
    if (row !== undefined) node.row = row;
    nodes.push(node);
  }
  if (nodes.length === 0) return null;

  const stages = list(doc.stages)
    .map((entry) => text(typeof entry === "string" ? entry : (entry as { label?: unknown } | null)?.label, 40))
    .filter(Boolean)
    .map((label) => ({ label }));

  const flows = links<DataflowFlow>(doc.flows ?? doc.edges, rename, (raw) =>
    withDefined({
      label: text(raw.label, 60) || "…",
      classification: text(raw.classification, 32) || undefined,
      variant: variant(raw.variant),
    }),
  );
  return {
    schema_version: 1,
    diagram_type: "dataflow",
    meta: meta(doc, fallbackTitle),
    stages,
    nodes,
    flows,
    cards: cards(doc.cards),
  };
}

function parseLifecycle(doc: Record<string, unknown>, fallbackTitle: string): ArchifyLifecycle | null {
  const laneIds = new Set<string>();
  const laneRename = new Map<string, string>();
  const lanes: { id: string; label: string }[] = [];
  for (const [index, entry] of list(doc.lanes).entries()) {
    const raw = typeof entry === "string" ? { label: entry } : (entry as Record<string, unknown> | null);
    if (!raw || typeof raw !== "object") continue;
    const label = text(raw.label, 60) || text(raw.name, 60) || text(raw.id, 60);
    if (!label) continue;
    const original = typeof raw.id === "string" ? raw.id : label;
    if (laneRename.has(original)) continue;
    const id = cleanId(original, `lane-${index + 1}`, laneIds);
    laneRename.set(original, id);
    laneRename.set(label, id);
    lanes.push({ id, label });
  }
  if (lanes.length === 0) {
    lanes.push({ id: "main", label: "Estados" });
    laneRename.set("main", "main");
  }

  const taken = new Set<string>();
  const rename = new Map<string, string>();
  const states: LifecycleState[] = [];
  for (const [index, entry] of list(doc.states).entries()) {
    const base = named(entry, index, taken, rename);
    if (!base) continue;
    const state: LifecycleState = {
      ...strip(base),
      type: lifecycleType(base.raw.type ?? base.raw.kind),
      lane: laneRename.get(String(base.raw.lane)) ?? lanes[0].id,
    };
    const step = text(base.raw.step, 12);
    if (step) state.step = step;
    const col = integer(base.raw.col, 0);
    if (col !== undefined) state.col = col;
    states.push(state);
  }
  if (states.length === 0) return null;

  const transitions = links<LifecycleTransition>(
    doc.transitions ?? doc.edges,
    rename,
    (raw) =>
      withDefined({
        label: text(raw.label, 48) || undefined,
        note: text(raw.note, 160) || undefined,
        variant: variant(raw.variant),
      }),
    true,
  );
  return {
    schema_version: 2,
    diagram_type: "lifecycle",
    meta: meta(doc, fallbackTitle),
    lanes,
    states,
    transitions,
    cards: cards(doc.cards),
  };
}

/**
 * Reads an archify document — an engine's answer, or a file — whichever of the five types it is.
 *
 * Lenient where being strict would lose a usable diagram and exact about what comes out: everything
 * returned is made of fields archify's schema knows. `meta.output` may be missing — it names the
 * HTML file archify writes, which only exists once somebody exports (see `sourceFile.ts`).
 */
export function parseArchify(
  raw: string,
  fallbackTitle = "",
): { ir: ArchifyDocument } | { error: ArchifyParseError; mode?: string } {
  if (!raw.trim()) return { error: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "json" };
  const doc = parsed as Record<string, unknown>;

  const declared = typeof doc.diagram_type === "string" ? doc.diagram_type.trim().toLowerCase() : "";
  let mode: ArchifyMode | undefined = oneOf(declared, ARCHIFY_MODES);
  if (!mode && declared) return { error: "mode", mode: declared };
  if (!mode) {
    mode = Array.isArray(doc.components)
      ? "architecture"
      : Array.isArray(doc.participants)
        ? "sequence"
        : Array.isArray(doc.states)
          ? "lifecycle"
          : Array.isArray(doc.stages)
            ? "dataflow"
            : Array.isArray(doc.nodes)
              ? "workflow"
              : undefined;
  }
  if (!mode) return { error: "entities" };

  const ir =
    mode === "architecture"
      ? parseArchitecture(doc, fallbackTitle)
      : mode === "workflow"
        ? parseWorkflow(doc, fallbackTitle)
        : mode === "sequence"
          ? parseSequence(doc, fallbackTitle)
          : mode === "dataflow"
            ? parseDataflow(doc, fallbackTitle)
            : parseLifecycle(doc, fallbackTitle);
  return ir ? { ir } : { error: "entities" };
}

// ---------------------------------------------------------------------------------------------
// What every mode has in common
// ---------------------------------------------------------------------------------------------

/** One thing on the page — a component, a step, a participant, a state. */
export interface ArchifyEntity {
  id: string;
  label: string;
  sublabel?: string;
  tag?: string;
  /** The colour/semantic key: one of the seven types, or a lifecycle state type. */
  kind: string;
  sources: ArchifySource[];
}

/** One link between two of them — a connection, an edge, a message, a flow, a transition. */
export interface ArchifyRelation {
  id: string;
  from: string;
  to: string;
  label: string;
  note?: string;
  classification?: string;
  /** How it is drawn. */
  style: "default" | "emphasis" | "security" | "dashed" | "return" | "error";
  role?: ArchifyRole;
}

function entityOf(item: Named, kind: string): ArchifyEntity {
  return { id: item.id, label: item.label, sublabel: item.sublabel, tag: item.tag, kind, sources: item.sources ?? [] };
}

export function archifyEntities(doc: ArchifyDocument): ArchifyEntity[] {
  switch (doc.diagram_type) {
    case "architecture":
      return doc.components.map((c) => entityOf(c, c.type));
    case "workflow":
      return doc.nodes.map((n) => entityOf(n, n.type));
    case "sequence":
      return doc.participants.map((p) => entityOf(p, p.type));
    case "dataflow":
      return doc.nodes.map((n) => entityOf(n, n.type));
    case "lifecycle":
      return doc.states.map((s) => ({ ...entityOf(s, s.type) }));
  }
}

function styleOf(variantName: string | undefined, role?: ArchifyRole): ArchifyRelation["style"] {
  if (variantName && variantName !== "default") return variantName as ArchifyRelation["style"];
  if (role === "main") return "emphasis";
  if (role === "async") return "dashed";
  if (role === "return") return "return";
  if (role === "error") return "error";
  return "default";
}

export function archifyRelations(doc: ArchifyDocument): ArchifyRelation[] {
  switch (doc.diagram_type) {
    case "architecture":
      return doc.connections.map((c, at) => ({
        id: c.id ?? `c${at + 1}`,
        from: c.from,
        to: c.to,
        label: c.label ?? "",
        style: styleOf(c.variant),
      }));
    case "workflow": {
      const main = new Set<string>();
      doc.mainPath.forEach((id, at) => {
        if (at > 0) main.add(`${doc.mainPath[at - 1]}\u0000${id}`);
      });
      return doc.edges.map((e, at) => ({
        id: e.id ?? `e${at + 1}`,
        from: e.from,
        to: e.to,
        label: e.label ?? "",
        style: styleOf(e.variant, e.role ?? (main.has(`${e.from}\u0000${e.to}`) ? "main" : undefined)),
        role: e.role,
      }));
    }
    case "sequence":
      return doc.messages.map((m, at) => ({
        id: m.id ?? `m${at + 1}`,
        from: m.from,
        to: m.to,
        label: m.label,
        note: m.note,
        style: styleOf(m.variant),
      }));
    case "dataflow":
      return doc.flows.map((f, at) => ({
        id: f.id ?? `f${at + 1}`,
        from: f.from,
        to: f.to,
        label: f.label,
        classification: f.classification,
        style: styleOf(f.variant),
      }));
    case "lifecycle":
      return doc.transitions.map((t, at) => ({
        id: t.id ?? `t${at + 1}`,
        from: t.from,
        to: t.to,
        label: t.label ?? "",
        note: t.note,
        style: styleOf(t.variant),
      }));
  }
}

/**
 * The activation bars of a sequence: written by the document, or derived.
 *
 * Derived the way a reader would draw them: a call into a participant switches it on, and it stays
 * on until the reply that answers that call goes back to its caller — or, when nothing answers, for
 * the one message that was the call.
 */
export function activationsOf(doc: ArchifySequence): SequenceActivation[] {
  if (doc.activations?.length) return doc.activations;
  const out: SequenceActivation[] = [];
  const messages = doc.messages;
  messages.forEach((message, at) => {
    if (message.variant === "return" || message.from === message.to) return;
    let end = -1;
    for (let next = at + 1; next < messages.length; next++) {
      const reply = messages[next];
      if (reply.from === message.to && reply.to === message.from && reply.variant === "return") {
        end = next;
        break;
      }
    }
    if (end < 0) return;
    out.push({ participant: message.to, from: at, to: end });
  });
  return out;
}
