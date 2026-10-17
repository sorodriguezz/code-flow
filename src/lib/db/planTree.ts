/**
 * A query plan, as text, turned into a tree the console can draw — so the expensive node is found
 * by looking, not by reading 80 indented lines.
 *
 * Each engine's `db_explain` answers in its own text format, and each one nests by indentation:
 *
 * - PostgreSQL `FORMAT TEXT`: the first line and every `->` line is a node, nested by the column of
 *   the `->`; the lines in between (`Filter:`, `Output:`, `Buffers:`) belong to the node above.
 * - MySQL `FORMAT=TREE` / `EXPLAIN ANALYZE`: every node is a `->` line, four spaces per level.
 * - SQLite: `EXPLAIN QUERY PLAN` rows, which the backend indents two spaces per level.
 * - SQL Server `SHOWPLAN_ALL`: the `StmtText` column — the statement, then `|--` operators.
 * - Oracle `DBMS_XPLAN.DISPLAY`: a `| Id | Operation | Name | Rows | … |` table, nested by the
 *   leading spaces of `Operation`, followed by its predicate section.
 *
 * Answers `null` when the text isn't in the shape expected (MariaDB's JSON, a driver's own
 * rendering): the view then shows the text as it came, which is never wrong.
 */

export type PlanEngine = "postgres" | "mysql" | "sqlite" | "mssql" | "oracle" | "other";

export interface PlanNode {
  label: string;
  /** Lines that describe the node rather than being one — conditions, outputs, buffers. */
  detail: string[];
  /** Estimated total cost, inclusive of the children, in the engine's own units. */
  cost: number | null;
  startupCost: number | null;
  /** Estimated rows (per loop, as the engines report them). */
  rows: number | null;
  /** Measured time, inclusive of the children, over every loop. Only after `ANALYZE`. */
  actualMs: number | null;
  /** Measured rows per loop. Only after `ANALYZE`. */
  actualRows: number | null;
  loops: number | null;
  children: PlanNode[];
}

export function parsePlan(text: string, engine: PlanEngine): PlanNode | null {
  if (!text.trim()) return null;
  try {
    switch (engine) {
      case "postgres":
        return parseArrowPlan(text, true);
      case "mysql":
        return parseArrowPlan(text, false);
      case "sqlite":
        return parseSqlite(text);
      case "mssql":
        return parseMssql(text);
      case "oracle":
        return parseOracle(text);
      default:
        // An engine whose own rendering we don't know: the Postgres shape is the common one
        // (CockroachDB, Redshift, Greenplum and friends all speak it), so try it and nothing else.
        return /^\s*->/m.test(text) ? parseArrowPlan(text, true) : null;
    }
  } catch {
    return null;
  }
}

/** The node where the most time (after `ANALYZE`) or cost is spent by the node itself. */
export function planHotspot(root: PlanNode): PlanNode | null {
  const measured = hasActual(root);
  let best: PlanNode | null = null;
  let bestValue = 0;
  walk(root, (node) => {
    const value = selfMetric(node, measured);
    if (value !== null && value > bestValue) {
      best = node;
      bestValue = value;
    }
  });
  return best;
}

/** The whole plan's time (after `ANALYZE`) or cost; `null` when the engine gives neither. */
export function totalOf(root: PlanNode): number | null {
  return inclusiveMetric(root, hasActual(root));
}

/** True when any node carries a measured time — the plan came from `ANALYZE`. */
export function hasActual(root: PlanNode): boolean {
  let found = false;
  walk(root, (node) => {
    if (node.actualMs !== null) found = true;
  });
  return found;
}

/** Inclusive time or cost of a node. A node without its own figure (a synthetic root, a SQL Server
 *  statement line) counts as the sum of its children. */
export function inclusiveMetric(node: PlanNode, measured: boolean): number | null {
  const own = measured ? node.actualMs : node.cost;
  if (own !== null) return own;
  let sum: number | null = null;
  for (const child of node.children) {
    const value = inclusiveMetric(child, measured);
    if (value !== null) sum = (sum ?? 0) + value;
  }
  return sum;
}

/** What the node spends itself: its inclusive figure minus its children's, never below zero
 *  (parallel workers and rounding can make the children add up to more than the parent). */
export function selfMetric(node: PlanNode, measured: boolean): number | null {
  const own = measured ? node.actualMs : node.cost;
  if (own === null) return null;
  const children = node.children.reduce((sum, child) => sum + (inclusiveMetric(child, measured) ?? 0), 0);
  return Math.max(0, own - children);
}

