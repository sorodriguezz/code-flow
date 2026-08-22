import { useEffect } from "react";
import type { CancellationToken, editor as MonacoEditorNS, languages, Position } from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import { MODEL_SCHEME } from "../../lib/editorModel";
import { localAiCancelCompletion, localAiComplete } from "../../lib/tauri/localaiCommands";
import { completionIsUsable, useLocalAiStore } from "../../state/localAiStore";

/**
 * Ghost text from the model running on this machine.
 *
 * # Registered once, for the whole app
 *
 * Monaco's providers are global. Registering per pane would have two editor groups asking for the
 * same completion twice and Monaco merging the two identical answers, which is the same trap
 * `useLanguageServer` and `installGoToDefinition` avoid — so this uses the same module-scope latch,
 * and the hook itself only makes sure the store has been loaded.
 *
 * # It must not fire in the other editors
 *
 * There are Monaco instances all over this app — the API client's script and GraphQL panes, the SQL
 * console, the notes editor, the DBML schema editor — and a globally registered provider sees every
 * one of them. The scheme check in [`fileOf`] is what keeps completion to files that are actually
 * open from a repository: only `editorModel.modelPathFor` mints `cf-editor:` URIs, everything else
 * gets Monaco's own `inmemory:`.
 *
 * # What makes it feel instant
 *
 * Not the model. Three things around it:
 *
 * 1. **Reuse while you type along.** After a suggestion is shown, typing the characters it
 *    predicted must not fetch anything — the remainder of the same suggestion is returned from
 *    memory. Without this, accepting a suggestion character by character issues one request per
 *    keystroke and each one arrives after the next character has already been typed.
 * 2. **A short debounce.** Enough that holding a key down does not queue a request per repeat, low
 *    enough that a pause reads as instant.
 * 3. **Real cancellation.** Monaco cancels the moment the caret moves; that is forwarded so the
 *    server abandons the generation instead of finishing an answer nobody will read.
 */

/**
 * Milliseconds of quiet before a request is issued.
 *
 * `llama.vscode` ships 0, and can afford to: it is talking to a server the user started and left
 * running. Here the engine may be cold, and a burst of requests during a fast run of typing would
 * each start, cancel and restart prompt evaluation. 150 ms is below the threshold where a pause
 * feels like a wait, and Monaco applies its own delay before this on top.
 */
const DEBOUNCE_MS = 150;

/**
 * How long a request may run before the status bar admits it is running.
 *
 * A warm engine answers in well under 200 ms — measured 173 ms end to end on a 0.5B — so showing
 * an indicator the moment a request starts would flash it on and off on every pause in typing,
 * dozens of times a minute, saying nothing. Past this threshold the answer is genuinely late:
 * the engine is cold, the model is large, or the prompt cache missed. That is worth a mark on
 * screen, because the alternative is a user who cannot tell "thinking" from "nothing to suggest".
 */
const THINKING_AFTER_MS = 300;

/**
 * Lines of context sent before the caret. `llama.vscode`'s `n_prefix`.
 *
 * The budget lives here rather than in Rust because this is the side that holds the buffer:
 * slicing before the `invoke` is what keeps a large file from crossing the IPC bridge on every
 * keystroke. Rust re-checks only a character cap it can enforce without the document — see
 * `localai::complete::MAX_SIDE_CHARS`.
 */
const PREFIX_LINES = 256;

/**
 * Lines sent after it. `llama.vscode`'s `n_suffix`.
 *
 * A quarter of the prefix, and the asymmetry is the point: what comes *before* the caret decides
 * what is being written, while what comes after mostly tells the model where to stop.
 */
const SUFFIX_LINES = 64;

/**
 * How much text may follow the caret *on its own line* before completion is skipped.
 *
 * `llama.vscode`'s `max_line_suffix`. Completing into the middle of an existing line is almost
 * always wrong — the user is editing, not writing — and the ghost text ends up interleaved with
 * what is already there. A few trailing characters are fine, because those are the closing
 * brackets and semicolons the caret sits inside constantly.
 */
const MAX_LINE_SUFFIX = 8;

let installed = false;

/** The file a request is about, or `null` for anything that is not a repository file. */
function fileOf(model: MonacoEditorNS.ITextModel): { uri: string } | null {
  if (model.uri.scheme !== MODEL_SCHEME) return null;
  return { uri: model.uri.toString() };
}

/** The last suggestion shown, so typing along it costs nothing. */
interface Memo {
  uri: string;
  /** The exact prefix the suggestion was produced for. */
  prefix: string;
  /** What the model returned for it. */
  text: string;
}

let memo: Memo | null = null;

/**
 * The still-valid remainder of the last suggestion, or `null`.
 *
 * Valid when this is the same file, the new prefix extends the old one, and everything typed since
 * is exactly what the suggestion predicted. Anything else — a different file, a backspace, a
 * divergence of one character — invalidates it, because a suggestion that no longer matches what is
 * on screen is worse than none.
 */
