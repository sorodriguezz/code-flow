import { create } from "zustand";
import type { ProblemSeverity } from "./problemsStore";

/**
 * The panel under the editor groups: Problems, and the results of the last "find all references"
 * or rename.
 *
 * A store rather than state in `EditorView` because the three things that open it are not in that
 * component: the counts in the status line, the Monaco action that finds references (registered
 * per pane), and the rename provider (registered once for the whole app).
 */

export type EditorPanelTab = "problems" | "results";

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
  /** Which severities the Problems list shows. */
  show: Record<ProblemSeverity, boolean>;
  /** Whether a compiler that can check the whole project is running for it — tsserver, today. */
  canCheckProject: boolean;
  /** A project-wide check in flight. */
  checkingProject: boolean;
  /** Opens on `tab`, or closes when that tab is already what is showing — the status line's toggle. */
  toggle: (tab: EditorPanelTab) => void;
  close: () => void;
  /** Replaces the results and brings them into view. */
  showResults: (results: ResultSet) => void;
  toggleSeverity: (severity: ProblemSeverity) => void;
  setProjectCheck: (state: { canCheckProject?: boolean; checkingProject?: boolean }) => void;
}

export const useEditorPanelStore = create<EditorPanelState>((set) => ({
  open: false,
  tab: "problems",
  results: null,
  show: { error: true, warning: true, info: true },
  canCheckProject: false,
  checkingProject: false,

  toggle: (tab) => set((state) => (state.open && state.tab === tab ? { open: false } : { open: true, tab })),
  close: () => set({ open: false }),
  showResults: (results) => set({ results, open: true, tab: "results" }),
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
