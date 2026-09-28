import * as monaco from "monaco-editor";
import { eolOf, formatWithPrettier, lineEdits, prettierCanFormat } from "../../lib/formatting";
import { pushErrorToast } from "../../state/toastStore";
import { translate } from "../../state/languageStore";

/**
 * "Formatear documento" and "Formatear al guardar" — one path for both, so a file formats the same
 * way whether ⇧⌥F was pressed or ⌘S was.
 *
 * The repository's own Prettier goes first when it has one and the file is one of its languages
 * (`lib/formatting`). Everything else is Monaco's `formatDocument` — the TypeScript worker's
 * formatter, CSS, HTML, JSON, or a language server's — exactly as the key did before.
 */

/** How a Prettier attempt ended. `fallback`: the repository has none, or it has no parser for this
 *  file — use the editor's formatter. `failed` has already been reported, or was a buffer that moved
 *  while Prettier ran; either way nothing more should happen. */
export type PrettierResult = "formatted" | "unchanged" | "fallback" | "failed";

/**
 * Formats a model with the repository's Prettier, as edits that touch only the lines it changed
 * (`lineEdits`) — one undo step, the caret where it was.
 *
 * A buffer that changed while Prettier ran is left alone: its answer describes text that is gone,
 * and laying it over what was typed since would take that typing away.
 */
export async function formatWithRepoPrettier(
  model: monaco.editor.ITextModel,
  repoPath: string,
  path: string,
): Promise<PrettierResult> {
  if (!prettierCanFormat(path)) return "fallback";
  const text = model.getValue();
  const version = model.getAlternativeVersionId();
  let outcome;
  try {
    outcome = await formatWithPrettier(repoPath, path, text);
  } catch (e) {
    pushErrorToast(translate("editor.prettierFailed", { error: String(e) }));
    return "failed";
  }
  if (outcome.kind !== "formatted") return "fallback";
  if (model.isDisposed() || model.getAlternativeVersionId() !== version) return "failed";
  if (outcome.text === text) return "unchanged";
  applyFormatted(model, text, outcome.text);
  return "formatted";
}

function applyFormatted(model: monaco.editor.ITextModel, before: string, after: string): void {
  const eol = model.getEOL();
  const edits = lineEdits(before, after, eol);
  // A model has one line ending for the whole file, so a formatter that changes the endings (the
  // project's `endOfLine`) is honoured by switching the model's — undoable, like the edits.
  const wanted = after.includes("\n") ? eolOf(after) : eol;
  model.pushStackElement();
  if (edits.length > 0) {
    model.pushEditOperations(
      [],
      edits.map((edit) => ({ range: edit.range, text: edit.text })),
      () => null,
    );
  }
  if (wanted !== eol) {
    model.pushEOL(wanted === "\r\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
  }
  model.pushStackElement();
}

/** `.vue`, `.svelte`, `.astro` — see `monacoSfc`. */
export function isComponentFile(path: string): boolean {
  return /\.(vue|svelte|astro)$/i.test(path);
}

/** A promise that gives up after `ms` — a formatter that hangs must not hold a save hostage. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
}

/**
 * Formats a model the way ⇧⌥F would: Prettier, then the editor's own formatter. Answers `none` when
 * nothing could format it — the key press says so, a save goes ahead unformatted.
 *
 * The editor's formatter needs an editor to run in (Monaco's action is per editor), so for a model
 * no pane is showing only Prettier can answer.
 */
export async function formatModel(
  model: monaco.editor.ITextModel,
  repoPath: string,
  path: string,
  editor?: monaco.editor.ICodeEditor | null,
): Promise<"done" | "none"> {
  if ((await formatWithRepoPrettier(model, repoPath, path)) !== "fallback") return "done";
  // A component file opens as HTML for its colours, and Monaco's HTML formatter would reflow a Vue
  // template or a Svelte block as markup it does not understand. Prettier (with its plugin) or nothing.
  if (isComponentFile(path)) return "none";
  const host = editor ?? monaco.editor.getEditors().find((candidate) => candidate.getModel() === model) ?? null;
  const action = host?.getAction("editor.action.formatDocument");
  if (!action || !action.isSupported()) return "none";
  await within(action.run(), 5000);
  return "done";
}