function reuse(uri: string, prefix: string): string | null {
  if (!memo || memo.uri !== uri) return null;
  if (!prefix.startsWith(memo.prefix)) return null;
  const typed = prefix.slice(memo.prefix.length);
  if (typed.length === 0) return memo.text;
  if (!memo.text.startsWith(typed)) return null;
  const remainder = memo.text.slice(typed.length);
  return remainder.length > 0 ? remainder : null;
}

/** Everything before the caret, trimmed to the line budget. */
function prefixOf(model: MonacoEditorNS.ITextModel, position: Position): string {
  const from = Math.max(1, position.lineNumber - PREFIX_LINES);
  return model.getValueInRange({
    startLineNumber: from,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
}

/** Everything after it, likewise. */
function suffixOf(model: MonacoEditorNS.ITextModel, position: Position): string {
  const to = Math.min(model.getLineCount(), position.lineNumber + SUFFIX_LINES);
  return model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: to,
    endColumn: model.getLineMaxColumn(to),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installProvider(monaco: Monaco): void {
  if (installed) return;
  installed = true;

  const provider: languages.InlineCompletionsProvider = {
    provideInlineCompletions: async (
      model: MonacoEditorNS.ITextModel,
      position: Position,
      context: languages.InlineCompletionContext,
      token: CancellationToken,
    ): Promise<languages.InlineCompletions | undefined> => {
      const file = fileOf(model);
      if (!file) return undefined;
      if (!completionIsUsable()) return undefined;

      // The suggest widget is open with something selected. Ghost text underneath it is two
      // competing answers to one keystroke, and accepting either is ambiguous.
      if (context.selectedSuggestionInfo) return undefined;

      // Mid-line editing — see MAX_LINE_SUFFIX.
      const restOfLine = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: model.getLineMaxColumn(position.lineNumber),
      });
      if (restOfLine.trim().length > MAX_LINE_SUFFIX) return undefined;

      const prefix = prefixOf(model, position);

      // Before the debounce, and before anything is asked of the backend: this is the path that
      // has to be free for typing along a suggestion to feel like nothing is happening at all.
      const remembered = reuse(file.uri, prefix);
      if (remembered) {
        return { items: [{ insertText: remembered, range: emptyRangeAt(position) }] };
      }

      await sleep(DEBOUNCE_MS);
      if (token.isCancellationRequested) return undefined;

      const requestId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;

      // Monaco cancels as soon as the caret moves. Forwarding it is what stops the server
      // generating an answer for a position that no longer exists — verified against llama.cpp:
      // dropping the request really does abandon the task.
      const cancelled = token.onCancellationRequested(() => {
        void localAiCancelCompletion(requestId).catch(() => {});
      });

      // Armed rather than set: only a request that outlives the threshold ever reaches the UI.
      const slow = setTimeout(() => useLocalAiStore.getState().setThinking(true), THINKING_AFTER_MS);

      try {
        const text = await localAiComplete({
          request_id: requestId,
          prefix,
          suffix: suffixOf(model, position),
        });
        if (token.isCancellationRequested || !text) return undefined;

        memo = { uri: file.uri, prefix, text };
        return { items: [{ insertText: text, range: emptyRangeAt(position) }] };
      } catch {
        // A keystroke must never raise anything. The settings pane is where a broken engine is
        // explained; here the honest response is simply no suggestion.
        return undefined;
      } finally {
        // In `finally` so every exit clears it — a cancelled or failed request that left the
        // indicator lit would leave the status bar claiming work that stopped long ago.
        clearTimeout(slow);
        useLocalAiStore.getState().setThinking(false);
        cancelled.dispose();
      }
    },

    /**
     * Required by the interface. Nothing to release — the items above hold only strings, and the
     * one piece of state that outlives a request (`memo`) is deliberately kept, since its whole
     * purpose is to survive until the next call.
     */
    disposeInlineCompletions: () => {},

    /** Shown on the inline-suggestion toolbar, so it is clear which provider answered. */
    displayName: "CodeFlow (local)",

    /**
     * Monaco's own debounce, explicitly disabled.
     *
     * Not because debouncing is unwanted — [`DEBOUNCE_MS`] above does it — but because two of them
     * stack. Leaving Monaco's default in place would add its delay to ours on every keystroke, and
     * the combined figure is the one the user feels.
     */
    debounceDelayMs: 0,

    /**
     * Partial acceptance — the user took a word with Ctrl/Cmd+Right rather than the whole line.
     *
     * Left to `reuse`: the accepted characters become part of the prefix on the next call, which is
     * exactly the case that function already handles. Declared anyway because its absence is easy
     * to read as an oversight.
     */
    handlePartialAccept: () => {},
  };

  monaco.languages.registerInlineCompletionsProvider("*", provider);
}

/** A zero-width range at the caret: an insertion, never a replacement. */
function emptyRangeAt(position: Position) {
  return {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
}

/**
 * Installs the provider and makes sure the store knows whether the feature is on.
 *
 * The store load is what `completionIsUsable` reads on every keystroke; without it the first
 * completions after launch would be declined for want of an answer rather than for a reason.
 */
export function useInlineCompletion(monaco: Monaco | null): void {
  const load = useLocalAiStore((state) => state.load);

  useEffect(() => {
    if (!monaco) return;
    installProvider(monaco);
    void load();
  }, [monaco, load]);
}
