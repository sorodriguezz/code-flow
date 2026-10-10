import type { CancellationToken, editor as MonacoEditorNS, languages, Position } from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import { MODEL_SCHEME } from "./editorModel";
import { localAiCancelCompletion, localAiComplete } from "./tauri/localaiCommands";
import { completionIsUsable, useLocalAiStore } from "../state/localAiStore";

/**
 * Ghost text from the model running on this machine.
 *
 * # Registered once, for the whole app
 *
 * Monaco's providers are global. Registering per pane would have two editor groups asking for the
 * same completion twice and Monaco merging the two identical answers, which is the same trap
 * `useLanguageServer` and `installGoToDefinition` avoid — so this uses the same module-scope latch.
 *
 * The registration itself happens at startup from `monacoSetup`, beside the other global ones,
 * rather than from whichever pane mounted first: the panels that get ghost text are no longer only
 * the code editor's, and installing it from `EditorPane` meant the feature was off in the database
 * console until you had opened a file. The hook below is now only about the *store* — making sure
 * `completionIsUsable` has an answer to give — which is why it still exists and why it is still
 * called from the editor.
 *
 * # Which editors it fires in
 *
 * There are Monaco instances all over this app, and a globally registered provider sees every one
 * of them. [`SURFACES`] is the list of the ones this is wanted in, keyed by the URI scheme each
 * panel mints for its models — which is a fact those panels already establish for their own reasons
 * (`cf-editor:` is what "go to definition" is scoped to, `cf-db:` is one model per console tab), so
 * no registry has to be kept in step with anything.
 *
 * It started as one scheme, `cf-editor:`, on the reasoning that completion was a code-editor
 * feature. It is not: the DBML workbench and the database console are both places where you type a
 * language into a Monaco buffer, and both were left out only because the check was written before
 * they existed. The panes still deliberately outside it — the API client's script and GraphQL
 * editors, the notes editor — are prose or per-request scratch, where a model finishing your
 * sentence is an interruption rather than help.
 *
 * # Some surfaces need context the buffer does not have
 *
 * A repository file carries its own: 256 lines of it. A console buffer is often three lines, and
 * three lines of SQL say nothing about the database they run against. So a surface may contribute a
 * `context` — a synthetic header, in that language's own comment syntax, prepended to the prefix.
 * It goes in the prefix because `/infill` takes a prefix and a suffix and nothing else; there is no
 * third slot for a system message.
 *
 * DBML contributes none, and that is not an omission: the buffer *is* the schema, so the model is
 * already looking at every table and column the answer could involve.
 *
 * # What makes it feel instant
 *
 * Not the model. Three things around it:
 *
 * 1. **Reuse while you type along.** After a suggestion is shown, typing the characters it
 *    predicted must not fetch anything — the remainder of the same suggestion is returned from
 *    memory. Without this, accepting a suggestion character by character issues one request per
 *    keystroke and each one arrives after the next character has already been typed.
 * 2. **A debounce that waits for a pause, not a gap between keys.** See [`DEBOUNCE_MS`].
 * 3. **Real cancellation.** Monaco cancels the moment the caret moves; that is forwarded so the
 *    server abandons the generation instead of finishing an answer nobody will read.
 *
 * # What keeps it from being pushy
 *
 * Instant was the easy half. The first version was also relentless: a suggestion on every pause,
 * several lines at a time, often re-typing code that was already there. Copilot is the reference
 * for calm, and the rules it follows are the ones copied here:
 *
 * - **One line at a time.** A request asks for the rest of the caret's line and nothing more, so
 *   the end of a finished statement gets no ghost text until Enter is pressed — then the next line
 *   arrives. Several lines only in an empty block; see [`completionShape`].
 * - **Not in the middle of a line**, unless all that follows the caret is closers — [`MID_LINE_OK`].
 * - **Not while deleting.** Backspace is correcting, not writing; a suggestion popping up under it
 *   is noise. An explicit trigger (Alt+\) still asks.
 * - **Never re-type what is there.** Done in Rust (`localai::complete::tidy`), which drops an answer
 *   that only reproduces the line below or above, and closers the line already has.
 */

