import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";

/**
 * The checks a GitHub Actions workflow gets here whether or not actionlint is installed: the
 * mistakes that make GitHub refuse the file outright ("Invalid workflow file") or that leave a job
 * that can never run — read from the YAML alone, with the line each one sits on.
 *
 * Not actionlint, and not trying to be: no expression type checking, no runner labels, no
 * shellcheck. When actionlint is on the machine its findings are shown beside these.
 */

export interface LintIssue {
  path: string;
  line: number;
  column: number;
  message: LintMessage;
  severity: "error" | "warning";
}

/** What went wrong, as a key and its values — the view words it. */
export type LintMessage =
  | { key: "yaml"; detail: string }
  | { key: "notMapping" }
  | { key: "missingOn" }
  | { key: "missingJobs" }
  | { key: "unknownTopKey"; name: string }
  | { key: "unknownJobKey"; job: string; name: string }
  | { key: "missingRunsOn"; job: string }
  | { key: "missingSteps"; job: string }
  | { key: "unknownNeed"; job: string; need: string }
  | { key: "needsItself"; job: string }
  | { key: "needsCycle"; jobs: string }
  | { key: "stepUsesAndRun"; job: string; step: number }
  | { key: "stepNeither"; job: string; step: number }
  | { key: "unclosedExpression" };

const TOP_KEYS = new Set(["name", "run-name", "on", "permissions", "env", "defaults", "concurrency", "jobs"]);
const JOB_KEYS = new Set([
  "name",
  "permissions",
  "needs",
  "if",
  "runs-on",
  "environment",
  "concurrency",
  "outputs",
  "env",
  "defaults",
  "steps",
  "timeout-minutes",
  "strategy",
  "continue-on-error",
  "container",
  "services",
  "uses",
  "with",
  "secrets",
]);

export function lintWorkflow(path: string, text: string): LintIssue[] {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, prettyErrors: false });
  const issues: LintIssue[] = [];
  const at = (node: Node | null | undefined, message: LintMessage, severity: LintIssue["severity"] = "error") => {
    const offset = node?.range?.[0] ?? 0;
    const pos = counter.linePos(offset);
    issues.push({ path, line: pos.line, column: pos.col, message, severity });
  };

  for (const error of doc.errors) {
    const pos = counter.linePos(error.pos[0]);
    issues.push({ path, line: pos.line, column: pos.col, message: { key: "yaml", detail: error.message.split("\n")[0] }, severity: "error" });
  }
  if (doc.errors.length > 0) return issues;

  const root = doc.contents;
  if (!isMap(root)) {
    at(root, { key: "notMapping" });
    return issues;
  }

  const keyName = (pair: Pair) => (isScalar(pair.key) ? String(pair.key.value) : "");
  const get = (map: YAMLMap, name: string) => map.items.find((pair) => keyName(pair) === name);

  for (const pair of root.items) {
    if (!TOP_KEYS.has(keyName(pair))) at(pair.key as Node, { key: "unknownTopKey", name: keyName(pair) }, "warning");
  }
  if (!get(root, "on")) at(root, { key: "missingOn" });

  const jobsPair = get(root, "jobs");
  const jobs = jobsPair?.value;
  if (!jobsPair || !isMap(jobs) || jobs.items.length === 0) {
    at((jobsPair?.key as Node) ?? root, { key: "missingJobs" });
  } else {
    const names = new Set(jobs.items.map(keyName));
    const needsOf = new Map<string, string[]>();
    for (const jobPair of jobs.items) {
      const job = keyName(jobPair);
      const body = jobPair.value;
      if (!isMap(body)) {
        at(jobPair.key as Node, { key: "missingRunsOn", job });
        continue;
      }
      for (const pair of body.items) {
        if (!JOB_KEYS.has(keyName(pair))) at(pair.key as Node, { key: "unknownJobKey", job, name: keyName(pair) }, "warning");
      }
      // A job that calls a reusable workflow (`uses:`) has neither a runner nor steps of its own.
      const calls = !!get(body, "uses");
      if (!calls) {
        if (!get(body, "runs-on")) at(jobPair.key as Node, { key: "missingRunsOn", job });
        const steps = get(body, "steps")?.value;
        if (!isSeq(steps) || steps.items.length === 0) {
          at(jobPair.key as Node, { key: "missingSteps", job });
        } else {
          steps.items.forEach((step, index) => {
            if (!isMap(step)) return;
            const uses = !!get(step, "uses");
            const run = !!get(step, "run");
            if (uses && run) at(step as Node, { key: "stepUsesAndRun", job, step: index + 1 });
            else if (!uses && !run) at(step as Node, { key: "stepNeither", job, step: index + 1 });
          });
        }
      }
      const needsPair = get(body, "needs");
      const needs: { name: string; node: Node }[] = [];
      if (needsPair) {
        const value = needsPair.value;
        if (isScalar(value)) needs.push({ name: String(value.value), node: value });
        else if (isSeq(value)) for (const item of value.items) if (isScalar(item)) needs.push({ name: String(item.value), node: item });
      }
      for (const need of needs) {
        if (need.name === job) at(need.node, { key: "needsItself", job });
        else if (!names.has(need.name)) at(need.node, { key: "unknownNeed", job, need: need.name });
      }
      needsOf.set(
        job,
        needs.map((need) => need.name).filter((name) => name !== job && names.has(name)),
      );
    }
    const cycle = findCycle(needsOf);
    if (cycle) {
      const first = jobs.items.find((pair) => keyName(pair) === cycle[0]);
      at(first?.key as Node, { key: "needsCycle", jobs: cycle.join(" → ") });
    }
  }

  // `${{ … }}` left open: GitHub refuses the whole file for one of these.
  const visit = (node: unknown) => {
    if (isScalar(node) && typeof node.value === "string") {
      const opens = node.value.split("${{").length - 1;
      const closes = node.value.split("}}").length - 1;
      if (opens > closes) at(node, { key: "unclosedExpression" });
    } else if (isMap(node)) {
      for (const pair of node.items) visit(pair.value);
    } else if (isSeq(node)) {
      for (const item of node.items) visit(item);
    }
  };
  visit(root);

  return issues.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** A loop in `needs:`, as the jobs around it ending where it started, or `null`. */
function findCycle(needsOf: Map<string, string[]>): string[] | null {
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const walk = (job: string): string[] | null => {
    state.set(job, "open");
    stack.push(job);
    for (const need of needsOf.get(job) ?? []) {
      if (state.get(need) === "open") return [...stack.slice(stack.indexOf(need)), need];
      if (!state.has(need)) {
        const found = walk(need);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(job, "done");
    return null;
  };
  for (const job of needsOf.keys()) {
    if (!state.has(job)) {
      const found = walk(job);
      if (found) return found;
    }
  }
  return null;
}
