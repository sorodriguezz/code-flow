import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
// Side-effect import: this is what points `@monaco-editor/react`'s loader at the *bundled* copy
// instead of a CDN, and wires up the language workers. `EditorPane` imports it for the same reason.
// Importing it here rather than relying on the Editor view having been opened first is what makes
// Notes work as the only view a user ever opens.
import "../../lib/monacoSetup";
import { applyTool, type MarkdownTool } from "../../lib/notes/markdownTools";
import { suggestNoteLinks, useNotesStore } from "../../state/notesStore";
import { useThemeStore } from "../../state/themeStore";

/**
 * The Markdown editing surface: Monaco, configured for prose rather than for code.
 *
 * **Its own module so it can be `lazy`-loaded.** Monaco is the largest chunk in the app, and a
 * notes workspace opens on a gallery of cards — nobody should pay for the editor until they open a
 * note. `NoteEditor` wraps this in `Suspense`; the whole of Monaco's cost is on this side of that
 * boundary.
 *
 * **Why Monaco and not a `<textarea>`.** The app already has a perfectly good textarea-based
 * Markdown field (`common/MarkdownEditor`) and it is the right thing for a description box. A
 * notes app is where you write the long documents, and the difference shows up immediately: line
 * numbers to refer to, syntax highlighting that tells a heading from a hash, folding for the
 * section you're not working on, multi-cursor, and a find/replace that works over a document
 * rather than a paragraph. That is the difference between the two screenshots this feature was
 * asked for and a bigger comment box.
 *
 * The editor's own configuration is on `BASE_OPTIONS` below.
 */

/**
 * Everything about the editor that never changes, as a module constant.
 *
 * Hoisted out of the JSX because `@monaco-editor/react` calls `editor.updateOptions()` whenever
 * the `options` prop changes *by reference* — and an object literal in the render body is a new
 * reference on every render, which for this component is every keystroke. Reconfiguring the editor
 * on each character is invisible but entirely wasted work.
 *
 * The configuration below is all one decision restated: **this is prose.** Word wrap on, minimap
 * off, no indent guides, no bracket colouring, generous line height, and a font stack whose first
 * choice is the reading face rather than the code one.
 */
const BASE_OPTIONS: MonacoEditorNS.IStandaloneEditorConstructionOptions = {
  // ---- prose, not code ----
  wordWrap: "on",
  // Wrapped lines indent to the start of the text rather than to column zero, which is what
  // keeps a wrapped list item reading as one item.
  wrappingIndent: "same",
  minimap: { enabled: false },
  lineNumbers: "on",
  lineNumbersMinChars: 3,
  glyphMargin: false,
  folding: true,
  renderLineHighlight: "line",
  guides: { indentation: false, bracketPairs: false },
  bracketPairColorization: { enabled: false },
  occurrencesHighlight: "off",
  // Suggestions over prose are noise: every second word would open a box listing the other
  // words in the document.
  quickSuggestions: false,
  wordBasedSuggestions: "off",
  suggestOnTriggerCharacters: false,
  parameterHints: { enabled: false },
  // ---- reading comfort ----
  fontSize: 13.5,
  lineHeight: 22,
  fontFamily:
    'ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  letterSpacing: 0.1,
  padding: { top: 14, bottom: 200 },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: "smooth",
  cursorSmoothCaretAnimation: "on",
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  // Trailing whitespace is two spaces = a line break in Markdown, so rendering it as a dot
  // is genuinely useful here in a way it isn't in code.
  renderWhitespace: "trailing",
  // A monospace tab in prose is a paragraph indent nobody asked for.
  tabSize: 2,
  /**
   * Monaco watches its own container and relays itself.
   *
   * This was a hand-rolled `ResizeObserver` calling `editor.layout()`, which is the same idea
   * done worse in two ways. It cannot fire before `onMount` has produced an editor to lay out —
   * so the *first* measurement, the one that matters, was always missed — and every pane in this
   * view is resizable (the sidebar splitter, the outline rail, the preview appearing beside it),
   * none of which changes the window size. `EditorPane` sets this flag for the same reasons.
   */
  automaticLayout: true,
};

/** Our own URI scheme, so a sweep can tell notes' models from the Editor view's. */
const NOTE_SCHEME = "cfnote";

/** How many notes' models Monaco may hold at once. See the sweep in the component. */
const MODEL_LIMIT = 12;

const modelPath = (noteId: string) => `${NOTE_SCHEME}:/${noteId}.md`;

export interface NoteMonacoHandle {
  /** Runs a toolbar action against the live selection. */
  apply: (tool: MarkdownTool) => void;
  /** Puts the caret on a line and scrolls it into view — what the outline clicks do. */
  goToLine: (line: number) => void;
  focus: () => void;
  /** What is selected right now, or `""`. */
  selectedText: () => string;
  /**
   * Replaces the selection — or inserts at the caret when there is none.
   *
   * Through `executeEdits`, so it is **one undo step**: the only thing that makes a generate button
   * safe to press on a document somebody cares about.
   */
  replaceSelection: (text: string) => void;
}

