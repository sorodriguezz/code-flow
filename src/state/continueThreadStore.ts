import { create } from "zustand";

/** An engine a new thread can start on — the account is `null` for the CLI's system one. */
export interface ThreadEngine {
  provider: string;
  model: string;
  account: string | null;
}

/** What opened the "continuar en un hilo nuevo" dialog — see `ContinueThreadDialog`. */
export interface ContinueThreadRequest {
  conversationId: string;
  /** Already chosen: a version of a locked provider, picked in the composer's model menu. Its
   *  `account` is only there when one was picked with it. */
  engine?: { provider: string; model: string; account?: string };
  /** What `/continue …` was followed by — what the summary should keep. */
  guidance?: string;
}

interface ContinueThreadState {
  request: ContinueThreadRequest | null;
  open: (request: ContinueThreadRequest) => void;
  close: () => void;
}

/** The dialog's one piece of shared state: which thread it was opened for, from where. Every door to
 *  it — the row's menu, `/continue`, a locked provider in the model menu — only sets this. */
export const useContinueThreadStore = create<ContinueThreadState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
