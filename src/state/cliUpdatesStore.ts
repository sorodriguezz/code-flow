import { create } from "zustand";
import { saving } from "./powerSaveStore";
import { listen } from "@tauri-apps/api/event";
import {
  cliUpdatesCheck,
  cliUpdatesInstall,
  cliUpdatesSkip,
  type CliUpdate,
  type CliUpdateResult,
} from "../lib/tauri/commands";

/**
 * The cards that offer to update an AI CLI — what the app found on launch, and where each one is.
 *
 * Nothing here talks to the registry or runs a command: the backend does both (`cli_updates.rs`), and
 * this only remembers which cards are showing and in what state.
 *
 * - `available` — a newer version exists; the person has not answered.
 * - `waiting` — they pressed Install, but an AI process is alive, so the update has not started. The
 *   backend refuses to replace a CLI under a running turn; this retries until none is.
 * - `updating` — the CLI's own update command is running.
 * - `done` — the CLI reports the new version; the card closes itself shortly.
 * - `failed` — it did not take. The result says why.
 *
 * **Closing a card hides it until the next launch** and does nothing else — it never stops an update
 * that is running, because stopping one half-way leaves a CLI half-installed. "Skip this version" is
 * the one that is remembered.
 */
export type CardState = "available" | "waiting" | "updating" | "done" | "failed";

export interface CliUpdateCard {
  update: CliUpdate;
  state: CardState;
  /** The last line the update command printed, while it runs. */
  lastLine: string;
  result: CliUpdateResult | null;
}

/** How long a finished card stays before it closes itself. */
const DONE_LINGER_MS = 4_000;
/** How often a card that is waiting for the AI processes to finish asks again. */
const WAIT_RETRY_MS = 10_000;

interface State {
  cards: Record<string, CliUpdateCard>;
  /** Providers whose card the person closed this session. A re-check does not bring them back. */
  closed: Record<string, true>;
  check: (force?: boolean) => Promise<void>;
  install: (provider: string) => Promise<void>;
  installAll: () => Promise<void>;
  close: (provider: string) => void;
  skip: (provider: string) => void;
}

export const useCliUpdatesStore = create<State>((set, get) => ({
  cards: {},
  closed: {},

  check: async (force = false) => {
    const found = await cliUpdatesCheck(force).catch(() => []);
    set((s) => {
      const cards = { ...s.cards };
      for (const update of found) {
        if (s.closed[update.provider] && !force) continue;
        // A card the person is already looking at keeps its state; only a new one is added.
        cards[update.provider] ??= { update, state: "available", lastLine: "", result: null };
      }
      return { cards, closed: force ? {} : s.closed };
    });
  },

  install: async (provider) => {
    const card = get().cards[provider];
    if (!card || card.state === "updating") return;
    patch(provider, { state: "updating", lastLine: "", result: null });
    let result: CliUpdateResult;
    try {
      result = await cliUpdatesInstall(provider, card.update.installed);
    } catch (error) {
      result = {
        provider,
        outcome: "failed",
        versionAfter: "",
        errorKind: null,
        reference: null,
        details: String(error),
      };
    }
    if (result.outcome === "busy") {
      patch(provider, { state: "waiting" });
      setTimeout(() => {
        if (get().cards[provider]?.state === "waiting") void get().install(provider);
      }, WAIT_RETRY_MS);
      return;
    }
    if (result.outcome === "done") {
      patch(provider, { state: "done", result });
      setTimeout(() => get().close(provider), DONE_LINGER_MS);
      return;
    }
    patch(provider, { state: "failed", result });
  },

  // One at a time: two package managers writing the same global folder is how an update half-applies.
  installAll: async () => {
    for (const card of Object.values(get().cards)) {
      if (card.state === "available") await get().install(card.update.provider);
    }
  },

  close: (provider) =>
    set((s) => {
      const { [provider]: _gone, ...cards } = s.cards;
      return { cards, closed: { ...s.closed, [provider]: true } };
    }),

  skip: (provider) => {
    const card = get().cards[provider];
    if (card) void cliUpdatesSkip(provider, card.update.latest).catch(() => {});
    get().close(provider);
  },
}));

function patch(provider: string, changes: Partial<CliUpdateCard>) {
  useCliUpdatesStore.setState((s) => {
    const card = s.cards[provider];
    return card ? { cards: { ...s.cards, [provider]: { ...card, ...changes } } } : {};
  });
}

let listening = false;
/** Follows the update command's output into the card. Once; cheap to call again. */
export function listenForCliUpdateProgress() {
  if (listening) return;
  listening = true;
  void listen<{ provider: string; line: string }>("cli-update:progress", (event) => {
    const { provider, line } = event.payload;
    patch(provider, { lastLine: line });
  }).catch(() => {
    listening = false;
  });
}

/** Seconds after launch before the check runs: the window is the first thing, never a version lookup. */
const FIRST_CHECK_DELAY_MS = 20_000;

/**
 * Looks for updates once, a little after the app opens. Skipped while battery saving is at its
 * second level or above (`powerSaveStore`): a network call and a few processes for something nobody
 * is waiting for. The backend keeps its own 12 h floor, so opening the app often does not mean
 * asking the registry often.
 */
export function startCliUpdateCheck() {
  setTimeout(() => {
    if (saving(2)) return;
    void useCliUpdatesStore.getState().check(false);
  }, FIRST_CHECK_DELAY_MS);
}