export function NoteMonaco({
  value,
  onChange,
  /** The note's id. Monaco keeps one model per `path`, so this is what gives each note its own
   *  undo history, folding state and view state — and what stops a switch between two notes from
   *  looking like one enormous edit in the undo stack. */
  noteId,
  readOnly,
  onScroll,
  onCursorLine,
  onImageRejected,
  handle,
}: {
  value: string;
  onChange: (next: string) => void;
  noteId: string;
  readOnly?: boolean;
  /** Fires as the editor scrolls, so the preview can follow it in split view. */
  onScroll?: (ratio: number) => void;
  /**
   * The line the caret moved to, one-based.
   *
   * Fires on every cursor move, which is often — the consumer is expected to derive something
   * coarse from it (which heading the caret is inside) and only set state when *that* changes.
   * Reporting the line rather than the derived value keeps this component ignorant of outlines.
   */
  onCursorLine?: (line: number) => void;
  /**
   * Someone tried to put an image *file* into the note — pasted from the clipboard, or dropped.
   *
   * Notes hold Markdown and nothing else: there is no blob store behind them, so a pasted image
   * has nowhere to be kept and an image pointed at a path on this disk would travel with no
   * backup. Refusing is the right answer; refusing *silently* is not, and silence is exactly what
   * happens by default — Monaco reads `text/plain` off the clipboard, finds none, and inserts
   * nothing. The caller turns this into a sentence saying URLs are the way.
   */
  onImageRejected?: () => void;
  handle?: Ref<NoteMonacoHandle>;
}) {
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  // The latest handler, read at call time. Without this the `onDidScrollChange` listener registered
  // at mount would close over the first render's callback forever.
  const scrollRef = useRef(onScroll);
  scrollRef.current = onScroll;
  const cursorRef = useRef(onCursorLine);
  cursorRef.current = onCursorLine;
  const rejectRef = useRef(onImageRejected);
  rejectRef.current = onImageRejected;

  useImperativeHandle(
    handle,
    () => ({
      apply: (tool) => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (editor && monaco) applyTool(editor, monaco, tool);
      },
      goToLine: (line) => {
        const editor = editorRef.current;
        if (!editor) return;
        // `revealLineInCenter` and not `revealLine`: an outline click on a heading near the bottom
        // of the document would otherwise put it on the last visible row, with the section it names
        // entirely off screen — which is the one thing the click was for.
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      },
      focus: () => editorRef.current?.focus(),
      selectedText: () => {
        const editor = editorRef.current;
        const selection = editor?.getSelection();
        const model = editor?.getModel();
        if (!editor || !selection || !model || selection.isEmpty()) return "";
        return model.getValueInRange(selection);
      },
      replaceSelection: (text) => {
        const editor = editorRef.current;
        const selection = editor?.getSelection();
        if (!editor || !selection) return;
        editor.executeEdits("note-ai", [{ range: selection, text }]);
        editor.focus();
      },
    }),
    [],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  /** Bumped by `onMount`, so effects that need the Monaco namespace can wait for it. */
  const [editorReady, setEditorReady] = useState(0);

  /**
   * Disposes the text models of notes the user has moved away from.
   *
   * `@monaco-editor/react` creates a model per `path` and only disposes the *current* one, on
   * unmount. Switching notes therefore leaves the previous note's model — its full text, its undo
   * stack, its tokenisation — alive in Monaco's global registry forever. A session spent reading
   * through a workspace ends with every note resident inside Monaco, which is exactly the state
   * `notesStore`'s `BODY_CACHE_LIMIT` exists to prevent and would have prevented in vain.
   *
   * The bound is deliberately larger than the store's: a model carries the undo history, and
   * throwing that away for a note the user is alt-tabbing between is worse than holding a few
   * more. Only models under our own `cfnote:` scheme are touched — the Editor view's models share
   * this registry and are none of our business.
   */
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    const ours = monaco.editor
      .getModels()
      .filter(
        (model: MonacoEditorNS.ITextModel) =>
          model.uri.scheme === NOTE_SCHEME && !model.isDisposed(),
      );
    if (ours.length <= MODEL_LIMIT) return;
    const current = modelPath(noteId);
    for (const model of ours.slice(0, ours.length - MODEL_LIMIT)) {
      // Never the one on screen. `getModels()` is in creation order, so the oldest go first —
      // and the current note is the most recently created unless it was reopened, which is the
      // case this guard covers.
      if (model.uri.toString() !== current) model.dispose();
    }
  }, [noteId]);

  // The one varying option, merged in behind a memo so the reference is still stable while
  // `readOnly` holds — which is always, in practice.
  const options = useMemo(
    () => ({ ...BASE_OPTIONS, readOnly: readOnly ?? false }),
    [readOnly],
  );

  /**
   * Catches an image arriving as a *file* and says so.
   *
   * On the DOM node rather than through a Monaco API because Monaco has no hook for "the clipboard
   * held something I cannot read". Capture phase, so the listener runs before Monaco's own handler
   * decides there is no text to insert. Text pastes are untouched — the guard only fires when the
   * payload is a file and its type is an image, which is precisely the case that would otherwise
   * do nothing at all.
   */
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const holdsImage = (data: DataTransfer | null) =>
      !!data &&
      (Array.from(data.files).some((file) => file.type.startsWith("image/")) ||
        Array.from(data.items).some(
          (item) => item.kind === "file" && item.type.startsWith("image/"),
        ));

    const onPaste = (event: ClipboardEvent) => {
      if (!holdsImage(event.clipboardData)) return;
      // Only when there is no text alongside it: copying a cell from a spreadsheet puts both an
      // image and its text on the clipboard, and the text is what the user meant.
      if (event.clipboardData?.getData("text/plain")) return;
      event.preventDefault();
      event.stopPropagation();
      rejectRef.current?.();
    };

    const onDrop = (event: DragEvent) => {
      if (!holdsImage(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      rejectRef.current?.();
    };

    element.addEventListener("paste", onPaste, true);
    element.addEventListener("drop", onDrop, true);
    return () => {
      element.removeEventListener("paste", onPaste, true);
      element.removeEventListener("drop", onDrop, true);
    };
  }, []);

  /**
   * Completion for `[[`, offering the workspace's other notes.
   *
   * Registered once per mount and disposed with it — Monaco's provider registry is global, so a
   * provider left behind would be a second copy on every remount, each suggesting the same notes.
   *
   * Scoped to `markdown` and to a line actually containing an unclosed `[[`, which is what keeps it
   * out of the way of ordinary typing: prose is not a place anyone wants a suggestion box.
   */
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    const provider = monaco.languages.registerCompletionItemProvider("markdown", {
      triggerCharacters: ["[", " "],
      provideCompletionItems(
        model: MonacoEditorNS.ITextModel,
        position: { lineNumber: number; column: number },
      ) {
        const line = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        // The last `[[` on the line with no `]]` after it — the reference being typed right now.
        const open = line.lastIndexOf("[[");
        if (open === -1 || line.indexOf("]]", open) !== -1) return { suggestions: [] };
        const typed = line.slice(open + 2);

        // Read at call time rather than closed over: the note list changes while the editor is
        // open, and a provider registered at mount would keep suggesting the notes that existed
        // then.
        const store = useNotesStore.getState();
        const matches = suggestNoteLinks(store.notes, typed);

        const range = {
          startLineNumber: position.lineNumber,
          startColumn: open + 3,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        };
        return {
          suggestions: matches
            .filter((note) => note.id !== noteId)
            .map((note) => ({
              label: note.title,
              kind: monaco.languages.CompletionItemKind.Reference,
              detail: note.excerpt.slice(0, 80),
              // The closing `]]` comes with it, so accepting a suggestion finishes the reference
              // rather than leaving the user to type the bracket that makes it one.
              insertText: `${note.title}]]`,
              range,
            })),
        };
      },
    });
    return () => provider.dispose();
    // `editorReady` rather than `[]`: `monacoRef` is null until `onMount` runs, so an effect with
    // no dependency on that would register nothing at all.
  }, [editorReady, noteId]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.onDidScrollChange(() => {
      const report = scrollRef.current;
      if (!report) return;
      const height = editor.getScrollHeight() - editor.getLayoutInfo().height;
      // A document shorter than the viewport has nothing to sync, and dividing by zero here would
      // send the preview a NaN it would scroll to the top on.
      report(height > 0 ? editor.getScrollTop() / height : 0);
    });
    editor.onDidChangeCursorPosition((event) =>
      cursorRef.current?.(event.position.lineNumber),
    );
    // Signals the completion provider's effect that `monacoRef` is now populated.
    setEditorReady((n) => n + 1);
  };

  return (
    <div ref={containerRef} className="h-full min-h-0 w-full">
      <Editor
        // Explicit rather than relying on the default: the wrapper `<section>` this renders takes
        // its height from the prop, and it is the first link in the percentage chain described in
        // `NoteEditor`'s surfaces block.
        height="100%"
        // The scheme is ours (so the sweep above can find them); the extension is what gives
        // Monaco the Markdown grammar.
        path={modelPath(noteId)}
        language="markdown"
        value={value}
        theme={monacoTheme}
        onMount={handleMount}
        onChange={(next) => onChange(next ?? "")}
        // Monaco's own loading state is a bare "Loading…" on a white square, which flashes against
        // a dark theme. An empty box in the surface colour is less than nothing, which is right:
        // this appears for a few frames after the chunk has already been fetched.
        loading={<div className="h-full w-full bg-[var(--cf-surface)]" />}
        options={options}
      />
    </div>
  );
}
