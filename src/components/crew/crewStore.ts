/**
 * The Agents view's own UI state: which space is open, which overlay, what is selected. Kept apart
 * from `state.ts` and free of the work stores, so the tour can stage a space without loading them.
 */
import { create } from "zustand";

export type Space = "tablero" | "equipos" | "agentes" | "en-vivo" | "taller";

export type Overlay =
  | { kind: "launch"; goal?: string; assignee?: { kind: "agent" | "team"; id: string }; cardId?: string; projectId?: string; attachments?: import("../../lib/tauri/chatCommands").ChatAttachment[] }
  | { kind: "wizard"; templateId?: string; agentId?: string }
  | { kind: "card"; id: string }
  | { kind: "chat"; runId: string; memberId: string; taskId?: string }
  | { kind: "task"; id: string }
  | { kind: "teamChat"; id: string }
  | { kind: "chain"; id: string }
  | { kind: "teamTemplates" }
  | { kind: "decider" }
  | { kind: "governor" }
  | { kind: "race"; batchId: string }
  | { kind: "chainEditor"; templateId?: string | null }
  | { kind: "story" }
  | null;

const SPACE_KEY = "cf.crew.space";

function readSpace(): Space {
  try {
    const raw = localStorage.getItem(SPACE_KEY);
    if (raw === "tablero" || raw === "equipos" || raw === "agentes" || raw === "en-vivo" || raw === "taller") return raw;
  } catch {
    /* private window, blocked storage */
  }
  return "tablero";
}

interface CrewState {
  space: Space;
  overlay: Overlay;
  selectedTeamId: string | null;
  selectedMemberId: string | null;
  /** `canal` and `panel` are tabs only on a narrow window, where the side rail folds into the main area. */
  liveTab: "tareas" | "equipo" | "miembros" | "canal" | "panel";
  workshopTab: "worktrees" | "bench" | "races";
  /** A card or agent to draw attention to once its space opens. */
  focus: string | null;
  setSpace: (space: Space) => void;
  open: (overlay: Overlay) => void;
  close: () => void;
  set: (patch: Partial<Omit<CrewState, "setSpace" | "open" | "close" | "set">>) => void;
}

export const useCrewStore = create<CrewState>((set) => ({
  space: typeof window === "undefined" ? "tablero" : readSpace(),
  overlay: null,
  selectedTeamId: null,
  selectedMemberId: null,
  liveTab: "tareas",
  workshopTab: "worktrees",
  focus: null,
  setSpace: (space) => {
    try {
      localStorage.setItem(SPACE_KEY, space);
    } catch {
      /* ignore */
    }
    set({ space });
  },
  open: (overlay) => set({ overlay }),
  close: () => set({ overlay: null }),
  set: (patch) => set(patch),
}));
