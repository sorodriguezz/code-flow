import { create } from "zustand";

/**
 * One typed answer, asked for the way `confirmStore` asks for a yes.
 *
 * **This exists because `window.prompt` does nothing in this app.** Not "looks wrong" — nothing:
 * wry builds no `WKUIDelegate` text-input panel, so on macOS WKWebView returns `null` the instant
 * it is called and the click appears to be ignored. `window.confirm` is dead the same way, which is
 * what `confirmAction` was written for; this is that store's other half, and the two are deliberate
 * twins so a dialog reads the same whichever question it is asking.
 *
 * It carries a `validate` because the alternative is a round trip: a container name that breaks
 * Azure's rule comes back as `InvalidResourceName` with no rule in it, and the rule is the entire
 * content of the message. Checked as the user types, it is a sentence under the field instead.
 */
interface PromptRequest {
  /** The question, one line. */
  message: string;
  initial: string;
  placeholder?: string;
  /** Overrides the generic "Confirm" when naming the action is clearer — "Create", "Rename". */
  confirmLabel?: string;
  /** The reason this value is not acceptable, or `null` when it is. Runs on every keystroke. */
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
}

interface PromptState {
  request: PromptRequest | null;
  ask: (request: Omit<PromptRequest, "resolve">) => Promise<string | null>;
  respond: (value: string | null) => void;
}

export const usePromptStore = create<PromptState>((set, get) => ({
  request: null,

  ask: (request) =>
    new Promise<string | null>((resolve) => {
      // Asking again while a dialog is already up would drop the first promise on the floor and
      // hang whatever was awaiting it, so the pending one is cancelled before being replaced.
      get().request?.resolve(null);
      set({ request: { ...request, resolve } });
    }),

  respond: (value) => {
    get().request?.resolve(value);
    set({ request: null });
  },
}));

/**
 * Drop-in replacement for `window.prompt()`. Resolves to the trimmed answer, or `null` when the
 * dialog was cancelled — same contract as the function it replaces, so a call site reads the same.
 */
export const promptAction = (
  message: string,
  options: {
    initial?: string;
    placeholder?: string;
    confirmLabel?: string;
    validate?: (value: string) => string | null;
  } = {},
) =>
  usePromptStore.getState().ask({
    message,
    initial: options.initial ?? "",
    placeholder: options.placeholder,
    confirmLabel: options.confirmLabel,
    validate: options.validate,
  });