function walk(node: PlanNode, visit: (node: PlanNode) => void) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

// ------------------------------------------------------------------ building

function emptyNode(label: string): PlanNode {
  return {
    label,
    detail: [],
    cost: null,
    startupCost: null,
    rows: null,
    actualMs: null,
    actualRows: null,
    loops: null,
    children: [],
  };
}

/**
 * Nests nodes by the column they start at: a node's parent is the nearest node above it that
 * starts further left. Several top-level nodes get a synthetic root, so the answer is one tree.
 */
class Nester {
  private stack: { node: PlanNode; column: number }[] = [];
  readonly roots: PlanNode[] = [];

  push(node: PlanNode, column: number) {
    while (this.stack.length && this.stack[this.stack.length - 1].column >= column) this.stack.pop();
    const parent = this.stack[this.stack.length - 1];
    if (parent) parent.node.children.push(node);
    else this.roots.push(node);
    this.stack.push({ node, column });
  }

  get last(): PlanNode | null {
    return this.stack.length ? this.stack[this.stack.length - 1].node : null;
  }

  root(): PlanNode | null {
    if (this.roots.length === 0) return null;
    if (this.roots.length === 1) return this.roots[0];
    const root = emptyNode("Query plan");
    root.children = this.roots;
    return root;
  }
}

const NUM = String.raw`(\d+(?:\.\d+)?(?:e[+-]?\d+)?)`;
const COST = new RegExp(String.raw`cost=${NUM}(?:\.\.${NUM})?\s+rows=${NUM}`, "i");
const ACTUAL = new RegExp(String.raw`actual(?:\s+time=${NUM}\.\.${NUM})?\s+rows=${NUM}\s+loops=${NUM}`, "i");

function applyFigures(node: PlanNode, text: string) {
  const cost = COST.exec(text);
  if (cost) {
    if (cost[2] !== undefined) {
      node.startupCost = Number(cost[1]);
      node.cost = Number(cost[2]);
    } else {
      node.cost = Number(cost[1]);
    }
    node.rows = Number(cost[3]);
  }
  const actual = ACTUAL.exec(text);
  if (actual) {
    node.loops = Number(actual[4]);
    node.actualRows = Number(actual[3]);
    // Both engines report the time per loop; the node's share of the run is that times the loops.
    if (actual[2] !== undefined) node.actualMs = Number(actual[2]) * node.loops;
  }
  if (/\(never executed\)/i.test(text)) {
    node.actualMs = 0;
    node.actualRows = 0;
    node.loops = 0;
  }
}

/** The operation alone: what is left once the `(cost=…)` / `(actual …)` groups are taken out. */
function arrowLabel(text: string): string {
  return text
    .replace(/\(cost=[^)]*\)/gi, "")
    .replace(/\(actual[^)]*\)/gi, "")
    .replace(/\(never executed\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

// ------------------------------------------------------------------ Postgres / MySQL

function parseArrowPlan(text: string, postgres: boolean): PlanNode | null {
  const nester = new Nester();
  const rootDetail: string[] = [];
  // Once a line at the left margin that isn't a node turns up (`Planning Time:`, `Planning:`,
  // `Execution Time:`, `JIT:`), the plan proper is over and the rest describes the run.
  let trailer = false;
  let sawArrow = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const trimmed = line.trim();
    // psql's own header and rule, when the text was pasted from a terminal.
    if (/^QUERY PLAN$/i.test(trimmed) || /^-{3,}$/.test(trimmed) || /^\(\d+ rows?\)$/.test(trimmed)) continue;
    // The backend's own note ("-- EXPLAIN ANALYZE needs MySQL 8.0.18 …").
    if (trimmed.startsWith("--")) {
      rootDetail.push(trimmed.replace(/^--\s*/, ""));
      continue;
    }

    const arrow = line.indexOf("->");
    const isArrow = arrow >= 0 && !line.slice(0, arrow).trim();
    if (isArrow && !trailer) {
      sawArrow = true;
      const node = emptyNode(arrowLabel(line.slice(arrow + 2)));
      applyFigures(node, line);
      nester.push(node, arrow);
      continue;
    }
    // Postgres: the first line is the root, written without an arrow.
    if (postgres && !nester.last && !trailer) {
      const node = emptyNode(arrowLabel(trimmed));
      applyFigures(node, line);
      nester.push(node, indentOf(line) - 1);
      continue;
    }
    if (indentOf(line) === 0) trailer = true;
    if (trailer || !nester.last) rootDetail.push(trimmed);
    else nester.last.detail.push(trimmed);
  }

  if (!postgres && !sawArrow) return null;
  const root = nester.root();
  if (!root) return null;
  root.detail.push(...rootDetail);
  return root;
}

// ------------------------------------------------------------------ SQLite

function parseSqlite(text: string): PlanNode | null {
  const nester = new Nester();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    nester.push(emptyNode(raw.trim()), indentOf(raw));
  }
  return nester.root();
}