/**
 * Milliseconds of quiet before a request is issued.
 *
 * `llama.vscode` ships 0, and can afford to: it is talking to a server the user started and left
 * running. Here the engine may be cold, and a burst of requests during a fast run of typing would
 * each start, cancel and restart prompt evaluation.
 *
 * It was 150 ms, and that was the main reason it felt pushy: ordinary typing leaves 150–250 ms
 * between keys, so ghost text kept flashing up *between letters* of a word still being typed. 300
 * is past that gap and still short of a pause that reads as a wait; with the model's ~150–300 ms on
 * top, a suggestion lands about where Copilot's does. Monaco's own debounce is off (see
 * `debounceDelayMs` below), so this is the whole delay.
 */
const DEBOUNCE_MS = 300;

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
 * What may follow the caret *on its own line* for completion to be offered there.
 *
 * Completing into the middle of an existing line is almost always wrong — the user is editing, not
 * writing — and the ghost text ends up interleaved with what is already there. Closers are the
 * exception, because the caret sits inside them constantly: `log(|)`, `"|"`, `{|};`.
 *
 * This replaced `llama.vscode`'s `max_line_suffix` (any 8 characters), which let `|foo)` and
 * `|.then` through — the caret before a word that is already written. The pattern is Copilot's:
 * closing brackets and quotes, then at most one `:`, `{`, `;` or `,`.
 */
const MID_LINE_OK = /^\s*[)\]}>"'`]*\s*[:{;,]?\s*$/;

/**
 * A line that opens a block when it ends like this: braces and brackets, Python's and YAML's `:`,
 * arrows, and the keyword openers of Ruby, Lua and shell.
 */
