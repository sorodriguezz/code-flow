import { create } from "zustand";
import { onAgentCliCreated, type AgentCliCreated } from "../lib/tauri/events";
import { isMainWindow } from "../lib/windowIdentity";
import { aiMemoryDelete } from "../lib/tauri/memoryCommands";
import { deleteAgentTask } from "../lib/tauri/commands";
import { pushErrorToast } from "./toastStore";
import { useAgentsStore } from "./agentsStore";
import { useUiStore } from "./uiStore";

/** What an agent made through `cf`, as a card the person can open or take back. */
export interface CreatedCard extends AgentCliCreated {
  /** The card's own key: the same row announced twice is still one card. */
  key: string;
}

interface CreatedCardsState {
  cards: CreatedCard[];
  init: () => void;
  open: (card: CreatedCard) => void;
  undo: (card: CreatedCard) => Promise<void>;
  dismiss: (key: string) => void;
}

/** More than this on screen is a wall, not a notice: the oldest give way. */
const MAX_CARDS = 4;

let started = false;

export function cardKey(created: AgentCliCreated): string {
  return `${created.kind}:${created.id}`;
}

/** The cards after `created` arrives: replaces its twin, newest last, oldest dropped past the cap. */
export function withCard(cards: CreatedCard[], created: AgentCliCreated): CreatedCard[] {
  const key = cardKey(created);
  return [...cards.filter((card) => card.key !== key), { ...created, key }].slice(-MAX_CARDS);
}

export const useCreatedCardsStore = create<CreatedCardsState>((set, get) => ({
  cards: [],

  init: () => {
    if (started || !isMainWindow()) return;
    started = true;
    void onAgentCliCreated((created) => set((s) => ({ cards: withCard(s.cards, created) })));
  },

  open: (card) => {
    if (card.kind === "task") {
      void useAgentsStore.getState().select(card.id);
      useUiStore.getState().setActiveView("agents");
    } else {
      useUiStore.getState().openSettings("claude");
    }
    get().dismiss(card.key);
  },

  // A task goes through the same delete the console's own menu uses, so its worktree is dealt with
  // the way it always is; a memory is simply removed — it was only ever a proposal.
  undo: async (card) => {
    try {
      if (card.kind === "task") await deleteAgentTask(card.id);
      else await aiMemoryDelete(card.id);
      if (card.kind === "task") void useAgentsStore.getState().reloadTasks();
      get().dismiss(card.key);
    } catch (e) {
      pushErrorToast(String(e));
    }
  },

  dismiss: (key) => set((s) => ({ cards: s.cards.filter((card) => card.key !== key) })),
}));
