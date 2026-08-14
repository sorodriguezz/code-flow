import {
  Suspense,
  lazy,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronRight,
  Columns2,
  Copy,
  Download,
  Eye,
  LayoutTemplate,
  ListTree,
  MoreHorizontal,
  Sparkles,
  PenLine,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { NotePreview } from "./NotePreview";
import { ResizeHandle } from "../common/ResizeHandle";
import { NoteToolbar } from "./NoteToolbar";
import { NoteOutline } from "./NoteOutline";
import { NoteTagBar } from "./NoteTagBar";
import { SaveTemplateModal } from "./SaveTemplateModal";
import { NoteAiModal } from "./NoteAiModal";
import { ICON_BUTTON, readingMinutes, relativeTime } from "./notesChrome";
import type { NoteMonacoHandle } from "./NoteMonaco";
import { outlineOf } from "../../lib/notes/outline";
import { bookPath } from "../../lib/notes/tree";
import { writeFileBytes } from "../../lib/tauri/commands";
import type { NoteViewMode } from "../../types/notes";
import { useNotesStore } from "../../state/notesStore";
import { confirmAction } from "../../state/confirmStore";
import { useLayoutStore } from "../../state/layoutStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useLanguageStore, useT } from "../../state/languageStore";

/**
 * Monaco is behind `lazy` so that a workspace opened on its gallery never fetches it. It is the
 * largest chunk in the app, and it is not needed until a note is actually opened. Declared at
 * module scope, not inside the component, or every render would create a new lazy component and
 * remount the editor — which for Monaco means losing the undo stack and the scroll position.
 */
const NoteMonaco = lazy(() => import("./NoteMonaco").then((m) => ({ default: m.NoteMonaco })));

/**
 * The open note: header, toolbar, editor, preview, outline, status bar.
 *
 * **The performance decision that matters here is `useDeferredValue`.** The preview re-parses the
 * whole document through `marked` + DOMPurify, and the outline rescans it; doing either
 * synchronously on every keystroke is what makes a Markdown editor feel like it is chewing gum on
 * a long note. React 19's deferred value lets the keystroke commit at once and the expensive
 * derivations catch up in a lower-priority render — so the caret never waits for the preview, and
 * a fast typist simply skips the intermediate ones.
 *
 * The second one is that the *draft* lives in the store while the *row* stays untouched until the
 * autosave fires. A keystroke updates one small object rather than an array of four hundred notes.
 * See `notesStore`.
 */
export function NoteEditor() {
  const draft = useNotesStore((s) => s.draft);
  const notes = useNotesStore((s) => s.notes);
  const books = useNotesStore((s) => s.books);
  const viewMode = useNotesStore((s) => s.viewMode);
  const outlineOpen = useNotesStore((s) => s.outlineOpen);
  const saving = useNotesStore((s) => s.saving);
  const savedAt = useNotesStore((s) => s.savedAt);

  const editDraft = useNotesStore((s) => s.editDraft);
  const setViewMode = useNotesStore((s) => s.setViewMode);
  const toggleOutline = useNotesStore((s) => s.toggleOutline);
  const togglePinned = useNotesStore((s) => s.togglePinned);
  const duplicateNote = useNotesStore((s) => s.duplicateNote);
  const deleteNote = useNotesStore((s) => s.deleteNote);
  const openNote = useNotesStore((s) => s.openNote);

  const outlineWidth = useLayoutStore((s) => s.sizes.notesOutlineWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const language = useLanguageStore((s) => s.language);
  const t = useT();

  const monaco = useRef<NoteMonacoHandle>(null);
  const previewPane = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [templating, setTemplating] = useState(false);
  /** The selection captured when the AI dialog opened. Taken then rather than read on submit,
   *  because focus moves into the dialog and Monaco's selection is gone by the time it is used. */
  const [aiSelection, setAiSelection] = useState<string | null>(null);
  const [caretHeadingLine, setCaretHeadingLine] = useState(0);

  const note = draft ? notes.find((n) => n.id === draft.id) ?? null : null;
  const content = draft?.content ?? "";

  // The expensive derivations run against the *deferred* text. See the component's doc comment —
  // this single hook is what keeps typing on a long note at keystroke speed.
  const settled = useDeferredValue(content);
  const headings = useMemo(() => outlineOf(settled), [settled]);
  const words = useMemo(() => settled.split(/\s+/).filter(Boolean).length, [settled]);
  const breadcrumb = useMemo(
    () => bookPath(books, note?.book_id ?? null),
    [books, note?.book_id],
  );

  // Set only when the caret crosses into a different heading's section, not on every cursor move:
  // Monaco fires that event for each arrow key, and re-rendering this component per keypress is
  // exactly the cost the deferred value above exists to avoid paying.
  const onCursorLine = useCallback(
    (line: number) => {
      // Monaco counts lines from 1; `Heading.line` counts from 0. Converted here, once, so what
      // reaches `NoteOutline` is in the same space as the headings it compares against — the two
      // being one apart is invisible until the caret lands exactly on a heading, and then the rail
      // marks the section *below* the one you are in.
      const zeroBased = line - 1;
      let boundary = 0;
      for (const heading of headings) {
        if (heading.line <= zeroBased) boundary = heading.line;
        else break;
      }
      setCaretHeadingLine((previous) => (previous === boundary ? previous : boundary));
    },
    [headings],
  );

  // An image file pasted or dropped into the editor. Notes are Markdown in a database with no
  // blob store beside it, so a picture can only be referenced by URL — and saying that once, at
  // the moment someone tries, is worth more than any amount of documentation nobody reads.
  const onImageRejected = useCallback(() => {
    useToastStore.getState().pushToast(t("notes.imageUrlsOnly"), "info");
  }, [t]);

  // Scrolling the editor scrolls the preview, one way only. Two-way sync is a feedback loop that
  // needs a suppression flag and still stutters where the two panes' heights disagree — and the
  // question a split view answers is "what does what I am writing look like", which is the editor
  // leading.
  const onScroll = useCallback((ratio: number) => {
    const pane = previewPane.current;
    if (!pane) return;
    const travel = pane.scrollHeight - pane.clientHeight;
    if (travel > 0) pane.scrollTop = ratio * travel;
  }, []);

  // The editor is not remounted between notes (see `NotesView`), so the preview keeps whatever
  // scroll the previous note left it at — which on a short note means opening it half way down a
  // document that has already ended. Monaco restores its own view state per model; this is the
  // preview's half of the same job.
  useEffect(() => {
    if (previewPane.current) previewPane.current.scrollTop = 0;
    setCaretHeadingLine(0);
  }, [draft?.id]);

  // Ctrl/Cmd-S writes now rather than waiting out the debounce. The note is already being saved
  // continuously, so this is not what makes the data safe — it is what lets someone who has typed
  // Ctrl-S at the end of every paragraph for twenty years keep doing it and be told it worked.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void useNotesStore.getState().flush();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!draft || !note) return null;

  const showEditor = viewMode !== "preview";
  const showPreview = viewMode !== "editor";

  const exportMarkdown = async () => {
    const name = `${(note.title || t("notes.untitled")).replace(/[/\\:*?"<>|]/g, "-")}.md`;
    try {
      const path = await saveDialog({
        defaultPath: name,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      // The *draft*, not the row: what is on screen is what the user means by "this note", and
      // exporting the last saved version would silently drop the sentence they just typed.
      await writeFileBytes(path, new TextEncoder().encode(draft.content));
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  const MODES: { mode: NoteViewMode; icon: typeof PenLine; labelKey: Parameters<typeof t>[0] }[] = [
    { mode: "editor", icon: PenLine, labelKey: "notes.modeEditor" },
    { mode: "split", icon: Columns2, labelKey: "notes.modeSplit" },
    { mode: "preview", icon: Eye, labelKey: "notes.modePreview" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---------- header ---------- */}
      <div className="shrink-0 border-b border-[var(--cf-border)] px-3 pb-2 pt-2">
        <div className="flex items-center gap-1">
          <nav
            className="flex min-w-0 flex-1 items-center gap-0.5 text-[10.5px] text-[var(--cf-text-muted)]"
            aria-label={t("notes.location")}
          >
            {breadcrumb.length === 0 ? (
              <span className="truncate">{t("notes.root")}</span>
            ) : (
              breadcrumb.map((book, index) => (
                <span key={book.id} className="flex min-w-0 items-center gap-0.5">
                  {index > 0 && <ChevronRight size={10} className="shrink-0 opacity-60" />}
                  <span className="truncate">{book.name}</span>
                </span>
              ))
            )}
          </nav>

          <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-black/[0.04] p-0.5 dark:bg-white/[0.05]">
            {MODES.map(({ mode, icon: Icon, labelKey }) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                aria-pressed={viewMode === mode}
                title={t(labelKey)}
                aria-label={t(labelKey)}
                className={`flex h-5 w-6 items-center justify-center rounded transition-colors ${
                  viewMode === mode
                    ? "bg-[var(--cf-surface-raised)] text-[var(--cf-accent)] shadow-sm"
                    : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                }`}
              >
                <Icon size={12} />
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setAiSelection(monaco.current?.selectedText() ?? "")}
            disabled={!showEditor}
            title={t("notes.ai.action")}
            aria-label={t("notes.ai.action")}
            data-tour="notes-ai"
            className={`${ICON_BUTTON} text-[var(--cf-accent)]`}
          >
            <Sparkles size={13} />
          </button>

          <button
            type="button"
            onClick={toggleOutline}
            aria-pressed={outlineOpen}
            title={t("notes.outline")}
            aria-label={t("notes.outline")}
            className={`${ICON_BUTTON} ${outlineOpen ? "text-[var(--cf-accent)]" : ""}`}
          >
            <ListTree size={13} />
          </button>

          <button
            type="button"
            onClick={() => void togglePinned(note.id)}
            title={note.pinned ? t("notes.unpin") : t("notes.pin")}
            aria-label={note.pinned ? t("notes.unpin") : t("notes.pin")}
            className={`${ICON_BUTTON} ${note.pinned ? "text-[var(--cf-accent)]" : ""}`}
          >
            {note.pinned ? <Pin size={13} fill="currentColor" /> : <Pin size={13} />}
          </button>

          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={t("notes.moreActions")}
            onClick={(event) =>
              setMenu({
                x: event.clientX,
                y: event.clientY,
                items: [
                  {
                    label: note.pinned ? t("notes.unpin") : t("notes.pin"),
                    icon: note.pinned ? PinOff : Pin,
                    onClick: () => void togglePinned(note.id),
                  },
                  {
                    label: t("notes.duplicate"),
                    icon: Copy,
                    onClick: () => {
                      void duplicateNote(note.id).then((id) => id && void openNote(id));
                    },
                  },
                  {
                    label: t("notes.saveAsTemplate"),
                    icon: LayoutTemplate,
                    onClick: () => setTemplating(true),
                  },
                  {
                    label: t("notes.exportMarkdown"),
                    icon: Download,
                    onClick: () => void exportMarkdown(),
                  },
                  {
                    label: t("notes.delete"),
                    icon: Trash2,
                    danger: true,
                    separated: true,
                    onClick: () => {
                      void confirmAction(
                        t("notes.deleteNoteConfirm", {
                          name: note.title || t("notes.untitled"),
                        }),
                        true,
                        t("notes.delete"),
                      ).then((ok) => ok && void deleteNote(note.id));
                    },
                  },
                ],
              })
            }
          >
            <MoreHorizontal size={13} />
          </button>
        </div>

        <input
          value={draft.title}
          onChange={(event) => editDraft({ title: event.target.value })}
          placeholder={t("notes.untitled")}
          aria-label={t("notes.noteTitle")}
          spellCheck={false}
          // Borderless and large: this is the document's title, not a form field, and a box around
          // it would make the header read as a settings panel over the writing.
          className="mt-1 w-full bg-transparent text-[17px] font-semibold text-[var(--cf-text)] outline-none placeholder:font-normal placeholder:italic placeholder:text-[var(--cf-text-muted)]"
        />

        <div className="mt-1.5">
          <NoteTagBar tags={draft.tags} onChange={(tags) => editDraft({ tags })} />
        </div>
      </div>

      {showEditor && (
        <NoteToolbar onApply={(tool) => monaco.current?.apply(tool)} disabled={!showEditor} />
      )}

      {/* ---------- surfaces ---------- */}
      {/* `h-full` on both the row and the editor's own column, and it is load-bearing rather than
          belt-and-braces: Monaco's container is a chain of `height: 100%` elements, and a
          percentage height only resolves against an ancestor whose height is definite. `flex-1`
          alone gave the row a *used* height but left `height: auto` in the cascade, so the chain
          collapsed to nothing and Monaco initialised into a zero-height box — blank, and with no
          later resize to recover from. `EditorPane` has always wrapped its own editor in
          `<div className="flex h-full">` for exactly this reason. */}
      <div className="flex h-full min-h-0 flex-1">
        {showEditor && (
          <div className={`h-full min-w-0 ${showPreview ? "flex-1" : "w-full"}`}>
            <Suspense fallback={<div className="h-full w-full bg-[var(--cf-surface)]" />}>
              <NoteMonaco
                handle={monaco}
                noteId={draft.id}
                value={draft.content}
                onChange={(next) => editDraft({ content: next })}
                onScroll={showPreview ? onScroll : undefined}
                onCursorLine={outlineOpen ? onCursorLine : undefined}
                onImageRejected={onImageRejected}
              />
            </Suspense>
          </div>
        )}

        {showEditor && showPreview && (
          <div className="w-px shrink-0 bg-[var(--cf-border)]" aria-hidden />
        )}

        {showPreview && (
          <div
            ref={previewPane}
            className={`min-w-0 overflow-y-auto px-6 py-4 ${showEditor ? "flex-1" : "w-full"}`}
          >
            {settled.trim() ? (
              // Memoised on `source`, and `source` is the deferred text — so the document is
              // parsed and re-highlighted once per settled edit rather than once per keystroke.
              <NotePreview source={settled} className="cf-markdown-preview mx-auto max-w-[760px]" />
            ) : (
              <p className="mx-auto max-w-[760px] text-[12.5px] italic text-[var(--cf-text-muted)]">
                {t("notes.previewEmpty")}
              </p>
            )}
          </div>
        )}

        {outlineOpen && (
          <>
            <ResizeHandle
              axis="x"
              value={outlineWidth}
              min={160}
              max={420}
              invert
              onChange={(value) => setSize("notesOutlineWidth", value)}
              onCommit={(value) => commitSize("notesOutlineWidth", value)}
            />
            <div
              style={{ width: outlineWidth }}
              className="shrink-0 border-l border-[var(--cf-border)]"
            >
              <NoteOutline
                headings={headings}
                activeLine={caretHeadingLine}
                onSelect={(heading, index) => {
                  // In preview-only there is no editor to move the caret in, so the click scrolls
                  // the rendered document instead. By *index*, because `marked` emits no `id` on
                  // its headings — the rail's Nth row is the Nth heading element, which is the
                  // alignment `outlineOf` goes out of its way to preserve.
                  if (showEditor) {
                    monaco.current?.goToLine(heading.line + 1);
                    return;
                  }
                  previewPane.current
                    ?.querySelectorAll("h1, h2, h3, h4, h5, h6")
                    .item(index)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              />
            </div>
          </>
        )}
      </div>

      {/* ---------- status bar ---------- */}
      <div className="flex shrink-0 items-center gap-3 border-t border-[var(--cf-border)] px-3 py-1 text-[10.5px] text-[var(--cf-text-muted)]">
        <span className="tabular-nums">{t("notes.wordCount", { n: words })}</span>
        <span className="tabular-nums">{t("notes.charCount", { n: settled.length })}</span>
        <span className="tabular-nums">{t("notes.readingTime", { n: readingMinutes(words) })}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {saving ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--cf-accent)]" />
              {t("notes.saving")}
            </>
          ) : draft.dirty ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--cf-warning)]" />
              {t("notes.unsaved")}
            </>
          ) : savedAt ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--cf-success)]" />
              {t("notes.savedAt", { when: relativeTime(savedAt, language) })}
            </>
          ) : null}
        </span>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {templating && <SaveTemplateModal onClose={() => setTemplating(false)} />}
      {aiSelection !== null && (
        <NoteAiModal
          selection={aiSelection}
          onInsert={(markdown) => monaco.current?.replaceSelection(markdown)}
          onClose={() => setAiSelection(null)}
        />
      )}
    </div>
  );
}