// ------------------------------------------------------------------ SQL Server

function parseMssql(text: string): PlanNode | null {
  const nester = new Nester();
  let sawOperator = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const bar = raw.indexOf("|--");
    if (bar < 0) {
      // A statement line: it heads the operators that follow it.
      nester.push(emptyNode(raw.trim()), -1);
      continue;
    }
    sawOperator = true;
    const body = raw.slice(bar + 3).trim();
    // `Clustered Index Seek(OBJECT:(…), SEEK:(…))`: the operator is the label, its arguments the detail.
    const open = body.indexOf("(");
    const node = emptyNode(open > 0 ? body.slice(0, open).trim() : body);
    if (open > 0) node.detail.push(body.slice(open + 1, body.endsWith(")") ? -1 : undefined).trim());
    nester.push(node, bar);
  }
  return sawOperator ? nester.root() : null;
}

// ------------------------------------------------------------------ Oracle

/** `10K`, `2M`, `1G` — DBMS_XPLAN shortens anything that doesn't fit its column. */
function oracleNumber(cell: string | undefined): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([KMGTP])?/i.exec(cell ?? "");
  if (!match) return null;
  const scale: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 };
  return Number(match[1]) * (match[2] ? scale[match[2].toUpperCase()] : 1);
}

function cellsOf(line: string): string[] {
  const parts = line.split("|");
  return parts.slice(1, parts.length - 1);
}

function parseOracle(text: string): PlanNode | null {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /\|\s*Id\s*\|\s*Operation\s*\|/i.test(line));
  if (headerIndex < 0) return null;
  const header = cellsOf(lines[headerIndex]).map((cell) => cell.trim().toLowerCase());
  const column = (name: string) => header.findIndex((cell) => cell.startsWith(name));
  const [idCol, opCol, nameCol, rowsCol, costCol, bytesCol] = ["id", "operation", "name", "rows", "cost", "bytes"].map(
    column,
  );

  const nester = new Nester();
  const byId = new Map<number, PlanNode>();
  let baseIndent: number | null = null;
  let index = headerIndex + 1;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*-+\s*$/.test(line)) {
      if (byId.size) break;
      continue;
    }
    if (!line.trim().startsWith("|")) break;
    const cells = cellsOf(line);
    const id = Number((cells[idCol] ?? "").replace("*", "").trim());
    const operation = cells[opCol] ?? "";
    const indent = indentOf(operation);
    baseIndent ??= indent;
    const name = nameCol >= 0 ? (cells[nameCol] ?? "").trim() : "";
    const node = emptyNode(name ? `${operation.trim()} ${name}` : operation.trim());
    node.rows = rowsCol >= 0 ? oracleNumber(cells[rowsCol]) : null;
    node.cost = costCol >= 0 ? oracleNumber(cells[costCol]) : null;
    const bytes = bytesCol >= 0 ? (cells[bytesCol] ?? "").trim() : "";
    if (bytes) node.detail.push(`Bytes: ${bytes}`);
    if (Number.isFinite(id)) byId.set(id, node);
    nester.push(node, indent - baseIndent);
  }

  const root = nester.root();
  if (!root) return null;
  if (lines[0]?.trim()) root.detail.unshift(lines[0].trim());

  // Predicate Information and Note: `   2 - access("ID"=1)` belongs to node 2; a line that
  // continues a predicate is indented further; anything else describes the whole plan.
  let target: PlanNode | null = null;
  for (; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (!trimmed || /^-+$/.test(trimmed)) continue;
    const predicate = /^(\d+)\s+-\s+(.*)$/.exec(trimmed);
    if (predicate && byId.has(Number(predicate[1]))) {
      target = byId.get(Number(predicate[1]))!;
      target.detail.push(predicate[2]);
    } else if (target && indentOf(lines[index]) > 6) {
      target.detail.push(trimmed);
    } else {
      target = null;
      if (!/^Predicate Information/i.test(trimmed)) root.detail.push(trimmed);
    }
  }
  return root;
}
