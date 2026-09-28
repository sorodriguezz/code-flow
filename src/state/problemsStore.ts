import { create } from "zustand";

/**
 * Every diagnostic the editor has been told about, for the Problems panel — not only the files on
 * screen.
 *
 * The markers in Monaco are the other copy, and they cannot be this one: markers live on models, so
 * a file with no tab has nowhere to put them. rust-analyzer reports a whole workspace after its
 * first `cargo check`, tsserver's project check reports every file in the program, and until this
 * existed all of that was dropped the moment it arrived for a file nobody had open.
 *
 * # Owners
 *
 * Each source replaces its own answers wholesale, per file, the way LSP's `publishDiagnostics` and
 * tsserver's diagnostic events both work — "here is everything I now think about this file". So the
 * store is keyed by **owner**, then by path: `lsp:<session>` per language server (Pyright and Ruff
 * on one Python file are two owners and never erase each other), `tsserver:semantic` and
 * `tsserver:syntax` for the compiler. An empty list removes the file, which is how a fixed file
 * leaves the panel.
 *
 * Scoped to one project: `EditorView` clears it when the window moves to another, which is also
 * when every server it came from is stopped.
 */

export type ProblemSeverity = "error" | "warning" | "info";

export interface Problem {
  /** 1-based, as Monaco and the rest of the editor count. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: ProblemSeverity;
  message: string;
  /** `TS2304`, `E0308` — what makes a problem searchable. */
  code?: string;
  /** Who said so: `ts`, `rust-analyzer`, `Pyright`. */
  source?: string;
}

export interface FileProblems {
  path: string;
  problems: Problem[];
}

export type ProblemsByOwner = Record<string, Record<string, Problem[]>>;

interface ProblemsState {
  byOwner: ProblemsByOwner;
  /** Replaces what `owner` says about `path`; an empty list forgets it. */
  report: (owner: string, path: string, problems: Problem[]) => void;
  /** Everything owners starting with `prefix` said — a server that stopped, a check restarted. */
  forget: (prefix: string) => void;
  /** What owners starting with `prefix` said about one file — a file tsserver no longer holds. */
  forgetFile: (prefix: string, path: string) => void;
  clear: () => void;
}

/**
 * Reports coalesced into one store update per burst — see `reportSoon`. Declared ahead of the store
 * so its actions can drop what is still waiting: a report queued for a server that has since
 * stopped, or for the project the window just left, must not land after the store was cleared.
 */
const pending = new Map<string, { owner: string; path: string; problems: Problem[] }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function dropPending(matches: (owner: string, path: string) => boolean): void {
  for (const [key, entry] of pending) if (matches(entry.owner, entry.path)) pending.delete(key);
}

export const useProblemsStore = create<ProblemsState>((set) => ({
  byOwner: {},

  report: (owner, path, problems) =>
    set((state) => {
      const current = state.byOwner[owner] ?? {};
      if (problems.length === 0 && !(path in current)) return state;
      const files = { ...current };
      if (problems.length === 0) delete files[path];
      else files[path] = problems;
      return { byOwner: { ...state.byOwner, [owner]: files } };
    }),

  forget: (prefix) =>
    set((state) => {
      dropPending((owner) => owner.startsWith(prefix));
      const owners = Object.keys(state.byOwner).filter((owner) => owner.startsWith(prefix));
      if (owners.length === 0) return state;
      const byOwner = { ...state.byOwner };
      for (const owner of owners) delete byOwner[owner];
      return { byOwner };
    }),

  forgetFile: (prefix, path) =>
    set((state) => {
      dropPending((owner, file) => owner.startsWith(prefix) && file === path);
      let changed = false;
      const byOwner = { ...state.byOwner };
      for (const [owner, files] of Object.entries(state.byOwner)) {
        if (!owner.startsWith(prefix) || !(path in files)) continue;
        const next = { ...files };
        delete next[path];
        byOwner[owner] = next;
        changed = true;
      }
      return changed ? { byOwner } : state;
    }),

  clear: () =>
    set((state) => {
      dropPending(() => true);
      return Object.keys(state.byOwner).length === 0 ? state : { byOwner: {} };
    }),
}));

/**
 * Reports coalesced into one store update per burst — the way diagnostics arrive. rust-analyzer
 * publishes a notification per file when `cargo check` finishes, and tsserver's project check an
 * event per file per kind: hundreds in a second, and a store write for each re-rendered the status
 * line and the panel for each. The last word for an owner and a file in a burst is the one kept.
 */
export function reportSoon(owner: string, path: string, problems: Problem[]): void {
  pending.set(`${owner}\n${path}`, { owner, path, problems });
  flushTimer ??= setTimeout(flushReports, 80);
}

/** Writes whatever `reportSoon` is holding, now. */
export function flushReports(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const batch = [...pending.values()];
  pending.clear();
  if (batch.length === 0) return;
  useProblemsStore.setState((state) => {
    const byOwner = { ...state.byOwner };
    for (const { owner, path, problems } of batch) {
      const files = { ...(byOwner[owner] ?? {}) };
      if (problems.length === 0) delete files[path];
      else files[path] = problems;
      byOwner[owner] = files;
    }
    return { byOwner };
  });
}

const SEVERITY_RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Every file's problems, merged across owners: sorted by path and then by position, and with a
 * problem two owners both reported shown once — tsserver's own check and its project check say the
 * same thing about an open file, and a list with each error twice reads as twice the errors.
 */
export function groupProblems(
  byOwner: ProblemsByOwner,
  show: Record<ProblemSeverity, boolean> = { error: true, warning: true, info: true },
): FileProblems[] {
  const byPath = new Map<string, Map<string, Problem>>();
  for (const files of Object.values(byOwner)) {
    for (const [path, problems] of Object.entries(files)) {
      for (const problem of problems) {
        if (!show[problem.severity]) continue;
        const key = `${problem.line}:${problem.column}:${problem.endLine}:${problem.endColumn}:${problem.severity}:${problem.message}`;
        let seen = byPath.get(path);
        if (!seen) byPath.set(path, (seen = new Map()));
        if (!seen.has(key)) seen.set(key, problem);
      }
    }
  }
  return [...byPath]
    .map(([path, problems]) => ({
      path,
      problems: [...problems.values()].sort(
        (a, b) => a.line - b.line || a.column - b.column || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
      ),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** How many of each, counted the way the list shows them — once per problem, however many owners. */
export function countProblems(byOwner: ProblemsByOwner): Record<ProblemSeverity, number> {
  const counts: Record<ProblemSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const file of groupProblems(byOwner)) {
    for (const problem of file.problems) counts[problem.severity] += 1;
  }
  return counts;
}
