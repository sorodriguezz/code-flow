import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

/**
 * What the chats attach to a question besides the question — one setting for the repository chat
 * and the Chat app, read by the backend on every turn (`context::need`). `auto` judges each
 * question: a follow-up or a general one goes with nothing the model could look up itself.
 */
export const CHAT_CONTEXT_MODES = ["auto", "always", "tools"] as const;
export type ChatContextMode = (typeof CHAT_CONTEXT_MODES)[number];

/** Mirrors `context::need::MODE_KEY`. */
const KEY = "chat_context_mode";

function parse(raw: string | null): ChatContextMode {
  return CHAT_CONTEXT_MODES.includes(raw as ChatContextMode) ? (raw as ChatContextMode) : "auto";
}

interface ChatContextModeState {
  mode: ChatContextMode;
  sync: () => Promise<void>;
  pick: (mode: ChatContextMode) => Promise<void>;
}

export const useChatContextModeStore = create<ChatContextModeState>((set) => ({
  mode: "auto",
  sync: async () => {
    try {
      set({ mode: parse(await getSetting(KEY)) });
    } catch {
      // Outside Tauri: the default.
    }
  },
  pick: async (mode) => {
    set({ mode });
    await setSetting(KEY, mode);
  },
}));

void useChatContextModeStore.getState().sync();
watchSettings([KEY], () => useChatContextModeStore.getState().sync());
