/**
 * What Arquitectura's editor is showing — the lens, the selection, the environment, the simulation's
 * dials — as against what the document says (`architectureStore`). Nothing here is persisted except
 * the lens and whether the component library and the side panel are open, which a person expects to
 * find as they left them.
 */
import { create } from "zustand";

export type Lens = "diagram" | "review" | "simulate" | "decisions" | "ask";
export const LENSES: Lens[] = ["diagram", "review", "simulate", "decisions", "ask"];
export type DiagramTab = "inspector" | "flow" | "notes" | "legend";

export type Selection =
  | { kind: "card"; id: string }
  | { kind: "cards"; ids: string[] }
  | { kind: "edge"; index: number }
  | { kind: "zone"; id: string }
  | { kind: "step"; step: number };

const LENS_KEY = "cf.arch.lens";
const PALETTE_KEY = "cf.arch.palette";
const PANEL_KEY = "cf.arch.panel";
const PANEL_STATES = ["open", "closed", "collapsed"] as const;
const read = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A webview without storage keeps the choice for the session only.
  }
};

interface ViewState {
  lens: Lens;
  /** The canvas's component library, open or folded to its rail. */
  paletteOpen: boolean;
  /** The lens's side panel, open or closed — one toggle for every lens. */
  panelOpen: boolean;
  /**
   * Hidden with the toolbar's toggle: a card picked on the canvas leaves it hidden until the toggle
   * shows it again. Closed with its own ×, the next card picked brings it back with the inspector —
   * the toggle that a pick undid was the one that "did nothing" (user report, 2026-10-21).
   */
  panelCollapsed: boolean;
  /** Which of its pages the Diagram lens's panel shows. */
  diagramTab: DiagramTab;
  selection: Selection | null;
  /** A transient highlight (hovering a flow step, a finding) that wins over the selection. */
  hover: Selection | null;
  env: string | null;
  scale: number;
  down: string[];
  /** Asks the canvas to bring this card or zone into view (a finding, a flow step, a reference chip). */
  focus: { id: string; at: number } | null;

  setLens: (lens: Lens) => void;
  togglePalette: () => void;
  setPanelOpen: (open: boolean) => void;
  /** The toolbar's toggle: hides the panel for good (see `panelCollapsed`), or shows it. */
  togglePanel: () => void;
  /** Shows that page of the Diagram lens's panel, opening the panel. */
  setDiagramTab: (tab: DiagramTab) => void;
  /** A card just clicked on the canvas — not dragged: the inspector comes up if the panel was closed
   *  with its ×, never when it was hidden with the toolbar's toggle. */
  revealInspector: () => void;
  select: (selection: Selection | null, opts?: { reveal?: boolean }) => void;
  setHover: (selection: Selection | null) => void;
  setEnv: (env: string) => void;
  setScale: (scale: number) => void;
  toggleDown: (id: string) => void;
  setDown: (ids: string[]) => void;
  focusOn: (id: string) => void;
  /** A different document: forget what was selected in the last one. */
  resetForDocument: () => void;
}

/** Whether two selections name the same things — the canvas reports a selection it was just given. */
export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "card" || a.kind === "zone") return a.id === (b as typeof a).id;
  if (a.kind === "edge") return a.index === (b as typeof a).index;
  if (a.kind === "step") return a.step === (b as typeof a).step;
  const x = [...a.ids].sort(), y = [...(b as typeof a).ids].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

export const useArchitectureViewStore = create<ViewState>((set, get) => ({
  lens: read(LENS_KEY, LENSES, "diagram"),
  paletteOpen: read(PALETTE_KEY, ["open", "closed"] as const, "open") === "open",
  panelOpen: read(PANEL_KEY, PANEL_STATES, "open") === "open",
  panelCollapsed: read(PANEL_KEY, PANEL_STATES, "open") === "collapsed",
  diagramTab: "inspector",
  selection: null,
  hover: null,
  env: null,
  scale: 1,
  down: [],
  focus: null,

  setLens: (lens) => {
    write(LENS_KEY, lens);
    set({ lens, hover: null });
  },
  togglePalette: () => {
    const paletteOpen = !get().paletteOpen;
    write(PALETTE_KEY, paletteOpen ? "open" : "closed");
    set({ paletteOpen });
  },
  setPanelOpen: (panelOpen) => {
    write(PANEL_KEY, panelOpen ? "open" : "closed");
    set({ panelOpen, panelCollapsed: false });
  },
  togglePanel: () => {
    if (!get().panelOpen) return get().setPanelOpen(true);
    write(PANEL_KEY, "collapsed");
    set({ panelOpen: false, panelCollapsed: true });
  },
  setDiagramTab: (diagramTab) => {
    set({ diagramTab });
    if (!get().panelOpen) get().setPanelOpen(true);
  },
  revealInspector: () => {
    const { lens, panelOpen, panelCollapsed } = get();
    if (lens === "diagram" && !panelOpen && !panelCollapsed) get().setDiagramTab("inspector");
  },
  select: (selection, opts = {}) => {
    if (!sameSelection(get().selection, selection)) set({ selection });
    if (opts.reveal && (selection?.kind === "card" || selection?.kind === "zone")) get().focusOn(selection.id);
  },
  setHover: (hover) => set({ hover }),
  setEnv: (env) => set({ env }),
  setScale: (scale) => set({ scale: Math.max(0.25, Math.min(8, scale)) }),
  toggleDown: (id) => {
    const down = get().down;
    set({ down: down.includes(id) ? down.filter((x) => x !== id) : [...down, id] });
  },
  setDown: (down) => set({ down }),
  focusOn: (id) => set({ focus: { id, at: Date.now() } }),
  resetForDocument: () => set({ selection: null, hover: null, env: null, scale: 1, down: [], focus: null }),
}));
