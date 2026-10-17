import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

/**
 * How long chat answers are — one setting for the repository chat and the Chat app, read by the
 * backend on every turn (`ai::chat_turn_rules`). `normal` adds nothing to what the engine is told.
 */
export const ANSWER_LENGTHS = ["auto", "short", "normal", "detailed"] as const;
export type AnswerLength = (typeof ANSWER_LENGTHS)[number];

/** Mirrors `ai::ANSWER_LENGTH_KEY`. */
const KEY = "chat_answer_length";

function parse(raw: string | null): AnswerLength {
  return ANSWER_LENGTHS.includes(raw as AnswerLength) ? (raw as AnswerLength) : "normal";
}

interface AnswerLengthState {
  length: AnswerLength;
  sync: () => Promise<void>;
  pick: (length: AnswerLength) => Promise<void>;
}

export const useAnswerLengthStore = create<AnswerLengthState>((set) => ({
  length: "normal",
  sync: async () => {
    try {
      set({ length: parse(await getSetting(KEY)) });
    } catch {
      // Outside Tauri: the default.
    }
  },
  pick: async (length) => {
    set({ length });
    await setSetting(KEY, length);
  },
}));

void useAnswerLengthStore.getState().sync();
watchSettings([KEY], () => useAnswerLengthStore.getState().sync());