const BLOCK_OPENER = /(?:[{([:]|=>|->|\b(?:do|then|else|begin))\s*$/;

/** How far up past blank lines [`completionShape`] looks for the line that opened the block. */
const OPENER_REACH = 3;

/**
 * How much the next request may write, decided from the lines around the caret.
 *
 * One line, unless the caret is on the blank, indented line of an **empty block** — the line Enter
 * leaves you on after `{` — with that block's closer (or a dedent, or the end of the file) below
 * it. That is Copilot's `isEmptyBlockStart`, done on indentation instead of a parse tree: the only
 * place a multi-line answer is plainly what is wanted, because there is nothing there yet and the
 * block says where to stop. Anywhere else the answer is the rest of the caret's line, and the next
 * line comes after Enter.
 *
 * `indent` is in characters, not columns — it goes to the server as `n_indent`, which counts a tab
 * as one. Widths compared *here* expand tabs, since a block written with tabs opens under a line
 * indented with them.
 */
export function completionShape(
  lineAt: (lineNumber: number) => string,
  lineCount: number,
  position: { lineNumber: number; column: number },
  tabSize: number,
): { multiline: boolean; indent: number } {
  const single = { multiline: false, indent: 0 };
  const line = lineAt(position.lineNumber);
  const before = line.slice(0, position.column - 1);
  if (before.trim() !== "" || line.trim() !== "") return single;

  const width = widthOf(before, tabSize);
  if (width === 0) return single;

  let opener: string | null = null;
  for (let n = position.lineNumber - 1; n >= Math.max(1, position.lineNumber - OPENER_REACH); n--) {
    const text = lineAt(n);
    if (text.trim() === "") continue;
    opener = text;
    break;
  }
  if (opener === null || !BLOCK_OPENER.test(opener)) return single;
  if (widthOf(leadingSpace(opener), tabSize) >= width) return single;

  // Empty means the next code below sits *outside* the caret's indentation: the closer, a dedent,
  // or nothing at all. Code at the caret's depth means the block already has a body.
  for (let n = position.lineNumber + 1; n <= lineCount; n++) {
    const text = lineAt(n);
    if (text.trim() === "") continue;
    if (widthOf(leadingSpace(text), tabSize) >= width) return single;
    break;
  }
  return { multiline: true, indent: before.length };
}

function leadingSpace(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

function widthOf(space: string, tabSize: number): number {
  let width = 0;
  for (const char of space) width += char === "\t" ? tabSize - (width % tabSize) : 1;
  return width;
}

let installed = false;

/**
 * The editors ghost text is offered in, by the URI scheme each one mints.
 *
 * `context` is optional and is given the model's whole text; what it returns is prepended to the
 * prefix. It must be cheap and synchronous — it runs on the keystroke path — and it must be
 * comment syntax for that language, since it is handed to the model as part of the document.
 */
const SURFACES: Record<string, { context?: ContextFor }> = {
  /** Repository files, minted by `editorModel.modelPathFor`. */
  [MODEL_SCHEME]: {},
  /** The DBML workbench — `cf-dbml:/<diagramId>.dbml`. The buffer is the schema; nothing to add. */
  "cf-dbml": {},
  /** The database console — `cf-db:/console/<tabId>.<ext>`. Its header is registered below. */
  "cf-db": {},
};

type ContextFor = (uri: string, text: string) => string;

/**
 * Gives a surface its synthetic header, from the module that knows how to build one.
 *
 * Pushed rather than pulled, and that is a bundling decision as much as a layering one. This module
 * is installed at startup from `monacoSetup`, and the SQL header needs the whole database store to
 * do its job — importing it here would put that store, and everything it reaches, in the startup
 * bundle for a feature that cannot fire until a console exists. `sqlCompletion` registers itself
 * when it loads instead, which is when the database workspace is first opened, which is the
 * earliest a `cf-db:` model can exist at all.
 *
 * Registering for a scheme not in [`SURFACES`] does nothing: the surface list is the decision about
 * where completion belongs, and it stays here.
 */
export function registerCompletionContext(scheme: string, context: ContextFor): void {
  const surface = SURFACES[scheme];
  if (surface) surface.context = context;
}

/** The surface a request is about, or `null` for a Monaco instance that is not one of them. */
function fileOf(
  model: MonacoEditorNS.ITextModel,
): { uri: string; context?: ContextFor } | null {
  const surface = SURFACES[model.uri.scheme];
  if (!surface) return null;
  return { uri: model.uri.toString(), context: surface.context };
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

/**
 * Registers the provider with Monaco. Idempotent, and safe to call from anywhere.
 *
 * Exported because *where* this is installed decides which panels get ghost text at all, and the
 * answer is "all of them, from startup". While it lived only in the hook below, the provider was
 * installed by `EditorPane` and by nothing else — so a session that opened the Diagrams workspace
 * or the database console without ever opening a repository file got no completion in either,
 * however configured. `monacoSetup` calls this beside the other global registrations.
 */
export function installInlineCompletion(monaco: Monaco): void {
  if (installed) return;
  installed = true;

  // The version each surface model was at when an edit removed text and added none — Backspace,
  // Delete, Cut, an undo of typing. Kept by version so a request can tell whether *the edit that
  // produced what it is looking at* was a deletion, whatever order the listeners ran in.
  const deletedAt = new WeakMap<MonacoEditorNS.ITextModel, number>();
  const watch = (model: MonacoEditorNS.ITextModel) => {
    if (!fileOf(model)) return;
    model.onDidChangeContent((event) => {
      if (event.changes.every((change) => change.text === "")) deletedAt.set(model, event.versionId);
      else deletedAt.delete(model);
    });
  };
  monaco.editor.getModels().forEach(watch);
  monaco.editor.onDidCreateModel(watch);

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

      // Mid-line editing — see MID_LINE_OK.
      const restOfLine = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: model.getLineMaxColumn(position.lineNumber),
      });
      if (!MID_LINE_OK.test(restOfLine)) return undefined;

      // Deleting — see the module comment. Before `reuse`, too: backspacing to exactly where a
      // suggestion was shown would otherwise pop the whole of it back up.
      const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      if (!explicit && deletedAt.get(model) === model.getVersionId()) return undefined;

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
        // The header is added here and *only* here. `memo` and `reuse` above are keyed on the plain
        // prefix, which is the one that corresponds to what is on screen: mixing a synthetic header
        // into the remembered prefix would make "have I already answered this?" depend on a catalog
        // read that may have landed since, and typing along a suggestion would start missing.
        const header = file.context?.(file.uri, model.getValue()) ?? "";
        const shape = completionShape(
          (lineNumber) => model.getLineContent(lineNumber),
          model.getLineCount(),
          position,
          model.getOptions().tabSize,
        );
        const text = await localAiComplete({
          request_id: requestId,
          prefix: header + prefix,
          suffix: suffixOf(model, position),
          ...shape,
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
