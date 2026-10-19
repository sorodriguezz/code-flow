import { create } from "zustand";
import type { ProblemSeverity } from "./problemsStore";
import type { HierarchyMode, HierarchyNode } from "../lib/hierarchy";

/**
 * The panel under the editor groups: Problems, and the results of the last "find all references"
 * or rename.
 *
 * A store rather than state in `EditorView` because the three things that open it are not in that
 * component: the counts in the status line, the Monaco action that finds references (registered
 * per pane), and the rename provider (registered once for the whole app).
 */

/** VS Code's panel, as far as this editor has it: Problems, the last references/rename, the call or
 *  type hierarchy asked for last, the repository's tests and its tasks (`.vscode/tasks.json`). */
export type EditorPanelTab = "problems" | "results" | "hierarchy" | "tests" | "tasks";

/** The tree on the Hierarchy tab: which kind, and where it starts. */
export interface HierarchyRequest {
  mode: HierarchyMode;
  root: HierarchyNode;
}

export interface ResultItem {
  line: number;
  column: number;
  /** The line's text, trimmed — what makes a row readable without opening the file. */
  text: string;
}

export interface ResultGroup {
  path: string;
  items: ResultItem[];
}

export interface ResultSet {
  /** "8 references to `useUser`", "Renamed to `fetchUser`: 12 changes in 5 files". */
  title: string;
  groups: ResultGroup[];
  /** Anything that went wrong on the way, one line each: a file that changed on disk, one that
   *  could not be written. */
  notes: string[];
}

interface EditorPanelState {
  open: boolean;
  tab: EditorPanelTab;
  results: ResultSet | null;
  hierarchy: HierarchyRequest | null;
  /** Which severities the Problems list shows. */
  show: Record<ProblemSeverity, boolean>;
  /** Whether a compiler that can check the whole project is running for it — tsserver, today. */
  canCheckProject: boolean;
  /** A project-wide check in flight. */
  checkingProject: boolean;
  /**
   * Why no compiler is answering for this project, when none is — the sentence `ts_start` refused
   * with ("No TypeScript in …/node_modules", "Could not start tsserver with node: …").
   *
   * Kept and shown rather than swallowed: without a server there are *no* type diagnostics at all
   * (Monaco's isolated worker has semantic validation off on purpose — see `monacoSetup`), so a
   * failure to start looks exactly like a file with nothing wrong in it. An unused import that
   * stops fading and a misspelt name that stops being underlined are the same event, and the one
   * thing that explains both is this line.
   */
  tsUnavailable: string | null;
  /** Opens on `tab`, or closes when that tab is already what is showing — the status line's toggle. */
  toggle: (tab: EditorPanelTab) => void;
  close: () => void;
  /** Replaces the results and brings them into view. */
  showResults: (results: ResultSet) => void;
  showHierarchy: (request: HierarchyRequest) => void;
  toggleSeverity: (severity: ProblemSeverity) => void;
  setProjectCheck: (state: { canCheckProject?: boolean; checkingProject?: boolean; tsUnavailable?: string | null }) => void;
}

export const useEditorPanelStore = create<EditorPanelState>((set) => ({
  open: false,
  tab: "problems",
  results: null,
  hierarchy: null,
  show: { error: true, warning: true, info: true },
  canCheckProject: false,
  checkingProject: false,
  tsUnavailable: null,

  toggle: (tab) => set((state) => (state.open && state.tab === tab ? { open: false } : { open: true, tab })),
  close: () => set({ open: false }),
  showResults: (results) => set({ results, open: true, tab: "results" }),
  showHierarchy: (hierarchy) => set({ hierarchy, open: true, tab: "hierarchy" }),
  toggleSeverity: (severity) => set((state) => ({ show: { ...state.show, [severity]: !state.show[severity] } })),
  setProjectCheck: (state) => set(state),
}));

/** A result location before it is grouped: which file, where, and the line's text when known. */
export interface ResultHit {
  path: string;
  range: { startLineNumber: number; startColumn: number };
  text?: string;
}

/** Hits grouped by file — files in path order, each file's hits in line order. */
export function groupHits(hits: ResultHit[]): ResultGroup[] {
  const byPath = new Map<string, ResultHit[]>();
  for (const hit of hits) byPath.set(hit.path, [...(byPath.get(hit.path) ?? []), hit]);
  return [...byPath]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, list]) => ({
      path,
      items: [...list]
        .sort((a, b) => a.range.startLineNumber - b.range.startLineNumber || a.range.startColumn - b.range.startColumn)
        .map((hit) => ({ line: hit.range.startLineNumber, column: hit.range.startColumn, text: hit.text ?? "" })),
    }));
}
